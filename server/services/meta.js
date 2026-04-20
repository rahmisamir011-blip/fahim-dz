/**
 * FAHIM DZ — Meta Graph API Service
 * Handles: Instagram DM, Facebook Messenger, WhatsApp Business API
 */

const axios = require('axios');

const META_BASE = 'https://graph.facebook.com';
const META_VERSION = process.env.META_API_VERSION || 'v21.0';

// ============================================================
// INSTAGRAM — Direct Messages
// ============================================================

/**
 * Send Instagram DM
 * @param {string} recipientIgId - Instagram scoped user ID (sender's IG ID)
 * @param {string} text - message text
 * @param {string} pageToken - page access token
 * @param {string} igAccountId - IG Business Account ID (17841448764600905)
 */
async function sendInstagramMessage(recipientIgId, text, pageToken, igAccountId) {
  // Instagram DMs require: POST /{ig-business-account-id}/messages
  // The ig-business-account-id (igAccountId) is different from the FB Page ID
  const payload = {
    recipient: { id: recipientIgId },
    message: { text },
    messaging_type: 'RESPONSE',
  };

  // Try primary endpoint: /{igAccountId}/messages
  if (igAccountId && igAccountId !== 'me') {
    try {
      const res = await axios.post(
        `${META_BASE}/${META_VERSION}/${igAccountId}/messages`,
        payload,
        { params: { access_token: pageToken } }
      );
      console.log(`✅ IG send success (igId): msgId=${res.data.message_id}`);
      return { success: true, messageId: res.data.message_id };
    } catch (err) {
      const e = err.response?.data?.error;
      console.error(`❌ IG send via igId=${igAccountId}:`, JSON.stringify(e || err.message));
      // Fall through to /me/messages
    }
  }

  // Fallback: /me/messages (works when token is issued for the IG account directly)
  try {
    const res2 = await axios.post(
      `${META_BASE}/${META_VERSION}/me/messages`,
      payload,
      { params: { access_token: pageToken } }
    );
    console.log(`✅ IG send success (/me): msgId=${res2.data.message_id}`);
    return { success: true, messageId: res2.data.message_id };
  } catch (err2) {
    const e2 = err2.response?.data?.error;
    console.error('❌ IG send /me fallback error:', JSON.stringify(e2 || err2.message));
    return { success: false, error: e2?.message || err2.message, code: e2?.code };
  }
}

/**
 * Get Instagram user info (name, profile picture)
 */
async function getInstagramUser(igScopedUserId, pageToken) {
  try {
    const res = await axios.get(
      `${META_BASE}/v19.0/${igScopedUserId}`,
      {
        params: { fields: 'name,profile_pic', access_token: pageToken }
      }
    );
    return res.data;
  } catch {
    return { name: igScopedUserId };
  }
}

// ============================================================
// FACEBOOK MESSENGER
// ============================================================

/**
 * Send Facebook Messenger message
 * @param {string} recipientPsid - Facebook Page Scoped ID
 * @param {string} text - message text
 * @param {string} pageToken - page access token
 */
async function sendFacebookMessage(recipientPsid, text, pageToken) {
  try {
    const res = await axios.post(
      `${META_BASE}/${META_VERSION}/me/messages`,
      {
        recipient: { id: recipientPsid },
        message: { text },
        messaging_type: 'RESPONSE',
      },
      {
        // Use both header and param for broad compatibility
        headers: { Authorization: `Bearer ${pageToken}` },
        params: { access_token: pageToken },
      }
    );
    console.log(`✅ FB send success: msgId=${res.data.message_id}`);
    return { success: true, messageId: res.data.message_id };
  } catch (err) {
    const errData = err.response?.data?.error;
    console.error('❌ FB send error:', JSON.stringify(errData || err.message));
    return { success: false, error: errData?.message || err.message, code: errData?.code };
  }
}

/**
 * Get Facebook user profile
 */
async function getFacebookUser(psid, pageToken) {
  try {
    const res = await axios.get(
      `${META_BASE}/v19.0/${psid}`,
      {
        params: { fields: 'first_name,last_name,profile_pic', access_token: pageToken }
      }
    );
    return {
      name: `${res.data.first_name || ''} ${res.data.last_name || ''}`.trim() || psid,
      ...res.data
    };
  } catch {
    return { name: psid };
  }
}

// ============================================================
// WHATSAPP BUSINESS API
// ============================================================

/**
 * Send WhatsApp text message
 * @param {string} phoneNumberId - WhatsApp Business Phone Number ID
 * @param {string} to - recipient phone number (international format, e.g. 213XXXXXXXXX)
 * @param {string} text - message text
 * @param {string} token - WhatsApp system user token
 */
async function sendWhatsAppMessage(phoneNumberId, to, text, token) {
  try {
    const res = await axios.post(
      `${META_BASE}/${META_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return { success: true, messageId: res.data.messages?.[0]?.id };
  } catch (err) {
    const errData = err.response?.data?.error;
    console.error('❌ WA send error:', errData || err.message);
    return { success: false, error: errData?.message || err.message };
  }
}

/**
 * Mark WhatsApp message as read
 */
async function markWhatsAppRead(phoneNumberId, messageId, token) {
  try {
    await axios.post(
      `${META_BASE}/${META_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  } catch { /* non-critical */ }
}

/**
 * Exchange short-lived token for long-lived (60-day) token
 */
async function getLongLivedToken(shortToken) {
  try {
    const res = await axios.get(`${META_BASE}/v19.0/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: shortToken,
      }
    });
    return res.data;
  } catch (err) {
    console.error('Token exchange error:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Get all pages for a user token (for FB/IG connection)
 */
async function getUserPages(userToken) {
  try {
    const res = await axios.get(`${META_BASE}/v19.0/me/accounts`, {
      params: { access_token: userToken, fields: 'id,name,access_token,instagram_business_account' }
    });
    return res.data.data || [];
  } catch (err) {
    console.error('Get pages error:', err.response?.data || err.message);
    return [];
  }
}

module.exports = {
  sendInstagramMessage,
  sendFacebookMessage,
  sendWhatsAppMessage,
  markWhatsAppRead,
  getInstagramUser,
  getFacebookUser,
  getLongLivedToken,
  getUserPages,
};
