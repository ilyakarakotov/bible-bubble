/* Bible Bubble — install, offline and update glue.
   Every capability in here is optional. Opened from file:// there is no service
   worker and no install prompt, so this module quietly does nothing at all. */
(function (BB) {
  'use strict';
  const U = BB.util;
  const { el } = U;

  /* Same namespace store.js writes its boards and prefs under. */
  const NUDGE_KEY = 'bb.pwa.nudge';

  /* Must match the two <meta name="theme-color"> values already in index.html. */
  const THEME_COLOR = { light: '#f4f0e8', dark: '#14161a' };

  /* Service workers need a secure context; localhost counts as one. */
  const SECURE = location.protocol === 'https:' ||
    /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(location.hostname);

  let deferred = null;    /* a captured beforeinstallprompt, single use */
  let waiting = null;     /* a worker that has installed and is parked */
  let reloading = false;
  let nudge = null;
  const watchers = new Set();

  function announce() {
    watchers.forEach((fn) => { try { fn(); } catch (_) {} });
  }

  /* ================= state ================= */

  function isStandalone() {
    return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone === true;
  }

  function isIOS() {
    const ua = navigator.userAgent || '';
    /* iPadOS reports itself as a Mac; the touch count is what gives it away. */
    const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    return (/iPad|iPhone|iPod/.test(ua) || iPadOS) && !isStandalone();
  }

  const canInstall = () => !!deferred && !isStandalone();
  const updateReady = () => !!waiting;

  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    watchers.add(fn);
    return () => watchers.delete(fn);
  }

  /* ================= install ================= */

  function install() {
    if (!deferred) return Promise.resolve('unavailable');
    /* A beforeinstallprompt cannot be replayed, so let go of it either way. */
    const prompt = deferred;
    deferred = null;
    announce();
    let shown;
    try { shown = prompt.prompt(); } catch (_) { return Promise.resolve('unavailable'); }
    return Promise.resolve(shown)
      .then(() => prompt.userChoice)
      .then((choice) => (choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed'))
      .catch(() => 'unavailable');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    announce();
    considerNudge();
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    markSeen();
    closeNudge();
    announce();
  });

  /* ================= updates ================= */

  function applyUpdate() {
    if (!waiting || reloading) return;
    reloading = true;
    try {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } catch (_) {
      reloading = false;
      return;
    }
    /* controllerchange is the usual route out of here; this is the backstop for
       a worker that never takes control. */
    setTimeout(reloadOnce, 2500);
  }

  let reloaded = false;
  function reloadOnce() {
    if (reloaded || !reloading) return;
    reloaded = true;
    location.reload();
  }

  function offerUpdate(sw) {
    if (!sw || waiting === sw) return;
    waiting = sw;
    announce();
    U.toast('A newer version is ready.', { ms: 9000, action: 'Reload', onAction: applyUpdate });
  }

  function watchUpdates(reg) {
    if (!reg) return;
    /* Parked from an earlier visit that never got reloaded. */
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        /* Reaching 'installed' while something already controls the page means
           this is an update; on a first visit there is nothing to announce. */
        if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(sw);
      });
    });
  }

  function registerWorker() {
    if (!SECURE || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
    navigator.serviceWorker.register('sw.js').then(watchUpdates).catch(() => {});
  }

  /* ================= status bar tint ================= */

  let tintMeta = null;

  /**
   * index.html carries two theme-colors, each scoped to prefers-color-scheme.
   * Once the user picks a theme by hand those no longer describe the page, so
   * slip an unscoped one in front of them — and take it away again when the app
   * goes back to following the system.
   */
  function syncTint() {
    const mode = document.documentElement.getAttribute('data-theme');
    if (!mode) {
      if (tintMeta) { tintMeta.remove(); tintMeta = null; }
      return;
    }
    if (!tintMeta) {
      tintMeta = el('meta', { name: 'theme-color' });
      const first = document.head.querySelector('meta[name="theme-color"]');
      document.head.insertBefore(tintMeta, first || document.head.firstChild);
    }
    tintMeta.setAttribute('content', THEME_COLOR[mode] || THEME_COLOR.light);
  }

  /* ================= the install nudge ================= */

  let seenCache = null;
  let offStore = null;

  /* Read through a cache: this is consulted on every store change. */
  function seen() {
    if (seenCache === null) {
      try { seenCache = localStorage.getItem(NUDGE_KEY) != null; } catch (_) { seenCache = true; }
    }
    return seenCache;
  }

  function stopWatching() {
    if (!offStore) return;
    const off = offStore;
    offStore = null;
    try { off(); } catch (_) {}
  }

  function markSeen() {
    seenCache = true;
    stopWatching();
    try { localStorage.setItem(NUDGE_KEY, String(Date.now())); } catch (_) {}
  }

  const isPhone = () => (BB.app && BB.app.isPhone ? BB.app.isPhone() : matchMedia('(max-width: 700px)').matches);

  function closeNudge() {
    if (!nudge) return;
    const node = nudge;
    nudge = null;
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 220);
  }

  /**
   * Asking to install before anyone has anything worth keeping is noise, so this
   * waits for a phone with people already on the board, and only ever fires once.
   */
  let nudgePending = false;

  function nudgeWanted() {
    if (nudge || seen() || isStandalone() || !isPhone()) return false;
    /* Android can be offered a real button; iOS Safari only ever gets told how. */
    if (!canInstall() && !isIOS()) return false;
    return !!(BB.store && BB.store.count() > 0);
  }

  function considerNudge() {
    if (seen()) { stopWatching(); return; }
    if (nudgePending || !nudgeWanted()) return;
    nudgePending = true;
    setTimeout(() => {
      nudgePending = false;
      if (nudgeWanted()) showNudge();
    }, 1400);
  }

  function showNudge() {
    markSeen();
    const ios = !canInstall() && isIOS();
    const body = el('div.pwa-nudge-body', {}, [
      el('strong', { text: 'Keep Bible Bubble on your home screen' }),
      ios
        ? el('span', { html: 'Tap <b>Share</b>, then <b>Add to Home Screen</b>.' })
        : el('span', { text: 'It opens full screen and keeps working with no signal.' }),
    ]);

    const close = el('button.pwa-nudge-x', {
      type: 'button', 'aria-label': 'Not now', onclick: closeNudge,
    }, [U.icon('close')]);

    const kids = [el('span.pwa-nudge-mark.brand-mark', {}, [el('i.dot.d1'), el('i.dot.d2')]), body];
    if (!ios) {
      kids.push(el('button.pwa-nudge-go', {
        type: 'button',
        text: 'Install',
        onclick: () => {
          install().then((outcome) => {
            closeNudge();
            if (outcome === 'accepted') U.toast('Bible Bubble is on your home screen.');
          });
        },
      }));
    }
    kids.push(close);

    nudge = el('div.pwa-nudge', { role: 'dialog', 'aria-label': 'Install Bible Bubble' }, kids);
    document.body.appendChild(nudge);
    requestAnimationFrame(() => nudge && nudge.classList.add('is-in'));
  }

  /* ================= boot ================= */

  function init() {
    syncTint();
    new MutationObserver(syncTint)
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    registerWorker();

    /* The board is only worth pinning once it holds someone, so look again after
       the first edits rather than only at load. */
    if (!seen() && BB.store && BB.store.on) offStore = BB.store.on('change', considerNudge);
    considerNudge();
  }

  BB.pwa = { isStandalone, canInstall, install, isIOS, onChange, updateReady, applyUpdate };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.BB);
