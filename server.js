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

// ── MongoDB Connection ────────────────────────────────
const { MongoClient } = require('mongodb');
let mongoClient = null;
let db = null;

async function connectMongo() {
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db('kayan_expenses');
    console.log('✅ MongoDB connected');
    // Init default data if empty
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
      console.log('✅ Default data created');
    }
  } catch (e) {
    console.error('❌ MongoDB error:', e.message);
  }
}

async function loadDB() {
  if (!db) return getFallback();
  try {
    const cfg = await db.collection('config').findOne({ _id: 'main' });
    const entries = await db.collection('entries').find({}).toArray();
    return {
      supervisors: (cfg.supervisors || []).map(s=>({...s, budget: s.budget||0})),
      projects: cfg.projects || [],
      managerPassword: cfg.managerPassword || 'admin123',
      nextId: cfg.nextId || 1,
      laborRates: cfg.laborRates || { company: 100, external: 150 },
      companyWorkers: cfg.companyWorkers || [],
      ownerPassword: cfg.ownerPassword || 'owner123',
      entries: entries.map(e => { const { _id, ...rest } = e; return rest; })
    };
  } catch (e) {
    console.error('loadDB error:', e.message);
    return getFallback();
  }
}

async function saveConfig(data) {
  if (!db) return;
  try {
    await db.collection('config').updateOne(
      { _id: 'main' },
      { $set: { 
        supervisors: data.supervisors, 
        projects: data.projects, 
        managerPassword: data.managerPassword, 
        nextId: data.nextId,
        laborRates: data.laborRates || { company: 100, external: 150 },
        companyWorkers: data.companyWorkers || [],
        ownerPassword: data.ownerPassword || 'owner123'
      }},
      { upsert: true }
    );
  } catch (e) { console.error('saveConfig error:', e.message); }
}

async function addEntry(entry) {
  if (!db) return;
  try { await db.collection('entries').insertOne(entry); } catch (e) { console.error('addEntry error:', e.message); }
}

async function deleteEntry(id) {
  if (!db) return;
  try { await db.collection('entries').deleteOne({ id: id }); } catch (e) { console.error('deleteEntry error:', e.message); }
}

function getFallback() {
  return { supervisors: [{ id: 1, name: 'المشرف', budget: 10000, password: '1234' }], projects: ['المشروع الأول'], entries: [], managerPassword: 'admin123', nextId: 1 };
}

// ── AI Analysis ───────────────────────────────────────
async function analyzeInvoice(b64, text, isPdf=false) {
  const { default: https } = await import('https');
  const prompt = `أنت خبير محاسبة سعودي متخصص في تصنيف الفواتير. مهمتك الأساسية التمييز بدقة بين نوعين من الفواتير.

## قاعدة التصنيف الأساسية:

### فاتورة ضريبية (tax) — يجب توفر واحد أو أكثر:
- حجمها A4 أو قريب منه
- مطبوعة من نظام محاسبي أو كمبيوتر
- تحتوي على رقم ضريبي للمورد (VAT Number / الرقم الضريبي)
- مكتوب عليها "فاتورة ضريبية" أو "Tax Invoice"
- تحتوي على خانة VAT أو ضريبة القيمة المضافة
- اسم العميل "كيان وبناء" أو الرقم الضريبي 31130575740003

### فاتورة نثرية (petty) — كل ما عدا ذلك:
- إيصال صغير الحجم
- مكتوبة بخط اليد
- إيصال من محل أو بقالة أو مطعم
- لا يوجد رقم ضريبي
- لا يوجد اسم شركة رسمي

## ملاحظة مهمة:
- إذا كانت الفاتورة مكتوبة بخط اليد → نثرية دائماً
- إذا كانت إيصال صغير → نثرية دائماً
- إذا كانت A4 مطبوعة مع رقم ضريبي → ضريبية دائماً
- الشك → نثرية (الأكثر أماناً)

## قراءة الأرقام:
- الفاصلة في الأرقام = عشرية: 26,15 → 26.15
- Net Total أو الصافي = total
- Total Excluding VAT = subtotal
- VAT 15% = taxAmt

## قراءة البنود:
اقرأ عمود البيان أو Description حرفياً. لا تكتب "صنية" أو "بند".

## الإخراج JSON نقي فقط:
{"desc":"اسم المورد فقط","type":"petty أو tax","supplier":"اسم المورد","invoiceNo":"رقم الفاتورة أو null","date":"YYYY-MM-DD","payMethod":"cash أو transfer","subtotal":رقم,"taxRate":رقم,"taxAmt":رقم,"total":رقم,"items":[{"desc":"اسم البند الحقيقي","qty":رقم,"unit":"الوحدة","unitPrice":رقم,"total":رقم}]}

إذا لا ضريبة: taxRate=0, taxAmt=0, total=subtotal
إذا لا بنود: items=[]
${text ? '\nنص إضافي: ' + text : ''}\``;

  let mediaType = 'image/jpeg';
  if (isPdf) mediaType = 'application/pdf';
  
  const content = b64
    ? isPdf
      ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: prompt }]
      : [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: prompt }]
    : [{ type: 'text', text: prompt }];

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 1500, messages: [{ role: 'user', content }] });
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
          const match = raw.match(/\{[\s\S]*\}/);
          if (!match) return reject(new Error('لم يُستخرج JSON'));
          let parsed = JSON.parse(match[0]);
          // Fix numbers
          const fixNum = v => { if (typeof v === 'string') { v = v.replace(/,/g, '.').replace(/[^0-9.]/g, ''); } return parseFloat(v) || 0; };
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


