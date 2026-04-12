/**
 * FAHIM DZ — Orders Routes
 * GET    /api/orders
 * POST   /api/orders
 * PATCH  /api/orders/:id
 * DELETE /api/orders/:id
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../config/firebase');

// ── GET /api/orders ──────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const db = getDb();
  const { status, page = 1, limit = 50 } = req.query;

  try {
    let query = db
      .collection('users').doc(req.tenant.userId)
      .collection('orders')
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit));

    if (status) query = query.where('status', '==', status);

    const snap = await query.get();
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({ orders, total: orders.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/orders ─────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { client, product, qty, price, phone, wilaya, source } = req.body;

  if (!client || !product || !price) {
    return res.status(400).json({ error: 'client, product, and price are required' });
  }

  const db = getDb();

  try {
    const orderRef = db
      .collection('users').doc(req.tenant.userId)
      .collection('orders')
      .doc();

    const order = {
      id: orderRef.id,
      client: client.trim(),
      product: product.trim(),
      qty: parseInt(qty) || 1,
      price: parseFloat(price),
      phone: phone || '',
      wilaya: wilaya || '',
      source: source || 'manual',
      status: 'pending',
      createdAt: Date.now(),
    };

    await orderRef.set(order);
    return res.status(201).json({ order });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/orders/:id ────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const allowedUpdates = ['status', 'wilaya', 'phone', 'notes'];
  const updates = {};

  for (const key of allowedUpdates) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid updates provided' });
  }

  const db = getDb();

  try {
    const ref = db
      .collection('users').doc(req.tenant.userId)
      .collection('orders').doc(id);

    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Order not found' });

    await ref.update({ ...updates, updatedAt: Date.now() });
    return res.json({ success: true, id, updates });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/orders/:id ───────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  const db = getDb();

  try {
    const ref = db
      .collection('users').doc(req.tenant.userId)
      .collection('orders').doc(req.params.id);

    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Order not found' });

    await ref.delete();
    return res.json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
