/**
 * FAHIM DZ — Authentication Routes
 * POST /api/auth/register
 * POST /api/auth/login
 * GET  /api/auth/me
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

// Firebase-not-configured guard
function checkFirebase(res) {
  const { isFirebaseReady } = require('../config/firebase');
  if (!isFirebaseReady()) {
    res.status(503).json({
      error: '⚠️ قاعدة البيانات غير مُهيأة بعد — أضف مفاتيح Firebase إلى ملف .env لتفعيل التسجيل والدخول الحقيقي',
      code: 'FIREBASE_NOT_CONFIGURED',
    });
    return false;
  }
  return true;
}
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');

function signToken(userId, email) {
  return jwt.sign(
    { userId, email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ── POST /api/auth/register ──────────────────────────────────
router.post('/register', async (req, res) => {
  if (!checkFirebase(res)) return;

  const { name, email, password, storeName } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'الاسم، البريد، وكلمة المرور مطلوبة' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  }

  const db = getDb();

  try {
    // Check if email already exists
    const existing = await db.collection('users')
      .where('email', '==', email.toLowerCase().trim())
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const userRef = db.collection('users').doc();
    const userData = {
      id: userRef.id,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      passwordHash,
      storeName: storeName?.trim() || `${name.trim()}'s Store`,
      // ── Bot configuration (customisable from dashboard settings) ──
      botName: 'فهيم',             // AI agent display name
      language: 'dz',              // dz=darija, ar=arabic, fr=french
      welcomeMessage: '',          // Custom greeting (optional)
      agentEnabled: true,          // Master on/off switch for AI replies
      // ── Account ──────────────────────────────────────────────────
      points: 100,                 // Free starter credits (100 message replies)
      plan: 'free',
      totalMessages: 0,
      connectedPlatforms: [],
      createdAt: Date.now(),
    };

    await userRef.set(userData);

    // Return token (exclude password hash)
    const { passwordHash: _, ...safeUser } = userData;
    const token = signToken(userRef.id, userData.email);

    return res.status(201).json({ token, user: safeUser });

  } catch (err) {
    console.error('Register error:', err.message);
    return res.status(500).json({ error: 'خطأ في السيرفر، حاول مرة أخرى' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  if (!checkFirebase(res)) return;

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'البريد وكلمة المرور مطلوبان' });
  }

  const db = getDb();

  try {
    const snap = await db.collection('users')
      .where('email', '==', email.toLowerCase().trim())
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
    }

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

    const passwordValid = await bcrypt.compare(password, userData.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
    }

    const { passwordHash: _, ...safeUser } = userData;
    const token = signToken(userDoc.id, userData.email);

    return res.json({ token, user: { id: userDoc.id, ...safeUser } });

  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'خطأ في السيرفر' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const snap = await db.collection('users').doc(req.tenant.userId).get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    const { passwordHash: _, ...safeUser } = snap.data();
    return res.json({ user: { id: snap.id, ...safeUser } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/auth/profile ──────────────────────────────────
router.patch('/profile', requireAuth, async (req, res) => {
  const db = getDb();
  const { name, storeName, welcomeMessage } = req.body;

  const updates = {};
  if (name) updates.name = name.trim();
  if (storeName) updates.storeName = storeName.trim();
  if (welcomeMessage !== undefined) updates.welcomeMessage = welcomeMessage;

  try {
    await db.collection('users').doc(req.tenant.userId).update(updates);
    return res.json({ success: true, updates });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
