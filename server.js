const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const PORT = process.env.PORT || 10000;
const CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD || 'dqgjqmwpy';
const CLOUDINARY_KEY = process.env.CLOUDINARY_KEY || '458945749658771';
const CLOUDINARY_SECRET = process.env.CLOUDINARY_SECRET || 'kmhpQlDaDsfxi04i5L7MZvvQCGl';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://ahmedezzelarab1122_db_user:D6hxMuamTPmqKkUO@cluster0.ukmtckx.mongodb.net/kayan_expenses?appName=Cluster0';
const { MongoClient } = require('mongodb');
let mongoClient = null;
let db = null;

async function connectMongo() {
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db('kayan_expenses');
    console.log('✅ MongoDB connected');
    const cfg = await db.collection('config').findOne({ _id: 'main' });
    if (!cfg) {
      await db.collection('config').insertOne({
        _id: 'main',
        supervisors: [{ id: 1, name: 'المشرف', budget: 10000, password: '1234' }],
        projects: ['المشروع الأول'],
        managerPassword: 'admin123',
        nextId: 1,
        laborRates: { company: 100, external: 150 },
        companyWorkers: [],
        ownerPassword: 'owner123'
      });
    }
  } catch (e) { console.error('❌ MongoDB error:', e.message); }
}

async function loadDB() {
  if (!db) return getFallback();
  try {
    const cfg = await db.collection('config').findOne({ _id: 'main' });
    const entries = await db.collection('entries').find({}).toArray();
    return {
      supervisors: cfg.supervisors || [],
      projects: cfg.projects || [],
      managerPassword: cfg.managerPassword || 'admin123',
      nextId: cfg.nextId || 1,
      laborRates: cfg.laborRates || { company: 100, external: 150 },
      companyWorkers: cfg.companyWorkers || [],
      ownerPassword: cfg.ownerPassword || 'owner123',
      entries: entries.map(e => { const { _id, ...rest } = e; return rest; })
    };
  } catch (e) { console.error('loadDB error:', e.message); return getFallback(); }
}

async function saveConfig(data) {
  if (!db) return;
  try {
    await db.collection('config').updateOne(
      { _id: 'main' },
      { $set: { supervisors: data.supervisors, projects: data.projects, managerPassword: data.managerPassword, nextId: data.nextId, laborRates: data.laborRates || { company: 100, external: 150 }, companyWorkers: data.companyWorkers || [], ownerPassword: data.ownerPassword || 'owner123' }},
      { upsert: true }
    );
  } catch (e) { console.error('saveConfig error:', e.message); }
}

async function addEntry(entry) {
  if (!db) return;
  try { await db.collection('entries').insertOne(entry); } catch (e) { console.error('addEntry error:', e.message); }
}

async function updateEntry(id, fields) {
  if (!db) return;
  try { await db.collection('entries').updateOne({ id }, { $set: fields }); } catch (e) { console.error('updateEntry error:', e.message); }
}

async function deleteEntry(id) {
  if (!db) return;
  try { await db.collection('entries').deleteOne({ id }); } catch (e) { console.error('deleteEntry error:', e.message); }
}

function getFallback() {
  return { supervisors: [{ id: 1, name: 'المشرف', budget: 10000, password: '1234' }], projects: ['المشروع الأول'], entries: [], managerPassword: 'admin123', nextId: 1 };
}

