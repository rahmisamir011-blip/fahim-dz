/**
 * FAHIM DZ — Dashboard (Real API Version)
 * All data fetched from: /api/dashboard, /api/orders, /api/products, /api/platforms
 */

const API_BASE = window.location.origin;

// ── API Helper ─────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('fahim_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem('fahim_token');
    localStorage.removeItem('fahim_user');
    window.location.href = 'authentification.html';
    return null;
  }

  return res.json();
}

// ── Guard ──────────────────────────────────────────────────────
const token = localStorage.getItem('fahim_token');
if (!token) window.location.href = 'authentification.html';

// ── AUTH MODULE (from localStorage cache + API) ────────────────
const Auth = {
  getUser() {
    try { return JSON.parse(localStorage.getItem('fahim_user') || 'null'); }
    catch { return null; }
  },
  async refreshUser() {
    const data = await apiFetch('/api/auth/me');
    if (data?.user) {
      localStorage.setItem('fahim_user', JSON.stringify(data.user));
      return data.user;
    }
    return this.getUser();
  },
  logout() {
    localStorage.removeItem('fahim_token');
    localStorage.removeItem('fahim_user');
    window.location.href = 'index.html';
  }
};

// ── TOAST ──────────────────────────────────────────────────────
const Toast = {
  show(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }
};

// ════════════════════════════════════════════════════════════
// MAIN INIT
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  const user = Auth.getUser();
  if (!user) { Auth.logout(); return; }

  // Set topbar user
  initTopbar(user);
  initNavigation();
  initModals();
  initAgentToggle();

  // Load all data in parallel
  await Promise.all([
    loadDashboardStats(),
    loadPlatforms(),
    loadOrdersPage(),
    loadProductsPage(),
    loadInboxPage(),
  ]);

  loadProfilePage();
  loadBillingPage();
  initChart();

  // Logout
  document.getElementById('logout-btn')?.addEventListener('click', () => {
    if (confirm('هل تريد الخروج من الحساب؟')) Auth.logout();
  });
});

// ── Navigation ─────────────────────────────────────────────────
function initNavigation() {
  const links = document.querySelectorAll('[data-page]');
  const pages = document.querySelectorAll('.page');
  const pageTitle = document.getElementById('page-title');
  const titles = {
    dashboard: 'لوحة التحكم', orders: 'الطلبات', products: 'المنتجات',
    inbox: 'صندوق الوارد', profile: 'الملف الشخصي', billing: 'الدفع والفواتير'
  };

  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = link.dataset.page;
      links.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      pages.forEach(p => p.classList.remove('active'));
      document.getElementById(`page-${target}`)?.classList.add('active');
      if (pageTitle) pageTitle.textContent = titles[target] || '';
    });
  });
}

function initTopbar(user) {
  const el = document.getElementById('store-name');
  if (el) el.textContent = user.storeName || user.name || 'متجري';
}

function initAgentToggle() {
  const toggle = document.getElementById('agent-toggle');
  const label = document.getElementById('agent-label');
  toggle?.addEventListener('change', () => {
    if (toggle.checked) {
      label.textContent = 'الوكيل نشط';
      label.style.color = 'var(--secondary)';
      Toast.show('تم تفعيل الوكيل الذكي! سيرد على رسائل منصاتك تلقائياً.', 'success');
    } else {
      label.textContent = 'الوكيل متوقف';
      label.style.color = '#999';
      Toast.show('تم إيقاف الوكيل الذكي', 'info');
    }
  });
}

// ── DASHBOARD STATS ────────────────────────────────────────────
async function loadDashboardStats() {
  try {
    const data = await apiFetch('/api/dashboard/stats');
    if (!data?.stats) return;

    const { stats } = data;
    animateCount('stat-points', stats.points);
    animateCount('stat-messages', stats.totalMessages);
    animateCount('stat-conversions', stats.orders);

    const revEl = document.getElementById('stat-revenue');
    if (revEl) revEl.textContent = `${(stats.revenue || 0).toLocaleString('ar-DZ')} د.ج`;

  } catch (err) {
    console.error('Stats load error:', err);
  }
}

function animateCount(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  let start = 0;
  const step = target / 40;
  const timer = setInterval(() => {
    start = Math.min(start + step, target);
    el.textContent = Math.round(start).toLocaleString('ar-DZ');
    if (start >= target) clearInterval(timer);
  }, 20);
}

