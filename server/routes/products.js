/**
 * FAHIM DZ — Products Routes
 * GET    /api/products
 * POST   /api/products
 * PATCH  /api/products/:id
 * DELETE /api/products/:id
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../config/firebase');

// ── GET /api/products ────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const snap = await db
      .collection('users').doc(req.tenant.userId)
      .collection('products')
      .orderBy('createdAt', 'desc')
      .get();

    const products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ products });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/products ───────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { name, price, stock, category, description } = req.body;

  if (!name || price === undefined) {
    return res.status(400).json({ error: 'name and price are required' });
  }

  const db = getDb();
  try {
    const ref = db
      .collection('users').doc(req.tenant.userId)
      .collection('products')
      .doc();

    const product = {
      id: ref.id,
      name: name.trim(),
      price: parseFloat(price),
      stock: parseInt(stock) || 0,
      category: category?.trim() || 'عام',
      description: description?.trim() || '',
      createdAt: Date.now(),
    };

    await ref.set(product);
    return res.status(201).json({ product });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/products/:id ──────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  const { name, price, stock, category, description } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name.trim();
  if (price !== undefined) updates.price = parseFloat(price);
  if (stock !== undefined) updates.stock = parseInt(stock);
  if (category !== undefined) updates.category = category.trim();
  if (description !== undefined) updates.description = description.trim();
  updates.updatedAt = Date.now();

  const db = getDb();
  try {
    const ref = db
      .collection('users').doc(req.tenant.userId)
      .collection('products').doc(req.params.id);

    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Product not found' });

    await ref.update(updates);
    return res.json({ success: true, id: req.params.id, updates });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/products/:id ─────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const ref = db
      .collection('users').doc(req.tenant.userId)
      .collection('products').doc(req.params.id);

    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Product not found' });

    await ref.delete();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
