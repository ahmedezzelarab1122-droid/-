const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DB_FILE = path.join(__dirname, 'data.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
  return {
    supervisors: [
      { id: 1, name: 'المشرف', budget: 10000, password: '1234' }
    ],
    projects: ['المشروع الأول'],
    entries: [],
    managerPassword: 'admin123',
    nextId: 1
  };
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

async function analyzeInvoice(b64, text) {
  const { default: https } = await import('https');
  const prompt = `أنت نظام OCR متخصص. اقرأ هذه الفاتورة بدقة شديدة.

## التصنيف:
- type="tax": تحتوي على "كيان وبناء" أو رقم ضريبي 31130575740003
- type="petty": لا تحتوي على ذلك

## حقل "desc" - مهم جداً:
- اكتب فقط: اسم المورد أو الشركة التي أصدرت الفاتورة
- مثال صحيح: "شركة المنصوري للتجارة" أو "مؤسسة محمد نورين التجارية" أو "محطة الدريس"
- مثال خاطئ: "مواد بناء - ازميل وسكين" أو "فاتورة ضريبية" — هذا خاطئ

## قراءة الأرقام:
- الفاصلة في الأرقام = عشرية: 26,15 → 26.15
- Total Amt With Tax = الإجمالي النهائي (total)
- Total Excluding VAT = قبل الضريبة (subtotal)
- Tax 15% = الضريبة (taxAmt)

## قراءة البنود:
ابحث عن جدول الأصناف. لكل سطر اقرأ عمود "اسم الصنف" أو "Item Name/Description" حرفياً:
- أمثلة صحيحة: "ازميل تكسيره 8ملي بوز"، "سكين معجون 6"، "متر 7 مثر اصفر"
- لا تكتب أبداً: "صنية" أو "بند" أو "منتج"

## الإخراج - JSON نقي فقط:
{"desc":"اسم المورد أو الشركة فقط","type":"petty أو tax","supplier":"اسم المورد كاملاً","invoiceNo":"رقم الفاتورة","date":"YYYY-MM-DD","payMethod":"cash أو transfer","subtotal":رقم,"taxRate":15,"taxAmt":رقم,"total":رقم,"items":[{"desc":"اسم الصنف الحقيقي","qty":رقم,"unit":"الوحدة","unitPrice":رقم,"total":رقم}]}

إذا لا ضريبة: taxRate=0, taxAmt=0, total=subtotal
إذا لا بنود: items=[]
${text ? '\nنص: ' + text : ''}\``;

  const content = b64
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: prompt }]
    : [{ type: 'text', text: prompt }];

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 1200, messages: [{ role: 'user', content }] });
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
          const parsed = JSON.parse(match[0]);
          if (!parsed.total) parsed.total = (parsed.subtotal || 0) + (parsed.taxAmt || 0);
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

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