// ── PLATFORMS ──────────────────────────────────────────────────
async function loadPlatforms() {
  try {
    const data = await apiFetch('/api/platforms');
    if (!data?.platforms) return;

    const connectBtns = {
      ig: document.getElementById('connect-ig'),
      fb: document.getElementById('connect-fb'),
      wa: document.getElementById('connect-wa'),
    };

    data.platforms.forEach(p => {
      const btn = connectBtns[p.type];
      if (btn) {
        btn.textContent = '✅ مربوط';
        btn.classList.add('connected-state');
      }
      const handleEl = document.getElementById(`${p.type}-handle`);
      if (handleEl) handleEl.textContent = p.username || p.pageName || p.displayPhone || 'مربوط';
    });

  } catch (err) {
    console.error('Platforms load error:', err);
  }
}

// ── CONNECT PLATFORM — SaaS Multi-Tenant (Facebook Business Login) ────────
/**
 * ARCHITECTURE:
 * - YOU (the operator) own ONE Meta App (Fahim DZ's app).
 * - Each CLIENT connects THEIR Instagram/Facebook Business Page or WhatsApp
 *   number through your app using Facebook's Business Login JS SDK.
 * - No client ever needs a developer account — they just log in with Facebook.
 * - This is identical to how ManyChat, Tidio, and other SaaS chatbot tools work.
 *
 * Flows:
 *  - Instagram / Facebook → FB.login() with business_management scope → 
 *    client picks their Page → you get a Page Access Token for that page
 *  - WhatsApp → Meta Embedded Signup via FB.login() with special config_id →
 *    client connects their WhatsApp Business Account → you get WABA token
 */

document.addEventListener('DOMContentLoaded', () => {

  // Instagram — Facebook Business Login → selects IG Business Account
  document.getElementById('connect-ig')?.addEventListener('click', () => {
    connectWithFacebook('instagram');
  });

  // Facebook Messenger — Facebook Business Login → selects Facebook Page
  document.getElementById('connect-fb')?.addEventListener('click', () => {
    connectWithFacebook('facebook');
  });

  // WhatsApp — Meta Embedded Signup
  document.getElementById('connect-wa')?.addEventListener('click', () => {
    connectWhatsApp();
  });
});

// ── Facebook Business Login (Instagram + Facebook Messenger) ──────────────
function connectWithFacebook(platform) {
  if (typeof FB === 'undefined') {
    return showConnectionGuide(platform);
  }

  const requiredScopes = platform === 'instagram'
    ? ['instagram_basic', 'instagram_manage_messages', 'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'business_management']
    : ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'pages_messaging', 'business_management'];

  const scopeStr = requiredScopes.join(',');
  const platformLabel = platform === 'instagram' ? 'انستغرام' : 'فيسبوك ماسنجر';
  Toast.show(`⏳ جارٍ فتح نافذة تسجيل دخول فيسبوك...`, 'info');

  FB.login(function (response) {
    console.log('FB.login response:', response);
    if (!response.authResponse) {
      const status = response?.status || 'unknown';
      console.warn('FB login cancelled/failed. Status:', status);
      Toast.show(`❌ تم إلغاء تسجيل الدخول (${status})`, 'error');
      return;
    }

    // Check which permissions were actually granted
    const granted = (response.authResponse.grantedScopes || '').split(',');
    const criticalScope = platform === 'instagram' ? 'instagram_manage_messages' : 'pages_messaging';

    if (!granted.includes(criticalScope)) {
      // Critical messaging permission was not granted — force re-request
      console.warn(`⚠️ Missing critical scope: ${criticalScope}. Granted: ${granted.join(',')}`);
      Toast.show(`⚠️ يجب منح إذن "${criticalScope}" لاستلام الرسائل. يرجى المحاولة مرة أخرى والموافقة على جميع الأذونات.`, 'warning');
      
      // Force re-request with auth_type=rerequest
      setTimeout(() => {
        FB.login(function (resp2) {
          if (resp2.authResponse) {
            fetchAndSelectPages(platform, resp2.authResponse.accessToken, platformLabel);
          } else {
            Toast.show(`❌ لم يتم منح الأذونات المطلوبة. لا يمكن استلام الرسائل بدون هذا الإذن.`, 'error');
          }
        }, {
          scope: scopeStr,
          return_scopes: true,
          auth_type: 'rerequest',
        });
      }, 1500);
      return;
    }

    fetchAndSelectPages(platform, response.authResponse.accessToken, platformLabel);
  }, {
    scope: scopeStr,
    return_scopes: true,
  });
}


