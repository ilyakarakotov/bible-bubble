/* Bible Bubble — the phone peek card: who you just tapped, and what to do next. */
(function (BB) {
  'use strict';
  const U = BB.util;
  const { el, icon } = U;

  let host, S, L, C;
  let currentId = null;        // whose card is showing
  let mode = null;             // null | 'card' | 'pick' | 'choose'
  let pick = null;             // {from, to} while two-tap linking
  let dismissed = false;       // swiped away, until the selection speaks again
  let clearedFor = null;       // we make room for a person once per open, not per repaint
  let sheetClearedFor = null;
  let hideTimer = null;
  let swipedAt = 0;
  let shownAt = 0;             // when this face of the card appeared

  const appEl = () => document.getElementById('app');
  const hasClass = (c) => { const a = appEl(); return !!a && a.classList.contains(c); };
  const isPhone = () => !!(BB.app && BB.app.isPhone && BB.app.isPhone());
  const sheetOpen = () => hasClass('panel-details') || hasClass('panel-lineage');
  const onCanvas = () => hasClass('view-canvas');
  const nameOf = (id) => { const p = S.person(id); return (p && p.name) || 'Unnamed'; };

  /**
   * Two taps this must never answer: the one that dismissed the card with a
   * swipe, and the one that opened this face of it in the first place — a tap
   * on a bubble down by the thumb lands again on whatever slides up under it.
   */
  const tap = (fn) => (e) => {
    if (Date.now() - swipedAt < 500 || Date.now() - shownAt < 250) return;
    fn(e);
  };

  /**
   * Writing a class that is already right still rewrites the attribute, and
   * that wakes the observer below — which would then write it again, forever.
   */
  function setClass(node, name, on) {
    if (!node || node.classList.contains(name) === !!on) return;
    node.classList.toggle(name, !!on);
  }

  /* ---------- the card ---------- */

  /** The same facts the bubble and the inspector show, on one line. */
  function subtitle(p) {
    const st = S.settings();
    const bits = [];
    if (p.role) bits.push(p.role);
    const span = U.formatSpan(p.birth, p.death, {
      mode: st.yearMode === 'am' ? 'am' : 'era', anchor: st.anchor, approx: p.approx,
    });
    if (span) bits.push(span);
    else if (U.isNum(p.age)) bits.push(p.age + ' yrs');
    if (!bits.length && p.era) bits.push(p.era);
    return bits.join(' · ');
  }

  function action(key, ico, label, run, opts) {
    const o = opts || {};
    return el('button.peek-act' + (o.on ? '.is-on' : ''), {
      type: 'button', 'data-peek': key, title: o.title || label,
      onclick: tap(run),
    }, [
      ico ? icon(ico) : el('span.peek-dots', { text: '···', 'aria-hidden': 'true' }),
      el('span', { text: label }),
    ]);
  }

  function cardFor(p) {
    const deg = L.degree(p.id);
    const sub = subtitle(p);
    const tracing = !!(C.trace && C.trace.id === p.id);
    return [
      el('div.peek-grip', { 'aria-hidden': 'true' }),
      el('button.peek-main', {
        type: 'button', title: 'Open the full details for ' + (p.name || 'this person'),
        onclick: tap(() => openDetails()),
      }, [
        el('span.peek-dot', { style: { background: `var(--c-${U.colorOf(p.color)})` } }),
        el('span.peek-text', {}, [
          el('span.peek-name', { text: p.name || 'Unnamed' }),
          sub ? el('span.peek-sub', { text: sub }) : null,
        ]),
        el('span.peek-stats', {}, [
          el('span', { text: 'Generation ' + (L.generationOf(p.id) + 1) }),
          el('span', { text: U.plural(deg.total, 'link') }),
        ]),
      ]),
      el('div.peek-acts', {}, [
        action('details', 'people', 'Details', () => openDetails()),
        action('trace', 'trace', tracing ? 'Untrace' : 'Trace', () => BB.app.toggleTrace(p.id),
          { on: tracing, title: tracing ? 'Stop tracing this line' : 'Trace this line up and down' }),
        action('link', 'link', 'Link', () => startPick(p.id),
          { title: 'Link ' + (p.name || 'this person') + ' to someone' }),
        action('more', null, 'More', (e) => {
          e.stopPropagation();                       // or the page click closes the menu again
          const r = e.currentTarget.getBoundingClientRect();
          C.contextAt(Math.round(r.left), Math.round(r.top), p.id);
        }, { title: 'Everything else' }),
      ]),
    ];
  }

  function openDetails() {
    if (!currentId) return;
    BB.app.setPanel('details', true);
  }

  /* ---------- two-tap linking ---------- */
  function startPick(from) {
    if (S.count() < 2) { U.toast('A link needs two people — add somebody else first.'); return; }
    if (!C.linkMode(from)) return;
    pick = { from: from, to: null };
    mode = 'pick';
    paint();
  }

  function bannerFor(from) {
    return [
      el('div.peek-banner', {}, [
        el('div.peek-banner-text', {}, [
          el('strong', { text: 'Tap who to link ' + nameOf(from) + ' to' }),
          el('span', { text: 'Drag to look around · pinch to zoom' }),
        ]),
        el('button.btn.peek-cancel', {
          type: 'button', text: 'Cancel', onclick: tap(() => C.endLinkMode()),
        }),
      ]),
    ];
  }

  /**
   * The chooser a dragged handle never needed: a handle already says which side
   * it came out of. Every answer here goes back through the same 'link-drop'.
   */
  function chooserFor(from, to) {
    const a = nameOf(from), b = nameOf(to);
    const row = (label, run) => el('button.peek-choice', { type: 'button', onclick: tap(run) }, [
      el('span', { text: label }), icon('chev'),
    ]);
    const done = () => { C.endLinkMode(); C.select([from]); };
    return [
      el('div.peek-grip', { 'aria-hidden': 'true' }),
      el('div.peek-ask', { text: 'How is ' + b + ' related to ' + a + '?' }),
      el('div.peek-choices', {}, [
        row('Child of ' + a, () => { C.linkTo(from, to, 'bottom'); done(); }),
        row('Parent of ' + a, () => { C.linkTo(from, to, 'top'); done(); }),
        row('Spouse of ' + a, () => { C.linkTo(from, to, 'right'); done(); }),
        row('Another kind of connection…', () => { done(); BB.app.addBond(from, to); }),
      ]),
      el('button.btn.peek-cancel.wide', {
        type: 'button', text: 'Cancel', onclick: tap(() => C.endLinkMode()),
      }),
    ];
  }

  /* ---------- showing and hiding ---------- */
  function paint() {
    if (mode === 'pick' && pick) { host.replaceChildren(...bannerFor(pick.from)); return; }
    if (mode === 'choose' && pick && pick.to) {
      host.replaceChildren(...chooserFor(pick.from, pick.to));
      return;
    }
    const p = currentId && S.person(currentId);
    if (!p) { hide(); return; }
    host.replaceChildren(...cardFor(p));
  }

  function reveal() {
    const face = mode || 'card';
    if (host.hidden || host.dataset.face !== face) shownAt = Date.now();
    host.dataset.face = face;
    clearTimeout(hideTimer);
    host.hidden = false;
    ['card', 'pick', 'choose'].forEach(m => setClass(host, 'mode-' + m, face === m));
    setClass(host, 'is-away', false);
    // A frame between unhiding and the class, or the slide-up never plays.
    requestAnimationFrame(() => { if (!host.hidden) setClass(host, 'is-open', true); });
    setPeekHeight();
  }

  /** The HUD and the toasts move up by exactly what the card takes. */
  function setPeekHeight() {
    requestAnimationFrame(() => {
      const a = appEl();
      if (!a) return;
      const h = host.hidden ? 0 : Math.round(host.getBoundingClientRect().height);
      setClass(a, 'peek-open', !host.hidden);
      // On the root, not on #app: the toasts live outside #app and still need it.
      document.documentElement.style.setProperty('--peek-h', h + 'px');
    });
  }

  function show(id) {
    if (!isPhone() || !onCanvas() || sheetOpen()) return;
    const p = S.person(id);
    if (!p) return;
    dismissed = false;
    if (mode !== 'pick' && mode !== 'choose') mode = 'card';
    currentId = id;
    paint();
    reveal();
    makeRoom();
  }

  function hide() {
    if (host.hidden) return;
    setClass(host, 'is-open', false);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      host.hidden = true;
      host.replaceChildren();
      setPeekHeight();
    }, 220);
    setClass(appEl(), 'peek-open', false);
    clearedFor = null;
  }

  const isOpen = () => !host.hidden;

  /** Pan the tapped person out from behind whatever just slid up over them. */
  function makeRoom() {
    if (!currentId || clearedFor === currentId) return;
    const id = currentId;
    clearedFor = id;
    requestAnimationFrame(() => {
      if (host.hidden || currentId !== id || C.isDragging()) return;
      C.keepVisible(id, { bottom: coverBy(host) });
    });
  }

  /** How much of the canvas the given panel is sitting on top of. */
  function coverBy(node) {
    const vp = document.getElementById('viewport');
    if (!vp || !node || node.hidden) return 0;
    const v = vp.getBoundingClientRect(), n = node.getBoundingClientRect();
    if (!n.height) return 0;
    return Math.max(0, Math.min(v.height, v.bottom - n.top));
  }

  /* ---------- what should be showing ---------- */
  function sync() {
    if (!isPhone() || !onCanvas()) {
      if (C.isPicking()) C.endLinkMode();
      mode = null; hide();
      return;
    }
    if (mode === 'pick' || mode === 'choose') {
      if (sheetOpen()) { C.endLinkMode(); return; }
      reveal();
      return;
    }
    if (sheetOpen()) { hide(); return; }
    const sel = C.selected();
    if (sel.length === 1 && !dismissed && S.person(sel[0])) show(sel[0]);
    else { currentId = sel.length === 1 ? sel[0] : null; hide(); }
  }

  function dismiss() {
    if (mode === 'pick' || mode === 'choose') { C.endLinkMode(); return; }
    dismissed = true;
    hide();
  }

  /* ---------- boot ---------- */
  function init() {
    host = document.getElementById('peek');
    if (!host || !BB.canvas || !BB.store) return;
    S = BB.store; L = BB.lineage; C = BB.canvas;
    host.setAttribute('aria-label', 'Selected person');

    C.on('select', () => { dismissed = false; sync(); });
    C.on('trace', () => { if (isOpen() && mode === 'card') paint(); });
    // Carrying someone across the canvas: the card ducks out of the way rather
    // than swallowing the half of the screen you are dragging into.
    C.on('lift', () => setClass(host, 'is-away', true));
    C.on('drop', () => setClass(host, 'is-away', false));
    C.on('pick-start', ({ from }) => {
      pick = { from: from, to: null };
      mode = 'pick'; currentId = from;
      paint(); reveal();
      // You cannot aim from behind the banner.
      requestAnimationFrame(() => C.keepVisible(from, { bottom: coverBy(host) }));
    });
    C.on('pick-target', ({ from, to }) => {
      pick = { from: from, to: to };
      mode = 'choose';
      paint(); reveal();
      // Both ends matter now, so make sure neither is hiding under the chooser.
      requestAnimationFrame(() => C.keepVisible(to, { bottom: coverBy(host) }));
    });
    C.on('pick-end', () => { pick = null; mode = null; sync(); });

    S.on('change', (p) => {
      if (p.reason === 'positions') return;
      if (currentId && !S.person(currentId)) {          // deleted out from under us
        currentId = null;
        if (mode === 'card') mode = null;
        hide();
        return;
      }
      if (isOpen() && mode === 'card') paint();
    });

    // The sheets and the view live on #app's class list; watching it saves
    // every other module from having to tell us. Only the four classes we care
    // about count — anything else is noise, and reacting to our own writes
    // would put the observer in a loop with itself.
    const state = () =>
      [isPhone(), onCanvas(), hasClass('panel-details'), hasClass('panel-lineage')].join('|');
    let was = state();
    new MutationObserver(() => {
      const now = state();
      if (now === was) return;
      const opened = sheetOpen();
      was = now;
      if (!opened) sheetClearedFor = null;
      sync();
      if (opened) clearSheet();
    }).observe(appEl(), { attributes: true, attributeFilter: ['class'] });

    window.addEventListener('resize', () => { setPeekHeight(); }, { passive: true });

    // Swipe down to put it away. The rest of the gesture is watched on the
    // window, because a downward swipe leaves the card long before it is done —
    // and capturing the pointer here would take the taps off the buttons.
    let sy = null;
    host.addEventListener('pointerdown', (e) => {
      sy = e.pointerType === 'mouse' ? null : e.clientY;
    }, { passive: true });
    window.addEventListener('pointermove', (e) => {
      if (sy == null) return;
      if (e.clientY - sy > 44) { sy = null; swipedAt = Date.now(); dismiss(); }
    }, { passive: true });
    const letGo = () => { sy = null; };
    window.addEventListener('pointerup', letGo, { passive: true });
    window.addEventListener('pointercancel', letGo, { passive: true });

    sync();
  }

  /** The details sheet is 70vh of the screen; keep its subject above the fold. */
  function clearSheet() {
    if (!isPhone() || !hasClass('panel-details')) return;
    const sel = C.selected();
    if (sel.length !== 1 || sheetClearedFor === sel[0]) return;
    sheetClearedFor = sel[0];
    setTimeout(() => {
      if (!hasClass('panel-details') || C.isDragging()) return;
      C.keepVisible(sel[0], { bottom: coverBy(document.getElementById('inspector')) });
    }, 260);                                   // after the sheet has finished sliding up
  }

  BB.peek = { show, hide, isOpen };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.BB);
