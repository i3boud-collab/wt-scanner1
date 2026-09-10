# 🚀 دليل النشر على Vercel — خطوة بخطوة

## الملفات المطلوبة
```
wt-live/ 
├── vercel.json          ← إعدادات Cron وRouting
├── package.json         ← المكتبات
├── api/
│   ├── config.js        ← ✏️ قائمة الأسهم والإعدادات (عدّل هنا)
│   ├── indicators.js    ← حسابات WT + RSI + Volume
│   ├── scan.js          ← الدالة التي تعمل كل 5 دقائق
│   └── signals.js       ← ترجع البيانات للموقع
└── public/
    └── index.html       ← الواجهة
```
a
---

## الخطوة 1: GitHub
1. اذهب إلى **github.com** → سجّل دخول أو أنشئ حساب
2. اضغط **New Repository** → اسمه `wt-scanner` → Public → Create
3. ارفع جميع الملفات (بما فيها مجلد api ومجلد public)

---

## الخطوة 2: Vercel KV (لتخزين الإشارات)
1. اذهب إلى **vercel.com** → سجّل بحساب GitHub
2. من Dashboard → **Storage** → **Create** → **KV Database**
3. اسمه `wt-kv` → Create
4. انسخ القيمتين:
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`

---

## الخطوة 3: نشر المشروع
1. في Vercel → **New Project** → Import من GitHub → اختر `wt-scanner`
2. قبل الضغط Deploy اذهب إلى **Environment Variables** وأضف:
   ```
   KV_REST_API_URL     =  (القيمة من الخطوة 2)
   KV_REST_API_TOKEN   =  (القيمة من الخطوة 2)
   CRON_SECRET         =  (اختر كلمة سر عشوائية مثل: abc123xyz)
   ```
3. اضغط **Deploy** — ينتهي خلال دقيقة

---

## الخطوة 4: تشغيل أول مسح يدوي
بعد النشر، شغّل أول مسح مباشرة:
```
https://your-app.vercel.app/api/scan?secret=abc123xyz
```
(استبدل abc123xyz بكلمة السر التي اخترتها)

بعدها الـ Cron يشتغل تلقائياً كل 5 دقائق.

---

## ✏️ تعديل الأسهم
افتح `api/config.js` وعدّل:
```js
const SYMBOLS = ["AAPL","MSFT","NVDA", ...];  // أضف حتى 50 سهم
```

---

## ⚠️ ملاحظة Vercel المجاني
- Cron Jobs متاحة في Hobby Plan (مجاني)
- KV Storage: 30,000 طلب/شهر — يكفي بسهولة
- Serverless Functions: 100GB-Hrs/شهر — أكثر من كافٍ