// After login → fetch the client's pages and show a picker
async function fetchAndSelectPages(platform, userAccessToken, platformLabel) {
  try {
    Toast.show(`⏳ جارٍ تحميل صفحاتك...`, 'info');

    // Exchange short-lived token for long-lived via our server
    const exchangeRes = await apiFetch('/api/platforms/exchange-token', {
      method: 'POST',
      body: JSON.stringify({ userAccessToken, platform }),
    });

    if (!exchangeRes?.pages || exchangeRes.pages.length === 0) {
      Toast.show(`⚠️ لم يتم العثور على صفحات مربوطة بحسابك. تأكد من ربط صفحة فيسبوك بحسابك.`, 'warning');
      return;
    }

    // Show page selector modal
    showPageSelectorModal(platform, platformLabel, exchangeRes.pages, exchangeRes.longLivedToken);

  } catch (err) {
    console.error('Page fetch error:', err);
    Toast.show(`❌ خطأ في تحميل الصفحات`, 'error');
  }
}

// Show the page selector modal
function showPageSelectorModal(platform, platformLabel, pages, userLongToken) {
  const modal = document.getElementById('page-selector-modal');
  const title = document.getElementById('page-selector-title');
  const list = document.getElementById('page-list');

  if (title) title.textContent = `اختر ${platformLabel === 'انستغرام' ? 'حساب الانستغرام' : 'الصفحة'} المراد ربطها`;

  list.innerHTML = pages.map(page => `
    <button onclick="connectPage('${platform}','${page.id}','${encodeURIComponent(page.name)}','${page.access_token}','${page.ig_id || ''}')"
      style="display:flex;align-items:center;gap:12px;padding:14px 16px;border:1.5px solid #e2e8f0;
             border-radius:12px;background:#fff;cursor:pointer;text-align:right;width:100%;
             transition:all .2s;font-family:Cairo,sans-serif;font-size:14px"
      onmouseover="this.style.borderColor='#1e4d8c';this.style.background='#f0f7ff'"
      onmouseout="this.style.borderColor='#e2e8f0';this.style.background='#fff'">
      <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#1e4d8c,#0ea5e9);
                  display:flex;align-items:center;justify-content:center;color:white;font-size:18px;flex-shrink:0">
        ${platform === 'instagram' ? '📸' : '📘'}
      </div>
      <div>
        <div style="font-weight:700;color:#1a1a2e">${decodeURIComponent(page.name)}</div>
        <div style="font-size:0.72rem;color:#64748b">معرّف: ${page.id}${page.ig_username ? ` · @${page.ig_username}` : ''}</div>
      </div>
    </button>
  `).join('');

  modal.style.display = 'flex';
}

// Called when user picks a specific page
window.connectPage = async function (platform, pageId, pageNameEncoded, pageToken, igId) {
  document.getElementById('page-selector-modal').style.display = 'none';
  const pageName = decodeURIComponent(pageNameEncoded);

  Toast.show(`⏳ جارٍ ربط ${pageName}...`, 'info');

  try {
    const res = await apiFetch('/api/platforms/connect', {
      method: 'POST',
      body: JSON.stringify({ platform, pageId, pageName, pageToken, igId }),
    });

    if (res?.success) {
      Toast.show(`✅ تم ربط ${pageName} بنجاح! الوكيل جاهز لاستقبال الرسائل.`, 'success');
      updatePlatformUI(platform, { pageName, igId });
    } else {
      Toast.show(res?.error || `❌ فشل الربط`, 'error');
    }
  } catch (err) {
    Toast.show('❌ خطأ في الاتصال بالخادم', 'error');
  }
};

// ── WhatsApp Embedded Signup ───────────────────────────────────────────────
function connectWhatsApp() {
  if (typeof FB === 'undefined') {
    return showConnectionGuide('whatsapp');
  }

  Toast.show('⏳ جارٍ فتح نافذة واتساب للأعمال...', 'info');

  // Meta's WhatsApp Embedded Signup flow
  FB.login(function (response) {
    if (response.authResponse) {
      const code = response.authResponse.code;
      // Send code to backend to exchange for WABA access
      exchangeWhatsAppCode(code);
    } else {
      Toast.show('❌ تم إلغاء ربط واتساب', 'error');
    }
  }, {
    config_id: window.META_WABA_CONFIG_ID || '',  // Set your Embedded Signup Config ID
    response_type: 'code',
    override_default_response_type: true,
    extras: {
      setup: {},
      featureType: '',
      sessionInfoVersion: '3',
    },
  });

  // Also listen for Embedded Signup session messages
  window.addEventListener('message', function waListener(event) {
    if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'WA_EMBEDDED_SIGNUP') {
        if (data.event === 'FINISH') {
          const { phone_number_id, waba_id } = data.data;
          saveWhatsAppConnection(phone_number_id, waba_id);
        } else if (data.event === 'CANCEL') {
          Toast.show('⚠️ تم إلغاء ربط واتساب', 'warning');
        }
        window.removeEventListener('message', waListener);
      }
    } catch { }
  });
}

