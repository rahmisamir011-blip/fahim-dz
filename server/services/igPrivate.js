/**
 * FAHIM DZ — Instagram Private API Service
 * ─────────────────────────────────────────────────────────────
 * Allows clients to connect Instagram via username + password.
 * Polls DMs every 60s and replies with AI — NO Meta App Review needed.
 *
 * ⚠️  This uses Instagram's private (undocumented) API.
 *      Use responsibly. High-volume abuse may trigger account flags.
 */

const { IgApiClient } = require('instagram-private-api');
const { getDb, isFirebaseReady } = require('../config/firebase');
const { generateReply } = require('./ai');

// ─────────────────────────────────────────────────────────────
// Connect — login and save session to Firestore
// ─────────────────────────────────────────────────────────────

/**
 * Connect an Instagram account for a tenant.
 * Saves session state (NOT the password) to Firestore.
 */
async function connectIgPrivate(userId, username, password) {
  const ig = new IgApiClient();
  ig.state.generateDevice(username.toLowerCase().trim());

  try {
    await ig.simulate.preLoginFlow();
    const account = await ig.account.login(username.trim(), password);

    // Post-login simulation (non-critical)
    try { await ig.simulate.postLoginFlow(); } catch (_) {}

    const sessionState = JSON.stringify(await ig.exportState());

    if (!isFirebaseReady()) throw new Error('Firebase not ready');
    const db = getDb();

    await db.collection('users').doc(userId).collection('platforms').doc('igp').set({
      platform:      'igp',
      username:      account.username,
      fullName:      account.full_name || '',
      igUserId:      String(account.pk),
      sessionState,                     // serialised cookies — NOT the password
      connected:     true,
      connectedAt:   Date.now(),
      seenMessageIds: [],               // tracks processed messages
      lastPoll:      0,
    });

    // Add 'igp' to connectedPlatforms array
    const userRef  = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    const current  = userSnap.data()?.connectedPlatforms || [];
    if (!current.includes('igp')) {
      await userRef.update({ connectedPlatforms: [...current, 'igp'] });
    }

    console.log(`✅ [IGP] Connected @${account.username} for user ${userId}`);
    return { success: true, username: account.username, fullName: account.full_name };

  } catch (err) {
    const msg      = err.message || '';
    const msgLower = msg.toLowerCase();
    const status   = err.response?.statusCode || err.response?.status;
    const body     = err.response?.body || {};

    console.error('[IGP] connect error:', err.name, status, msg.substring(0, 200));

    // ── Account linked to Facebook login ──────────────────────────
    if (msgLower.includes('facebook') || msgLower.includes('linked')) {
      return {
        success: false,
        error:
          '⚠️ هذا الحساب مرتبط بفيسبوك.\n\n' +
          'افصل الحساب عن فيسبوك من:\n' +
          'Instagram → الإعدادات → المركز → الحسابات المرتبطة → افصل',
      };
    }

    // ── Suspicious login / email verification challenge ───────────
    // "We can send you an email to help you get back into your account"
    if (
      msgLower.includes('send you an email') ||
      msgLower.includes('get back into your account') ||
      msgLower.includes('verify') ||
      msgLower.includes('suspicious') ||
      msgLower.includes('unusual')
    ) {
      return {
        success: false,
        suspicious: true,
        error:
          '🔐 Instagram اكتشف محاولة دخول مشبوهة من سيرفر خارجي.\n\n' +
          'الحل:\n' +
          '1. افتح تطبيق Instagram على هاتفك\n' +
          '2. ابحث عن إشعار أمني أو بريد إلكتروني من Instagram\n' +
          '3. اضغط "السماح بتسجيل الدخول"\n' +
          '4. ارجع وحاول الربط مرة أخرى',
      };
    }

    // ── 2FA / Checkpoint ──────────────────────────────────────────
    if (
      err.name === 'IgCheckpointError' ||
      msgLower.includes('checkpoint') ||
      msgLower.includes('challenge')
    ) {
      return {
        success:    false,
        checkpoint: true,
        error:
          '📱 Instagram طلب تأكيد الهوية.\n' +
          'افتح تطبيق Instagram على هاتفك، وافق على طلب تسجيل الدخول، ثم حاول مرة أخرى بعد دقيقة.',
      };
    }

    // ── Wrong password / account locked ──────────────────────────
    if (
      err.name === 'IgLoginRequiredError' ||
      msgLower.includes('login_required') ||
      msgLower.includes('password') ||
      msgLower.includes('incorrect') ||
      msgLower.includes('bad_password')
    ) {
      return { success: false, error: '❌ كلمة السر غير صحيحة أو الحساب محظور مؤقتاً.' };
    }

    // ── Rate limited ──────────────────────────────────────────────
    if (status === 429 || msgLower.includes('too many') || msgLower.includes('rate')) {
      return { success: false, error: '⏳ محاولات كثيرة — انتظر 10 دقائق ثم حاول مجدداً.' };
    }

    // ── Generic fallback ──────────────────────────────────────────
    return { success: false, error: `❌ خطأ في الاتصال: ${msg.substring(0, 120)}` };
  }
}

