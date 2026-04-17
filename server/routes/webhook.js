/**
 * FAHIM DZ — Meta Webhook Route
 * Handles: Instagram DM, Facebook Messenger, WhatsApp Business
 *
 * GET  /webhook/meta  → verification challenge
 * POST /webhook/meta  → receive messages
 */

const express = require('express');
const router = express.Router();
const { verifyMetaSignature } = require('../middleware/webhookVerify');
const { processMessage, findTenantByPageId, findTenantByPhoneId } = require('../services/messaging');
const { getDb } = require('../config/firebase');

// ── GET: Meta Webhook Verification ──────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Webhook verification failed:', { mode, token });
  return res.status(403).json({ error: 'Verification failed' });
});

// ── POST: Receive Messages ───────────────────────────────────
router.post('/', verifyMetaSignature, async (req, res) => {
  const body = req.body;

  // LOG EVERY INCOMING WEBHOOK — visible in Render logs
  const entry0 = body.entry?.[0];
  const msg0   = entry0?.messaging?.[0];
  console.log('📨 Webhook received:', JSON.stringify({
    object: body.object,
    entryCount: body.entry?.length,
    entry0id: entry0?.id,
    sender0id: msg0?.sender?.id,
    isEcho: msg0?.message?.is_echo,
    text0: msg0?.message?.text?.substring(0,40),
    hasMessaging: !!(entry0?.messaging?.length),
    hasChanges: !!(entry0?.changes?.length),
    timestamp: new Date().toISOString(),
  }));

  // Always respond 200 immediately (Meta requires < 20s)
  res.status(200).json({ status: 'EVENT_RECEIVED' });

  if (body.object !== 'instagram' && body.object !== 'page' && body.object !== 'whatsapp_business_account') {
    console.log('⚠️ Unknown webhook object type:', body.object);
    return;
  }

  try {
    for (const entry of (body.entry || [])) {

      // ── INSTAGRAM Direct Messages ──────────────────────────
      if (body.object === 'instagram') {
        await handleInstagramEntry(entry);
        continue;
      }

      // ── FACEBOOK Messenger ─────────────────────────────────
      if (body.object === 'page') {
        await handleFacebookEntry(entry);
        continue;
      }

      // ── WHATSAPP Business ──────────────────────────────────
      if (body.object === 'whatsapp_business_account') {
        await handleWhatsAppEntry(entry);
        continue;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});



// ── INSTAGRAM Handler ────────────────────────────────────────
async function handleInstagramEntry(entry) {
  // entry.id for instagram object can be the IG Business Account ID (17841448764600905)
  // or sometimes the FB Page ID (586509198429031). We look up both via webhook_registry.
  const entryId = entry.id;
  const messaging = entry.messaging || [];

  if (messaging.length === 0) return;

  console.log(`🔍 IG entry.id=${entryId} messaging=${messaging.length}`);

  // Find tenant via webhook_registry (works for both IG ID and FB Page ID)
  const registry = await findTenantByPageId(entryId);
  if (!registry) {
    console.warn(`⚠️ No tenant found for IG entry id: ${entryId}`);
    return;
  }

  const db = getDb();
  const platformSnap = await db
    .collection('users').doc(registry.userId)
    .collection('platforms').doc('ig')
    .get();

  if (!platformSnap.exists) {
    console.warn(`⚠️ No IG platform doc for user ${registry.userId}`);
    return;
  }

  const rawPlatform = platformSnap.data();
  const platform = {
    type: 'ig',
    ...rawPlatform,
    accessToken: rawPlatform.accessToken || rawPlatform.pageAccessToken || rawPlatform.token || '',
  };

  // IDs that belong to the bot itself — skip any message FROM these
  const botIds = new Set([
    entryId,
    rawPlatform.igAccountId || '',
    rawPlatform.pageId || '',
  ].filter(Boolean));

  for (const msg of messaging) {
    const senderId = msg.sender?.id;

    // ── Skip echo / messages sent by the bot itself ─────────
    if (msg.message?.is_echo) {
      console.log(`🔕 Skipping is_echo from ${senderId}`);
      continue;
    }
    if (botIds.has(senderId)) {
      console.log(`🔕 Skipping bot self-message from ${senderId}`);
      continue;
    }
    if (!msg.message?.text) {
      console.log(`🔕 Skipping non-text IG message type from ${senderId}`);
      continue;
    }

    console.log(`📩 IG message from ${senderId}: "${msg.message.text?.substring(0, 50)}"`);

    const event = {
      platform: 'ig',
      senderId,
      senderName: null,
      messageText: msg.message.text,
      messageId: msg.message.mid,
      timestamp: msg.timestamp,
    };

    await processMessage(event, registry.userId, platform);
  }
}



// ── FACEBOOK Handler ─────────────────────────────────────────
async function handleFacebookEntry(entry) {
  const pageId = entry.id;
  const messaging = entry.messaging || [];

  const registry = await findTenantByPageId(pageId);
  if (!registry) {
    console.warn(`⚠️ No tenant found for FB page: ${pageId}`);
    return;
  }

  const db = getDb();
  const platformSnap = await db
    .collection('users').doc(registry.userId)
    .collection('platforms').doc('fb')
    .get();

  if (!platformSnap.exists) return;
  const rawPlatformFb = platformSnap.data();
  const platform = {
    type: 'fb',
    ...rawPlatformFb,
    accessToken: rawPlatformFb.accessToken || rawPlatformFb.pageAccessToken || rawPlatformFb.token || '',
  };

  for (const msg of messaging) {
    if (msg.sender?.id === pageId) continue; // Echo
    if (!msg.message?.text) continue;

    const event = {
      platform: 'fb',
      senderId: msg.sender.id,
      senderName: null,
      messageText: msg.message.text,
      messageId: msg.message.mid,
      timestamp: msg.timestamp,
    };

    await processMessage(event, registry.userId, platform);
  }
}


// ── WHATSAPP Handler ─────────────────────────────────────────
async function handleWhatsAppEntry(entry) {
  const waChanges = entry.changes || [];

  for (const change of waChanges) {
    if (change.field !== 'messages') continue;

    const value = change.value;
    const phoneNumberId = value.metadata?.phone_number_id;
    const messages = value.messages || [];

    if (!phoneNumberId || messages.length === 0) continue;

    const registry = await findTenantByPhoneId(phoneNumberId);
    if (!registry) {
      console.warn(`⚠️ No tenant found for WA phone: ${phoneNumberId}`);
      continue;
    }

    const db = getDb();
    const platformSnap = await db
      .collection('users').doc(registry.userId)
      .collection('platforms').doc('wa')
      .get();

    if (!platformSnap.exists) continue;
    const rawPlatformWa = platformSnap.data();
    const platform = {
      type: 'wa',
      ...rawPlatformWa,
      accessToken: rawPlatformWa.accessToken || rawPlatformWa.systemToken || rawPlatformWa.token || '',
    };

    for (const msg of messages) {
      if (msg.type !== 'text') continue; // Skip media for now

      const contact = (value.contacts || []).find(c => c.wa_id === msg.from);
      const senderName = contact?.profile?.name || msg.from;

      const event = {
        platform: 'wa',
        senderId: msg.from, // phone number
        senderName,
        messageText: msg.text?.body,
        messageId: msg.id,
        timestamp: msg.timestamp,
      };

      await processMessage(event, registry.userId, platform);
    }
  }
}

module.exports = router;