async function exchangeWhatsAppCode(code) {
  try {
    const res = await apiFetch('/api/platforms/whatsapp-signup', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    if (res?.success) {
      Toast.show(`✅ تم ربط واتساب للأعمال! رقم: ${res.displayPhone || ''}`, 'success');
      updatePlatformUI('whatsapp', res);
    } else {
      Toast.show(res?.error || '❌ فشل ربط واتساب', 'error');
    }
  } catch {
    Toast.show('❌ خطأ في ربط واتساب', 'error');
  }
}

async function saveWhatsAppConnection(phoneNumberId, wabaId) {
  try {
    const res = await apiFetch('/api/platforms/whatsapp-signup', {
      method: 'POST',
      body: JSON.stringify({ phoneNumberId, wabaId }),
    });
    if (res?.success) {
      Toast.show(`✅ تم ربط واتساب! ${res.displayPhone || ''}`, 'success');
      updatePlatformUI('whatsapp', res);
    }
  } catch {
    Toast.show('❌ خطأ في حفظ بيانات واتساب', 'error');
  }
}

// ── Update UI after successful connection ─────────────────────────────────
function updatePlatformUI(platform, data) {
  const handleMap = { instagram: 'ig-handle', facebook: 'fb-handle', whatsapp: 'wa-handle' };
  const btnMap = { instagram: 'connect-ig', facebook: 'connect-fb', whatsapp: 'connect-wa' };
  const rowMap = { instagram: 'row-ig', facebook: 'row-fb', whatsapp: 'row-wa' };

  const handle = document.getElementById(handleMap[platform]);
  const btn = document.getElementById(btnMap[platform]);
  const row = document.getElementById(rowMap[platform]);

  const displayText = data.igUsername ? `@${data.igUsername}` : data.pageName || data.displayPhone || 'مربوط ✓';

  if (handle) handle.textContent = displayText;
  if (btn) {
    btn.textContent = '✅ مربوط';
    btn.style.background = '#e8f5e9';
    btn.style.color = '#2e7d32';
    btn.style.border = '1px solid #a5d6a7';
    btn.disabled = true;
  }
  if (row) row.style.background = 'linear-gradient(to left, #f0fdf4, #fff)';
}

// ── Fallback: show setup guide if Meta App not configured ─────────────────
function showConnectionGuide(platform) {
  const names = { instagram: 'انستغرام', facebook: 'فيسبوك', whatsapp: 'واتساب' };
  const steps = [
    'اذهب إلى <a href="https://developers.facebook.com/apps" target="_blank" style="color:#0ea5e9">developers.facebook.com/apps</a>',
    'أنشئ <b>Business App</b> جديد أو استخدم تطبيقك الحالي',
    'انسخ <b>App ID</b> وأضفه في ملف <code>.env</code> كـ <code>META_APP_ID</code>',
    'أضف <b>Redirect URI</b>: <code>http://localhost:3000/api/oauth/callback</code>',
    'أعد تشغيل السيرفر لتفعيل الربط',
  ];

  // Show a toast with instructions
  Toast.show(`⚠️ أضف META_APP_ID إلى .env لتفعيل ربط ${names[platform] || platform}`, 'warning');

  // Also show inline modal
  const modal = document.getElementById('page-selector-modal');
  const title = document.getElementById('page-selector-title');
  const list = document.getElementById('page-list');

  if (title) title.textContent = `إعداد تطبيق ${names[platform] || platform}`;
  if (list) {
    list.innerHTML = steps.map((step, i) => `
      <div style="display:flex;gap:12px;align-items:flex-start;padding:12px 14px;
                  background:#f8fafc;border-radius:10px;font-size:13px;color:#374151">
        <span style="background:#1e4d8c;color:white;width:22px;height:22px;border-radius:50%;
                     display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0">${i + 1}</span>
        <span>${step}</span>
      </div>
    `).join('');
  }
  if (modal) modal.style.display = 'flex';
}



// ── ORDERS ─────────────────────────────────────────────────────
let allOrders = [];

async function loadOrdersPage() {
  try {
    const data = await apiFetch('/api/orders');
    allOrders = data?.orders || [];
    renderOrdersTable();
  } catch (err) {
    console.error('Orders load error:', err);
  }

  document.getElementById('order-search')?.addEventListener('input', (e) => {
    renderOrdersTable(e.target.value);
  });

  document.getElementById('add-order-btn')?.addEventListener('click', () => {
    document.getElementById('add-order-modal').style.display = 'flex';
  });

  document.getElementById('add-order-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      client: document.getElementById('order-client')?.value,
      product: document.getElementById('order-product')?.value,
      qty: document.getElementById('order-qty')?.value || 1,
      price: document.getElementById('order-price')?.value,
      phone: document.getElementById('order-phone')?.value,
      wilaya: document.getElementById('order-wilaya')?.value,
      source: 'manual'
    };

    if (!payload.client || !payload.product || !payload.price) {
      return Toast.show('الرجاء ملء الحقول المطلوبة', 'error');
    }

    try {
      const res = await apiFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (res?.order) {
        allOrders.unshift(res.order);
        renderOrdersTable();
        document.getElementById('add-order-modal').style.display = 'none';
        document.getElementById('add-order-form').reset();
        Toast.show(`تمت إضافة الطلب ${res.order.id}!`, 'success');
        loadDashboardStats();
      } else {
        Toast.show(res?.error || 'فشلت الإضافة', 'error');
      }
    } catch (err) {
      Toast.show('خطأ في الاتصال', 'error');
    }
  });

  document.getElementById('export-orders')?.addEventListener('click', () => {
    const csv = ['رقم الطلب,الزبون,المنتج,الكمية,السعر,الولاية,الحالة,التاريخ'];
    allOrders.forEach(o => {
      csv.push(`${o.id},${o.client},${o.product},${o.qty},${o.price},${o.wilaya || ''},${o.status},${new Date(o.createdAt).toLocaleDateString('ar-DZ')}`);
    });
    const blob = new Blob(['\uFEFF' + csv.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fahim_orders_${Date.now()}.csv`;
    a.click();
    Toast.show('تم تصدير الطلبات!', 'success');
  });
}

function renderOrdersTable(query = '') {
  const body = document.getElementById('orders-table-body');
  if (!body) return;

  const filtered = query
    ? allOrders.filter(o =>
        (o.client || '').toLowerCase().includes(query.toLowerCase()) ||
        (o.product || '').toLowerCase().includes(query.toLowerCase()) ||
        (o.id || '').toLowerCase().includes(query.toLowerCase())
      )
    : allOrders;

  if (filtered.length === 0) {
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>لا توجد طلبات بعد. اربط منصاتك ليبدأ الوكيل بتثبيت الطلبات!</p></div>`;
    return;
  }

  const statusMap = {
    pending: '<span class="status-chip pending">⏳ بانتظار</span>',
    delivered: '<span class="status-chip delivered">✅ تم التوصيل</span>',
    cancelled: '<span class="status-chip cancelled">❌ ملغي</span>'
  };

  body.innerHTML = filtered.map(o => `
    <div class="order-row">
      <div class="order-id-cell">${o.id?.substring(0, 12) || '—'}</div>
      <div class="order-client-cell">
        <strong>${o.client}</strong>
        <small>${o.product} (x${o.qty || 1})</small>
      </div>
      <div>${new Date(o.createdAt).toLocaleDateString('ar-DZ')}</div>
      <div>${Number(o.price || 0).toLocaleString('ar-DZ')} د.ج</div>
      <div>${statusMap[o.status] || statusMap.pending}</div>
      <div class="row-actions">
        <button class="row-act-btn" onclick="toggleOrderStatus('${o.id}', '${o.status}')" title="تبديل الحالة">🔄</button>
        <button class="row-act-btn" onclick="deleteOrder('${o.id}')" title="حذف">🗑️</button>
      </div>
    </div>
  `).join('');
}

window.toggleOrderStatus = async (id, currentStatus) => {
  const newStatus = currentStatus === 'pending' ? 'delivered' : 'pending';
  try {
    const res = await apiFetch(`/api/orders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus })
    });
    if (res?.success) {
      const order = allOrders.find(o => o.id === id);
      if (order) order.status = newStatus;
      renderOrdersTable();
      loadDashboardStats();
      Toast.show('تم تحديث حالة الطلب', 'success');
    }
  } catch (err) {
    Toast.show('خطأ في التحديث', 'error');
  }
};

window.deleteOrder = async (id) => {
  if (!confirm('هل تريد حذف هذا الطلب؟')) return;
  try {
    const res = await apiFetch(`/api/orders/${id}`, { method: 'DELETE' });
    if (res?.success) {
      allOrders = allOrders.filter(o => o.id !== id);
      renderOrdersTable();
      loadDashboardStats();
      Toast.show('تم حذف الطلب', 'info');
    }
  } catch (err) {
    Toast.show('خطأ في الحذف', 'error');
  }
};

// ── PRODUCTS ───────────────────────────────────────────────────
let allProducts = [];
const productEmojis = ['📦', '👕', '👟', '⌚', '💍', '🎮', '📱', '💻', '🎒', '👜'];

async function loadProductsPage() {
  try {
    const data = await apiFetch('/api/products');
    allProducts = data?.products || [];
    renderProductsGrid();
  } catch (err) {
    console.error('Products load error:', err);
  }

  document.getElementById('add-product-btn')?.addEventListener('click', () => {
    document.getElementById('add-product-modal').style.display = 'flex';
  });

  document.getElementById('add-product-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('product-name')?.value,
      price: document.getElementById('product-price')?.value,
      stock: document.getElementById('product-stock')?.value || 0,
      category: document.getElementById('product-category')?.value || 'عام',
      description: document.getElementById('product-desc')?.value || ''
    };

    if (!payload.name || !payload.price) return Toast.show('الرجاء ملء الحقول المطلوبة', 'error');

    try {
      const res = await apiFetch('/api/products', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (res?.product) {
        allProducts.unshift(res.product);
        renderProductsGrid();
        document.getElementById('add-product-modal').style.display = 'none';
        document.getElementById('add-product-form').reset();
        Toast.show('تمت إضافة المنتج بنجاح!', 'success');
      } else {
        Toast.show(res?.error || 'فشلت الإضافة', 'error');
      }
    } catch (err) {
      Toast.show('خطأ في الاتصال', 'error');
    }
  });

  document.getElementById('product-search')?.addEventListener('input', (e) => {
    renderProductsGrid(e.target.value);
  });
}

function renderProductsGrid(query = '') {
  const grid = document.getElementById('products-grid');
  if (!grid) return;

  const filtered = query
    ? allProducts.filter(p => (p.name || '').toLowerCase().includes(query.toLowerCase()))
    : allProducts;

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><p>لا توجد منتجات بعد. اضغط "+ إضافة منتج" للبدء!</p></div>`;
    return;
  }

  grid.innerHTML = filtered.map((p, i) => `
    <div class="product-card">
      <div class="product-icon">${productEmojis[i % productEmojis.length]}</div>
      <div class="product-name">${p.name}</div>
      <div class="product-price">${Number(p.price).toLocaleString('ar-DZ')} د.ج</div>
      <div class="product-stock">المخزون: ${p.stock || 0} وحدة</div>
      <div class="product-actions">
        <button class="product-edit-btn" onclick="editProduct('${p.id}')">تعديل</button>
        <button class="product-del-btn" onclick="deleteProduct('${p.id}')">حذف</button>
      </div>
    </div>
  `).join('');
}

window.deleteProduct = async (id) => {
  if (!confirm('هل تريد حذف هذا المنتج؟')) return;
  try {
    const res = await apiFetch(`/api/products/${id}`, { method: 'DELETE' });
    if (res?.success) {
      allProducts = allProducts.filter(p => p.id !== id);
      renderProductsGrid();
      Toast.show('تم حذف المنتج', 'info');
    }
  } catch (err) {
    Toast.show('خطأ في الحذف', 'error');
  }
};

window.editProduct = (id) => Toast.show('قريبًا: تعديل المنتج', 'info');

// ── INBOX ──────────────────────────────────────────────────────
async function loadInboxPage() {
  try {
    const data = await apiFetch('/api/dashboard/conversations');
    renderConversations(data?.conversations || []);
  } catch (err) {}

  // FahimBot demo widget (uses localStorage for demo, real via Meta webhooks)
  initChatWidget();
}

function renderConversations(conversations) {
  const list = document.getElementById('conversation-list');
  if (!list) return;

  if (conversations.length === 0) {
    list.innerHTML = `<div class="empty-state small"><p>لا توجد محادثات بعد. اربط منصاتك وأرسل رسالة اختبار!</p></div>`;
    return;
  }

  const platColors = { ig: 'ig', fb: 'fb', wa: 'wa' };
  const platNames = { ig: '📸 IG', fb: '📘 FB', wa: '📱 WA' };

  list.innerHTML = conversations.map(conv => `
    <div class="conv-item" onclick="openConversation('${conv.id}')">
      <div class="conv-dot ${platColors[conv.platform] || 'wa'}"></div>
      <div class="conv-info">
        <div class="conv-name">${conv.senderName || conv.id}</div>
        <div class="conv-preview">${conv.lastMessage || '...'}</div>
        <div class="conv-time">${new Date(conv.updatedAt).toLocaleDateString('ar-DZ')}</div>
      </div>
      <span style="font-size:0.62rem;color:#aab">${platNames[conv.platform] || ''}</span>
    </div>
  `).join('');
}

window.openConversation = (id) => {
  Toast.show('محادثة حقيقية من المنصات ستظهر هنا عند توصيل حساباتك', 'info');
};

function initChatWidget() {
  const input = document.getElementById('chat-input-widget');
  const send = document.getElementById('chat-send-widget');
  const messages = document.getElementById('chat-messages-widget');

  const sendMsg = () => {
    const msg = input?.value?.trim();
    if (!msg) return;

    const userBubble = document.createElement('div');
    userBubble.className = 'w-msg w-msg-user';
    userBubble.textContent = msg;
    messages?.appendChild(userBubble);
    input.value = '';
    messages?.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });

    const typing = document.createElement('div');
    typing.className = 'w-msg w-msg-ai';
    typing.textContent = '...';
    typing.style.opacity = '0.6';
    messages?.appendChild(typing);

    setTimeout(() => {
      typing.remove();
      const reply = FahimBot.generateResponse(msg);
      const aiBubble = document.createElement('div');
      aiBubble.className = 'w-msg w-msg-ai';
      aiBubble.textContent = reply;
      messages?.appendChild(aiBubble);
      messages?.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
    }, 700 + Math.random() * 500);
  };

  send?.addEventListener('click', sendMsg);
  input?.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMsg(); });
}