// ─────────────────────────────────────────────────────────────
// Poll DMs for a single tenant
// ─────────────────────────────────────────────────────────────

async function pollUserDMs(userId, igpData, tenantConfig, products) {
  const ig = new IgApiClient();

  // Restore session
  try {
    await ig.importState(JSON.parse(igpData.sessionState));
  } catch (parseErr) {
    console.error(`[IGP] Bad session for ${userId}: ${parseErr.message}`);
    return;
  }

  const db         = getDb();
  const seenIds    = new Set(igpData.seenMessageIds || []);
  const newSeenIds = new Set(seenIds);

  try {
    const inbox   = ig.feed.directInbox();
    const threads = await inbox.items();

    for (const thread of threads.slice(0, 15)) {
      const lastItem = thread.items?.[0];
      if (!lastItem) continue;

      const msgId = lastItem.item_id;

      // Already processed
      if (seenIds.has(msgId)) continue;
      newSeenIds.add(msgId);

      // Only handle text messages
      if (lastItem.item_type !== 'text' || !lastItem.text?.trim()) continue;

      // Skip our own messages
      if (String(lastItem.user_id) === String(igpData.igUserId)) continue;

      // Skip messages that arrived before we connected (avoid replying to old DMs)
      const msgTimeSec = Math.floor(Number(lastItem.timestamp) / 1000);
      const connectedAtSec = Math.floor((igpData.connectedAt || 0) / 1000);
      if (msgTimeSec < connectedAtSec - 30) continue;

      const messageText    = lastItem.text.trim();
      const senderId       = String(lastItem.user_id);
      const senderUsername = thread.users?.find(u => String(u.pk) === senderId)?.username || senderId;
      const threadId       = thread.thread_id;

      console.log(`\n📩 [IGP] @${igpData.username} ← @${senderUsername}: "${messageText.substring(0, 50)}"`);

      // Load conversation history
      const convId    = `igp_${senderId}`;
      const convRef   = db.collection('users').doc(userId).collection('conversations').doc(convId);
      const convSnap  = await convRef.get();
      const history   = convSnap.exists ? (convSnap.data().messages || []) : [];

      // Generate AI reply
      const { reply, orderData } = await generateReply(messageText, history, products, tenantConfig);
      if (!reply) continue;

      console.log(`🤖 [IGP] Reply: "${reply.substring(0, 60)}..."`);

      // Send reply
      let sent = false;
      try {
        await ig.entity.directThread(threadId).broadcastText({ text: reply });
        sent = true;
        console.log(`✅ [IGP] Sent to @${senderUsername}`);
      } catch (sendErr) {
        console.error(`❌ [IGP] Send failed for @${senderUsername}: ${sendErr.message}`);
      }

      // Save conversation to Firestore
      const now           = Date.now();
      const updatedHistory = [
        ...history,
        { role: 'user',      content: messageText, ts: now },
        { role: 'assistant', content: reply,        ts: now },
      ].slice(-40);

      await convRef.set({
        platform:    'igp',
        senderId,
        senderName:  senderUsername,
        messages:    updatedHistory,
        lastMessage: messageText,
        lastReply:   reply,
        replySent:   sent,
        updatedAt:   now,
        ...(convSnap.exists ? {} : { createdAt: now }),
      }, { merge: true });

      // Auto-create order if AI confirmed one
      if (orderData?.intent === 'order_confirmed') {
        const orderRef = db.collection('users').doc(userId).collection('orders').doc();
        await orderRef.set({
          id:             orderRef.id,
          client:         orderData.client  || senderUsername,
          product:        orderData.product || 'غير محدد',
          qty:            orderData.qty     || 1,
          price:          orderData.price   || 0,
          phone:          orderData.phone   || '',
          wilaya:         orderData.wilaya  || '',
          source:         'igp',
          status:         'pending',
          conversationId: convId,
          createdAt:      now,
        });
        console.log(`📦 [IGP] Auto-order created for @${igpData.username}`);
      }

      // Deduct 1 credit
      if (sent) {
        const userRef  = db.collection('users').doc(userId);
        const userSnap = await userRef.get();
        const balance  = userSnap.data()?.points ?? 0;
        await userRef.update({
          points:        Math.max(0, balance - 1),
          totalMessages: (userSnap.data()?.totalMessages || 0) + 1,
        });
      }

      // Small delay between replies to avoid rate limiting
      await new Promise(r => setTimeout(r, 1500));
    }

    // Persist updated session state (cookies may have refreshed) and seen IDs
    const freshSession = JSON.stringify(await ig.exportState());
    await db.collection('users').doc(userId).collection('platforms').doc('igp').update({
      seenMessageIds: Array.from(newSeenIds).slice(-300),
      sessionState:   freshSession,
      lastPoll:       Date.now(),
    });

  } catch (err) {
    const isSessionErr = err.name?.includes('Login') || err.message?.includes('login_required') || err.message?.includes('checkpoint');
    console.error(`❌ [IGP] Poll error for ${userId}: ${err.message}`);

    if (isSessionErr) {
      // Session expired — mark disconnected so user knows to reconnect
      await db.collection('users').doc(userId).collection('platforms').doc('igp').update({
        connected:         false,
        disconnectedAt:    Date.now(),
        disconnectReason:  'انتهت الجلسة — أعد الربط من لوحة التحكم',
      }).catch(() => {});
      console.warn(`⚠️ [IGP] Session expired for ${userId} — marked disconnected`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Poll all tenants who have IGP connected
// ─────────────────────────────────────────────────────────────

async function pollAllIgPrivateUsers() {
  if (!isFirebaseReady()) return;

  const db = getDb();
  try {
    const usersSnap = await db.collection('users').get();

    for (const userDoc of usersSnap.docs) {
      const userId   = userDoc.id;
      const userData = userDoc.data();

      // Skip if agent off or no credits
      if (userData.agentEnabled === false) continue;
      if ((userData.points ?? 0) <= 0) continue;

      // Check for active igp platform
      const igpRef  = db.collection('users').doc(userId).collection('platforms').doc('igp');
      const igpSnap = await igpRef.get();
      if (!igpSnap.exists || !igpSnap.data().connected) continue;

      // Load products for this tenant
      const productsSnap = await db.collection('users').doc(userId).collection('products')
        .where('active', '!=', false).limit(30).get();
      const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      const tenantConfig = {
        storeName:      userData.storeName      || 'المتجر',
        botName:        userData.botName        || 'فهيم',
        language:       userData.language       || 'dz',
        welcomeMessage: userData.welcomeMessage || '',
      };

      await pollUserDMs(userId, igpSnap.data(), tenantConfig, products);

      // 2s delay between users to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error('[IGP] pollAll error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Start background polling service
// ─────────────────────────────────────────────────────────────

function startIgPrivatePolling() {
  const INTERVAL = 60 * 1000; // every 60 seconds
  console.log(`🔄 [IGP] Polling service started (interval: ${INTERVAL / 1000}s)`);

  // First poll after 15 seconds (give server time to fully start)
  setTimeout(() => {
    pollAllIgPrivateUsers().catch(err => console.error('[IGP] First poll error:', err.message));

    // Then every INTERVAL
    setInterval(() => {
      pollAllIgPrivateUsers().catch(err => console.error('[IGP] Poll error:', err.message));
    }, INTERVAL);
  }, 15000);
}

module.exports = {
  connectIgPrivate,
  pollAllIgPrivateUsers,
  startIgPrivatePolling,
};
