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
  res.json({
    status: 'ok',
    service: 'FAHIM DZ API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
  });
});


// ── Serve frontend for all HTML routes ────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard.html'));
});

app.get('/auth', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'authentification.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'privacy.html'));
});

app.get('/privacy.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'privacy.html'));
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
