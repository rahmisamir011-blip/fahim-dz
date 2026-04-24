/**
 * ╔════════════════════════════════════════════════════════╗
 * ║         FAHIM DZ — Backend Server                     ║
 * ║  Multi-Tenant AI SaaS for IG, Facebook & WhatsApp     ║
 * ║  Deploy: 2026-04-20 — multi-tenant + token refresh    ║
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
const { startTokenRefreshService } = require('./services/tokenRefresh');

// ── Routes ────────────────────────────────────────────────────
const authRoutes     = require('./routes/auth');
const webhookRoutes  = require('./routes/webhook');
const platformRoutes = require('./routes/platforms');
const orderRoutes    = require('./routes/orders');
const productRoutes  = require('./routes/products');
const dashboardRoutes = require('./routes/dashboard');
const oauthRoutes      = require('./routes/oauth');
const settingsRoutes   = require('./routes/settings');
const igPrivateRoutes  = require('./routes/igPrivate');

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

// ── JS fix route — server-side OAuth popup approach ─────────
// Extracted to routes/fix.js for cleaner code. Fixes authResponse:null
// issue with Meta Business Login by using /api/oauth/connect/:platform
app.use('/js/fix.js', require('./routes/fix'));


// ── Serve static frontend files ───────────────────────────────
// JS/CSS: no-store so browser always fetches fresh version after deploy

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
app.use('/api/auth',      authLimiter, authRoutes);
app.use('/api/oauth',     apiLimiter,  oauthRoutes);
app.use('/api/platforms', apiLimiter,  platformRoutes);
app.use('/api/orders',    apiLimiter,  orderRoutes);
app.use('/api/products',  apiLimiter,  productRoutes);
app.use('/api/dashboard', apiLimiter,  dashboardRoutes);
app.use('/api/settings',    apiLimiter,  settingsRoutes);   // per-tenant bot config + agent toggle
app.use('/api/ig-private',  apiLimiter,  igPrivateRoutes);  // Instagram Private API (no Meta App Review needed)

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
    version: '3.0.0-multitenant',
    deploy: '2026-04-20T22:00',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
    firebase: isFirebaseReady() ? 'connected' : 'DEMO mode',
    gemini: process.env.GEMINI_API_KEY ? '✅ configured' : '❌ MISSING',
    meta: process.env.META_APP_ID ? '✅ configured' : '❌ MISSING',
    webhookUrl: `${process.env.FRONTEND_URL}/webhook/meta`,
    features: ['multi-tenant', 'per-tenant-bot', 'agent-toggle', 'token-auto-refresh'],
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
  const apiVersion = process.env.META_API_VERSION || 'v21.0';
  const FIELDS = 'messages,messaging_postbacks'; // minimal set that always works
  const results = {};

  try {
    const checkRes = await axios.get(
      `https://graph.facebook.com/${apiVersion}/${pageId}/subscribed_apps`,
      { params: { access_token: token } }
    );
    results.before = checkRes.data;
  } catch (e) { results.checkError = e.response?.data || e.message; }

  try {
    const subRes = await axios.post(
      `https://graph.facebook.com/${apiVersion}/${pageId}/subscribed_apps`,
      null,
      { params: { subscribed_fields: FIELDS, access_token: token } }
    );
    results.subscribeResult = subRes.data;
  } catch (e) { results.subscribeError = e.response?.data || e.message; }

  try {
    const verifyRes = await axios.get(
      `https://graph.facebook.com/${apiVersion}/${pageId}/subscribed_apps`,
      { params: { access_token: token } }
    );
    results.after = verifyRes.data;
  } catch (e) { results.verifyError = e.response?.data || e.message; }

  res.json(results);
});

// ── Debug: Re-subscribe ALL tenant platforms ───────────────────
// Usage: GET /api/debug/resubscribe-all
// Fixes existing connected accounts that had bad subscription fields
app.get('/api/debug/resubscribe-all', async (req, res) => {
  const axios = require('axios');
  const { getDb, isFirebaseReady } = require('./config/firebase');
  if (!isFirebaseReady()) return res.json({ error: 'Firebase not ready' });

  const apiVersion = process.env.META_API_VERSION || 'v21.0';
  const FIELDS = 'messages,messaging_postbacks';
  const db = getDb();
  const results = [];

  try {
    const usersSnap = await db.collection('users').get();
    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id;
      const platsSnap = await db.collection('users').doc(userId).collection('platforms').get();
      for (const platDoc of platsSnap.docs) {
        const d = platDoc.data();
        const pageId = d.pageId;
        const token  = d.accessToken || d.pageAccessToken;
        if (!pageId || !token) { results.push({ userId, platform: platDoc.id, status: 'skipped: no pageId or token' }); continue; }
        try {
          const r = await axios.post(
            `https://graph.facebook.com/${apiVersion}/${pageId}/subscribed_apps`,
            null,
            { params: { subscribed_fields: FIELDS, access_token: token } }
          );
          results.push({ userId, platform: platDoc.id, pageId, status: r.data?.success ? '✅ ok' : JSON.stringify(r.data) });
        } catch (e) {
          results.push({ userId, platform: platDoc.id, pageId, status: '❌ ' + (e.response?.data?.error?.message || e.message) });
        }
      }
    }
    res.json({ resubscribed: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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


// ── Debug: Full pipeline diagnosis for logged-in user ─────────────────
// Usage: GET /api/debug/diagnose  (with Authorization: Bearer <fahim_token>)
// Returns pass/fail for every step in the messaging pipeline
app.get('/api/debug/diagnose', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.json({ error: 'Pass Authorization: Bearer <token> header or ?token=...' });

  const report = { timestamp: new Date().toISOString(), steps: [] };
  const ok  = (step, msg, data = {}) => report.steps.push({ step, status: '✅', msg, ...data });
  const fail = (step, msg, data = {}) => report.steps.push({ step, status: '❌', msg, ...data });
  const warn = (step, msg, data = {}) => report.steps.push({ step, status: '⚠️', msg, ...data });

  try {
    const jwt = require('jsonwebtoken');
    let userId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.userId;
      ok('auth', `JWT valid, userId=${userId}`);
    } catch (e) {
      fail('auth', `JWT invalid: ${e.message}`);
      return res.json(report);
    }

    const { getDb, isFirebaseReady } = require('./config/firebase');
    if (!isFirebaseReady()) { fail('firebase', 'Firebase not ready'); return res.json(report); }
    ok('firebase', 'Firebase connected');

    const db = getDb();

    // Check user doc
    const userSnap = await db.collection('users').doc(userId).get();
    if (!userSnap.exists) { fail('user', 'User doc not found in Firestore'); return res.json(report); }
    const userData = userSnap.data();
    const balance = userData.points ?? userData.credits ?? 0;
    if (balance <= 0) fail('points', `Balance is ${balance} — bot will NOT reply (add points!)`);
    else ok('points', `Balance: ${balance} points`);

    // Check platform docs
    const platSnap = await db.collection('users').doc(userId).collection('platforms').get();
    if (platSnap.empty) { fail('platforms', 'No platforms connected — connect Instagram/Facebook first'); return res.json(report); }

    const axios = require('axios');
    const META_VERSION = process.env.META_API_VERSION || 'v21.0';

    for (const doc of platSnap.docs) {
      const platData = doc.data();
      const platKey = doc.id; // should be 'ig', 'fb', 'wa'
      const token = platData.accessToken || platData.pageAccessToken;

      ok(`platform:${platKey}`, `Doc found — pageId=${platData.pageId} igAccountId=${platData.igAccountId || 'N/A'}`);

      if (!token) { fail(`platform:${platKey}:token`, 'No access token stored!'); continue; }
      ok(`platform:${platKey}:token`, `Token present (${token.substring(0,20)}...)`);

      // Check webhook_registry
      const reg1 = await db.collection('webhook_registry').doc(platData.pageId).get();
      if (!reg1.exists) fail(`registry:${platKey}:pageId`, `FB pageId=${platData.pageId} NOT in webhook_registry — will not receive messages`);
      else ok(`registry:${platKey}:pageId`, `FB pageId=${platData.pageId} → userId=${reg1.data().userId}`);

      if (platData.igAccountId) {
        const reg2 = await db.collection('webhook_registry').doc(platData.igAccountId).get();
        if (!reg2.exists) fail(`registry:${platKey}:igId`, `IG accountId=${platData.igAccountId} NOT in webhook_registry`);
        else ok(`registry:${platKey}:igId`, `IG accountId=${platData.igAccountId} → userId=${reg2.data().userId}`);
      }

      // Check page webhook subscription
      try {
        const subCheck = await axios.get(
          `https://graph.facebook.com/${META_VERSION}/${platData.pageId}/subscribed_apps`,
          { params: { access_token: token } }
        );
        const subs = subCheck.data?.data || [];
        if (subs.length === 0) fail(`webhook:${platKey}`, `Page ${platData.pageId} has NO app subscriptions — messages will NOT arrive`);
        else ok(`webhook:${platKey}`, `Page ${platData.pageId} subscribed: ${subs.map(s => s.name).join(', ')}`);
      } catch (e) {
        warn(`webhook:${platKey}`, `Could not check subscription: ${e.response?.data?.error?.message || e.message}`);
      }

      // Token validity check
      try {
        const debugRes = await axios.get(`https://graph.facebook.com/debug_token`, {
          params: { input_token: token, access_token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}` }
        });
        const tokenData = debugRes.data?.data;
        if (!tokenData?.is_valid) fail(`token:${platKey}`, `Token is INVALID or expired!`, { tokenData });
        else {
          const exp = tokenData.expires_at ? new Date(tokenData.expires_at * 1000).toISOString() : 'never';
          ok(`token:${platKey}`, `Token valid, expires: ${exp}, scopes: ${(tokenData.scopes || []).slice(0,5).join(',')}`);
        }
      } catch (e) {
        warn(`token:${platKey}`, `Could not validate token: ${e.message}`);
      }
    }

    // Gemini check
    if (!process.env.GEMINI_API_KEY) fail('gemini', 'GEMINI_API_KEY not set — no AI replies possible');
    else ok('gemini', 'GEMINI_API_KEY configured');

    report.summary = report.steps.filter(s => s.status === '❌').length === 0 ? '✅ All checks passed' : '❌ Issues found — check steps above';
    res.json(report);

  } catch (err) {
    report.error = err.message;
    res.status(500).json(report);
  }
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
  console.log(`  🏢  Multi-tenant: each user's bot uses their own store config`);
  console.log(`  🔄  Token refresh: running every 24h to keep connections alive\n`);

  // ── Start background services ──────────────────────────────
  startTokenRefreshService(); // keeps Meta tokens alive for all tenants

  // ── Instagram Private API polling (every 60s) ──────────────
  const { startIgPrivatePolling } = require('./services/igPrivate');
  startIgPrivatePolling(); // polls DMs for all tenants using IGP
});

module.exports = app;
