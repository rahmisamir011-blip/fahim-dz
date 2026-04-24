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
 * Connect via Session Cookie (sessionid from browser).
 * Most reliable — bypasses server-IP blocks entirely.
 */
async function connectIgPrivate(userId, username, sessionId) {
  const ig = new IgApiClient();
  ig.state.generateDevice(username.toLowerCase().trim());

  try {
    // Inject the sessionid cookie directly — no login request needed
    await ig.state.deserializeCookieJar(
      JSON.stringify({
        version: 'tough-cookie@4.1.3',
        storeType: 'MemoryCookieStore',
        rejectPublicSuffixes: true,
        cookies: [
          {
            key:      'sessionid',
            value:    sessionId.trim(),
            domain:   '.instagram.com',
            path:     '/',
            secure:   true,
            httpOnly: true,
            hostOnly: false,
          },
        ],
      })
    );

    // Verify session by fetching current user profile
    const account = await ig.account.currentUser();

    const sessionState = JSON.stringify(await ig.exportState());

    if (!isFirebaseReady()) throw new Error('Firebase not ready');
    const db = getDb();

    await db.collection('users').doc(userId).collection('platforms').doc('igp').set({
      platform:       'igp',
      username:       account.username,
      fullName:       account.full_name || '',
      igUserId:       String(account.pk),
      sessionState,
      connected:      true,
      connectedAt:    Date.now(),
      seenMessageIds: [],
      lastPoll:       0,
    });

    const userRef  = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    const current  = userSnap.data()?.connectedPlatforms || [];
    if (!current.includes('igp')) {
      await userRef.update({ connectedPlatforms: [...current, 'igp'] });
    }

    console.log(`✅ [IGP] Connected @${account.username} for user ${userId} (via session cookie)`);
    return { success: true, username: account.username, fullName: account.full_name };

  } catch (err) {
    const msg      = err.message || '';
    const msgLower = msg.toLowerCase();
    const status   = err.response?.statusCode || err.response?.status;

    console.error('[IGP] session-connect error:', err.name, status, msg.substring(0, 200));

    // Bad / expired session
    if (
      msgLower.includes('login_required') ||
      msgLower.includes('not authenticated') ||
      msgLower.includes('session') ||
      status === 401 || status === 403
    ) {
      return {
        success: false,
        error:
          '❌ الـ Session ID غير صالح أو انتهت صلاحيته.\n' +
          'تأكد أنك نسخت القيمة الصحيحة من المتصفح وأن حسابك لا يزال مسجلاً دخوله على Instagram.com',
      };
    }

    if (status === 429 || msgLower.includes('too many') || msgLower.includes('rate')) {
      return { success: false, error: '⏳ محاولات كثيرة — انتظر 5 دقائق ثم حاول مجدداً.' };
    }

    return { success: false, error: `❌ فشل الاتصال: ${msg.substring(0, 150)}` };
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