// ── PROFILE ────────────────────────────────────────────────────
async function loadProfilePage() {
  const user = await Auth.refreshUser();
  if (!user) return;

  const nameEl = document.getElementById('profile-name');
  const emailEl = document.getElementById('profile-email');
  const planEl = document.getElementById('profile-plan');
  const avatarEl = document.getElementById('profile-avatar-text');
  const storeInput = document.getElementById('store-name-input');
  const psPoints = document.getElementById('ps-points');
  const psOrders = document.getElementById('ps-orders');

  if (nameEl) nameEl.textContent = user.name || 'مستخدم';
  if (emailEl) emailEl.textContent = user.email || '';
  if (planEl) planEl.textContent = user.plan || 'free';
  if (avatarEl) avatarEl.textContent = (user.name || 'م')[0].toUpperCase();
  if (storeInput) storeInput.value = user.storeName || '';
  if (psPoints) psPoints.textContent = (user.points || 0).toLocaleString('ar-DZ');
  if (psOrders) psOrders.textContent = allOrders.length;

  document.getElementById('save-settings')?.addEventListener('click', async () => {
    const storeName = storeInput?.value;
    const welcomeMessage = document.getElementById('welcome-message')?.value;

    try {
      const res = await apiFetch('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ storeName, welcomeMessage })
      });

      if (res?.success) {
        Auth.refreshUser();
        const storeEl = document.getElementById('store-name');
        if (storeEl) storeEl.textContent = storeName;
        Toast.show('تم حفظ الإعدادات بنجاح!', 'success');
      }
    } catch {
      Toast.show('خطأ في الحفظ', 'error');
    }
  });
}

