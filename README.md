# نظام مصروفات المشرفين

## تشغيل التطبيق

### الطريقة 1 — على جهازك مباشرة

1. نزّل [Node.js](https://nodejs.org) إذا ما عندك
2. افتح CMD أو Terminal في مجلد التطبيق
3. اكتب الأمر التالي (ضع مفتاح Anthropic API):

**Windows:**
```
set ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
node server.js
```

**Mac / Linux:**
```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx node server.js
```

4. افتح المتصفح على: http://localhost:3000
5. أرسل الرابط لكل مشرف على الواتساب

---

### الطريقة 2 — استضافة مجانية على Render.com

1. ارفع المجلد على GitHub
2. اذهب لـ [render.com](https://render.com) وسجل حساب مجاني
3. اختر "New Web Service" → اربطه بـ GitHub
4. أضف متغير البيئة: `ANTHROPIC_API_KEY = sk-ant-xxxxxxxx`
5. ستحصل على رابط ثابت تشاركه مع المشرفين

---

## كيف تحصل على مفتاح API؟
1. اذهب لـ https://console.anthropic.com
2. سجل حساب
3. اذهب لـ API Keys → Create Key
4. انسخ المفتاح واستخدمه في الأوامر أعلاه

## الملفات
- `server.js` — السيرفر (Node.js)
- `index.html` — واجهة التطبيق
- `data.json` — قاعدة البيانات (تُنشأ تلقائياً)
