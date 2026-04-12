/**
 * FAHIM DZ — Auth Page (Real API Version)
 * Connects to backend: POST /api/auth/login and /api/auth/register
 */

const API_BASE = window.location.origin;

// ── DOM Elements ─────────────────────────────────────────────
const loginForm    = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginTab     = document.getElementById('tab-login');
const registerTab  = document.getElementById('tab-register');
const loginPanel   = document.getElementById('login-panel');
const registerPanel = document.getElementById('register-panel');

// ── Tab Switching ─────────────────────────────────────────────
loginTab?.addEventListener('click', () => switchTab('login'));
registerTab?.addEventListener('click', () => switchTab('register'));

function switchTab(tab) {
  if (tab === 'login') {
    loginTab?.classList.add('active');
    registerTab?.classList.remove('active');
    loginPanel?.classList.add('active');
    registerPanel?.classList.remove('active');
  } else {
    registerTab?.classList.add('active');
    loginTab?.classList.remove('active');
    registerPanel?.classList.add('active');
    loginPanel?.classList.remove('active');
  }
}

// ── Redirect if already logged in ────────────────────────────
if (localStorage.getItem('fahim_token')) {
  window.location.href = 'dashboard.html';
}

// ── Helper: Show error on form ────────────────────────────────
function showFormError(formId, message) {
  const errEl = document.getElementById(`${formId}-error`);
  if (errEl) {
    errEl.textContent = message;
    errEl.style.display = 'block';
  }
}

function hideFormError(formId) {
  const errEl = document.getElementById(`${formId}-error`);
  if (errEl) errEl.style.display = 'none';
}

function setButtonLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn._originalText = btn.textContent;
    btn.textContent = '...';
  } else {
    btn.disabled = false;
    btn.textContent = btn._originalText || btn.textContent;
  }
}

// ── LOGIN ─────────────────────────────────────────────────────
loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideFormError('login');

  const email = document.getElementById('login-email')?.value?.trim();
  const password = document.getElementById('login-password')?.value;
  const submitBtn = loginForm.querySelector('[type="submit"]');

  if (!email || !password) {
    return showFormError('login', 'الرجاء إدخال البريد وكلمة المرور');
  }

  setButtonLoading(submitBtn, true);

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      showFormError('login', data.error || 'فشل تسجيل الدخول');
      return;
    }

    // Save token and user
    localStorage.setItem('fahim_token', data.token);
    localStorage.setItem('fahim_user', JSON.stringify(data.user));

    // Redirect to dashboard
    window.location.href = 'dashboard.html';

  } catch (err) {
    showFormError('login', 'خطأ في الاتصال — تأكد من تشغيل السيرفر');
  } finally {
    setButtonLoading(submitBtn, false);
  }
});

// ── REGISTER ──────────────────────────────────────────────────
registerForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideFormError('register');

  const name = document.getElementById('register-name')?.value?.trim();
  const email = document.getElementById('register-email')?.value?.trim();
  const storeName = document.getElementById('register-store')?.value?.trim();
  const password = document.getElementById('register-password')?.value;
  const confirmPassword = document.getElementById('register-confirm')?.value;
  const submitBtn = registerForm.querySelector('[type="submit"]');

  if (!name || !email || !password) {
    return showFormError('register', 'الرجاء إدخال جميع الحقول المطلوبة');
  }

  if (password.length < 6) {
    return showFormError('register', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل');
  }

  if (confirmPassword && password !== confirmPassword) {
    return showFormError('register', 'كلمتا المرور غير متطابقتين');
  }

  setButtonLoading(submitBtn, true);

  try {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, storeName }),
    });

    const data = await res.json();

    if (!res.ok) {
      showFormError('register', data.error || 'فشل إنشاء الحساب');
      return;
    }

    localStorage.setItem('fahim_token', data.token);
    localStorage.setItem('fahim_user', JSON.stringify(data.user));
    window.location.href = 'dashboard.html';

  } catch (err) {
    showFormError('register', 'خطأ في الاتصال — تأكد من تشغيل السيرفر');
  } finally {
    setButtonLoading(submitBtn, false);
  }
});

// ── Password Strength Indicator ───────────────────────────────
document.getElementById('register-password')?.addEventListener('input', (e) => {
  const pw = e.target.value;
  const strengthEl = document.getElementById('password-strength');
  if (!strengthEl) return;

  let strength = 0;
  if (pw.length >= 6) strength++;
  if (pw.length >= 10) strength++;
  if (/[A-Z]/.test(pw)) strength++;
  if (/[0-9]/.test(pw)) strength++;
  if (/[^A-Za-z0-9]/.test(pw)) strength++;

  const levels = ['', 'ضعيفة', 'مقبولة', 'جيدة', 'قوية', 'ممتازة'];
  const colors = ['', '#ef4444', '#f59e0b', '#3b82f6', '#22c55e', '#10b981'];

  strengthEl.textContent = levels[strength] || '';
  strengthEl.style.color = colors[strength] || '';
});