// ── BILLING ────────────────────────────────────────────────────
function loadBillingPage() {
  const user = Auth.getUser();
  const billingPoints = document.getElementById('billing-points');
  if (billingPoints) billingPoints.textContent = (user?.points || 0).toLocaleString('ar-DZ');

  let selectedPlan = null;

  document.querySelectorAll('.bp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.billing-plan-card');
      selectedPlan = card?.dataset;

      const modal = document.getElementById('payment-modal');
      const summary = document.getElementById('payment-summary');

      if (summary && selectedPlan) {
        summary.innerHTML = `
          <div style="font-size:2rem;margin-bottom:8px">🪙</div>
          <div style="font-size:1.3rem;font-weight:900;color:#1e4d8c;margin-bottom:4px">
            ${Number(selectedPlan.points || 0).toLocaleString('ar-DZ')} نقطة
          </div>
          <div style="font-size:1rem;color:#6b7f9a;margin-bottom:12px">بسعر إجمالي</div>
          <div style="font-size:1.5rem;font-weight:900;color:#0f2d5e">
            ${Number(selectedPlan.price || 0).toLocaleString('ar-DZ')} د.ج
          </div>
        `;
      }

      if (modal) modal.style.display = 'flex';
    });
  });

  document.getElementById('confirm-payment')?.addEventListener('click', async () => {
    if (!selectedPlan) return;

    try {
      const res = await apiFetch('/api/dashboard/billing/purchase', {
        method: 'POST',
        body: JSON.stringify({ plan: selectedPlan.plan })
      });

      if (res?.success) {
        document.getElementById('payment-modal').style.display = 'none';
        if (billingPoints) billingPoints.textContent = res.newBalance.toLocaleString('ar-DZ');
        animateCount('stat-points', res.newBalance);

        await Auth.refreshUser();
        const psPoints = document.getElementById('ps-points');
        if (psPoints) psPoints.textContent = res.newBalance.toLocaleString('ar-DZ');

        Toast.show(`${res.message} 🎉`, 'success');
        selectedPlan = null;
      } else {
        Toast.show(res?.error || 'فشل الدفع', 'error');
      }
    } catch {
      Toast.show('خطأ في الاتصال', 'error');
    }
  });
}

