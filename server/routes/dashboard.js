/**
 * FAHIM DZ — Dashboard & Stats Routes
 * GET /api/dashboard/stats
 * GET /api/dashboard/conversations
 * POST /api/dashboard/billing/purchase
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../config/firebase');

// ── GET /api/dashboard/stats ─────────────────────────────────
router.get('/stats', requireAuth, async (req, res) => {
  const db = getDb();
  const userId = req.tenant.userId;

  try {
    const [userSnap, ordersSnap, productsSnap, convsSnap] = await Promise.all([
      db.collection('users').doc(userId).get(),
      db.collection('users').doc(userId).collection('orders').get(),
      db.collection('users').doc(userId).collection('products').get(),
      db.collection('users').doc(userId).collection('conversations').get(),
    ]);

    const user = userSnap.data() || {};
    const orders = ordersSnap.docs.map(d => d.data());
    const totalMessages = convsSnap.docs.reduce((sum, d) => {
      return sum + ((d.data().messages || []).length);
    }, 0);

    const delivered = orders.filter(o => o.status === 'delivered');
    const totalRevenue = delivered.reduce((sum, o) => sum + (o.price * (o.qty || 1)), 0);
    const conversionRate = orders.length > 0
      ? Math.round((delivered.length / orders.length) * 100)
      : 0;

    // Last 7 days revenue
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recentRevenue = orders
      .filter(o => o.createdAt > sevenDaysAgo && o.status === 'delivered')
      .reduce((sum, o) => sum + (o.price * (o.qty || 1)), 0);

    return res.json({
      stats: {
        points: user.points || 0,
        messages: totalMessages,
        totalMessages: user.totalMessages || 0,
        orders: orders.length,
        pendingOrders: orders.filter(o => o.status === 'pending').length,
        deliveredOrders: delivered.length,
        products: productsSnap.size,
        conversations: convsSnap.size,
        revenue: totalRevenue,
        recentRevenue,
        conversionRate,
        plan: user.plan || 'free',
        storeName: user.storeName || user.name,
      }
    });

  } catch (err) {
    console.error('Stats error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/conversations ────────────────────────
router.get('/conversations', requireAuth, async (req, res) => {
  const db = getDb();
  const userId = req.tenant.userId;

  try {
    const snap = await db
      .collection('users').doc(userId)
      .collection('conversations')
      .orderBy('updatedAt', 'desc')
      .limit(30)
      .get();

    const conversations = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        platform: data.platform,
        senderName: data.senderName || data.senderId,
        lastMessage: data.lastMessage,
        lastReply: data.lastReply,
        messageCount: (data.messages || []).length,
        updatedAt: data.updatedAt,
      };
    });

    return res.json({ conversations });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/conversations/:id ─────────────────────
router.get('/conversations/:id', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const snap = await db
      .collection('users').doc(req.tenant.userId)
      .collection('conversations').doc(req.params.id)
      .get();

    if (!snap.exists) return res.status(404).json({ error: 'Conversation not found' });
    return res.json({ conversation: { id: snap.id, ...snap.data() } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dashboard/billing/purchase ─────────────────────
router.post('/billing/purchase', requireAuth, async (req, res) => {
  const { plan, points, price } = req.body;

  const validPlans = {
    starter:    { points: 1000,  price: 3500,  name: 'رصيد البداية' },
    growth:     { points: 5000,  price: 8500,  name: 'رصيد النمو' },
    business:   { points: 10000, price: 14500, name: 'رصيد الأعمال' },
    enterprise: { points: 25000, price: 36000, name: 'رصيد المؤسسات' },
  };

  if (!plan || !validPlans[plan]) {
    return res.status(400).json({ error: 'Invalid plan. Use: starter, growth, business, or enterprise' });
  }

  const planData = validPlans[plan];
  const db = getDb();

  try {
    const userRef = db.collection('users').doc(req.tenant.userId);
    const snap = await userRef.get();
    const currentPoints = snap.data()?.points || 0;
    const newPoints = currentPoints + planData.points;

    // NOTE: In production, verify payment before adding points
    // Here we simulate a successful payment
    await userRef.update({
      points: newPoints,
      plan,
      lastPurchase: {
        plan,
        points: planData.points,
        price: planData.price,
        purchasedAt: Date.now(),
      },
    });

    return res.json({
      success: true,
      message: `تمت إضافة ${planData.points.toLocaleString('ar-DZ')} نقطة!`,
      newBalance: newPoints,
      plan: planData.name,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
