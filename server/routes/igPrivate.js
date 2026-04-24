/**
 * FAHIM DZ — Instagram Private API Routes
 *
 * POST   /api/ig-private/connect      → login + save session
 * DELETE /api/ig-private/disconnect   → mark disconnected
 * GET    /api/ig-private/status       → check connection
 */

const express    = require('express');
const router     = express.Router();
const admin      = require('firebase-admin');
const { requireAuth }        = require('../middleware/auth');
const { getDb, isFirebaseReady } = require('../config/firebase');
const { connectIgPrivate }   = require('../services/igPrivate');

// ── POST /api/ig-private/connect ─────────────────────────────
router.post('/connect', requireAuth, async (req, res) => {
  const { username, password } = req.body;
  const userId = req.tenant.userId;

  if (!username?.trim() || !password) {
    return res.status(400).json({ error: 'اسم المستخدم وكلمة السر مطلوبان' });
  }

  if (!isFirebaseReady()) {
    return res.status(503).json({ error: 'Firebase غير متوفر' });
  }

  try {
    const result = await connectIgPrivate(userId, username.trim(), password);

    if (!result.success) {
      return res.status(400).json({
        error:      result.error,
        checkpoint: result.checkpoint || false,
      });
    }

    return res.json({
      success:  true,
      username: result.username,
      fullName: result.fullName || '',
    });

  } catch (err) {
    console.error('[IGP route] connect error:', err.message);
    return res.status(500).json({ error: 'حدث خطأ في السيرفر: ' + err.message });
  }
});

// ── DELETE /api/ig-private/disconnect ───────────────────────
router.delete('/disconnect', requireAuth, async (req, res) => {
  const userId = req.tenant.userId;

  if (!isFirebaseReady()) {
    return res.status(503).json({ error: 'Firebase غير متوفر' });
  }

  const db = getDb();
  try {
    // Mark as disconnected (keep session data for potential reconnect)
    await db.collection('users').doc(userId)
      .collection('platforms').doc('igp')
      .update({ connected: false, disconnectedAt: Date.now() });

    // Remove from connectedPlatforms list
    await db.collection('users').doc(userId).update({
      connectedPlatforms: admin.firestore.FieldValue.arrayRemove('igp'),
    });

    console.log(`[IGP] Disconnected for user ${userId}`);
    return res.json({ success: true });

  } catch (err) {
    console.error('[IGP route] disconnect error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ig-private/status ───────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  const userId = req.tenant.userId;

  if (!isFirebaseReady()) return res.json({ connected: false });

  const db = getDb();
  try {
    const snap = await db.collection('users').doc(userId)
      .collection('platforms').doc('igp').get();

    if (!snap.exists || !snap.data().connected) {
      return res.json({ connected: false });
    }

    const d = snap.data();
    return res.json({
      connected:        true,
      username:         d.username  || '',
      fullName:         d.fullName  || '',
      lastPoll:         d.lastPoll  || 0,
      disconnectReason: d.disconnectReason || null,
    });

  } catch (err) {
    console.error('[IGP route] status error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