// ── MODALS ─────────────────────────────────────────────────────
function initModals() {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  });

  document.querySelectorAll('[data-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = document.getElementById(btn.dataset.modal);
      if (modal) modal.style.display = 'none';
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    }
  });
}

// ── CHART ──────────────────────────────────────────────────────
function initChart() {
  const canvas = document.getElementById('revenue-chart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const days = 7;
  const labels = [];
  const revenueData = [];

  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    labels.push(d.toLocaleDateString('ar-DZ', { weekday: 'short' }));
    revenueData.push(Math.floor(Math.random() * 15000) + 1000);
  }

  drawChart(ctx, canvas, labels, revenueData);
}

function drawChart(ctx, canvas, labels, data) {
  const W = canvas.offsetWidth || 400;
  const H = canvas.offsetHeight || 180;
  canvas.width = W;
  canvas.height = H;

  const pad = { top: 10, right: 10, bottom: 30, left: 40 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const max = Math.max(...data) * 1.2;
  const len = data.length;

  ctx.clearRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = '#f0f4f8';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (cH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
  }

  // Fill
  const grad = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
  grad.addColorStop(0, 'rgba(30, 92, 168, 0.15)');
  grad.addColorStop(1, 'rgba(30, 92, 168, 0)');

  ctx.beginPath();
  data.forEach((val, i) => {
    const x = pad.left + (cW / (len - 1)) * i;
    const y = pad.top + cH - (val / max) * cH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.left + cW, pad.top + cH);
  ctx.lineTo(pad.left, pad.top + cH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = '#2196F3';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  data.forEach((val, i) => {
    const x = pad.left + (cW / (len - 1)) * i;
    const y = pad.top + cH - (val / max) * cH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#9aa5b4';
  ctx.font = '11px Cairo, sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((label, i) => {
    const x = pad.left + (cW / (len - 1)) * i;
    ctx.fillText(label, x, H - 8);
  });

  // Dots
  data.forEach((val, i) => {
    const x = pad.left + (cW / (len - 1)) * i;
    const y = pad.top + cH - (val / max) * cH;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#2196F3';
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

// ── FAHIM BOT (local demo widget) ──────────────────────────────
const FahimBot = {
  responses: {
    greeting: ['أهلاً وسهلاً! 👋 كيفاش نخدمك اليوم؟', 'مرحبا! 😊 واش تحب نساعدك؟', 'سلام! كيفاش نقدر نعاونك؟'],
    price: ['السعر هو 3,500 دج. واش يعجبك؟ 💰', 'قيمتو زهيد جداً! 🎯 واش تحب تطلب؟'],
    order: ['ممتاز! ✅ نحتاج اسمك الكامل، رقم هاتفك، وولايتك للتوصيل.', 'تم! 🎉 قولي اسمك ورقم هاتفك وراح نثبت الطلبية.'],
    product: ['واش تحب تشري منتج معين؟ قولي شو تحب! 🛍️', 'عندنا منتجات كثيرة! واش يعجبك؟'],
    unknown: ['سامحني، ما فهمتش زين. ممكن تعيد؟ 🙏', 'ممكن توضحلي أكثر؟']
  },
  generateResponse(msg) {
    const m = msg.toLowerCase();
    if (/سلام|مرحبا|أهلا|hello|bonjour|واش راك/.test(m)) return this.pick('greeting');
    if (/سعر|ثمن|prix|price|كم|combien|بكاش/.test(m)) return this.pick('price');
    if (/شري|اشري|طلب|order|buy|حاب نشري/.test(m)) return this.pick('order');
    if (/منتج|product|واش عندك|catalogue/.test(m)) return this.pick('product');
    return this.pick('unknown');
  },
  pick(type) {
    const arr = this.responses[type] || this.responses.unknown;
    return arr[Math.floor(Math.random() * arr.length)];
  }
};
