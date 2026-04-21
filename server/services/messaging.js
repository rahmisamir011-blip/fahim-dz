/**
 * FAHIM DZ — Core Messaging Service
 * Multi-tenant: each message is routed to its owner's bot, using
 * that tenant's configuration, products, and conversation history.
 *
 * Pipeline:
 *   webhook → findTenant → loadConfig → agentToggle check →
 *   loadHistory → loadProducts → AI reply → send → save → deduct credit
 */

const { getDb } = require('../config/firebase');
const { generateReply } = require('./ai');
const metaService = require('./meta');

// ─────────────────────────────────────────────────────────────
// Main Message Processor
// ─────────────────────────────────────────────────────────────

/**
 * Process an incoming message for a specific tenant
 * @param {object} event    - { platform, senderId, senderName, messageText, messageId, timestamp }
 * @param {string} tenantId - Firestore userId of the page owner
 * @param {object} platform - { type, accessToken, pageId, igAccountId, ... }
 */
async function processMessage(event, tenantId, platform) {
  const db = getDb();
  const { senderId, senderName, messageText, platform: platformType, messageId } = event;

  console.log(`\n📩 [${platformType.toUpperCase()}] tenant=${tenantId} sender=${senderId} text="${messageText?.substring(0, 40)}"`);

  if (!messageText?.trim()) return;

  try {
    // ── 1. Load tenant config ─────────────────────────────────
    const userRef  = db.collection('users').doc(tenantId);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      console.warn(`⚠️ Tenant ${tenantId} not found in Firestore`);
      return;
    }

    const userData = userSnap.data();

    // ── 2. Check agent toggle (per-tenant on/off switch) ──────
    // agentEnabled defaults to true if not set (backwards compat)
    if (userData.agentEnabled === false) {
      console.log(`🔕 Agent disabled for tenant ${tenantId} (${userData.storeName}) — skipping reply`);
      return;
    }

    // ── 3. Check credit balance ───────────────────────────────
    const balance = userData.points ?? userData.credits ?? 0;
    if (balance <= 0) {
      console.warn(`💸 Tenant ${tenantId} (${userData.storeName}) has no credits — skipping reply`);
      return;
    }

    // ── 4. Load conversation history ──────────────────────────
    const convId  = `${platformType}_${senderId}`;
    const convRef = db.collection('users').doc(tenantId).collection('conversations').doc(convId);
    const convSnap = await convRef.get();
    const history  = convSnap.exists ? (convSnap.data().messages || []) : [];

    // ── 5. Load tenant products ───────────────────────────────
    const productsSnap = await db
      .collection('users').doc(tenantId)
      .collection('products')
      .where('active', '!=', false)   // only active products
      .limit(30)
      .get();

    const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // ── 6. Build tenant config for AI ─────────────────────────
    const tenantConfig = {
      storeName:      userData.storeName      || 'المتجر',
      botName:        userData.botName        || 'فهيم',
      language:       userData.language       || 'dz',
      welcomeMessage: userData.welcomeMessage || '',
    };

    // ── 7. Generate AI reply ──────────────────────────────────
    const { reply, orderData } = await generateReply(
      messageText, history, products, tenantConfig
    );

    console.log(`🤖 [${platformType.toUpperCase()}] AI reply for ${userData.storeName}: "${reply.substring(0, 60)}..."`);

    // ── 8. Send reply via Meta Graph API ──────────────────────
    let sendResult;

    if (platformType === 'ig') {
      const igAccountId = platform.igAccountId || platform.pageId || '';
      console.log(`📤 IG → ${senderId} via igAccountId=${igAccountId}`);
      sendResult = await metaService.sendInstagramMessage(
        senderId, reply, platform.accessToken, igAccountId
      );
    } else if (platformType === 'fb') {
      console.log(`📤 FB → ${senderId}`);
      sendResult = await metaService.sendFacebookMessage(
        senderId, reply, platform.accessToken
      );
    } else if (platformType === 'wa') {
      console.log(`📤 WA → ${senderId}`);
      sendResult = await metaService.sendWhatsAppMessage(
        platform.phoneNumberId, senderId, reply, platform.accessToken
      );
      if (messageId) {
        await metaService.markWhatsAppRead(
          platform.phoneNumberId, messageId, platform.accessToken
        ).catch(() => {}); // non-critical
      }
    }

    const sent = sendResult?.success;
    console.log(`${sent ? '✅' : '❌'} [${platformType.toUpperCase()}] send to ${senderId}: ${sent ? 'ok' : sendResult?.error}`);

    // ── 9. Save conversation to Firestore ─────────────────────
    const now = Date.now();
    const updatedHistory = [
      ...history,
      { role: 'user',      content: messageText, ts: now },
      { role: 'assistant', content: reply,        ts: now },
    ].slice(-40); // keep last 40 messages

    await convRef.set({
      platform:    platformType,
      senderId,
      senderName:  senderName || senderId,
      messages:    updatedHistory,
      lastMessage: messageText,
      lastReply:   reply,
      replySent:   sent,
      updatedAt:   now,
      ...(convSnap.exists ? {} : { createdAt: now }),
    }, { merge: true });

    // ── 10. If order confirmed → create order doc ─────────────
    if (orderData?.intent === 'order_confirmed') {
      const orderRef = db
        .collection('users').doc(tenantId)
        .collection('orders').doc();

      await orderRef.set({
        id:             orderRef.id,
        client:         orderData.client  || senderName || senderId,
        product:        orderData.product || 'غير محدد',
        qty:            orderData.qty     || 1,
        price:          orderData.price   || 0,
        phone:          orderData.phone   || '',
        wilaya:         orderData.wilaya  || '',
        source:         platformType,
        status:         'pending',
        conversationId: convId,
        createdAt:      now,
      });

      console.log(`📦 Auto-order created for ${userData.storeName}: ${orderData.product}`);
    }

    // ── 11. Deduct 1 credit ───────────────────────────────────
    if (sent !== false) { // only deduct if send was attempted
      await userRef.update({
        points:        Math.max(0, balance - 1),
        totalMessages: (userData.totalMessages || 0) + 1,
      });
    }

  } catch (err) {
    console.error(`❌ processMessage error [${platformType}/${senderId}/${tenantId}]:`, err.message);
    // Don't re-throw — webhook must always return 200 to Meta
  }
}

// ─────────────────────────────────────────────────────────────
// Tenant Lookup (fast O(1) via webhook_registry)
// ─────────────────────────────────────────────────────────────

/**
 * Find the tenant who owns a given Facebook Page ID or IG Business Account ID.
 * Uses the webhook_registry collection for O(1) lookup.
 * @param {string} pageId - FB Page ID or IG Business Account ID
 * @returns {object|null} { userId, platform, fbPageId } or null
 */
async function findTenantByPageId(pageId) {
  if (!pageId) return null;
  const db = getDb();
  try {
    const snap = await db.collection('webhook_registry').doc(String(pageId)).get();
    if (snap.exists) {
      console.log(`🔍 webhook_registry: ${pageId} → userId=${snap.data().userId}`);
      return snap.data();
    }
    console.warn(`⚠️ webhook_registry: no entry for id=${pageId}`);
    return null;
  } catch (err) {
    console.error('findTenantByPageId error:', err.message);
    return null;
  }
}

/**
 * Find tenant by WhatsApp phone number ID (same lookup, different name)
 */
async function findTenantByPhoneId(phoneNumberId) {
  return findTenantByPageId(phoneNumberId);
}

module.exports = { processMessage, findTenantByPageId, findTenantByPhoneId };
