/**
 * FAHIM DZ — Telegram Bot Integration
 *
 * Zero-verification alternative to Instagram/Facebook.
 * Each tenant creates a bot via @BotFather and pastes the token here.
 *
 * Routes:
 *   POST /api/telegram/connect          — validate token, save, set webhook
 *   DELETE /api/telegram/disconnect     — remove bot + delete webhook
 *   GET  /api/telegram/status           — check if bot is live
 *   POST /webhook/telegram/:userId      — receive Telegram messages (public)
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const { getDb, isFirebaseReady } = require('../config/firebase');
const { processMessage }         = require('../services/messaging');

const TG_API = 'https://api.telegram.org/bot';
const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ── Helper: call Telegram API ─────────────────────────────────
async function tgCall(token, method, params = {}) {
  const res = await axios.post(`${TG_API}${token}/${method}`, params);
  return res.data;
}

// ── Helper: get userId from JWT ───────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Token invalid' });
  }
}

// ── POST /api/telegram/connect ────────────────────────────────
router.post('/connect', authMiddleware, async (req, res) => {
  const { botToken } = req.body;
  if (!botToken || !botToken.includes(':')) {
    return res.status(400).json({ error: 'أدخل توكن البوت الصحيح — يجده في @BotFather' });
  }

  try {
    // 1. Validate token — getMe returns bot info
    let botInfo;
    try {
      const meRes = await tgCall(botToken, 'getMe');
      if (!meRes.ok) throw new Error('Invalid token');
      botInfo = meRes.result;
    } catch {
      return res.status(400).json({ error: 'التوكن غير صحيح — تحقق من @BotFather وأعد المحاولة' });
    }

    // 2. Set webhook so Telegram sends messages to our server
    const webhookUrl = `${BASE_URL}/webhook/telegram/${req.userId}`;
    const whRes = await tgCall(botToken, 'setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
    });

    if (!whRes.ok) {
      return res.status(500).json({ error: 'فشل تسجيل Webhook: ' + whRes.description });
    }

    // 3. Save to Firestore
    if (isFirebaseReady()) {
      const db = getDb();
      const platformData = {
        platform:    'tg',
        botToken,
        botId:       botInfo.id,
        botUsername: botInfo.username,
        botName:     botInfo.first_name,
        webhookUrl,
        connectedAt: Date.now(),
        active:      true,
      };
      await db.collection('users').doc(req.userId).collection('platforms').doc('tg').set(platformData);

      // Update connectedPlatforms array on user doc
      const userRef  = db.collection('users').doc(req.userId);
      const userSnap = await userRef.get();
      const current  = userSnap.data()?.connectedPlatforms || [];
      if (!current.includes('tg')) {
        await userRef.update({ connectedPlatforms: [...current, 'tg'] });
      }
    }

    console.log(`✅ Telegram bot connected: @${botInfo.username} for user ${req.userId}`);
    return res.json({
      success:     true,
      botUsername: botInfo.username,
      botName:     botInfo.first_name,
      webhookUrl,
    });

  } catch (err) {
    console.error('Telegram connect error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/telegram/disconnect ──────────────────────────
router.delete('/disconnect', authMiddleware, async (req, res) => {
  try {
    if (!isFirebaseReady()) return res.json({ success: true });
    const db   = getDb();
    const snap = await db.collection('users').doc(req.userId).collection('platforms').doc('tg').get();

    if (snap.exists) {
      const { botToken } = snap.data();
      // Delete Telegram webhook
      try { await tgCall(botToken, 'deleteWebhook'); } catch { /* non-critical */ }
      await db.collection('users').doc(req.userId).collection('platforms').doc('tg').update({ active: false });
    }

    const userRef  = db.collection('users').doc(req.userId);
    const userSnap = await userRef.get();
    const current  = (userSnap.data()?.connectedPlatforms || []).filter(p => p !== 'tg');
    await userRef.update({ connectedPlatforms: current });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/telegram/status ──────────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    if (!isFirebaseReady()) return res.json({ connected: false });
    const db   = getDb();
    const snap = await db.collection('users').doc(req.userId).collection('platforms').doc('tg').get();
    if (!snap.exists || !snap.data().active) return res.json({ connected: false });
    const d = snap.data();
    return res.json({ connected: true, botUsername: d.botUsername, botName: d.botName });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook/telegram/:userId ────────────────────────────
// Telegram sends all updates here. This is a PUBLIC route (no auth header),
// because Telegram calls it directly.
router.post('/webhook/:userId', async (req, res) => {
  // Always respond 200 immediately
  res.status(200).json({ ok: true });

  const userId = req.params.userId;
  const update = req.body;

  // Only handle text messages
  const message = update.message;
  if (!message?.text) return;

  const chatId     = message.chat.id;
  const senderId   = String(message.from?.id || chatId);
  const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
    || message.from?.username || senderId;
  const messageText = message.text;
  const messageId   = String(message.message_id);

  console.log(`📩 [TG] from ${senderName} (${senderId}): "${messageText.substring(0, 60)}"`);

  try {
    if (!isFirebaseReady()) return;
    const db   = getDb();
    const snap = await db.collection('users').doc(userId).collection('platforms').doc('tg').get();

    if (!snap.exists || !snap.data().active) {
      console.warn(`⚠️ [TG] No active Telegram platform for user ${userId}`);
      return;
    }

    const platData = snap.data();
    const platform = {
      type:        'tg',
      ...platData,
      accessToken: platData.botToken, // processMessage expects accessToken
      chatId,                         // needed for reply routing
    };

    const event = {
      platform:    'tg',
      senderId,
      senderName,
      messageText,
      messageId,
      timestamp:   message.date * 1000,
      chatId,      // Telegram needs chatId to reply, not just senderId
    };

    await processMessage(event, userId, platform);

  } catch (err) {
    console.error(`Telegram webhook error for user ${userId}:`, err.message);
  }
});

module.exports = router;
