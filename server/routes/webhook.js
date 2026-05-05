/**
 * FAHIM DZ — Meta Webhook Route
 * Handles: Instagram DM, Facebook Messenger, WhatsApp Business
 *
 * GET  /webhook/meta  → verification challenge
 * POST /webhook/meta  → receive messages
 *
 * KEY INSIGHT about Instagram DMs:
 * When connecting Instagram via Facebook Business Login (which is the ONLY way
 * Meta allows), IG DMs arrive in TWO possible formats:
 *
 *   Format A: object='instagram', entry.id = IG Business Account ID
 *             → handled by handleInstagramEntry()
 *
 *   Format B: object='page', entry.id = FB Page ID,
 *             msg.recipient.id = IG Business Account ID (≠ page ID)
 *             → comes through handleFacebookEntry() which must detect & route to IG
 *
 * Both formats must be handled. This is Meta's API design, not a bug in our app.
 */

const express = require('express');
const router = express.Router();
const { verifyMetaSignature } = require('../middleware/webhookVerify');
const { processMessage, findTenantByPageId, findTenantByPhoneId } = require('../services/messaging');
const { getDb } = require('../config/firebase');

// ── GET: Meta Webhook Verification ───────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Webhook verification failed:', { mode, token });
  return res.status(403).json({ error: 'Verification failed' });
});

