/**
 * FAHIM DZ — Meta OAuth Routes
 * Handles Instagram, Facebook & WhatsApp OAuth connection flow
 *
 * Flow:
 *  1. Frontend opens popup → /api/oauth/connect/:platform?token=JWT
 *  2. Server redirects to Meta OAuth dialog
 *  3. Meta redirects back → /api/oauth/callback?code=...&state=...
 *  4. Server exchanges code for long-lived token
 *  5. Server saves to Firestore, closes popup, notifies opener
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getDb, isFirebaseReady } = require('../config/firebase');
const jwt = require('jsonwebtoken');

const META_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v19.0';
const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Scope sets per platform
const SCOPES = {
  instagram: [
    'instagram_basic',
    'instagram_manage_messages',
    'instagram_manage_comments',
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
  ].join(','),

  facebook: [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
    'pages_messaging',
  ].join(','),

  whatsapp: [
    'whatsapp_business_management',
    'whatsapp_business_messaging',
    'pages_show_list',
  ].join(','),
};

// ── GET /api/oauth/connect/:platform ─────────────────────────
// Entry point — frontend calls this via popup window
router.get('/connect/:platform', (req, res) => {
  const { platform } = req.params;
  const { token } = req.query;

  if (!['instagram', 'facebook', 'whatsapp'].includes(platform)) {
    return res.status(400).send('منصة غير معروفة');
  }

  if (!token) {
    return res.status(401).send('يجب تسجيل الدخول أولاً');
  }

  const META_APP_ID = process.env.META_APP_ID;
  if (!META_APP_ID || META_APP_ID === 'YOUR_META_APP_ID') {
    // No Meta app configured — return an HTML page with instructions
    return res.send(buildNoMetaAppPage(platform));
  }

  // Encode userId in state for security
  let userId;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = decoded.userId;
  } catch {
    return res.status(401).send('جلسة منتهية — أعد تسجيل الدخول');
  }

  const state = Buffer.from(JSON.stringify({ userId, platform, ts: Date.now() })).toString('base64');
  const redirectUri = `${BASE_URL}/api/oauth/callback`;
  const scope = SCOPES[platform];

  const oauthUrl = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?` +
    `client_id=${META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(state)}` +
    `&response_type=code`;

  return res.redirect(oauthUrl);
});

// ── GET /api/oauth/callback ───────────────────────────────────
// Meta redirects here after user grants permission
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.send(buildCallbackPage(false, null, decodeURIComponent(error_description || error)));
  }

  if (!code || !state) {
    return res.send(buildCallbackPage(false, null, 'بيانات OAuth ناقصة'));
  }

  let userId, platform;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    userId = decoded.userId;
    platform = decoded.platform;
  } catch {
    return res.send(buildCallbackPage(false, null, 'state غير صالح'));
  }

  try {
    const redirectUri = `${BASE_URL}/api/oauth/callback`;

    // 1. Exchange code for short-lived token
    const tokenRes = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/oauth/access_token`, {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: redirectUri,
        code,
      },
    });
    const shortToken = tokenRes.data.access_token;

    // 2. Exchange for long-lived token (60 days)
    const longTokenRes = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: shortToken,
      },
    });
    const longToken = longTokenRes.data.access_token;
    const expiresIn = longTokenRes.data.expires_in; // seconds

    // 3. Get user's Facebook Pages
    const pagesRes = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/me/accounts`, {
      params: { access_token: longToken, fields: 'id,name,access_token,instagram_business_account' },
    });
    const pages = pagesRes.data.data || [];

    if (pages.length === 0) {
      return res.send(buildCallbackPage(false, platform, 'لم يتم العثور على صفحات. تأكد من ربط صفحة فيسبوك.'));
    }

    const page = pages[0]; // Use first page
    const pageToken = page.access_token;
    const pageId = page.id;

    let platformData = {
      platform,
      pageId,
      pageName: page.name,
      pageAccessToken: pageToken,
      longLivedToken: longToken,
      tokenExpiry: Date.now() + (expiresIn * 1000),
      connectedAt: Date.now(),
      active: true,
    };

    // 4. If Instagram — get IG Business Account ID
    if (platform === 'instagram' && page.instagram_business_account) {
      const igId = page.instagram_business_account.id;
      const igRes = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/${igId}`, {
        params: { fields: 'id,name,username,followers_count', access_token: pageToken },
      });
      platformData.igAccountId = igId;
      platformData.igUsername = igRes.data.username;
      platformData.igName = igRes.data.name;
    }

    // 5. Save to Firestore
    if (isFirebaseReady()) {
      const db = getDb();
      await db.collection('users').doc(userId).collection('platforms').doc(platform).set(platformData);

      // Update user's connectedPlatforms array
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      const current = userDoc.data()?.connectedPlatforms || [];
      if (!current.includes(platform)) {
        await userRef.update({ connectedPlatforms: [...current, platform] });
      }
    }

    return res.send(buildCallbackPage(true, platform, null, platformData));

  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    const errMsg = err.response?.data?.error?.message || err.message;
    return res.send(buildCallbackPage(false, platform, errMsg));
  }
});

// ── GET /api/oauth/status ─────────────────────────────────────
// Returns connected platforms for an authenticated user
router.get('/status', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { userId } = jwt.verify(token, process.env.JWT_SECRET);
    if (!isFirebaseReady()) return res.json({ platforms: [] });

    const db = getDb();
    const snap = await db.collection('users').doc(userId).collection('platforms').get();
    const platforms = {};
    snap.forEach(doc => {
      const d = doc.data();
      platforms[doc.id] = {
        connected: d.active,
        pageName: d.pageName,
        igUsername: d.igUsername,
        connectedAt: d.connectedAt,
      };
    });
    return res.json({ platforms });
  } catch {
    return res.status(401).json({ error: 'Token invalid' });
  }
});

// ── DELETE /api/oauth/disconnect/:platform ────────────────────
router.delete('/disconnect/:platform', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { userId } = jwt.verify(token, process.env.JWT_SECRET);
    const { platform } = req.params;
    if (!isFirebaseReady()) return res.json({ success: true });

    const db = getDb();
    await db.collection('users').doc(userId).collection('platforms').doc(platform).update({ active: false });

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const current = (userDoc.data()?.connectedPlatforms || []).filter(p => p !== platform);
    await userRef.update({ connectedPlatforms: current });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// HTML Helpers
// ─────────────────────────────────────────────────────────────

function buildCallbackPage(success, platform, errorMsg, data = {}) {
  const platformNames = { instagram: 'انستغرام', facebook: 'فيسبوك', whatsapp: 'واتساب' };
  const name = platformNames[platform] || platform;

  if (success) {
    const displayName = data.igUsername ? `@${data.igUsername}` : data.pageName;
    return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>تم الربط</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Cairo', sans-serif; display: flex; align-items: center; justify-content: center;
    min-height: 100vh; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
  .card { background: white; border-radius: 20px; padding: 40px; text-align: center;
    max-width: 400px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: pop .4s ease; }
  @keyframes pop { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .icon { font-size: 60px; margin-bottom: 16px; }
  h2 { font-size: 22px; color: #1a1a2e; margin-bottom: 8px; }
  p { color: #666; font-size: 14px; margin-bottom: 20px; }
  .badge { background: #e8f5e9; color: #2e7d32; padding: 8px 16px; border-radius: 20px;
    font-size: 13px; display: inline-block; margin-bottom: 24px; }
  button { background: linear-gradient(135deg, #667eea, #764ba2); color: white;
    border: none; padding: 12px 32px; border-radius: 25px; cursor: pointer; font-size: 15px;
    font-family: inherit; transition: opacity .2s; }
  button:hover { opacity: .85; }
</style></head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h2>تم ربط ${name}!</h2>
  <div class="badge">📱 ${displayName || name}</div>
  <p>تم ربط الحساب بنجاح. يمكنك الآن استقبال الرسائل وإدارتها من لوحة التحكم.</p>
  <button onclick="window.close(); if(window.opener) window.opener.location.reload();">
    إغلاق وتحديث اللوحة
  </button>
</div>
<script>
  // Auto-notify parent window
  if (window.opener) {
    window.opener.postMessage({ type: 'OAUTH_SUCCESS', platform: '${platform}', data: ${JSON.stringify({ igUsername: data.igUsername, pageName: data.pageName })} }, '*');
    setTimeout(() => window.close(), 3000);
  }
</script>
</body></html>`;
  }

  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>خطأ في الربط</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Cairo', sans-serif; display: flex; align-items: center; justify-content: center;
    min-height: 100vh; background: linear-gradient(135deg, #f5576c 0%, #f093fb 100%); }
  .card { background: white; border-radius: 20px; padding: 40px; text-align: center;
    max-width: 400px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .icon { font-size: 60px; margin-bottom: 16px; }
  h2 { font-size: 22px; color: #1a1a2e; margin-bottom: 12px; }
  .error { background: #fff3cd; color: #856404; padding: 12px; border-radius: 10px;
    font-size: 13px; margin-bottom: 20px; }
  button { background: #f5576c; color: white; border: none; padding: 12px 32px;
    border-radius: 25px; cursor: pointer; font-size: 15px; font-family: inherit; }
</style></head>
<body>
<div class="card">
  <div class="icon">❌</div>
  <h2>فشل ربط ${name}</h2>
  <div class="error">${errorMsg || 'حدث خطأ غير معروف'}</div>
  <button onclick="window.close()">إغلاق</button>
</div>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: 'OAUTH_ERROR', platform: '${platform}', error: '${errorMsg}' }, '*');
  }
</script>
</body></html>`;
}

function buildNoMetaAppPage(platform) {
  const icons = { instagram: '📸', facebook: '👤', whatsapp: '💬' };
  const names = { instagram: 'انستغرام', facebook: 'فيسبوك', whatsapp: 'واتساب' };
  return `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>إعداد Meta App</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Cairo', sans-serif; display: flex; align-items: center; justify-content: center;
    min-height: 100vh; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: white; }
  .card { background: rgba(255,255,255,.08); backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,.15); border-radius: 20px; padding: 40px;
    text-align: center; max-width: 460px; width: 90%; }
  .icon { font-size: 56px; margin-bottom: 16px; }
  h2 { font-size: 20px; margin-bottom: 12px; }
  p { color: rgba(255,255,255,.7); font-size: 14px; line-height: 1.7; margin-bottom: 20px; }
  .step { background: rgba(255,255,255,.06); border-radius: 12px; padding: 14px 20px;
    margin: 8px 0; text-align: right; font-size: 13px; color: rgba(255,255,255,.8); }
  .step strong { color: #4fc3f7; }
  a { color: #81d4fa; }
  button { background: rgba(255,255,255,.15); color: white; border: 1px solid rgba(255,255,255,.2);
    padding: 12px 32px; border-radius: 25px; cursor: pointer; font-size: 15px;
    font-family: inherit; margin-top: 20px; transition: background .2s; }
  button:hover { background: rgba(255,255,255,.25); }
</style></head>
<body>
<div class="card">
  <div class="icon">${icons[platform] || '🔗'}</div>
  <h2>ربط ${names[platform] || platform}</h2>
  <p>لتفعيل الربط الحقيقي، تحتاج إلى إعداد تطبيق Meta:</p>
  <div class="step">1. اذهب إلى <a href="https://developers.facebook.com/apps" target="_blank">developers.facebook.com/apps</a></div>
  <div class="step">2. أنشئ <strong>Business App</strong> جديد</div>
  <div class="step">3. انسخ <strong>App ID</strong> و<strong>App Secret</strong></div>
  <div class="step">4. أضفهما في ملف <strong>.env</strong>:<br><code style="font-size:11px;color:#80cbc4">META_APP_ID=...<br>META_APP_SECRET=...</code></div>
  <div class="step">5. أضف <strong>Redirect URI</strong>:<br><code style="font-size:11px;color:#80cbc4">http://localhost:3000/api/oauth/callback</code></div>
  <button onclick="window.close()">فهمت — إغلاق</button>
</div>
</body></html>`;
}

module.exports = router;
