# FAHIM DZ — Setup Guide
## كيفية إعداد المشروع بالكامل

---

## 1. تشغيل السيرفر

```bash
cd "c:\Users\PC\Desktop\SAAS\SOFTWEAR + PLUGGINGS + TOOLS\fahhem dz"
npm run dev
```

الموقع يعمل على: **http://localhost:3000**

---

## 2. Firebase Setup (قاعدة البيانات)

### أ. إنشاء مشروع Firebase
1. اذهب إلى [firebase.google.com](https://firebase.google.com)
2. اضغط **"Add project"** → أدخل اسم المشروع
3. فعّل **Firestore Database** (في Cloud Firestore)
4. اختر **Production mode** أو **Test mode**

### ب. الحصول على مفاتيح الخدمة
1. في Firebase Console → **Project Settings** ⚙️
2. اضغط **Service accounts** → **Generate new private key**
3. انسخ القيم إلى `.env`:
   ```env
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@your-project.iam.gserviceaccount.com
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```

---

## 3. OpenAI Setup (الذكاء الاصطناعي)

1. اذهب إلى [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. اضغط **"Create new secret key"**
3. انسخ المفتاح إلى `.env`:
   ```env
   OPENAI_API_KEY=sk-proj-...
   ```

> يستخدم النظام نموذج **gpt-4o-mini** (رخيص وسريع)

---

## 4. Meta App Setup (انستغرام، فيسبوك، واتساب)

### أ. إنشاء Meta App
1. اذهب إلى [developers.facebook.com](https://developers.facebook.com/apps)
2. اضغط **"Create App"** → اختر **"Business"**
3. أدخل اسم التطبيق وأكمل الخطوات

### ب. إعداد Webhook
1. في التطبيق → **Webhooks** → **Subscribe to events**
2. أدخل URL الـ Webhook:
   - للتطوير المحلي: استخدم **ngrok**:
     ```bash
     npx ngrok http 3000
     # ستحصل على: https://xxxx.ngrok.io
     # Webhook URL: https://xxxx.ngrok.io/webhook/meta
     ```
   - للإنتاج: `https://yourdomain.com/webhook/meta`
3. أدخل **Verify Token** (نفس القيمة في `.env`):
   ```
   fahim_webhook_secret_2024
   ```
4. اشترك في الأحداث:
   - `messages`
   - `messaging_postbacks`

### ج. Instagram
1. في التطبيق → **Instagram** → **API with Instagram Login**
2. احصل على **Page ID** و **Page Access Token**
3. أضفهما في لوحة التحكم → الحسابات المربوطة → ربط انستغرام

### د. Facebook Messenger
1. في التطبيق → **Messenger** → **Settings**
2. احصل على **Page Access Token** لصفحتك
3. أضفه في لوحة التحكم → ربط فيسبوك

### هـ. WhatsApp Business API
1. في التطبيق → **WhatsApp** → **API Setup**
2. احصل على:
   - **Phone Number ID**
   - **System User Token** (أو Temporary Token للاختبار)
3. أضفهما في لوحة التحكم → ربط واتساب

---

## 5. المتغيرات البيئية المطلوبة

افتح ملف `.env` وأدخل قيمك:

```env
PORT=3000
JWT_SECRET=your_strong_secret_here

FIREBASE_PROJECT_ID=...
FIREBASE_PRIVATE_KEY="..."
FIREBASE_CLIENT_EMAIL=...

OPENAI_API_KEY=sk-...

META_APP_ID=...
META_APP_SECRET=...
META_WEBHOOK_VERIFY_TOKEN=fahim_webhook_secret_2024
```

---

## 6. اختبار الـ Webhook

```bash
# اختبار التحقق
curl "http://localhost:3000/webhook/meta?hub.mode=subscribe&hub.verify_token=fahim_webhook_secret_2024&hub.challenge=TEST_CHALLENGE"
# يجب أن يرد بـ: TEST_CHALLENGE

# Health check
curl http://localhost:3000/health
```

---

## 7. هيكل الـ API

| Method | Endpoint | الوصف |
|--------|----------|-------|
| POST | /api/auth/register | إنشاء حساب |
| POST | /api/auth/login | تسجيل الدخول |
| GET  | /api/auth/me | معلومات المستخدم |
| GET  | /api/platforms | المنصات المربوطة |
| POST | /api/platforms/ig | ربط انستغرام |
| POST | /api/platforms/fb | ربط فيسبوك |
| POST | /api/platforms/wa | ربط واتساب |
| GET  | /api/orders | قائمة الطلبات |
| POST | /api/orders | إضافة طلب |
| GET  | /api/products | قائمة المنتجات |
| POST | /api/products | إضافة منتج |
| GET  | /api/dashboard/stats | إحصائيات |
| POST | /api/dashboard/billing/purchase | شراء نقاط |
| GET  | /webhook/meta | التحقق من Webhook |
| POST | /webhook/meta | استقبال الرسائل |
