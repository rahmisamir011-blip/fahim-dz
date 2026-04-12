/**
 * FAHIM DZ — Core Messaging Service
 * Orchestrates: webhook event → AI → Meta reply → Firestore save
 */

const { getDb } = require('../config/firebase');
const { generateReply } = require('./ai');
const metaService = require('./meta');

/**
 * Process an incoming message from any platform
 * @param {object} event - normalized event from webhook parser
 * @param {string} tenantId - the user/tenant who owns the platform
 * @param {object} platform - { type, accessToken, phoneNumberId, pageId }
 */
async function processMessage(event, tenantId, platform) {
  const db = getDb();
  const { senderId, senderName, messageText, platform: platformType, messageId } = event;

  if (!messageText || messageText.trim() === '') return;

  try {
    // ── 1. Check tenant points balance ──────────────────────
    const userRef = db.collection('users').doc(tenantId);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      console.warn(`⚠️ Tenant ${tenantId} not found`);
      return;
    }

    const userData = userSnap.data();

    if ((userData.points || 0) <= 0) {
      console.log(`💸 Tenant ${tenantId} has 0 points — skipping reply`);
      return;
    }

    // ── 2. Load conversation history ────────────────────────
    const convId = `${platformType}_${senderId}`;
    const convRef = db
      .collection('users').doc(tenantId)
      .collection('conversations').doc(convId);

    const convSnap = await convRef.get();
    const existingConv = convSnap.exists ? convSnap.data() : null;
    const history = existingConv?.messages || [];

    // ── 3. Load products for context ────────────────────────
    const productsSnap = await db
      .collection('users').doc(tenantId)
      .collection('products')
      .limit(20)
      .get();

    const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // ── 4. Generate AI reply ────────────────────────────────
    const { reply, orderData } = await generateReply(messageText, history, products);

    // ── 5. Send reply via Meta ──────────────────────────────
    let sendResult;

    if (platformType === 'ig') {
      sendResult = await metaService.sendInstagramMessage(
        senderId, reply, platform.accessToken
      );
    } else if (platformType === 'fb') {
      sendResult = await metaService.sendFacebookMessage(
        senderId, reply, platform.accessToken
      );
    } else if (platformType === 'wa') {
      sendResult = await metaService.sendWhatsAppMessage(
        platform.phoneNumberId, senderId, reply, platform.accessToken
      );
      // Mark as read
      if (messageId) {
        await metaService.markWhatsAppRead(
          platform.phoneNumberId, messageId, platform.accessToken
        );
      }
    }

    console.log(`✅ [${platformType.toUpperCase()}] Reply sent to ${senderId}: "${reply.substring(0, 40)}..."`);

    // ── 6. Save conversation to Firestore ──────────────────
    const now = Date.now();
    const updatedHistory = [
      ...history,
      { role: 'user', content: messageText, ts: now },
      { role: 'assistant', content: reply, ts: now },
    ].slice(-40); // Keep last 40 messages max

    const convUpdate = {
      platform: platformType,
      senderId,
      senderName: senderName || senderId,
      messages: updatedHistory,
      lastMessage: messageText,
      lastReply: reply,
      updatedAt: now,
    };

    if (!convSnap.exists) {
      convUpdate.createdAt = now;
    }

    await convRef.set(convUpdate, { merge: true });

    // ── 7. If order confirmed → create order in Firestore ──
    if (orderData?.intent === 'order_confirmed') {
      const orderRef = db
        .collection('users').doc(tenantId)
        .collection('orders')
        .doc();

      await orderRef.set({
        id: orderRef.id,
        client: orderData.client || senderName || senderId,
        product: orderData.product || 'غير محدد',
        qty: orderData.qty || 1,
        price: orderData.price || 0,
        phone: orderData.phone || '',
        wilaya: orderData.wilaya || '',
        source: platformType,
        status: 'pending',
        conversationId: convId,
        createdAt: now,
      });

      console.log(`📦 Auto-order created for ${tenantId}: ${orderData.product}`);
    }

    // ── 8. Deduct 1 point ──────────────────────────────────
    await userRef.update({
      points: Math.max(0, (userData.points || 0) - 1),
      totalMessages: (userData.totalMessages || 0) + 1,
    });

  } catch (err) {
    console.error(`❌ processMessage error [${platformType}/${senderId}]:`, err.message);
  }
}

/**
 * Find the tenant who owns a given page/phone ID
 * Uses the webhook_registry collection for fast lookup
 */
async function findTenantByPageId(pageId) {
  const db = getDb();
  try {
    const snap = await db.collection('webhook_registry').doc(pageId).get();
    if (snap.exists) return snap.data();
    return null;
  } catch (err) {
    console.error('findTenantByPageId error:', err.message);
    return null;
  }
}

/**
 * Find the tenant who owns a given WhatsApp phone number ID
 */
async function findTenantByPhoneId(phoneNumberId) {
  return findTenantByPageId(phoneNumberId);
}

module.exports = { processMessage, findTenantByPageId, findTenantByPhoneId };
