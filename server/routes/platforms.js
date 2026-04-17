/**
 * FAHIM DZ — Platforms Connection Routes (SaaS Multi-Tenant)
 *
 * SaaS Architecture:
 *  - ONE Meta App owned by operator (Fahim DZ)
 *  - Each TENANT connects THEIR Facebook Page/IG account/WhatsApp via FB Business Login
 *  - Operator never asks clients for tokens manually — FB SDK handles it seamlessly
 *
 * API:
 * GET    /api/platforms                 → list connected platforms for current tenant
 * POST   /api/platforms/exchange-token  → exchange FB JS SDK token → long-lived + fetch pages
 * POST   /api/platforms/connect         → save chosen page to Firestore
 * POST   /api/platforms/whatsapp-signup → handle WhatsApp Embedded Signup code
 * DELETE /api/platforms/:type           → disconnect platform
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { getDb, isFirebaseReady } = require('../config/firebase');
const admin = require('firebase-admin');

const META_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v19.0';

// ─────────────────────────────────────────────────────────────
// SaaS Business Login Routes
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/platforms/exchange-token
 * Called by dashboard after FB.login() succeeds.
 * 1. Exchange short-lived user token → long-lived (60-day) user token
 * 2. Fetch all Facebook Pages the user administers
 * 3. For Instagram: also fetch linked IG Business Account IDs
 * Returns: { pages: [...], longLivedToken }
 */
