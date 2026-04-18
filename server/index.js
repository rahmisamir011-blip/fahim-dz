/**
 * ╔════════════════════════════════════════════════════════╗
 * ║         FAHIM DZ — Backend Server                     ║
 * ║  AI Sales Agent for Instagram, Facebook & WhatsApp    ║
 * ╚════════════════════════════════════════════════════════╝
 *
 * Start: node server/index.js
 * Dev:   npm run dev  (with nodemon)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

// ── Config & Services ─────────────────────────────────────────
const { initFirebase } = require('./config/firebase');
const { captureRawBody } = require('./middleware/webhookVerify');

// ── Routes ────────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const platformRoutes = require('./routes/platforms');
const orderRoutes = require('./routes/orders');
const productRoutes = require('./routes/products');
const dashboardRoutes = require('./routes/dashboard');
const oauthRoutes = require('./routes/oauth');

// ── Initialize Firebase ───────────────────────────────────────
initFirebase();

// ── Express App ───────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

// ── Trust Render's reverse proxy (REQUIRED for rate-limit + HTTPS) ───
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);

// ── Security middleware ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Disable for serving HTML files
}));

// ── CORS ──────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [
        process.env.FRONTEND_URL,
        'https://fahim-dz.onrender.com',
      ].filter(Boolean)
    : '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  message: { error: 'Too many requests — please try again later' },
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { error: 'Too many auth attempts — please wait an hour' },
});

// ── Logging ───────────────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── CRITICAL: Webhook route uses raw body BEFORE express.json ─
// The webhook endpoint needs raw body for HMAC verification
app.use('/webhook', captureRawBody);
app.use('/webhook/meta', webhookRoutes);

// ── JSON body parser for all other routes ─────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Inline JS fix route (bypasses static file cache) ─────────
// This route is embedded in server code so it always reflects the latest deploy.
// It overrides the broken connectWithFacebook in the old cached dashboard.js.
app.get('/js/fix.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.send(`
/* FAHIM FIX v20260418 — served by Express (never cached) */
(function() {
  'use strict';

  // ── 1. Override connectWithFacebook with working version ────
  window._origConnect = window.connectWithFacebook;

  window.connectWithFacebook = function(platform) {
    if (typeof FB === 'undefined') {
      _showToast('❌ Facebook SDK لم يُحمَّل. انتظر ثانية وأعد المحاولة.', 'error');
      return;
    }
    var baseScopes = 'pages_show_list,pages_read_engagement,pages_manage_metadata,business_management';
    var scopes = platform === 'instagram'
      ? 'instagram_basic,' + baseScopes
      : baseScopes + ',pages_messaging';

    _showToast('⏳ جارٍ التحقق من حالة الاتصال...', 'info');

    // Step 1: Check existing session first (avoids unnecessary popup)
    FB.getLoginStatus(function(st) {
      console.log('[FIX] getLoginStatus:', JSON.stringify(st));
      if (st && st.authResponse && st.authResponse.accessToken) {
        _showToast('⏳ جارٍ تحميل صفحاتك...', 'info');
        _doPageFetch(platform, st.authResponse.accessToken);
        return;
      }

      // Step 2: Open login popup (no auth_type:rerequest — causes null on already-authed apps)
      _showToast('⏳ جارٍ فتح نافذة تسجيل الدخول...', 'info');
      FB.login(function(r) {
        console.log('[FIX] FB.login:', JSON.stringify(r));
        if (r && r.authResponse && r.authResponse.accessToken) {
          _doPageFetch(platform, r.authResponse.accessToken);
          return;
        }

        // Step 3: Popup closed — final fallback
        FB.getLoginStatus(function(st2) {
          console.log('[FIX] fallback getLoginStatus:', JSON.stringify(st2));
          if (st2 && st2.authResponse && st2.authResponse.accessToken) {
            _doPageFetch(platform, st2.authResponse.accessToken);
          } else {
            _showToast('❌ لم يتم تسجيل الدخول. حاول مرة أخرى.', 'error');
          }
        }, true);
      }, { scope: scopes, return_scopes: true }); // No auth_type!
    }, true);
  };

  async function _doPageFetch(platform, token) {
    _showToast('⏳ جارٍ تحميل الصفحات...', 'info');
    try {
      var authToken = localStorage.getItem('fahim_token') || localStorage.getItem('authToken') || localStorage.getItem('token');
      var r = await fetch('/api/platforms/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
        body: JSON.stringify({ userAccessToken: token, platform: platform })
      });
      var d = await r.json();
      console.log('[FIX] exchange-token:', JSON.stringify(d));
      if (!r.ok || d.error) { _showToast('❌ ' + (d.error || r.status), 'error'); return; }
      if (!d.pages || !d.pages.length) { _showToast('⚠️ لا توجد صفحات مربوطة بحسابك.', 'warning'); return; }
      _showModal(platform, d.pages);
    } catch(e) {
      console.error('[FIX] fetch error:', e);
      _showToast('❌ خطأ: ' + e.message, 'error');
    }
  }

  var _fixPages = [], _fixPlat = '';

  function _showModal(platform, pages) {
    _fixPages = pages; _fixPlat = platform;
    var modal = document.getElementById('page-selector-modal');
    var title = document.getElementById('page-selector-title');
    var list  = document.getElementById('page-list');
    if (title) title.textContent = 'اختر ' + (platform === 'instagram' ? 'حساب انستغرام' : 'الصفحة') + ' المراد ربطها';
    if (list) {
      list.innerHTML = pages.map(function(p, i) {
        return '<button onclick="window._fixConnect(' + i + ')" style="display:flex;align-items:center;gap:12px;padding:14px;border:1.5px solid #e2e8f0;border-radius:12px;background:#fff;cursor:pointer;width:100%;text-align:right;font-family:Cairo,sans-serif;margin-bottom:6px">'
          + '<div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#1e4d8c,#0ea5e9);display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;flex-shrink:0">' + (platform==='instagram'?'📸':'📘') + '</div>'
          + '<div><b style="color:#1a1a2e">' + p.name + '</b><br><small style="color:#64748b">ID: ' + p.id + (p.ig_username?' · @'+p.ig_username:'') + '</small></div>'
          + '</button>';
      }).join('');
    }
    if (modal) modal.style.display = 'flex';
  }

  window._fixConnect = async function(i) {
    var p = _fixPages[i], plat = _fixPlat;
    if (!p) return;
    document.getElementById('page-selector-modal').style.display = 'none';
    _showToast('⏳ جارٍ ربط ' + p.name + '...', 'info');
    try {
      var authToken = localStorage.getItem('fahim_token') || localStorage.getItem('authToken') || localStorage.getItem('token');
      var r = await fetch('/api/platforms/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
        body: JSON.stringify({ platform: plat, pageId: p.id, pageName: p.name, pageToken: p.access_token, igId: p.ig_id || '' })
      });
      var d = await r.json();
      console.log('[FIX] connect:', JSON.stringify(d));
      if (d.success) {
        _showToast('✅ تم ربط ' + p.name + ' بنجاح!', 'success');
        // Update UI
        var key = plat === 'instagram' ? 'ig' : plat === 'facebook' ? 'fb' : 'wa';
        var hdl = document.getElementById(key + '-handle');
        var btn = document.getElementById('connect-' + key);
        var dis = document.getElementById('disconnect-' + key);
        if (hdl) hdl.textContent = p.ig_username ? '@' + p.ig_username : p.name;
        if (btn) { btn.textContent = '✅ مربوط'; btn.disabled = true; btn.style.background = '#e8f5e9'; btn.style.color = '#2e7d32'; }
        if (dis) dis.style.display = 'inline-flex';
      } else {
        _showToast('❌ ' + (d.error || 'فشل الربط'), 'error');
      }
    } catch(e) { _showToast('❌ خطأ: ' + e.message, 'error'); }
  };

  // ── 2. Fix logout button ────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function() {
    var btn = document.getElementById('logout-btn');
    if (btn) {
      btn.onclick = function(e) {
        e.stopImmediatePropagation();
        if (window.Auth) window.Auth.logout();
        else { localStorage.clear(); sessionStorage.clear(); window.location.href = '/authentification.html'; }
      };
    }
  });

  function _showToast(msg, type) {
    if (window.Toast && window.Toast.show) { window.Toast.show(msg, type); return; }
    var c = document.getElementById('toast-container');
    if (!c) return;
    var t = document.createElement('div');
    t.style.cssText = 'padding:12px 18px;border-radius:10px;margin-bottom:8px;font-family:Cairo,sans-serif;font-size:14px;direction:rtl;color:#1a1a2e;box-shadow:0 4px 12px rgba(0,0,0,.15);background:' + (type==='error'?'#fee2e2':type==='success'?'#d1fae5':'#fef3c7');
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(function(){t.remove();},5000);
  }

  console.log('[FIX] v20260418 loaded — connectWithFacebook patched ✅');
})();
`);
});

// ── Serve static frontend files ───────────────────────────────
// JS/CSS: no-store so browser always fetches fresh version after deploy
app.use('/js', express.static(path.join(__dirname, '..', 'js'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
  },
}));
app.use('/css', express.static(path.join(__dirname, '..', 'css'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
  },
}));
// Everything else (assets, etc.) can cache normally
app.use(express.static(path.join(__dirname, '..')));

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/oauth', apiLimiter, oauthRoutes);
app.use('/api/platforms', apiLimiter, platformRoutes);
app.use('/api/orders', apiLimiter, orderRoutes);
app.use('/api/products', apiLimiter, productRoutes);
app.use('/api/dashboard', apiLimiter, dashboardRoutes);

// ── Public Config (safe to expose to frontend) ────────────────
// Only meta APP_ID is public — App Secret NEVER goes to frontend
app.get('/api/config/public', (req, res) => {
  res.json({
    metaAppId: process.env.META_APP_ID || '',
    wabaConfigId: process.env.META_WABA_CONFIG_ID || '',
  });
});

// ── Health Check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  const { isFirebaseReady } = require('./config/firebase');
  res.json({
    status: 'ok',
    service: 'FAHIM DZ API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
    firebase: isFirebaseReady() ? 'connected' : 'DEMO mode',
    gemini: process.env.GEMINI_API_KEY ? 'configured' : 'MISSING',
    meta: process.env.META_APP_ID ? 'configured' : 'MISSING',
    webhookUrl: `${process.env.FRONTEND_URL}/webhook/meta`,
  });
});

// ── Debug: Check & Force Webhook Subscription ─────────────────
// Usage: GET /api/debug/subscribe?pageId=PAGE_ID&token=PAGE_TOKEN
app.get('/api/debug/subscribe', async (req, res) => {
  const { pageId, token } = req.query;
  if (!pageId || !token) {
    return res.status(400).json({ error: 'pageId and token are required' });
  }
  const axios = require('axios');
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v19.0';
  const results = {};

  // 1. Check current subscriptions
  try {
    const checkRes = await axios.get(
      `https://graph.facebook.com/${apiVersion}/${pageId}/subscribed_apps`,
      { params: { access_token: token } }
    );
    results.currentSubscriptions = checkRes.data;
  } catch (e) {
    results.checkError = e.response?.data || e.message;
  }

  // 2. Force subscribe
  try {
    const subRes = await axios.post(
      `https://graph.facebook.com/${apiVersion}/${pageId}/subscribed_apps`,
      null,
      { params: {
        subscribed_fields: 'messages,messaging_postbacks,messaging_optins,message_reads',
        access_token: token,
      }}
    );
    results.subscribeResult = subRes.data;
  } catch (e) {
    results.subscribeError = e.response?.data || e.message;
  }

  // 3. Verify after subscribe
  try {
    const verifyRes = await axios.get(
      `https://graph.facebook.com/${apiVersion}/${pageId}/subscribed_apps`,
      { params: { access_token: token } }
    );
    results.afterSubscription = verifyRes.data;
  } catch (e) {
    results.verifyError = e.response?.data || e.message;
  }

  res.json(results);
});