// Generate Excel XML
function generateExcel(db) {
  const supMap = {};
  db.supervisors.forEach(s => supMap[s.id] = s.name);

  let rows = db.entries.map(e => {
    const itemsDesc = (e.items && e.items.length > 0)
      ? e.items.map(it => it.desc + ' (' + it.qty + ' ' + it.unit + ')').join(' | ')
      : (e.desc || '');
    return `
    <Row>
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
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="المصروفات">
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

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // Login
  if (pathname === '/api/login' && req.method === 'POST') {
    const { role, password, supId } = await parseBody(req);
    const db = loadDB();
    if (role === 'manager') {
      if (password === db.managerPassword) return sendJSON(res, { ok: true, role: 'manager', name: 'المدير' });
      return sendJSON(res, { ok: false, error: 'كلمة المرور خاطئة' }, 401);
    }
    if (role === 'supervisor') {
      const sup = db.supervisors.find(s => s.id === parseInt(supId));
      if (!sup) return sendJSON(res, { ok: false, error: 'المشرف غير موجود' }, 404);
      if (sup.password !== password) return sendJSON(res, { ok: false, error: 'كلمة المرور خاطئة' }, 401);
      return sendJSON(res, { ok: true, role: 'supervisor', name: sup.name, supId: sup.id, budget: sup.budget });
    }
    return sendJSON(res, { ok: false, error: 'بيانات خاطئة' }, 400);
  }

  // Get DB
  if (pathname === '/api/db' && req.method === 'GET') {
    const db = loadDB();
    // Don't send passwords to client
    const safe = { ...db, supervisors: db.supervisors.map(s => ({ id: s.id, name: s.name, budget: s.budget })) };
    delete safe.managerPassword;
    return sendJSON(res, safe);
  }

  // Update passwords
  if (pathname === '/api/passwords' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = loadDB();
    if (body.managerPassword) db.managerPassword = body.managerPassword;
    if (body.supervisors) {
      body.supervisors.forEach(({ id, password }) => {
        const sup = db.supervisors.find(s => s.id === id);
        if (sup && password) sup.password = password;
      });
    }
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  // Add entry
  if (pathname === '/api/entries' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = loadDB();
    
    // Check duplicate - by invoice number OR by (supplier + total + date)
    const normalize = s => (s || '').toString().trim().toLowerCase().replace(/\s+/g, '');
    
    // Check 1: same invoice number
    if (body.invoiceNo && body.invoiceNo.trim()) {
      const dup = db.entries.find(e =>
        e.invoiceNo && normalize(e.invoiceNo) === normalize(body.invoiceNo)
      );
      if (dup) {
        return sendJSON(res, {
          error: `⚠️ تنبيه: الفاتورة رقم ${body.invoiceNo} مسجلة مسبقاً بتاريخ ${dup.date}`
        }, 200);
      }
    }
    
    // Check 2: same supplier + total + date (even if invoice number differs)
    if (body.supplier && body.total && body.date) {
      const dup2 = db.entries.find(e =>
        normalize(e.supplier) === normalize(body.supplier) &&
        Math.abs((e.total || 0) - (body.total || 0)) < 0.1 &&
        e.date === body.date
      );
      if (dup2) {
        return sendJSON(res, {
          error: `⚠️ تنبيه: يبدو أن هذه الفاتورة مسجلة مسبقاً — نفس المورد والمبلغ والتاريخ (${dup2.date})`
        }, 200);
      }
    }
    
    const entry = { ...body, id: db.nextId++ };
    db.entries.push(entry);
    saveDB(db);
    return sendJSON(res, { ok: true, entry });
  }

  // Delete entry
  if (pathname.startsWith('/api/entries/') && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/').pop());
    const db = loadDB();
    db.entries = db.entries.filter(e => e.id !== id);
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  // Add supervisor
  if (pathname === '/api/supervisors' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = loadDB();
    db.supervisors.push({ id: Date.now(), name: body.name, budget: body.budget, password: body.password || '1234', visa: body.visa || '' });
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  // Delete supervisor
  if (pathname.startsWith('/api/supervisors/') && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/').pop());
    const db = loadDB();
    db.supervisors = db.supervisors.filter(s => s.id !== id);
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  // Add project
  if (pathname === '/api/projects' && req.method === 'POST') {
    const { name } = await parseBody(req);
    const db = loadDB();
    if (name && !db.projects.includes(name)) db.projects.push(name);
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  // Delete project
  if (pathname.startsWith('/api/projects/') && req.method === 'DELETE') {
    const name = decodeURIComponent(pathname.split('/').pop());
    const db = loadDB();
    db.projects = db.projects.filter(p => p !== name);
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  // Analyze invoice
  if (pathname === '/api/analyze' && req.method === 'POST') {
    if (!API_KEY) return sendJSON(res, { error: 'ANTHROPIC_API_KEY غير موجود' }, 500);
    try {
      const { b64, text } = await parseBody(req);
      const result = await analyzeInvoice(b64 || null, text || '');
      return sendJSON(res, result);
    } catch (e) {
      return sendJSON(res, { error: e.message }, 500);
    }
  }


  // Auto backup - save DB snapshot
  if (pathname === '/api/backup' && req.method === 'GET') {
    const db = loadDB();
    const timestamp = new Date().toISOString().split('T')[0];
    const backupFile = path.join(__dirname, `backup_${timestamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(db, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Disposition': `attachment; filename="kayan_backup_${timestamp}.json"` });
    return res.end(JSON.stringify(db, null, 2));
  }

  // Export Excel
  if (pathname === '/api/export' && req.method === 'GET') {
    const db = loadDB();
    const xml = generateExcel(db);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.ms-excel',
      'Content-Disposition': 'attachment; filename="expenses.xls"',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(xml);
  }

  // Serve PWA files
  // Serve icons
  if (pathname === '/icon-192.png') {
    const b64 = require('fs').readFileSync(path.join(__dirname, 'icon-192.b64'), 'utf8');
    const buf = Buffer.from(b64, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public,max-age=86400' });
    return res.end(buf);
  }
  if (pathname === '/icon-512.png') {
    const b64 = require('fs').readFileSync(path.join(__dirname, 'icon-512.b64'), 'utf8');
    const buf = Buffer.from(b64, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public,max-age=86400' });
    return res.end(buf);
  }
  if (pathname === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    return res.end(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  }
  if (pathname === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8'));
  }
  if (pathname === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8'));
  }

  // Serve HTML
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
});

server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
