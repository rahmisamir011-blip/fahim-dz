/**
 * FAHIM DZ — Meta Webhook Signature Verification
 * Verifies X-Hub-Signature-256 from Meta
 */

const crypto = require('crypto');

/**
 * Raw body parser — must be used BEFORE express.json()
 * Stores raw body on req.rawBody for signature verification
 */
function captureRawBody(req, res, next) {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch {
      req.body = {};
    }
    next();
  });
}

/**
 * Verify X-Hub-Signature-256 header
 */
function verifyMetaSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];

  if (!signature) {
    console.warn('⚠️ Missing X-Hub-Signature-256');
    return res.status(403).json({ error: 'Missing webhook signature' });
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(req.rawBody || '')
    .digest('hex');

  const valid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );

  if (!valid) {
    console.error('❌ Invalid webhook signature');
    return res.status(403).json({ error: 'Invalid webhook signature' });
  }

  next();
}

module.exports = { captureRawBody, verifyMetaSignature };
