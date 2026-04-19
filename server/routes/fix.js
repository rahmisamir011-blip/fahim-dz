/**
 * FAHIM DZ — Fix.js Dynamic Route
 * Serves the latest JS patch via Express (bypasses all static file caching).
 *
 * v20260419b: Switched from broken FB.login() JS SDK popup
 *             to server-side OAuth redirect (/api/oauth/connect/:platform)
 *             which properly handles Meta Business Login.
 */

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const js = `
/* FAHIM FIX v20260419b — Server-Side OAuth Popup (Express route, never cached) */
(function() {
  'use strict';

  /* ─── Override connectWithFacebook ─────────────────────────────────────────
   * PROBLEM: The old fix used FB.login() (JS SDK), which returns authResponse:null
   *          for Meta Business Login (Business selection + IG account picker).
   *          The Business Login flow does not use the JS SDK callback at all —
   *          it redirects with a ?code= parameter like standard OAuth.
   *
   * SOLUTION: Open /api/oauth/connect/:platform as a popup. The server redirects
   *           to Meta OAuth → Meta redirects back to /api/oauth/callback → server
   *           exchanges code, saves token to Firestore, sends postMessage(OAUTH_SUCCESS).
   * ─────────────────────────────────────────────────────────────────────────── */
  window.connectWithFacebook = function(platform) {
    var authToken = localStorage.getItem('fahim_token')
                 || localStorage.getItem('authToken')
                 || localStorage.getItem('token');

    if (!authToken) {
      _showToast('\\u274c \\u064a\\u062c\\u0628 \\u062a\\u0633\\u062c\\u064a\\u0644 \\u0627\\u0644\\u062f\\u062e\\u0648\\u0644 \\u0623\\u0648\\u0644\\u0627\\u064b.', 'error');
      return;
    }

    _showToast('\\u23f3 \\u062c\\u0627\\u0631\\u0650 \\u0641\\u062a\\u062d \\u0646\\u0627\\u0641\\u0630\\u0629 \\u0627\\u0644\\u0631\\u0628\\u0637...', 'info');

    var url = '/api/oauth/connect/' + platform + '?token=' + encodeURIComponent(authToken);
    var w = 620, h = 720;
    var left = Math.max(0, Math.round((screen.width  - w) / 2));
    var top  = Math.max(0, Math.round((screen.height - h) / 2));
    var popup = window.open(
      url,
      'fahim_oauth_' + platform,
      'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top +
        ',scrollbars=yes,resizable=yes,status=yes'
    );

    if (!popup || popup.closed || typeof popup.closed === 'undefined') {
      _showToast('\\u26a0\\ufe0f \\u062a\\u0645 \\u062d\\u062c\\u0628 \\u0627\\u0644\\u0646\\u0627\\u0641\\u0630\\u0629 \\u0627\\u0644\\u0645\\u0646\\u0628\\u062b\\u0642\\u0629. \\u064a\\u0631\\u062c\\u0649 \\u0627\\u0644\\u0633\\u0645\\u0627\\u062d \\u0628\\u0647\\u0627.', 'warning');
      return;
    }

    console.log('[FIX v20260419b] OAuth popup opened for:', platform);

    function _onMsg(e) {
      if (e.origin !== location.origin) return;
      if (!e.data || !e.data.type) return;
      if (e.data.platform !== platform) return;

      if (e.data.type === 'OAUTH_SUCCESS') {
        window.removeEventListener('message', _onMsg);
        clearInterval(pollTimer);

        var d = e.data.data || {};
        var displayName = d.igUsername ? '@' + d.igUsername : d.pageName || platform;
        console.log('[FIX v20260419b] OAUTH_SUCCESS — platform:', platform, 'name:', displayName);

        _showToast('\\u2705 \\u062a\\u0645 \\u0631\\u0628\\u0637 ' + displayName + ' \\u0628\\u0646\\u062c\\u0627\\u062d!', 'success');
        _updateUI(platform, displayName);

        setTimeout(function() {
          try {
            if (typeof loadPlatforms === 'function') loadPlatforms();
            else if (window.Dashboard && window.Dashboard.refresh) window.Dashboard.refresh();
            else location.reload();
          } catch(e2) { location.reload(); }
        }, 1500);
      }

      if (e.data.type === 'OAUTH_ERROR') {
        window.removeEventListener('message', _onMsg);
        clearInterval(pollTimer);
        console.error('[FIX v20260419b] OAUTH_ERROR:', e.data.error);
        _showToast('\\u274c \\u0641\\u0634\\u0644 \\u0627\\u0644\\u0631\\u0628\\u0637: ' + (e.data.error || '\\u062e\\u0637\\u0623 \\u063a\\u064a\\u0631 \\u0645\\u0639\\u0631\\u0648\\u0641'), 'error');
      }
    }

    window.addEventListener('message', _onMsg);

    var pollTimer = setInterval(function() {
      try { if (popup.closed) { clearInterval(pollTimer); window.removeEventListener('message', _onMsg); } }
      catch(e3) { clearInterval(pollTimer); }
    }, 800);
  };

  function _updateUI(platform, displayName) {
    var key = platform === 'instagram' ? 'ig' : platform === 'facebook' ? 'fb' : 'wa';
    var hdl = document.getElementById(key + '-handle');
    var btn = document.getElementById('connect-' + key);
    var dis = document.getElementById('disconnect-' + key);
    if (hdl) hdl.textContent = displayName;
    if (btn) {
      btn.textContent = '\\u2705 \\u0645\\u0631\\u0628\\u0648\\u0637';
      btn.disabled = true;
      btn.style.cssText += 'background:#e8f5e9!important;color:#2e7d32!important;';
    }
    if (dis) dis.style.display = 'inline-flex';
  }

  /* ─── Fix logout button ─────────────────────────────────────────────────── */
  function _patchLogout() {
    var btn = document.getElementById('logout-btn');
    if (!btn) return;
    btn.onclick = function(e) {
      e.stopImmediatePropagation();
      if (window.Auth && window.Auth.logout) window.Auth.logout();
      else { localStorage.clear(); sessionStorage.clear(); window.location.href = '/authentification.html'; }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _patchLogout);
  else _patchLogout();

  /* ─── Toast helper ──────────────────────────────────────────────────────── */
  function _showToast(msg, type) {
    if (window.Toast && window.Toast.show) { window.Toast.show(msg, type); return; }
    var c = document.getElementById('toast-container');
    if (!c) { console.log('[FIX Toast]', msg); return; }
    var t = document.createElement('div');
    var bg = type === 'error' ? '#fee2e2' : type === 'success' ? '#d1fae5' : type === 'warning' ? '#fef3c7' : '#e0f2fe';
    t.style.cssText = 'padding:12px 18px;border-radius:10px;margin-bottom:8px;'
      + 'font-family:Cairo,sans-serif;font-size:14px;direction:rtl;color:#1a1a2e;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,.15);background:' + bg;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(function() { t.remove(); }, 5000);
  }

  console.log('[FIX] v20260419b loaded \\u2014 server-side OAuth popup \\u2705');
  console.log('[FIX] connectWithFacebook \\u2192 /api/oauth/connect/:platform');
})();
`;

  res.send(js);
});

module.exports = router;
