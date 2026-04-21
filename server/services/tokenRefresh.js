/**
 * FAHIM DZ — Token Auto-Refresh Service
 *
 * Meta Page Access Tokens from the User OAuth flow are long-lived (~60 days).
 * This service automatically refreshes them before they expire so
 * clients never lose their connection unexpectedly.
 *
 * Runs every 24 hours on server start.
 * Refreshes any token expiring within the next 10 days.
 */

const axios = require('axios');
const { getDb, isFirebaseReady } = require('../config/firebase');

const META_VERSION = process.env.META_API_VERSION || 'v21.0';
const REFRESH_THRESHOLD_MS = 10 * 24 * 60 * 60 * 1000; // 10 days in ms
const INTERVAL_MS          = 24 * 60 * 60 * 1000;       // 24 hours

/**
 * Refresh a single platform token using the long-lived token exchange endpoint.
 * Meta allows you to exchange a long-lived token for a new one before it expires.
 */
async function refreshToken(currentToken) {
  const res = await axios.get(`https://graph.facebook.com/${META_VERSION}/oauth/access_token`, {
    params: {
      grant_type:       'fb_exchange_token',
      client_id:        process.env.META_APP_ID,
      client_secret:    process.env.META_APP_SECRET,
      fb_exchange_token: currentToken,
    },
  });
  return res.data; // { access_token, token_type, expires_in }
}

/**
 * Scan all users' connected platforms and refresh tokens expiring soon.
 */
async function refreshAllExpiringTokens() {
  if (!isFirebaseReady()) return;

  const db  = getDb();
  const now = Date.now();
  const refreshBefore = now + REFRESH_THRESHOLD_MS;

  console.log(`🔄 Token refresh: scanning all tenants (${new Date().toISOString()})`);

  let refreshed = 0;
  let skipped   = 0;
  let errors    = 0;

  try {
    const usersSnap = await db.collection('users').get();

    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id;

      try {
        const platformsSnap = await db
          .collection('users').doc(userId)
          .collection('platforms')
          .where('active', '==', true)
          .get();

        for (const platDoc of platformsSnap.docs) {
          const platData = platDoc.data();
          const token    = platData.longLivedToken || platData.accessToken || platData.pageAccessToken;
          const expiry   = platData.tokenExpiry;

          if (!token) { skipped++; continue; }

          // Only refresh if expiring within threshold (or expiry unknown)
          const needsRefresh = !expiry || expiry < refreshBefore;
          if (!needsRefresh) { skipped++; continue; }

          try {
            const newTokenData = await refreshToken(token);
            const newToken   = newTokenData.access_token;
            const newExpiry  = Date.now() + (newTokenData.expires_in * 1000);

            await platDoc.ref.update({
              longLivedToken:  newToken,
              accessToken:     newToken,
              pageAccessToken: newToken,
              tokenExpiry:     newExpiry,
              tokenRefreshedAt: Date.now(),
            });

            console.log(`✅ Token refreshed: userId=${userId} platform=${platDoc.id} expires=${new Date(newExpiry).toISOString()}`);
            refreshed++;

          } catch (tokenErr) {
            // Token may be invalid/expired — mark platform as needing reconnect
            const errMsg = tokenErr.response?.data?.error?.message || tokenErr.message;
            console.warn(`⚠️ Token refresh failed: userId=${userId} platform=${platDoc.id}: ${errMsg}`);

            // If error is "token has expired" or "invalid token" → mark as needs_reconnect
            const isExpiredError = errMsg.includes('expired') || errMsg.includes('invalid') || errMsg.includes('Invalid');
            if (isExpiredError) {
              await platDoc.ref.update({
                active:       false,
                needsReconnect: true,
                reconnectReason: errMsg,
              });
              console.warn(`⚠️ Marked platform as needs_reconnect: ${userId}/${platDoc.id}`);
            }
            errors++;
          }
        }
      } catch (userErr) {
        console.error(`Token refresh user scan error [${userId}]:`, userErr.message);
        errors++;
      }
    }

    console.log(`🔄 Token refresh done: refreshed=${refreshed} skipped=${skipped} errors=${errors}`);

  } catch (err) {
    console.error('Token refresh scan error:', err.message);
  }
}

/**
 * Start the token refresh background service.
 * Runs once immediately, then every 24 hours.
 */
function startTokenRefreshService() {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    console.warn('⚠️ Token refresh service disabled — META_APP_ID or META_APP_SECRET not set');
    return;
  }

  console.log('🔄 Token refresh service started (interval: 24h)');

  // Run immediately (with 30s delay to let server fully boot)
  setTimeout(refreshAllExpiringTokens, 30_000);

  // Then every 24 hours
  setInterval(refreshAllExpiringTokens, INTERVAL_MS);
}

module.exports = { startTokenRefreshService, refreshAllExpiringTokens };