// ── Cloudinary Upload ─────────────────────────────────
async function uploadToCloudinary(b64, isPdf=false) {
  const { default: https } = await import('https');
  
  const UPLOAD_PRESET = 'kayan_invoices';
  const boundary = 'CloudinaryBoundary' + Date.now();
  const fileData = Buffer.from(b64, 'base64');
  const fileName = isPdf ? 'invoice.pdf' : 'invoice.jpg';
  const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';
  const resourceType = isPdf ? 'raw' : 'image';
  
  const textField = (name, value) => 
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  
  const filePart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  
  const body = Buffer.concat([
    textField('upload_preset', UPLOAD_PRESET),
    filePart,
    fileData,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  
  // Use correct resource type path
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUDINARY_CLOUD}/${resourceType}/upload`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.secure_url) resolve(json.secure_url);
          else reject(new Error(json.error?.message || JSON.stringify(json)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Helpers ────────────────────────────────────────────
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

// ── Excel Export ────────────────────────────────────────
function generateExcel(dbData) {
  const supMap = {};
  dbData.supervisors.forEach(s => supMap[s.id] = s.name);
  const rows = dbData.entries.map(e => {
    const itemsDesc = (e.items && e.items.length > 0)
      ? e.items.map(it => it.desc + ' (' + it.qty + ' ' + it.unit + ')').join(' | ')
      : (e.desc || '');
    return `<Row>
      <Cell><Data ss:Type="Number">${e.id}</Data></Cell>
      <Cell><Data ss:Type="String">${supMap[e.supId] || ''}</Data></Cell>
      <Cell><Data ss:Type="String">${e.project || ''}</Data></Cell>
      <Cell><Data ss:Type="String">${e.type === 'petty' ? 'نثرية' : e.type === 'tax' ? 'ضريبية' : 'أخرى'}</Data></Cell>
      <Cell><Data ss:Type="String">${itemsDesc}</Data></Cell>
      <Cell><Data ss:Type="String">${e.supplier || ''}</Data></Cell>
      <Cell><Data ss:Type="String">${e.invoiceNo || ''}</Data></Cell>
      <Cell><Data ss:Type="String">${e.date || ''}</Data></Cell>
      <Cell><Data ss:Type="String">${e.payMethod === 'cash' ? 'كاش' : 'تحويل'}</Data></Cell>
      <Cell><Data ss:Type="Number">${e.subtotal || 0}</Data></Cell>
      <Cell><Data ss:Type="Number">${e.taxRate || 0}</Data></Cell>
      <Cell><Data ss:Type="Number">${e.taxAmt || 0}</Data></Cell>
      <Cell><Data ss:Type="Number">${e.total || 0}</Data></Cell>
    </Row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel">
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
    <PageSetup>
      <Layout x:Orientation="Landscape"/>
    </PageSetup>
  </WorksheetOptions>
  <Worksheet ss:Name="المصروفات" ss:RightToLeft="1">
    <Table>
      <Row>
        <Cell><Data ss:Type="String">الرقم</Data></Cell>
        <Cell><Data ss:Type="String">المشرف</Data></Cell>
        <Cell><Data ss:Type="String">المشروع</Data></Cell>
        <Cell><Data ss:Type="String">النوع</Data></Cell>
        <Cell><Data ss:Type="String">الوصف</Data></Cell>
        <Cell><Data ss:Type="String">المورد</Data></Cell>
        <Cell><Data ss:Type="String">رقم الفاتورة</Data></Cell>
        <Cell><Data ss:Type="String">التاريخ</Data></Cell>
        <Cell><Data ss:Type="String">طريقة الدفع</Data></Cell>
        <Cell><Data ss:Type="String">قبل الضريبة</Data></Cell>
        <Cell><Data ss:Type="String">نسبة الضريبة%</Data></Cell>
        <Cell><Data ss:Type="String">مبلغ الضريبة</Data></Cell>
        <Cell><Data ss:Type="String">الإجمالي</Data></Cell>
      </Row>
      ${rows}
    </Table>
  </Worksheet>
</Workbook>`;
}

// ── Server ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // Login
  if (pathname === '/api/login' && req.method === 'POST') {
    const { role, password, supId } = await parseBody(req);
    const data = await loadDB();
    if (role === 'owner') {
      const ownerPass = data.ownerPassword || 'owner123';
      if (password === ownerPass) return sendJSON(res, { ok: true, role: 'owner', name: 'المالك' });
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

  // Get DB
  if (pathname === '/api/db' && req.method === 'GET') {
    const data = await loadDB();
    const safe = { ...data, supervisors: data.supervisors.map(s => ({ id: s.id, name: s.name, budget: s.budget, visa: s.visa || '' })), laborRates: data.laborRates || { company: 100, external: 150 }, companyWorkers: data.companyWorkers || [] };
    delete safe.managerPassword;
    return sendJSON(res, safe);
  }

  // Update passwords
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

  // Add entry
  if (pathname === '/api/entries' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = await loadDB();
    const normalize = s => (s || '').toString().trim().toLowerCase().replace(/\s+/g, '');
    // Duplicate check by invoice number
    if (body.invoiceNo && body.invoiceNo.trim()) {
      const dup = data.entries.find(e => e.invoiceNo && normalize(e.invoiceNo) === normalize(body.invoiceNo));
      if (dup) return sendJSON(res, { error: `⚠️ الفاتورة رقم ${body.invoiceNo} مسجلة مسبقاً بتاريخ ${dup.date}` });
    }
    // Duplicate check by supplier + total + date
    if (body.supplier && body.total && body.date) {
      const dup2 = data.entries.find(e => normalize(e.supplier) === normalize(body.supplier) && Math.abs((e.total||0)-(body.total||0)) < 0.1 && e.date === body.date);
      if (dup2) return sendJSON(res, { error: `⚠️ يبدو أن هذه الفاتورة مسجلة مسبقاً — نفس المورد والمبلغ والتاريخ` });
    }
    const entry = { ...body, id: data.nextId++ };
    // Handle file upload - both images and PDFs go to Cloudinary
    if (body.b64Image) {
      const isPdf = body.isPdf || false;
      console.log('Uploading to Cloudinary, isPdf:', isPdf, 'size:', body.b64Image.length);
      try {
        entry.imageUrl = await uploadToCloudinary(body.b64Image, isPdf);
        entry.isPdf = isPdf;
        console.log('Uploaded:', entry.imageUrl);
      } catch(e) { 
        console.error('Upload failed:', e.message);
      }
      delete entry.b64Image;
    }
    await addEntry(entry);
    await saveConfig(data);
    return sendJSON(res, { ok: true, entry });
  }

  // Delete entry
  if (pathname.startsWith('/api/entries/') && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/').pop());
    await deleteEntry(id);
    return sendJSON(res, { ok: true });
  }

  // Add supervisor
  if (pathname === '/api/supervisors' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = await loadDB();
    data.supervisors.push({ id: Date.now(), name: body.name, budget: body.budget, password: body.password || '1234', visa: body.visa || '' });
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }

  // Add budget to supervisor
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

  // Delete supervisor
  if (pathname.startsWith('/api/supervisors/') && !pathname.includes('/budget') && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/').pop());
    const data = await loadDB();
    data.supervisors = data.supervisors.filter(s => s.id !== id);
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }

  // Add project
  if (pathname === '/api/projects' && req.method === 'POST') {
    const { name } = await parseBody(req);
    const data = await loadDB();
    if (name && !data.projects.includes(name)) data.projects.push(name);
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }

  // Delete project
  if (pathname.startsWith('/api/projects/') && req.method === 'DELETE') {
    const name = decodeURIComponent(pathname.split('/').pop());
    const data = await loadDB();
    data.projects = data.projects.filter(p => p !== name);
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }


  // Upload invoice image to Cloudinary
  if (pathname === '/api/upload-image' && req.method === 'POST') {
    try {
      const { b64 } = await parseBody(req);
      if (!b64) return sendJSON(res, { error: 'لا توجد صورة' }, 400);
      const url = await uploadToCloudinary(b64);
      return sendJSON(res, { ok: true, url });
    } catch(e) {
      console.error('Cloudinary error:', e.message);
      return sendJSON(res, { error: 'فشل رفع الصورة: ' + e.message }, 500);
    }
  }

  // Analyze invoice
  if (pathname === '/api/analyze' && req.method === 'POST') {
    if (!API_KEY) return sendJSON(res, { error: 'ANTHROPIC_API_KEY غير موجود' }, 500);
    try {
      const { b64, text, isPdf } = await parseBody(req);
      const result = await analyzeInvoice(b64 || null, text || '', isPdf);
      return sendJSON(res, result);
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }



  // Get/Add/Delete company workers
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

  // Save labor rates
  if (pathname === '/api/labor-rates' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = await loadDB();
    data.laborRates = { company: parseFloat(body.company)||100, external: parseFloat(body.external)||150 };
    await saveConfig(data);
    return sendJSON(res, { ok: true });
  }

  // Add labor entry
  if (pathname === '/api/labor' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = await loadDB();
    const rates = data.laborRates || { company: 100, external: 150 };
    const presentWorkers = body.presentWorkers || []; // [{id, name}]
    const externalWorkersList = body.externalWorkersList || []; // [{name, jobTitle}]
    const companyCount = presentWorkers.length;
    const externalCount = externalWorkersList.length;
    const companyTotal = companyCount * rates.company;
    const externalTotal = externalCount * rates.external;
    const total = companyTotal + externalTotal;
    
    if (companyCount + externalCount === 0) return sendJSON(res, { error: 'أدخل عمالاً للتسجيل' }, 400);

    // منع تكرار العامل في نفس اليوم
    const todayDate = new Date().toISOString().split('T')[0];
    try {
      const todayAll = data.entries.filter(e => e.type === 'labor' && e.date === todayDate);
      const allCompany = [];
      const allExternal = [];
      todayAll.forEach(e => {
        if(e.laborDetails && e.laborDetails.presentWorkers) e.laborDetails.presentWorkers.forEach(w => allCompany.push(w.name));
        if(e.laborDetails && e.laborDetails.externalWorkersList) e.laborDetails.externalWorkersList.forEach(w => allExternal.push(w.name));
      });
      if(presentWorkers && presentWorkers.length > 0) {
        const dupC = presentWorkers.filter(w => allCompany.includes(w.name));
        if(dupC.length > 0) return sendJSON(res, { error: '⚠️ هؤلاء العمال مسجلون اليوم: ' + dupC.map(w=>w.name).join('، ') });
      }
      if(externalWorkersList && externalWorkersList.length > 0) {
        const dupE = externalWorkersList.filter(w => allExternal.includes(w.name));
        if(dupE.length > 0) return sendJSON(res, { error: '⚠️ هؤلاء العمال مسجلون اليوم: ' + dupE.map(w=>w.name).join('، ') });
      }
    } catch(dupErr) { console.error('Dup check error:', dupErr.message); }
    

    
    const sup = data.supervisors.find(s => s.id == body.supId);
    const today = todayDate;
    const companyNames = presentWorkers.map(w => w.name).join('، ');
    const externalNames = externalWorkersList.map(w => `${w.name} (${w.jobTitle})`).join('، ');
    const entry = {
      id: data.nextId++,
      supId: parseInt(body.supId),
      supName: sup ? sup.name : '',
      project: body.project || '',
      type: 'labor',
      desc: `عمالة ${today}`,
      supplier: '',
      invoiceNo: 'LAB-' + Date.now(),
      date: today,
      payMethod: 'cash',
      subtotal: externalTotal,
      taxRate: 0,
      taxAmt: 0,
      total: externalTotal,  // Only external workers deducted from budget
      items: [
        ...presentWorkers.map(w => ({ desc: w.name, qty: 1, unit: 'يوم', unitPrice: rates.company, total: rates.company, type: 'company' })),
        ...externalWorkersList.map(w => ({ desc: `${w.name} - ${w.jobTitle}`, qty: 1, unit: 'يوم', unitPrice: rates.external, total: rates.external, type: 'external' }))
      ],
      laborDetails: { 
        presentWorkers, externalWorkersList,
        companyCount, externalCount,
        companyRate: rates.company, externalRate: rates.external, 
        laborTotal: total,
        companyNames, externalNames
      }
    };
    
    await addEntry(entry);
    await saveConfig(data);
    return sendJSON(res, { ok: true, entry, total });
  }

  // Transfer between supervisors
  if (pathname === '/api/transfer' && req.method === 'POST') {
    const { fromId, toId, amount, note } = await parseBody(req);
    const data = await loadDB();
    const fromSup = data.supervisors.find(s => s.id == fromId);
    const toSup = data.supervisors.find(s => s.id == toId);
    if (!fromSup || !toSup) return sendJSON(res, { error: 'مشرف غير موجود' }, 400);
    if (fromId == toId) return sendJSON(res, { error: 'لا يمكن التحويل لنفس المشرف' }, 400);
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return sendJSON(res, { error: 'المبلغ غير صحيح' }, 400);
    const fromSpent = data.entries.filter(e => e.supId == fromId && e.type !== 'budget_add').reduce((a, e) => a + (e.total || 0), 0);
    const fromBalance = fromSup.budget - fromSpent;
    if (amt > fromBalance) return sendJSON(res, { error: `الرصيد غير كافٍ — المتبقي: ${fromBalance.toFixed(2)} ﷼` }, 400);
    const today = todayDate;
    const trf = 'TRF-' + Date.now();
    // OUT entry for sender
    const entryOut = { id: data.nextId++, supId: parseInt(fromId), supName: fromSup.name, project: 'تحويل داخلي', type: 'transfer', direction: 'out', desc: `تحويل إلى ${toSup.name}`, supplier: '', invoiceNo: trf, date: today, payMethod: 'transfer', subtotal: amt, taxRate: 0, taxAmt: 0, total: amt, items: [], transferTo: toSup.name, transferNote: note || '' };
    // IN entry for receiver
    const entryIn = { id: data.nextId++, supId: parseInt(toId), supName: toSup.name, project: 'تحويل داخلي', type: 'transfer', direction: 'in', desc: `تحويل من ${fromSup.name}`, supplier: '', invoiceNo: trf+'-IN', date: today, payMethod: 'transfer', subtotal: amt, taxRate: 0, taxAmt: 0, total: amt, items: [], transferFrom: fromSup.name, transferNote: note || '' };
    await addEntry(entryOut);
    await addEntry(entryIn);
    await saveConfig(data);
    return sendJSON(res, { ok: true, message: `تم تحويل ${amt} ﷼ من ${fromSup.name} إلى ${toSup.name}` });
  }

  // Backup
  if (pathname === '/api/backup' && req.method === 'GET') {
    const data = await loadDB();
    const timestamp = new Date().toISOString().split('T')[0];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Disposition': `attachment; filename="kayan_backup_${timestamp}.json"` });
    return res.end(JSON.stringify(data, null, 2));
  }

  // Restore backup
  if (pathname === '/api/restore' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body.supervisors || !body.projects) return sendJSON(res, { error: 'ملف غير صحيح' }, 400);
      if (!body.managerPassword) body.managerPassword = 'admin123';
      // Clear and restore entries
      if (db) {
        await db.collection('entries').deleteMany({});
        if (body.entries && body.entries.length > 0) await db.collection('entries').insertMany(body.entries);
      }
      await saveConfig(body);
      return sendJSON(res, { ok: true, message: 'تم الاستعادة', entries: body.entries ? body.entries.length : 0, supervisors: body.supervisors.length });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }

  // Export Excel
  if (pathname === '/api/export' && req.method === 'GET') {
    const data = await loadDB();
    const xml = generateExcel(data);
    res.writeHead(200, { 'Content-Type': 'application/vnd.ms-excel', 'Content-Disposition': 'attachment; filename="expenses.xls"', 'Access-Control-Allow-Origin': '*' });
    return res.end(xml);
  }

  // PWA files
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

  // HTML
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
});

// Start
connectMongo().then(() => {
  server.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
});