// ── POST: Receive Messages ────────────────────────────────────
router.post('/', verifyMetaSignature, async (req, res) => {
  const body = req.body;

  // Always respond 200 immediately — Meta requires < 20s
  res.status(200).json({ status: 'EVENT_RECEIVED' });

  const entry0 = body.entry?.[0];
  const msg0   = entry0?.messaging?.[0];

  console.log('📨 Webhook received:', JSON.stringify({
    object:      body.object,
    entryCount:  body.entry?.length,
    entry0id:    entry0?.id,
    recipient0:  msg0?.recipient?.id,
    sender0:     msg0?.sender?.id,
    isEcho:      msg0?.message?.is_echo,
    text0:       msg0?.message?.text?.substring(0, 40),
    hasMessaging: !!(entry0?.messaging?.length),
    hasChanges:   !!(entry0?.changes?.length),
    ts: new Date().toISOString(),
  }));

  if (!['instagram', 'page', 'whatsapp_business_account'].includes(body.object)) {
    console.log('⚠️ Unknown webhook object:', body.object);
    return;
  }

  try {
    for (const entry of (body.entry || [])) {
      if (body.object === 'instagram') {
        await handleInstagramEntry(entry);
      } else if (body.object === 'page') {
        await handlePageEntry(entry);      // handles BOTH FB Messenger AND IG-via-page
      } else if (body.object === 'whatsapp_business_account') {
        await handleWhatsAppEntry(entry);
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});


// ── INSTAGRAM Handler (object='instagram') ───────────────────
// entry.id = IG Business Account ID (e.g. 17841448764600905)
async function handleInstagramEntry(entry) {
  const entryId   = entry.id;
  const messaging = entry.messaging || [];

  if (messaging.length === 0) return;

  console.log(`🔍 [IG object] entry.id=${entryId} msgs=${messaging.length}`);

  const registry = await findTenantByPageId(entryId);
  if (!registry) {
    console.warn(`⚠️ No tenant in webhook_registry for IG id: ${entryId}`);
    return;
  }

  const platform = await loadPlatformDoc(registry.userId, 'ig');
  if (!platform) return;

  const botIds = new Set([entryId, platform.igAccountId, platform.pageId].filter(Boolean));

  for (const msg of messaging) {
    const senderId = msg.sender?.id;
    if (msg.message?.is_echo) { console.log(`🔕 [IG] skip echo from ${senderId}`); continue; }
    if (botIds.has(senderId)) { console.log(`🔕 [IG] skip self-msg from ${senderId}`); continue; }

    // Extract text or audio URL from message
    const { messageText, audioUrl } = extractMessageContent(msg.message);

    if (!messageText && !audioUrl) {
      console.log(`🔕 [IG] skip non-text/non-audio from ${senderId} (type=${getAttachmentType(msg.message)})`);
      continue;
    }

    if (audioUrl) {
      console.log(`🎤 [IG] Voice message from ${senderId}: audioUrl=${audioUrl.substring(0, 60)}...`);
    } else {
      console.log(`📩 [IG] from ${senderId}: "${messageText?.substring(0, 60)}"`);
    }

    await processMessage(
      { platform: 'ig', senderId, senderName: null, messageText, audioUrl, messageId: msg.message?.mid, timestamp: msg.timestamp },
      registry.userId,
      platform
    );
  }
}


// ── PAGE Handler (object='page') ─────────────────────────────
// Handles BOTH:
//   • Facebook Messenger DMs  (msg.recipient.id === entry.id / page ID)
//   • Instagram DMs via Page  (msg.recipient.id === IG Business Account ID ≠ page ID)
async function handlePageEntry(entry) {
  const pageId    = entry.id;
  const messaging = entry.messaging || [];

  if (messaging.length === 0) return;

  console.log(`🔍 [page object] pageId=${pageId} msgs=${messaging.length}`);

  // Find tenant by FB page ID
  const registry = await findTenantByPageId(pageId);
  if (!registry) {
    console.warn(`⚠️ No tenant in webhook_registry for page: ${pageId}`);
    return;
  }

  // Load BOTH platform docs (we'll decide which to use per-message)
  const [fbPlatform, igPlatform] = await Promise.all([
    loadPlatformDoc(registry.userId, 'fb'),
    loadPlatformDoc(registry.userId, 'ig'),
  ]);

  for (const msg of messaging) {
    if (msg.message?.is_echo) { console.log(`🔕 [page] skip echo`); continue; }

    const senderId    = msg.sender?.id;
    const recipientId = msg.recipient?.id;

    // Extract text or audio URL from message
    const { messageText, audioUrl } = extractMessageContent(msg.message);

    // Skip if no useful content at all
    if (!messageText && !audioUrl) {
      console.log(`🔕 [page] skip non-text/non-audio from ${senderId} (type=${getAttachmentType(msg.message)})`);
      continue;
    }

    // ── Detect Instagram DM via page ─────────────────────────
    // When an IG DM arrives via the page object, recipient.id is the
    // IG Business Account ID, which is DIFFERENT from the FB Page ID.
    const isInstagramDM = igPlatform && recipientId && recipientId !== pageId
      && (recipientId === igPlatform.igAccountId || recipientId === igPlatform.pageId);

    if (isInstagramDM) {
      // Skip if sender is the bot itself
      const igBotIds = new Set([igPlatform.igAccountId, igPlatform.pageId, pageId].filter(Boolean));
      if (igBotIds.has(senderId)) { console.log(`🔕 [IG-via-page] skip self-msg`); continue; }

      if (audioUrl) {
        console.log(`🎤 [IG-via-page] Voice from ${senderId} → ${recipientId}`);
      } else {
        console.log(`📩 [IG-via-page] from ${senderId} → ${recipientId}: "${messageText?.substring(0, 60)}"`);
      }

      await processMessage(
        { platform: 'ig', senderId, senderName: null, messageText, audioUrl, messageId: msg.message?.mid, timestamp: msg.timestamp },
        registry.userId,
        igPlatform
      );
      continue;
    }

    // ── Regular Facebook Messenger DM ────────────────────────
    if (!fbPlatform) { console.warn(`⚠️ No fb platform doc for user ${registry.userId}`); continue; }
    if (senderId === pageId) { console.log(`🔕 [FB] skip echo`); continue; }

    if (audioUrl) {
      console.log(`🎤 [FB] Voice from ${senderId}`);
    } else {
      console.log(`📩 [FB] from ${senderId}: "${messageText?.substring(0, 60)}"`);
    }

    await processMessage(
      { platform: 'fb', senderId, senderName: null, messageText, audioUrl, messageId: msg.message?.mid, timestamp: msg.timestamp },
      registry.userId,
      fbPlatform
    );
  }
}


// ── WHATSAPP Handler ─────────────────────────────────────────
async function handleWhatsAppEntry(entry) {
  const waChanges = entry.changes || [];

  for (const change of waChanges) {
    if (change.field !== 'messages') continue;

    const value         = change.value;
    const phoneNumberId = value.metadata?.phone_number_id;
    const messages      = value.messages || [];

    if (!phoneNumberId || messages.length === 0) continue;

    const registry = await findTenantByPhoneId(phoneNumberId);
    if (!registry) {
      console.warn(`⚠️ No tenant for WA phone: ${phoneNumberId}`);
      continue;
    }

    const platform = await loadPlatformDoc(registry.userId, 'wa');
    if (!platform) continue;

    for (const msg of messages) {
      if (msg.type !== 'text') continue;

      const contact    = (value.contacts || []).find(c => c.wa_id === msg.from);
      const senderName = contact?.profile?.name || msg.from;

      console.log(`📩 [WA] from ${msg.from}: "${msg.text?.body?.substring(0, 60)}"`);
      await processMessage(
        { platform: 'wa', senderId: msg.from, senderName, messageText: msg.text?.body, messageId: msg.id, timestamp: msg.timestamp },
        registry.userId,
        platform
      );
    }
  }
}


// ── Helper: load platform doc from Firestore ─────────────────
async function loadPlatformDoc(userId, key) {
  try {
    const db   = getDb();
    const snap = await db.collection('users').doc(userId).collection('platforms').doc(key).get();
    if (!snap.exists) {
      console.warn(`⚠️ No platform doc: users/${userId}/platforms/${key}`);
      return null;
    }
    const raw = snap.data();
    return {
      type: key,
      ...raw,
      accessToken: raw.accessToken || raw.pageAccessToken || raw.token || '',
    };
  } catch (err) {
    console.error(`loadPlatformDoc(${userId}, ${key}) error:`, err.message);
    return null;
  }
}

// ── Helper: extract text and/or audio URL from a Meta message object ──
// Supports Instagram DMs and Facebook Messenger voice notes.
// Instagram/FB voice payload:
//   msg.attachments = [{ type: 'audio', payload: { url: '...' } }]
function extractMessageContent(message) {
  if (!message) return { messageText: null, audioUrl: null };

  const text = message.text || null;

  // Look for an audio attachment
  const attachments = message.attachments || [];
  const audioAttachment = attachments.find(a => a.type === 'audio');
  const audioUrl = audioAttachment?.payload?.url || null;

  return { messageText: text, audioUrl };
}

// ── Helper: get the attachment type string for logging ────────
function getAttachmentType(message) {
  if (!message) return 'none';
  const a = (message.attachments || [])[0];
  return a ? a.type : (message.text ? 'text' : 'none');
}

module.exports = router;
