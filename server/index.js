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