// ── Debug: Show Firestore webhook registry ─────────────────────
// Usage: GET /api/debug/registry
app.get('/api/debug/registry', async (req, res) => {
  try {
    const { getDb, isFirebaseReady } = require('./config/firebase');
    if (!isFirebaseReady()) return res.json({ error: 'Firebase not ready' });
    const db = getDb();
    const snap = await db.collection('webhook_registry').limit(20).get();
    const entries = [];
    snap.forEach(doc => entries.push({ id: doc.id, ...doc.data() }));
    res.json({ count: entries.length, entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug: Simulate incoming webhook (for testing without Meta) ─
app.post('/api/debug/simulate-message', async (req, res) => {
  const { pageId, senderId, text } = req.body;
  if (!pageId || !senderId || !text) {
    return res.status(400).json({ error: 'pageId, senderId, text required' });
  }
  // Simulate what Meta would send for an Instagram DM
  const fakeBody = {
    object: 'instagram',
    entry: [{
      id: pageId,
      time: Date.now(),
      messaging: [{
        sender: { id: senderId },
        recipient: { id: pageId },
        timestamp: Date.now(),
        message: { mid: `debug_${Date.now()}`, text },
      }],
    }],
  };
  // Internally process it
  try {
    const { processMessage, findTenantByPageId } = require('./services/messaging');
    const registry = await findTenantByPageId(pageId);
    if (!registry) return res.json({ error: `No tenant found for pageId: ${pageId}` });
    const { getDb } = require('./config/firebase');
    const db = getDb();
    const platformSnap = await db.collection('users').doc(registry.userId).collection('platforms').doc(registry.platform).get();
    if (!platformSnap.exists) return res.json({ error: 'Platform not found in Firestore' });
    const rawPlatform = platformSnap.data();
    const platform = {
      type: registry.platform,
      ...rawPlatform,
      accessToken: rawPlatform.accessToken || rawPlatform.pageAccessToken || '',
    };
    const event = { platform: registry.platform, senderId, messageText: text, messageId: `debug_${Date.now()}`, timestamp: Date.now() };
    await processMessage(event, registry.userId, platform);
    res.json({ success: true, registry, platformKey: registry.platform });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});




// ── Debug: Test sending a direct IG reply ───────────────────────
// Usage: GET /api/debug/test-ig-send?recipientId=SENDER_IG_ID
app.get('/api/debug/test-ig-send', async (req, res) => {
  const { recipientId } = req.query;
  if (!recipientId) {
    return res.json({ error: 'Pass ?recipientId=SENDER_IG_ID in the URL' });
  }
  try {
    const { getDb, isFirebaseReady } = require('./config/firebase');
    if (!isFirebaseReady()) return res.json({ error: 'Firebase not ready' });
    const db = getDb();
    const platformSnap = await db.collection('users').doc('Tc88HuFDlZ9I9Gc9w9nv').collection('platforms').doc('ig').get();
    if (!platformSnap.exists) return res.json({ error: 'No IG platform doc found' });
    const igData = platformSnap.data();
    const pageToken = igData.accessToken || igData.pageAccessToken || '';
    const igAccountId = igData.igAccountId || '';
    const metaService = require('./services/meta');
    const result = await metaService.sendInstagramMessage(
      recipientId, 'مرحباً! هذا اختبار من روبوت فاهيم DZ 🤖', pageToken, igAccountId
    );
    res.json({ result, igAccountId, hasToken: !!pageToken, tokenPreview: pageToken.substring(0, 20) + '...' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Serve frontend for all HTML routes (no-cache) ─────────────
const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

app.get('/', (req, res) => {
  res.set(NO_CACHE).sendFile(path.join(__dirname, '..', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.set(NO_CACHE).sendFile(path.join(__dirname, '..', 'dashboard.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.set(NO_CACHE).sendFile(path.join(__dirname, '..', 'dashboard.html'));
});

app.get('/auth', (req, res) => {
  res.set(NO_CACHE).sendFile(path.join(__dirname, '..', 'authentification.html'));
});

app.get('/authentification.html', (req, res) => {
  res.set(NO_CACHE).sendFile(path.join(__dirname, '..', 'authentification.html'));
});

app.get('/privacy', (req, res) => {
  res.set(NO_CACHE).sendFile(path.join(__dirname, '..', 'privacy.html'));
});

app.get('/privacy.html', (req, res) => {
  res.set(NO_CACHE).sendFile(path.join(__dirname, '..', 'privacy.html'));
});


// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
    return res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
  }
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ── Start Server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║         FAHIM DZ  —  Server Started        ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  🌐  http://localhost:${PORT}                  ║`);
  console.log(`║  📡  Webhook: /webhook/meta                ║`);
  console.log(`║  🔐  API:     /api/auth, /api/dashboard    ║`);
  console.log(`║  ❤️   Health:  /health                      ║`);
  console.log('╚════════════════════════════════════════════╝');
  console.log(`  Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Firebase Project: ${process.env.FIREBASE_PROJECT_ID || '⚠️  NOT SET'}`);
  console.log(`  Gemini AI: ${process.env.GEMINI_API_KEY ? '✅ configured' : '⚠️  NOT SET'}`);
  console.log(`  Meta App: ${process.env.META_APP_ID && process.env.META_APP_ID !== 'YOUR_META_APP_ID' ? '✅ configured' : '⚠️  NOT SET (OAuth will show setup guide)'}\n`);
});

module.exports = app;