router.post('/exchange-token', requireAuth, async (req, res) => {
  const { userAccessToken, platform } = req.body;

  if (!userAccessToken) return res.status(400).json({ error: 'userAccessToken required' });

  const META_APP_ID = process.env.META_APP_ID;
  const META_APP_SECRET = process.env.META_APP_SECRET;

  if (!META_APP_ID || META_APP_ID === 'YOUR_META_APP_ID') {
    return res.status(503).json({ error: 'META_APP_ID غير مهيأ في .env' });
  }

  try {
    // 1. Exchange for long-lived user token
    const llRes = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        fb_exchange_token: userAccessToken,
      },
    });
    const longLivedToken = llRes.data.access_token;

    // 2. Fetch pages
    const fields = platform === 'instagram'
      ? 'id,name,access_token,instagram_business_account{id,username,name,followers_count}'
      : 'id,name,access_token';

    const pagesRes = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/me/accounts`, {
      params: { access_token: longLivedToken, fields, limit: 25 },
    });

    const pages = (pagesRes.data.data || []).map(page => ({
      id: page.id,
      name: page.name,
      access_token: page.access_token,
      ig_id: page.instagram_business_account?.id || null,
      ig_username: page.instagram_business_account?.username || null,
    }));

    return res.json({ pages, longLivedToken });

  } catch (err) {
    console.error('exchange-token error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

/**
 * POST /api/platforms/connect
 * Called when tenant selects a page from the picker modal.
 * Saves the page token + ID to Firestore under their tenant namespace.
 * Also writes to webhook_registry so incoming webhooks route to them.
 */
router.post('/connect', requireAuth, async (req, res) => {
  const { platform, pageId, pageName, pageToken, igId } = req.body;
  if (!platform || !pageId || !pageToken) {
    return res.status(400).json({ error: 'platform, pageId, pageToken required' });
  }

  const userId = req.tenant.userId;
  const platformKey = platform === 'instagram' ? 'ig' : platform === 'facebook' ? 'fb' : 'wa';

  if (!isFirebaseReady()) return res.status(503).json({ error: 'Firebase غير متوفر' });

  const db = getDb();
  try {
    const platformData = {
      platform: platformKey,
      pageId,
      pageName: pageName || '',
      accessToken: pageToken,       // ← must be 'accessToken' for messaging.js to read it
      pageAccessToken: pageToken,   // keep for backwards compat
      connectedAt: Date.now(),
      active: true,
    };
    if (igId) platformData.igAccountId = igId;

    // Save under tenant's platforms sub-collection
    await db.collection('users').doc(userId).collection('platforms').doc(platformKey).set(platformData);

    // Webhook registry: pageId → userId (for routing incoming messages)
    await db.collection('webhook_registry').doc(pageId).set({
      userId,
      platform: platformKey,
      registeredAt: Date.now(),
    });

    // If Instagram, also register igAccountId
    if (igId) {
      await db.collection('webhook_registry').doc(igId).set({ userId, platform: 'ig', registeredAt: Date.now() });
    }

    // ─────────────────────────────────────────────────────────────────────
    // CRITICAL: Subscribe the Facebook Page to webhook events.
    // Without this call, Meta NEVER sends messages to our webhook URL.
    // This is the equivalent of clicking "Subscribe" in the Meta App Dashboard.
    // ─────────────────────────────────────────────────────────────────────
    const subscribeFields = platform === 'instagram'
      ? 'messages,messaging_postbacks,messaging_optins,message_reads,mention,comments'
      : 'messages,messaging_postbacks,messaging_optins,message_reads,feed';

    try {
      const subRes = await axios.post(
        `https://graph.facebook.com/${META_API_VERSION}/${pageId}/subscribed_apps`,
        null,
        {
          params: {
            subscribed_fields: subscribeFields,
            access_token: pageToken,
          },
        }
      );
      console.log(`✅ Page ${pageId} subscribed to webhook events:`, subRes.data);
    } catch (subErr) {
      // Log but don't fail — Firestore is saved, just the live subscription failed
      console.error(`⚠️ Failed to subscribe page ${pageId} to webhooks:`, subErr.response?.data || subErr.message);
    }

    // Update user's connectedPlatforms array
    await db.collection('users').doc(userId).update({
      connectedPlatforms: admin.firestore.FieldValue.arrayUnion(platformKey),
    });

    return res.json({ success: true, platform: platformKey, pageName, subscribed: true });

  } catch (err) {
    console.error('Platform connect error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/platforms/whatsapp-signup
 * Handles WhatsApp Embedded Signup completion.
 * Can receive either:
 *  - { code } from FB.login() response_type=code
 *  - { phoneNumberId, wabaId } from window.message WA_EMBEDDED_SIGNUP event
 */
router.post('/whatsapp-signup', requireAuth, async (req, res) => {
  const { code, phoneNumberId, wabaId } = req.body;
  const userId = req.tenant.userId;

  const META_APP_ID = process.env.META_APP_ID;
  const META_APP_SECRET = process.env.META_APP_SECRET;

  if (!isFirebaseReady()) return res.status(503).json({ error: 'Firebase غير متوفر' });

  const db = getDb();

  try {
    let finalPhoneId = phoneNumberId;
    let finalWabaId = wabaId;
    let systemToken = null;
    let displayPhone = '';

    if (code) {
      // Exchange code for access token
      const tokenRes = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/oauth/access_token`, {
        params: {
          client_id: META_APP_ID,
          client_secret: META_APP_SECRET,
          code,
        },
      });
      systemToken = tokenRes.data.access_token;

      // Get WhatsApp phone numbers under the WABA
      if (finalWabaId) {
        const phonesRes = await axios.get(
          `https://graph.facebook.com/${META_API_VERSION}/${finalWabaId}/phone_numbers`,
          { params: { access_token: systemToken, fields: 'id,display_phone_number' } }
        );
        const phone = phonesRes.data.data?.[0];
        if (phone) {
          finalPhoneId = phone.id;
          displayPhone = phone.display_phone_number;
        }
      }
    }

    const waData = {
      platform: 'wa',
      phoneNumberId: finalPhoneId || '',
      wabaId: finalWabaId || '',
      displayPhone,
      connectedAt: Date.now(),
      active: true,
    };
    if (systemToken) waData.systemToken = systemToken;

    await db.collection('users').doc(userId).collection('platforms').doc('wa').set(waData);

    if (finalPhoneId) {
      await db.collection('webhook_registry').doc(finalPhoneId).set({ userId, platform: 'wa', registeredAt: Date.now() });
    }

    await db.collection('users').doc(userId).update({
      connectedPlatforms: admin.firestore.FieldValue.arrayUnion('wa'),
    });

    return res.json({ success: true, displayPhone, phoneNumberId: finalPhoneId });

  } catch (err) {
    console.error('WhatsApp signup error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Legacy / Manual Routes (kept for admin use)
// ─────────────────────────────────────────────────────────────

// ── GET /api/platforms ───────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const snap = await db
      .collection('users').doc(req.tenant.userId)
      .collection('platforms')
      .get();

    const platforms = snap.docs.map(d => {
      const data = d.data();
      // Never expose access tokens to frontend
      const { accessToken, ...safeData } = data;
      return { type: d.id, ...safeData, connected: true };
    });

    return res.json({ platforms });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/platforms/ig ───────────────────────────────────
router.post('/ig', requireAuth, async (req, res) => {
  const { pageToken, pageId, igUserId, username } = req.body;

  if (!pageToken || !pageId) {
    return res.status(400).json({ error: 'pageToken and pageId are required' });
  }

  const db = getDb();
  const userId = req.tenant.userId;

  try {
    // Try to exchange for long-lived token
    let finalToken = pageToken;
    try {
      const llResult = await getLongLivedToken(pageToken);
      finalToken = llResult.access_token || pageToken;
    } catch { /* use short-lived token if exchange fails */ }

    const platformData = {
      accessToken: finalToken,
      pageId,
      igUserId: igUserId || '',
      username: username || '',
      connectedAt: Date.now(),
    };

    // Save platform config
    await db
      .collection('users').doc(userId)
      .collection('platforms').doc('ig')
      .set(platformData);

    // Register in webhook registry for routing
    await db.collection('webhook_registry').doc(pageId).set({
      userId,
      platform: 'ig',
      registeredAt: Date.now(),
    });

    // Update user's connectedPlatforms list
    await db.collection('users').doc(userId).update({
      connectedPlatforms: require('firebase-admin').firestore.FieldValue.arrayUnion('ig'),
    });

    return res.json({
      success: true,
      message: 'Instagram connected successfully',
      platform: { type: 'ig', pageId, username, connected: true }
    });

  } catch (err) {
    console.error('IG connect error:', err.message);
    return res.status(500).json({ error: 'Failed to connect Instagram: ' + err.message });
  }
});

// ── POST /api/platforms/fb ───────────────────────────────────
router.post('/fb', requireAuth, async (req, res) => {
  const { pageToken, pageId, pageName } = req.body;

  if (!pageToken || !pageId) {
    return res.status(400).json({ error: 'pageToken and pageId are required' });
  }

  const db = getDb();
  const userId = req.tenant.userId;

  try {
    let finalToken = pageToken;
    try {
      const llResult = await getLongLivedToken(pageToken);
      finalToken = llResult.access_token || pageToken;
    } catch { }

    await db
      .collection('users').doc(userId)
      .collection('platforms').doc('fb')
      .set({
        accessToken: finalToken,
        pageId,
        pageName: pageName || '',
        connectedAt: Date.now(),
      });

    await db.collection('webhook_registry').doc(pageId).set({
      userId,
      platform: 'fb',
      registeredAt: Date.now(),
    });

    await db.collection('users').doc(userId).update({
      connectedPlatforms: require('firebase-admin').firestore.FieldValue.arrayUnion('fb'),
    });

    return res.json({
      success: true,
      message: 'Facebook connected successfully',
      platform: { type: 'fb', pageId, pageName, connected: true }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to connect Facebook: ' + err.message });
  }
});

// ── POST /api/platforms/wa ───────────────────────────────────
router.post('/wa', requireAuth, async (req, res) => {
  const { accessToken, phoneNumberId, displayPhone, wabaId } = req.body;

  if (!accessToken || !phoneNumberId) {
    return res.status(400).json({ error: 'accessToken and phoneNumberId are required' });
  }

  const db = getDb();
  const userId = req.tenant.userId;

  try {
    await db
      .collection('users').doc(userId)
      .collection('platforms').doc('wa')
      .set({
        accessToken,
        phoneNumberId,
        displayPhone: displayPhone || '',
        wabaId: wabaId || '',
        connectedAt: Date.now(),
      });

    // Register phone number ID for webhook routing
    await db.collection('webhook_registry').doc(phoneNumberId).set({
      userId,
      platform: 'wa',
      registeredAt: Date.now(),
    });

    await db.collection('users').doc(userId).update({
      connectedPlatforms: require('firebase-admin').firestore.FieldValue.arrayUnion('wa'),
    });

    return res.json({
      success: true,
      message: 'WhatsApp connected successfully',
      platform: { type: 'wa', phoneNumberId, displayPhone, connected: true }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to connect WhatsApp: ' + err.message });
  }
});

// ── DELETE /api/platforms/:type ──────────────────────────────
router.delete('/:type', requireAuth, async (req, res) => {
  const { type } = req.params;
  const validTypes = ['ig', 'fb', 'wa'];

  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid platform type. Use: ig, fb, or wa' });
  }

  const db = getDb();
  const userId = req.tenant.userId;

  try {
    // Get platform data first (to clean up registry)
    const platformSnap = await db
      .collection('users').doc(userId)
      .collection('platforms').doc(type)
      .get();

    if (platformSnap.exists) {
      const { pageId, phoneNumberId } = platformSnap.data();
      const registryId = pageId || phoneNumberId;

      // Remove from registry
      if (registryId) {
        await db.collection('webhook_registry').doc(registryId).delete();
      }
    }

    // Delete platform config
    await db
      .collection('users').doc(userId)
      .collection('platforms').doc(type)
      .delete();

    // Update user list
    await db.collection('users').doc(userId).update({
      connectedPlatforms: require('firebase-admin').firestore.FieldValue.arrayRemove(type),
    });

    return res.json({ success: true, message: `${type.toUpperCase()} disconnected` });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
