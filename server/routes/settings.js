/**
 * FAHIM DZ — Bot Settings Routes
 * Lets each tenant configure their AI bot from the dashboard.
 *
 * GET  /api/settings        → load current settings
 * PATCH /api/settings       → update bot name, language, greeting, agent toggle
 * PATCH /api/settings/agent → toggle agent on/off (quick toggle)
 */

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb }       = require('../config/firebase');

// ── GET /api/settings ─────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const snap = await db.collection('users').doc(req.tenant.userId).get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });

    const d = snap.data();
    return res.json({
      storeName:      d.storeName      || '',
      botName:        d.botName        || 'فهيم',
      language:       d.language       || 'dz',
      welcomeMessage: d.welcomeMessage || '',
      agentEnabled:   d.agentEnabled   !== false, // default true
      points:         d.points         || 0,
      plan:           d.plan           || 'free',
      totalMessages:  d.totalMessages  || 0,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/settings ───────────────────────────────────────
router.patch('/', requireAuth, async (req, res) => {
  const db = getDb();
  const { storeName, botName, language, welcomeMessage, agentEnabled } = req.body;

  const updates = {};
  if (storeName      !== undefined) updates.storeName      = String(storeName).trim();
  if (botName        !== undefined) updates.botName        = String(botName).trim();
  if (language       !== undefined && ['dz','ar','fr'].includes(language)) updates.language = language;
  if (welcomeMessage !== undefined) updates.welcomeMessage = String(welcomeMessage);
  if (agentEnabled   !== undefined) updates.agentEnabled   = Boolean(agentEnabled);

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  try {
    await db.collection('users').doc(req.tenant.userId).update(updates);
    return res.json({ success: true, updated: updates });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/settings/agent ─────────────────────────────────
// Quick toggle for the dashboard "bot active/paused" switch
router.patch('/agent', requireAuth, async (req, res) => {
  const db = getDb();
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }

  try {
    await db.collection('users').doc(req.tenant.userId).update({
      agentEnabled: enabled,
    });
    console.log(`🤖 Agent ${enabled ? 'ENABLED' : 'DISABLED'} for tenant ${req.tenant.userId}`);
    return res.json({ success: true, agentEnabled: enabled });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
