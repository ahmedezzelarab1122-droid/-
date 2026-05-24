const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DB_FILE = path.join(__dirname, 'data.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
  return {
    supervisors: [
      { id: 1, name: 'أحمد العتيبي', budget: 5000 },
      { id: 2, name: 'محمد القحطاني', budget: 4000 },
      { id: 3, name: 'خالد الشهري', budget: 6000 }
    ],
    projects: ['مشروع الرياض', 'مشروع جدة', 'مشروع الدمام'],
    entries: [],
    nextId: 1
  };
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

async function analyzeInvoice(b64, text) {
  const { default: https } = await import('https');
  const prompt = `أنت خبير محاسبة. استخرج كل بيانات الفاتورة أو المصروف وأرجعها كـ JSON نقي فقط بدون أي نص أو markdown:
{"desc":"وصف المصروف","type":"petty أو tax أو other","supplier":"اسم المورد أو null","invoiceNo":"رقم الفاتورة أو null","date":"YYYY-MM-DD أو null","payMethod":"cash أو transfer","subtotal":رقم,"taxRate":رقم,"taxAmt":رقم,"total":رقم,"items":[{"desc":"البند","qty":رقم,"unit":"الوحدة","unitPrice":رقم,"total":رقم}]}
petty=أكل/مياه/قهوة/وقود/يومي. tax=فاتورة ضريبية رسمية أو مواد بناء. إذا لا ضريبة: taxRate=0,taxAmt=0,total=subtotal. إذا لا بنود items=[]. أرقام بدون فواصل.${text ? '\nنص: ' + text : ''}`;

  const content = b64
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: prompt }]
    : [{ type: 'text', text: prompt }];

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1200, messages: [{ role: 'user', content }] });
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
          if (!match) return reject(new Error('لم يتم استخراج JSON'));
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

function sendHTML(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // API routes
  if (pathname === '/api/db' && req.method === 'GET') return sendJSON(res, loadDB());

  if (pathname === '/api/entries' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = loadDB();
    const entry = { ...body, id: db.nextId++ };
    db.entries.push(entry);
    saveDB(db);
    return sendJSON(res, { ok: true, entry });
  }

  if (pathname.startsWith('/api/entries/') && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/').pop());
    const db = loadDB();
    db.entries = db.entries.filter(e => e.id !== id);
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  if (pathname === '/api/supervisors' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = loadDB();
    db.supervisors.push({ id: Date.now(), ...body });
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  if (pathname.startsWith('/api/supervisors/') && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/').pop());
    const db = loadDB();
    db.supervisors = db.supervisors.filter(s => s.id !== id);
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  if (pathname === '/api/projects' && req.method === 'POST') {
    const { name } = await parseBody(req);
    const db = loadDB();
    if (name && !db.projects.includes(name)) db.projects.push(name);
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  if (pathname.startsWith('/api/projects/') && req.method === 'DELETE') {
    const name = decodeURIComponent(pathname.split('/').pop());
    const db = loadDB();
    db.projects = db.projects.filter(p => p !== name);
    saveDB(db);
    return sendJSON(res, { ok: true });
  }

  if (pathname === '/api/analyze' && req.method === 'POST') {
    if (!API_KEY) return sendJSON(res, { error: 'ANTHROPIC_API_KEY غير موجود في البيئة' }, 500);
    try {
      const { b64, text } = await parseBody(req);
      const result = await analyzeInvoice(b64 || null, text || '');
      return sendJSON(res, result);
    } catch (e) {
      return sendJSON(res, { error: e.message }, 500);
    }
  }

  // Serve main HTML
  sendHTML(res, getHTML());
});

server.listen(PORT, () => console.log(`✅ التطبيق يعمل على http://localhost:${PORT}`));

function getHTML() { return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'); }