async function analyzeInvoice(b64, text, isPdf=false) {
  const { default: https } = await import('https');
  const prompt = text ? text : `أنت خبير محاسبة سعودي. انظر لهذه الفاتورة واستخرج بياناتها بدقة مهما كانت جودة الصورة.
استخرج كل ما تستطيع رؤيته وأكمل الباقي بتقدير منطقي.
أخرج JSON نقي فقط بهذا الشكل:
{"desc":"اسم المورد","type":"petty أو tax","supplier":"اسم المورد","invoiceNo":"رقم أو null","date":"YYYY-MM-DD","payMethod":"cash أو transfer","subtotal":0,"taxRate":0,"taxAmt":0,"total":0,"items":[]}
قواعد: type=tax إذا فيها رقم ضريبي أو VAT، وإلا petty. إذا لم تجد subtotal احسبها = total - taxAmt.
`;
  const content = b64
    ? isPdf
      ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: prompt }]
      : [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: prompt }]
    : [{ type: 'text', text: prompt }];
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64000,
      system: 'You are an expert Saudi accountant. Always return ONLY valid JSON. For single invoice return a JSON object. For bulk/list return {"invoices":[...]}. No explanation, no markdown, no extra text.',
      messages: [{ role: 'user', content }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          const raw = json.content.map(x => x.text || '').join('');
          let parsed = null;
          try { parsed = JSON.parse(raw.trim()); }
          catch(e1) {
            const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
            if (!match) return reject(new Error('لم يُستخرج JSON: ' + raw.slice(0,300)));
            try { parsed = JSON.parse(match[0]); }
            catch(e2) {
              const m2 = raw.match(/\{"invoices":\s*\[[\s\S]*?\]\s*\}/);
              if(m2) { try { parsed = JSON.parse(m2[0]); } catch(e3) { return reject(new Error('JSON parse failed: ' + e2.message)); } }
              else return reject(new Error('JSON parse failed: ' + e2.message));
            }
          }
          const fixNum = v => { if (typeof v === 'string') { v = v.replace(/,/g, '.').replace(/[^0-9.]/g, ''); } return parseFloat(v) || 0; };
          if (parsed && parsed.invoices && Array.isArray(parsed.invoices)) {
            parsed.invoices = parsed.invoices.map(inv => ({ ...inv, subtotal: fixNum(inv.subtotal), taxAmt: fixNum(inv.taxAmt), taxRate: fixNum(inv.taxRate), total: fixNum(inv.total) || (fixNum(inv.subtotal) + fixNum(inv.taxAmt)) }));
            return resolve(parsed);
          }
          if (Array.isArray(parsed)) {
            return resolve({ invoices: parsed.map(inv => ({ ...inv, subtotal: fixNum(inv.subtotal), taxAmt: fixNum(inv.taxAmt), taxRate: fixNum(inv.taxRate), total: fixNum(inv.total) || (fixNum(inv.subtotal) + fixNum(inv.taxAmt)) })) });
          }
          parsed.subtotal = fixNum(parsed.subtotal);
          parsed.taxAmt = fixNum(parsed.taxAmt);
          parsed.taxRate = fixNum(parsed.taxRate);
          parsed.total = fixNum(parsed.total);
          if (parsed.items && Array.isArray(parsed.items)) {
            parsed.items = parsed.items.map(it => ({ ...it, qty: fixNum(it.qty), unitPrice: fixNum(it.unitPrice), total: fixNum(it.total) }));
          }
          if (!parsed.total || parsed.total === 0) parsed.total = parsed.subtotal + parsed.taxAmt;
          if (!parsed.date) parsed.date = new Date().toISOString().split('T')[0];
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function uploadToCloudinary(b64, isPdf=false) {
  const { default: https } = await import('https');
  const UPLOAD_PRESET = 'kayan_invoices';
  const boundary = 'CloudinaryBoundary' + Date.now();
  const fileData = Buffer.from(b64, 'base64');
  const fileName = isPdf ? 'invoice.pdf' : 'invoice.jpg';
  const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';
  const resourceType = isPdf ? 'raw' : 'image';
  const textField = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const filePart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const body = Buffer.concat([textField('upload_preset', UPLOAD_PRESET), filePart, fileData, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudinary.com', path: `/v1_1/${CLOUDINARY_CLOUD}/${resourceType}/upload`, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { const json = JSON.parse(data); if (json.secure_url) resolve(json.secure_url); else reject(new Error(json.error?.message || JSON.stringify(json))); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function generateExcel(dbData) {
  const supMap = {};
  dbData.supervisors.forEach(s => supMap[s.id] = s.name);
  const rows = dbData.entries.map(e => {
    const itemsDesc = (e.items && e.items.length > 0) ? e.items.map(it => it.desc + ' (' + it.qty + ' ' + it.unit + ')').join(' | ') : (e.desc || '');
    return `<Row><Cell><Data ss:Type="Number">${e.id}</Data></Cell><Cell><Data ss:Type="String">${supMap[e.supId] || ''}</Data></Cell><Cell><Data ss:Type="String">${e.project || ''}</Data></Cell><Cell><Data ss:Type="String">${e.type === 'petty' ? 'نثرية' : e.type === 'tax' ? 'ضريبية' : e.type === 'return' ? 'مرتجع' : 'أخرى'}</Data></Cell><Cell><Data ss:Type="String">${itemsDesc}</Data></Cell><Cell><Data ss:Type="String">${e.supplier || ''}</Data></Cell><Cell><Data ss:Type="String">${e.invoiceNo || ''}</Data></Cell><Cell><Data ss:Type="String">${e.date || ''}</Data></Cell><Cell><Data ss:Type="String">${e.payMethod === 'cash' ? 'كاش' : 'تحويل'}</Data></Cell><Cell><Data ss:Type="Number">${e.subtotal || 0}</Data></Cell><Cell><Data ss:Type="Number">${e.taxRate || 0}</Data></Cell><Cell><Data ss:Type="Number">${e.taxAmt || 0}</Data></Cell><Cell><Data ss:Type="Number">${e.total || 0}</Data></Cell></Row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel"><Worksheet ss:Name="المصروفات" ss:RightToLeft="1"><Table><Row><Cell><Data ss:Type="String">الرقم</Data></Cell><Cell><Data ss:Type="String">المشرف</Data></Cell><Cell><Data ss:Type="String">المشروع</Data></Cell><Cell><Data ss:Type="String">النوع</Data></Cell><Cell><Data ss:Type="String">الوصف</Data></Cell><Cell><Data ss:Type="String">المورد</Data></Cell><Cell><Data ss:Type="String">رقم الفاتورة</Data></Cell><Cell><Data ss:Type="String">التاريخ</Data></Cell><Cell><Data ss:Type="String">طريقة الدفع</Data></Cell><Cell><Data ss:Type="String">قبل الضريبة</Data></Cell><Cell><Data ss:Type="String">نسبة الضريبة%</Data></Cell><Cell><Data ss:Type="String">مبلغ الضريبة</Data></Cell><Cell><Data ss:Type="String">الإجمالي</Data></Cell></Row>${rows}</Table></Worksheet></Workbook>`;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    const { role, password, supId } = await parseBody(req);
    const data = await loadDB();
    if (role === 'owner') {
      if (password === (data.ownerPassword || 'owner123')) return sendJSON(res, { ok: true, role: 'owner', name: 'المالك' });
      return sendJSON(res, { ok: false, error: 'كلمة المرور خاطئة' }, 401);
    }
    if (role === 'manager') {
      if (password === data.managerPassword) return sendJSON(res, { ok: true, role: 'manager', name: 'المدير' });
      return sendJSON(res, { ok: false, error: 'كلمة المرور خاطئة' }, 401);
    }
    if (role === 'supervisor') {
      const sup = data.supervisors.find(s => s.id === parseInt(supId));
      if (!sup) return sendJSON(res, { ok: false, error: 'المشرف غير موجود' }, 404);
      if (sup.password !== password) return sendJSON(res, { ok: false, error: 'كلمة المرور خاطئة' }, 401);
      return sendJSON(res, { ok: true, role: 'supervisor', name: sup.name, supId: sup.id, budget: sup.budget });
    }
    return sendJSON(res, { ok: false, error: 'بيانات خاطئة' }, 400);
  }
  if (pathname === '/api/status' && req.method === 'GET') {
    const cfg = db ? await db.collection('config').findOne({ _id: 'main' }).catch(()=>null) : null;
    const entryCount = db ? await db.collection('entries').countDocuments().catch(()=>-1) : -1;
    return sendJSON(res, { mongo: !!db, hasCfg: !!cfg, supervisors: cfg?.supervisors?.length || 0, entries: entryCount, mongoUri: process.env.MONGO_URI ? 'env' : 'hardcoded' });
  }
  if (pathname === '/api/db' && req.method === 'GET') {
    const data = await loadDB();
    const safe = { ...data, supervisors: data.supervisors.map(s => ({ id: s.id, name: s.name, budget: s.budget, visa: s.visa || '' })), laborRates: data.laborRates || { company: 100, external: 150 }, companyWorkers: data.companyWorkers || [] };
    delete safe.managerPassword;
    return sendJSON(res, safe);
  }
  if (pathname === '/api/passwords' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = await loadDB();
    if (body.managerPassword) data.managerPassword = body.managerPassword;
    if (body.ownerPassword) data.ownerPassword = body.ownerPassword;
    if (body.supervisors) {
      body.supervisors.forEach(({ id, password }) => {
        const sup = data.supervisors.find(s => s.id == id);
        if (sup && password) sup.password = password;
      });
    }
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }
  if (pathname === '/api/entries' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = await loadDB();
    const normalize = s => (s || '').toString().trim().toLowerCase().replace(/\s+/g, '');
    if (body.type !== 'return') {
      if (body.invoiceNo && body.invoiceNo.trim() && body.total) {
        const dup = data.entries.find(e =>
          e.invoiceNo && normalize(e.invoiceNo) === normalize(body.invoiceNo) &&
          Math.abs((e.total||0)-(body.total||0)) < 0.5 &&
          normalize(e.supplier||e.desc||'') === normalize(body.supplier||body.desc||'')
        );
        if (dup) return sendJSON(res, { error: `⚠️ الفاتورة رقم ${body.invoiceNo} بنفس المبلغ والمورد مسجلة مسبقاً` });
      }
    }
    const entry = { ...body, id: data.nextId++ };
    if (body.b64Image) {
      const isPdf = body.isPdf || false;
      try { entry.imageUrl = await uploadToCloudinary(body.b64Image, isPdf); entry.isPdf = isPdf; }
      catch(e) { console.error('Upload failed:', e.message); }
      delete entry.b64Image;
    }
    await addEntry(entry);
    await saveConfig(data);
    return sendJSON(res, { ok: true, entry });
  }
  if (pathname.match(/\/api\/entries\/\d+\/reject/) && req.method === 'POST') {
    const id = parseInt(pathname.split('/')[3]);
    const { rejected } = await parseBody(req);
    await updateEntry(id, { rejected: !!rejected });
    return sendJSON(res, { ok: true });
  }
  // ── PATCH: تعديل فاتورة ──
  if (pathname.match(/^\/api\/entries\/\d+$/) && req.method === 'PATCH') {
    const entryId = parseInt(pathname.split('/')[3]);
    const body = await parseBody(req);
    const data = await loadDB();
    const idx = data.entries.findIndex(e => e.id === entryId);
    if (idx === -1) return sendJSON(res, { error: 'الفاتورة غير موجودة' }, 404);
    const updated = { ...data.entries[idx], ...body };
    await db.collection('entries').updateOne({ id: entryId }, { $set: updated });
    return sendJSON(res, { ok: true });
  }
  if (pathname.match(/^\/api\/entries\/\d+$/) && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/')[3]);
    await deleteEntry(id);
    return sendJSON(res, { ok: true });
  }
  if (pathname === '/api/supervisors' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = await loadDB();
    data.supervisors.push({ id: Date.now(), name: body.name, budget: 0, password: body.password || '1234', visa: body.visa || '' });
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }
  if (pathname.match(/\/api\/supervisors\/\d+\/budget/) && req.method === 'POST') {
    const id = parseInt(pathname.split('/')[3]);
    const { amount } = await parseBody(req);
    const data = await loadDB();
    const sup = data.supervisors.find(s => s.id === id);
    if (!sup) return sendJSON(res, { error: 'مشرف غير موجود' }, 404);
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return sendJSON(res, { error: 'مبلغ غير صحيح' }, 400);
    sup.budget += amt;
    await saveConfig(data);
    return sendJSON(res, { ok: true, newBudget: sup.budget });
  }
  if (pathname.startsWith('/api/supervisors/') && !pathname.includes('/budget') && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/').pop());
    const data = await loadDB();
    data.supervisors = data.supervisors.filter(s => s.id !== id);
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }
  if (pathname === '/api/projects' && req.method === 'POST') {
    const { name } = await parseBody(req);
    const data = await loadDB();
    if (name && !data.projects.includes(name)) data.projects.push(name);
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }
  if (pathname.startsWith('/api/projects/') && req.method === 'DELETE') {
    const name = decodeURIComponent(pathname.split('/').pop());
    const data = await loadDB();
    data.projects = data.projects.filter(p => p !== name);
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }
  if (pathname === '/api/upload-image' && req.method === 'POST') {
    try {
      const { b64 } = await parseBody(req);
      if (!b64) return sendJSON(res, { error: 'لا توجد صورة' }, 400);
      const imgUrl = await uploadToCloudinary(b64);
      return sendJSON(res, { ok: true, url: imgUrl });
    } catch(e) { return sendJSON(res, { error: 'فشل رفع الصورة: ' + e.message }, 500); }
  }
  if (pathname === '/api/contracts' && req.method === 'POST') {
    try {
      const { contracts } = await parseBody(req);
      await db.collection('config').updateOne({ _id: 'main' }, { $set: { contracts: contracts || [] } }, { upsert: true });
      return sendJSON(res, { ok: true });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (pathname === '/api/contracts' && req.method === 'GET') {
    try {
      const cfg = await db.collection('config').findOne({ _id: 'main' });
      return sendJSON(res, { contracts: cfg?.contracts || [] });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (pathname === '/api/sales' && req.method === 'POST') {
    try {
      const { sales } = await parseBody(req);
      await db.collection('config').updateOne({ _id: 'main' }, { $set: { sales: sales || [] } }, { upsert: true });
      return sendJSON(res, { ok: true });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (pathname === '/api/sales' && req.method === 'GET') {
    try {
      const cfg = await db.collection('config').findOne({ _id: 'main' });
      return sendJSON(res, { sales: cfg?.sales || [] });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (pathname === '/api/sales-returns' && req.method === 'POST') {
    try {
      const { returns } = await parseBody(req);
      await db.collection('config').updateOne({_id:'main'},{$set:{salesReturns:returns||[]}},{upsert:true});
      return sendJSON(res, { ok: true });
    } catch(e){ return sendJSON(res,{error:e.message},500); }
  }
  if (pathname === '/api/sales-returns' && req.method === 'GET') {
    try {
      const cfg = await db.collection('config').findOne({_id:'main'});
      return sendJSON(res, { returns: cfg?.salesReturns||[] });
    } catch(e){ return sendJSON(res,{error:e.message},500); }
  }
  if (pathname === '/api/analyze-transfer' && req.method === 'POST') {
    if (!API_KEY) return sendJSON(res, { error: 'ANTHROPIC_API_KEY غير موجود' }, 500);
    try {
      const { b64, isPdf } = await parseBody(req);
      const { default: https } = await import('https');
      const prompt = 'هذا إيصال حوالة بنكية أو تحويل مالي. استخرج فقط: المبلغ المحول (total كرقم)، تاريخ التحويل (date بصيغة YYYY-MM-DD)، رقم المرجع (invoiceNo)، اسم البنك (supplier). أخرج JSON نقي فقط.';
      const content = b64 ? (isPdf ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: prompt }] : [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: prompt }]) : [{ type: 'text', text: prompt }];
      const result = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content }] });
        const r2 = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, res2 => {
          let data = ''; res2.on('data', d => data += d);
          res2.on('end', () => { try { const json = JSON.parse(data); if (json.error) return reject(new Error(json.error.message)); const raw = json.content.map(x => x.text || '').join(''); const match = raw.match(/\{[\s\S]*\}/); if (!match) return reject(new Error('لم يُستخرج JSON')); const parsed = JSON.parse(match[0]); parsed.total = parseFloat(String(parsed.total || '0').replace(/[^0-9.]/g, '')) || 0; if (!parsed.date) parsed.date = new Date().toISOString().split('T')[0]; resolve(parsed); } catch (e) { reject(e); } });
        }); r2.on('error', reject); r2.write(body); r2.end();
      });
      return sendJSON(res, result);
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (pathname === '/api/analyze' && req.method === 'POST') {
    if (!API_KEY) return sendJSON(res, { error: 'ANTHROPIC_API_KEY غير موجود' }, 500);
    try {
      const { b64, text, isPdf } = await parseBody(req);
      const result = await analyzeInvoice(b64 || null, text || '', isPdf);
      return sendJSON(res, result);
    } catch (e) {
      console.error('❌ /api/analyze error:', e.message);
      if(e.message && e.message.includes('Overloaded')){
        try {
          await new Promise(r=>setTimeout(r,3000));
          const { b64, text, isPdf } = await parseBody(req).catch(()=>({b64:null,text:'',isPdf:false}));
          const result2 = await analyzeInvoice(b64||null, text||'', isPdf);
          return sendJSON(res, result2);
        } catch(e2) { return sendJSON(res, { error: 'السيرفر مشغول — حاول مرة أخرى بعد قليل' }, 503); }
      }
      return sendJSON(res, { error: e.message }, 500);
    }
  }
  if (pathname === '/api/workers' && req.method === 'POST') {
    const { name, jobTitle } = await parseBody(req);
    const data = await loadDB();
    if (!data.companyWorkers) data.companyWorkers = [];
    data.companyWorkers.push({ id: Date.now(), name, jobTitle: jobTitle || '' });
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }
  if (pathname.startsWith('/api/workers/') && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/').pop());
    const data = await loadDB();
    data.companyWorkers = (data.companyWorkers || []).filter(w => w.id !== id);
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }
  if (pathname === '/api/labor-rates' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = await loadDB();
    data.laborRates = { company: parseFloat(body.company)||100, external: parseFloat(body.external)||150 };
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }
  if (pathname === '/api/labor-waiting' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = await loadDB();
    const todayDate = new Date().toISOString().split('T')[0];
    const entry = { id: Date.now(), supId: 0, supName: 'المدير', project: body.project || '', type: 'labor_waiting', desc: `عمالة انتظار ${body.date || todayDate}`, date: body.date || todayDate, total: 0, laborDetails: { companyCount: (body.presentWorkers||[]).length, externalCount: (body.externalWorkersList||[]).length, laborTotal: 0, presentWorkers: body.presentWorkers || [], externalWorkersList: body.externalWorkersList || [], isWaiting: true } };
    const dup = data.entries.find(e => e.type === 'labor_waiting' && e.date === entry.date && e.project === entry.project);
    if (dup) return sendJSON(res, { error: 'تم تسجيل عمالة انتظار لهذا المشروع في نفس اليوم' }, 400);
    await addEntry(entry);
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }
  if (pathname === '/api/labor' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = await loadDB();
    const rates = data.laborRates || { company: 100, external: 150 };
    const presentWorkers = body.presentWorkers || [];
    const externalWorkersList = body.externalWorkersList || [];
    const companyCount = presentWorkers.length;
    const externalCount = externalWorkersList.length;
    const externalTotal = externalCount * rates.external;
    const total = companyCount * rates.company + externalTotal;
    if (companyCount + externalCount === 0) return sendJSON(res, { error: 'أدخل عمالاً للتسجيل' }, 400);
    const todayDate = new Date().toISOString().split('T')[0];
    try {
      const todayAll = data.entries.filter(e => e.type === 'labor' && e.date === todayDate);
      const allCompany = [], allExternal = [];
      todayAll.forEach(e => {
        if(e.laborDetails && e.laborDetails.presentWorkers) e.laborDetails.presentWorkers.forEach(w => allCompany.push(w.name));
        if(e.laborDetails && e.laborDetails.externalWorkersList) e.laborDetails.externalWorkersList.forEach(w => allExternal.push(w.name));
      });
      const dupC = presentWorkers.filter(w => allCompany.includes(w.name));
      if(dupC.length > 0) return sendJSON(res, { error: '⚠️ هؤلاء العمال مسجلون اليوم: ' + dupC.map(w=>w.name).join('، ') });
      const dupE = externalWorkersList.filter(w => allExternal.includes(w.name));
      if(dupE.length > 0) return sendJSON(res, { error: '⚠️ هؤلاء العمال مسجلون اليوم: ' + dupE.map(w=>w.name).join('، ') });
    } catch(dupErr) { console.error('Dup check error:', dupErr.message); }
    const sup = data.supervisors.find(s => s.id == body.supId);
    const entry = { id: data.nextId++, supId: parseInt(body.supId), supName: sup ? sup.name : '', project: body.project || '', type: 'labor', desc: `عمالة ${todayDate}`, supplier: '', invoiceNo: 'LAB-' + Date.now(), date: todayDate, payMethod: 'cash', subtotal: externalTotal, taxRate: 0, taxAmt: 0, total: externalTotal, items: [...presentWorkers.map(w => ({ desc: w.name, qty: 1, unit: 'يوم', unitPrice: rates.company, total: rates.company, type: 'company' })), ...externalWorkersList.map(w => ({ desc: `${w.name} - ${w.jobTitle}`, qty: 1, unit: 'يوم', unitPrice: rates.external, total: rates.external, type: 'external' }))], laborDetails: { presentWorkers, externalWorkersList, companyCount, externalCount, companyRate: rates.company, externalRate: rates.external, laborTotal: total, companyNames: presentWorkers.map(w=>w.name).join('، '), externalNames: externalWorkersList.map(w=>`${w.name} (${w.jobTitle})`).join('، ') } };
    await addEntry(entry);
    await saveConfig(data);
    return sendJSON(res, { ok: true, entry, total });
  }
  if (pathname === '/api/transfer' && req.method === 'POST') {
    const { fromId, toId, amount, note } = await parseBody(req);
    const data = await loadDB();
    const fromSup = data.supervisors.find(s => s.id == fromId);
    const toSup = data.supervisors.find(s => s.id == toId);
    if (!fromSup || !toSup) return sendJSON(res, { error: 'مشرف غير موجود' }, 400);
    if (fromId == toId) return sendJSON(res, { error: 'لا يمكن التحويل لنفس المشرف' }, 400);
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return sendJSON(res, { error: 'المبلغ غير صحيح' }, 400);
    const today = new Date().toISOString().split('T')[0];
    const trf = 'TRF-' + Date.now();
    await addEntry({ id: data.nextId++, supId: parseInt(fromId), supName: fromSup.name, project: 'تحويل داخلي', type: 'transfer', direction: 'out', desc: `تحويل إلى ${toSup.name}`, supplier: '', invoiceNo: trf, date: today, payMethod: 'transfer', subtotal: amt, taxRate: 0, taxAmt: 0, total: amt, items: [], transferTo: toSup.name, transferNote: note || '' });
    await addEntry({ id: data.nextId++, supId: parseInt(toId), supName: toSup.name, project: 'تحويل داخلي', type: 'transfer', direction: 'in', desc: `تحويل من ${fromSup.name}`, supplier: '', invoiceNo: trf+'-IN', date: today, payMethod: 'transfer', subtotal: amt, taxRate: 0, taxAmt: 0, total: amt, items: [], transferFrom: fromSup.name, transferNote: note || '' });
    await saveConfig(data);
    return sendJSON(res, { ok: true, message: `تم تحويل ${amt} ﷼ من ${fromSup.name} إلى ${toSup.name}` });
  }
  // Manager withdrawals
  if (pathname === '/api/owner-withdrawals' && req.method === 'POST') {
    try {
      const { withdrawals } = await parseBody(req);
      await db.collection('config').updateOne({_id:'main'},{$set:{ownerWithdrawals:withdrawals||[]}},{upsert:true});
      return sendJSON(res, { ok: true });
    } catch(e){ return sendJSON(res, { error: e.message }, 500); }
  }
  if (pathname === '/api/owner-withdrawals' && req.method === 'GET') {
    try {
      const cfg = await db.collection('config').findOne({_id:'main'});
      return sendJSON(res, { withdrawals: cfg?.ownerWithdrawals||[] });
    } catch(e){ return sendJSON(res, { error: e.message }, 500); }
  }

  if (pathname === '/api/backup' && req.method === 'GET') {
    const data = await loadDB();
    const timestamp = new Date().toISOString().split('T')[0];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Disposition': `attachment; filename="kayan_backup_${timestamp}.json"` });
    return res.end(JSON.stringify(data, null, 2));
  }
  if (pathname === '/api/restore' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body.supervisors || !body.projects) return sendJSON(res, { error: 'ملف غير صحيح' }, 400);
      if (!body.managerPassword) body.managerPassword = 'admin123';
      if (db) {
        await db.collection('entries').deleteMany({});
        if (body.entries && body.entries.length > 0) await db.collection('entries').insertMany(body.entries);
      }
      await saveConfig(body);
      return sendJSON(res, { ok: true, message: 'تم الاستعادة', entries: body.entries ? body.entries.length : 0, supervisors: body.supervisors.length });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (pathname === '/api/export' && req.method === 'GET') {
    const data = await loadDB();
    const xml = generateExcel(data);
    res.writeHead(200, { 'Content-Type': 'application/vnd.ms-excel', 'Content-Disposition': 'attachment; filename="expenses.xls"', 'Access-Control-Allow-Origin': '*' });
    return res.end(xml);
  }
  if (pathname === '/manifest.json') {
    const f = path.join(__dirname, 'manifest.json');
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); return res.end(fs.readFileSync(f, 'utf8')); }
  }
  if (pathname === '/sw.js') {
    const f = path.join(__dirname, 'sw.js');
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(fs.readFileSync(f, 'utf8')); }
  }
  if (pathname === '/icon-192.png' || pathname === '/icon-512.png') {
    const f = path.join(__dirname, pathname.replace('/', '') + '.b64');
    if (fs.existsSync(f)) { const buf = Buffer.from(fs.readFileSync(f, 'utf8'), 'base64'); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(buf); }
  }
  if (pathname === '/api/attendance' && req.method === 'GET') {
    const data = await loadDB();
    const query = url.parse(req.url, true).query;
    const month = parseInt(query.month) || new Date().getMonth();
    const year = parseInt(query.year) || new Date().getFullYear();
    const laborEntries = data.entries.filter(e => {
      if (e.type !== 'labor' && e.type !== 'labor_waiting') return false;
      const d = new Date(e.date);
      return d.getMonth() === month && d.getFullYear() === year;
    });
    const workerDays = {};
    laborEntries.forEach(e => {
      if (e.laborDetails && e.laborDetails.presentWorkers) {
        e.laborDetails.presentWorkers.forEach(w => {
          if (!workerDays[w.name]) workerDays[w.name] = new Set();
          workerDays[w.name].add(e.date);
        });
      }
    });
    const workDays = 26;
    const employees = Object.entries(workerDays).map(([name, dates]) => ({ name, present_days: dates.size, absent_days: Math.max(0, workDays - dates.size), late_minutes: 0, notes: '' }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ month: ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'][month], year, work_days: workDays, employees }));
  }
  // HTML fallback
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
});

connectMongo().then(() => {
  server.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
});
