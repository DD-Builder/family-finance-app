// Pre-bundle error capture + opt-in service-worker nuke. Runs synchronously
// before main.tsx loads so any boot failure (failed asset fetch, syntax
// error in a chunk, missing import) is surfaced in the visible fallback
// block instead of leaving the user on a blank page. Lives in /public so
// it ships to the same origin as the rest of the bundle and is covered
// by `script-src 'self'` in the CSP — no inline-script hash needed.

// closed: F-SECC-P1-2 — JS frame-buster. `frame-ancestors` is ignored in
// <meta> CSP and X-Frame-Options is HTTP-header-only (GitHub Pages does
// not emit it). Without a JS check, a malicious page can embed this app
// in an iframe and clickjack the unlock / send / wipe flows. The check
// runs BEFORE main.tsx so the React tree never mounts inside a frame.
// If access to window.top is denied (cross-origin lock), the catch
// blocks rendering entirely.
(function frameBuster() {
  try {
    if (window.top !== window.self) {
      try {
        window.top.location = window.self.location.href;
      } catch (e) {
        document.documentElement.innerHTML =
          '<body style="font-family: system-ui, sans-serif; padding: 24px;">' +
          '<div style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">HQ</div>' +
          '<div style="font-size: 14px; color: #7d8694;">' +
          'This app cannot run inside a frame. Open it directly in a new tab.' +
          '</div></body>';
        // Refuse to hand off to main.tsx.
        throw new Error('framed');
      }
    }
  } catch (e) {
    if (e && e.message === 'framed') throw e;
    // Any other error here means we couldn't even check — fail closed.
    document.documentElement.innerHTML =
      '<body style="font-family: system-ui, sans-serif; padding: 24px;">' +
      'This app cannot start in this context.</body>';
    throw e;
  }
})();

window.__bootErrors = [];
function showBootError(msg) {
  var el = document.getElementById('boot-error');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = (el.textContent ? el.textContent + '\n\n' : '') + msg;
}
window.addEventListener('error', function (e) {
  showBootError('error: ' + (e.message || e.error || 'unknown'));
});
window.addEventListener('unhandledrejection', function (e) {
  showBootError('unhandled: ' + ((e.reason && e.reason.message) || e.reason || 'unknown'));
});

// Opt-in service-worker rescue. Visiting `?reset-sw=1` once unregisters
// every SW + nukes every cache, then hard-reloads onto a clean origin.
// This is the manual escape hatch for users stuck behind a poisoned
// cache; the default load path leaves the SW running so app updates
// propagate via the v6+ stale-while-revalidate flow.
//
// History: from Apr→May 2026 this block ran unconditionally as the
// emergency kill-switch after the broken Option B deploy. The new SW
// (v6, 2026-05-01) uses SWR for assets so a bad chunk gets replaced on
// the next request — the unconditional nuke is no longer needed.
(function maybeResetServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  var params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (e) {
    return;
  }
  if (params.get('reset-sw') !== '1') return;

  function nukeCaches() {
    if (!('caches' in self)) return Promise.resolve();
    return caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (k) {
            return caches.delete(k).catch(function () {});
          }),
        );
      })
      .catch(function () {});
  }

  try {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      var unregs = regs.map(function (r) {
        return r.unregister().catch(function () {
          return false;
        });
      });
      Promise.all(unregs).then(function () {
        nukeCaches().then(function () {
          // Strip the query param + hard reload so the user lands on a
          // clean origin without an SW controller.
          var clean = window.location.pathname + window.location.hash;
          window.location.replace(clean);
        });
      });
    });
  } catch (e) {
    /* swallow */
  }
})();
