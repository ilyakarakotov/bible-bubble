/* Bible Bubble — wiring: toolbar, menus, search, shortcuts, routing, first run. */
(function (BB) {
  'use strict';
  const U = BB.util;
  const { $, $$, el, icon } = U;

  let S, L, C;
  let currentView = 'canvas';

  const VIEWS = ['canvas', 'web', 'timeline'];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = window.matchMedia('(pointer: coarse)');
  /** Canvas moves are animated unless the reader has asked for stillness. */
  const glide = (opts) => Object.assign({ animate: !reduceMotion.matches }, opts || {});

  /* ================= theme ================= */
  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    S.setPref('theme', mode);
    setTimeout(() => C.render(), 0);
  }
  function initTheme() {
    const pref = S.prefs().theme;
    if (pref && pref !== 'system') document.documentElement.setAttribute('data-theme', pref);
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    const isDark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(isDark ? 'light' : 'dark');
  }

  /* ================= the URL ================= */
  /**
   * The address bar is app state: `?view=` for the open view, `?board=` for
   * which board, `#p=` for the person in focus. Everything routine replaces the
   * current entry; only changing view pushes one, which is what lets Android's
   * back button walk back through the views instead of leaving an installed app.
   *
   * A `file://` document has an opaque origin and rejects pushState outright, so
   * the whole router falls silent there rather than throwing on every move.
   */
  const canRoute = location.protocol !== 'file:';
  let applyingRoute = false;
  let lastUrl = location.href;
  let guardPushed = false;
  let depth = 0;                  // how many entries of our own are behind this one

  function readRoute() {
    const q = new URLSearchParams(location.search);
    let p = null;
    try { p = new URLSearchParams(location.hash.replace(/^#/, '')).get('p'); } catch (_) {}
    const v = q.get('view');
    return { view: VIEWS.includes(v) ? v : null, board: q.get('board'), person: p };
  }

  function routeUrl() {
    const q = new URLSearchParams();
    if (currentView !== 'canvas') q.set('view', currentView);
    if (S.doc.id) q.set('board', S.doc.id);
    const sel = C.selected();
    const query = q.toString();
    return location.pathname + (query ? '?' + query : '') +
      (sel.length === 1 ? '#p=' + encodeURIComponent(sel[0]) : '');
  }

  function writeUrl(mode) {
    if (!canRoute || applyingRoute) return;
    const next = routeUrl();
    if (next === location.pathname + location.search + location.hash) { lastUrl = location.href; return; }
    const push = mode === 'push';
    try {
      history[push ? 'pushState' : 'replaceState']({ bb: 1, i: push ? depth + 1 : depth }, '', next);
      if (push) depth++;
      lastUrl = location.href;
    } catch (_) { /* opaque origin — the app works, it just has no address */ }
  }
  const writeUrlSoon = U.debounce(() => writeUrl('replace'), 220);

  /** Take the view and the selection from whatever the URL now says. */
  function applyRoute() {
    const r = readRoute();
    applyingRoute = true;
    try {
      setView(r.view || 'canvas', { history: 'none' });
      if (r.person && S.person(r.person)) revealPerson(r.person);
      else if (!r.person) C.select([]);
    } finally {
      applyingRoute = false;
      lastUrl = location.href;
    }
  }

  /**
   * Back closes what is on top before it navigates, which needs an entry to pop.
   * Installed from a home screen there is nothing behind the first page, so one
   * spare entry goes in the moment something openable opens — once, and only
   * while we are still standing on our own first entry.
   */
  function guardHistory() {
    if (!canRoute || guardPushed || depth > 0) return;
    try { history.pushState({ bb: 'guard', i: depth }, '', lastUrl); guardPushed = true; } catch (_) {}
  }

  function closeTopLayer() {
    if (modalStack.length) { modalStack[modalStack.length - 1].close(); return true; }
    if (!$('#context-menu').hidden) { closeMenu(); return true; }
    if (isPhone() && anyPanelOpen()) { closePanels(); return true; }
    if (BB.peek && BB.peek.isOpen && BB.peek.isOpen()) { BB.peek.hide(); return true; }
    if ($('#app').classList.contains('search-open')) { toggleSearch(false); return true; }
    return false;
  }

  function initRouter() {
    window.addEventListener('popstate', () => {
      const st = history.state;
      depth = (st && typeof st.i === 'number') ? st.i : 0;
      /* Consume the press to close what is open, then put the entry back so the
         next press is the one that navigates. */
      if (closeTopLayer()) {
        try { history.pushState({ bb: 1, i: depth }, '', lastUrl); } catch (_) {}
        return;
      }
      applyRoute();
    });
  }

  /* ================= views ================= */
  function setView(v, opts) {
    const o = opts || {};
    if (!VIEWS.includes(v)) v = 'canvas';
    const moved = v !== currentView;
    currentView = v;
    const app = $('#app');
    app.classList.toggle('view-canvas', v === 'canvas');
    app.classList.toggle('view-timeline', v === 'timeline');
    app.classList.toggle('view-web', v === 'web');
    paintViewTabs();
    if (v === 'timeline') BB.timeline.show(); else BB.timeline.hide();
    if (v === 'web') BB.web.show(); else BB.web.hide();
    if (v === 'canvas') C.render();
    S.setPref('view', v);
    paintMobileBar();
    if (o.history !== 'none') writeUrl(o.history || (moved ? 'push' : 'replace'));
  }

  function paintViewTabs() {
    $$('.viewtabs .tab').forEach(t => {
      const on = t.dataset.view === currentView;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
  }

  /* ================= placement helpers ================= */
  const NEW_W = 188, NEW_H = 100;

  /** Slide a candidate box right until it stops overlapping anything. */
  function freeSpot(x, y, skipId) {
    let box = { x, y, w: NEW_W, h: NEW_H };
    const others = S.people().filter(p => p.id !== skipId).map(p => C.rectOf(p));
    for (let i = 0; i < 400; i++) {
      const hit = others.find(o => U.rectsOverlap({ x: box.x - 14, y: box.y - 14, w: box.w + 28, h: box.h + 28 }, o));
      if (!hit) break;
      box.x = hit.x + hit.w + 24;
    }
    return { x: Math.round(box.x), y: Math.round(box.y) };
  }

  function addPersonAt(at, props) {
    const spot = freeSpot(at.x - NEW_W / 2, at.y - NEW_H / 2);
    const p = S.addPerson(Object.assign({ x: spot.x, y: spot.y, name: '' }, props || {}));
    C.select([p.id]);
    focusNameField(p.id);
    return p;
  }

  /**
   * Naming happens in the details panel. On a phone that panel is a sheet that
   * is closed until asked for, so focusing the field inside it would raise the
   * keyboard over nothing at all: open the sheet first, and shift the canvas so
   * the bubble being named is not left underneath it.
   */
  function focusNameField(id) {
    /* setPanel slides the canvas clear of the sheet on the way in. */
    if (isPhone()) setPanel('details', true);
    requestAnimationFrame(() => {
      const input = $('#inspector .insp-name-input');
      if (input) { input.focus(); input.select(); }
    });
  }

  /* ================= relations ================= */
  /** Create a new person already linked to `anchorId`. */
  function quickRelative(anchorId, kind, sex, at) {
    const anchor = S.person(anchorId);
    if (!anchor) return;
    const ar = C.rectOf(anchor);
    let x, y;
    if (at) { x = at.x - NEW_W / 2; y = at.y - NEW_H / 2; }
    else if (kind === 'child') {
      const kids = L.childrenOf(anchorId);
      x = ar.x + kids.length * (NEW_W + 30);
      y = ar.y + ar.h + 110;
    } else if (kind === 'parent') {
      x = ar.x; y = ar.y - NEW_H - 110;
    } else {
      x = ar.x + ar.w + 40; y = ar.y;
    }
    const spot = freeSpot(x, y);
    const p = S.addPerson({
      x: spot.x, y: spot.y, sex: sex || '', color: anchor.color, era: anchor.era,
    });
    const res = kind === 'parent' ? S.addLink(p.id, anchorId, 'parent')
      : kind === 'spouse' ? S.addLink(anchorId, p.id, 'spouse')
      : S.addLink(anchorId, p.id, 'parent');
    if (!res.ok) U.toast(linkError(res.reason));
    C.select([p.id]);
    focusNameField(p.id);
    return p;
  }

  const linkError = (reason) => ({
    cycle: 'That would make someone their own ancestor.',
    duplicate: 'Those two are already linked that way.',
    self: 'A person cannot be linked to themselves.',
    missing: 'One of those people no longer exists.',
  }[reason] || 'Could not create that link.');

  function linkBySide(from, to, side) {
    const res = side === 'top' ? S.addLink(to, from, 'parent')
      : side === 'bottom' ? S.addLink(from, to, 'parent')
      : S.addLink(from, to, 'spouse');
    if (!res.ok) U.toast(linkError(res.reason));
    else {
      const a = S.person(from), b = S.person(to);
      const verb = side === 'top' ? 'now the parent of' : side === 'bottom' ? 'now the parent of' : 'linked with';
      const names = side === 'top' ? [b.name || 'Unnamed', a.name || 'Unnamed'] : [a.name || 'Unnamed', b.name || 'Unnamed'];
      U.toast(`${names[0]} is ${verb} ${names[1]}`);
    }
    return res;
  }

  /* ================= actions ================= */
  /* The undo offer comes from the watcher on the store, so a delete started
     anywhere — menu, key, inspector — is offered back the same way. */
  function deleteSelected() {
    const ids = C.selected();
    if (!ids.length) return;
    S.removePeople(ids);
    C.select([]);
  }

  function duplicatePerson(id) {
    const p = S.person(id);
    if (!p) return;
    const copy = U.deepClone(p);
    delete copy.id;
    const spot = freeSpot(p.x + 40, p.y + 40);
    copy.x = spot.x; copy.y = spot.y;
    copy.name = p.name ? p.name + ' (copy)' : '';
    const made = S.addPerson(copy);
    C.select([made.id]);
    focusNameField(made.id);
  }

  function autoLayout(ids) {
    C.invalidateSizes();
    const sizes = {};
    (ids && ids.length ? ids : Object.keys(S.doc.people)).forEach(id => { sizes[id] = C.sizeOf(id); });
    const b = C.boundsOf(ids && ids.length ? ids : null);
    const pos = L.layout(S.doc, {
      sizes, ids: ids && ids.length ? ids : null,
      originX: b ? b.x : 0, originY: b ? b.y : 0,
    });
    if (!Object.keys(pos).length) return;
    S.movePeople(pos, 'layout');
    S.seal();
    setTimeout(() => C.fit(ids && ids.length ? ids : null, glide()), 40);
    offerUndo('Tidied into generations');
  }

  function toggleTrace(id) {
    const t = C.trace;
    if (t && t.id === id) { C.setTrace(null); return; }
    C.setTrace(id);
  }

  function paintTraceBar(trace) {
    const bar = $('#trace-bar');
    if (!trace) { bar.hidden = true; return; }
    const p = S.person(trace.id);
    if (!p) { bar.hidden = true; return; }
    bar.hidden = false;
    $('#trace-name').textContent = p.name || 'Unnamed';
    $('#trace-stats').textContent = `${U.plural(trace.up.size, 'ancestor')} · ${U.plural(trace.down.size, 'descendant')}`;
  }

  /** Bring a person into view in whichever view is open. */
  function revealPerson(id) {
    C.select([id]);
    if (isPhone()) closePanels();
    if (currentView === 'canvas') C.focus(id, glide({ zoom: 0.95 }));
    else if (currentView === 'web') BB.web.focus(id);
    else BB.timeline.draw();
  }
  function showOnCanvas(id) {
    setView('canvas');
    requestAnimationFrame(() => C.focus(id, glide({ zoom: 0.95 })));
  }

  /* ================= menus ================= */
  let openMenu = null;              // the name of whatever menu is up, for rebuilding in place
  let menuAnchor = null;            // the button that opened it, for rebuilding and focus
  let menuReturn = null;            // where focus came from
  /** `#context-menu` is a fixture in the page — empty and hide it, never remove it. */
  function closeMenu() {
    const m = $('#context-menu');
    if (!m || m.hidden) { openMenu = null; return; }
    const inside = m.contains(document.activeElement);
    m.hidden = true;
    m.replaceChildren();
    openMenu = null;
    menuAnchor = null;
    /* Only take focus back if the menu still had it — a click elsewhere has
       already put it somewhere better. */
    if (inside && menuReturn && menuReturn.isConnected) menuReturn.focus();
    menuReturn = null;
  }

  const menuItems = () => $$('.menu-item:not(.is-off)', $('#context-menu'));

  function menu(x, y, items, opts) {
    const o = opts || {};
    const host = $('#context-menu');
    if (host.hidden) menuReturn = document.activeElement;
    host.setAttribute('role', 'menu');
    host.replaceChildren();
    items.forEach(it => {
      if (!it) return;
      if (it === '-') { host.appendChild(el('div.menu-sep', { role: 'separator' })); return; }
      if (it.head) { host.appendChild(el('div.menu-head', { role: 'presentation', text: it.head })); return; }
      host.appendChild(el('div.menu-item' + (it.danger ? '.danger' : '') + (it.disabled ? '.is-off' : ''), {
        role: 'menuitem', tabindex: '-1',
        'aria-disabled': it.disabled ? 'true' : null,
        onclick: () => { closeMenu(); it.run && it.run(); },
      }, [
        it.icon ? icon(it.icon) : el('span', { style: { width: '15px' } }),
        el('span', { text: it.label }),
        it.key ? el('span.k', { text: it.key }) : null,
      ]));
    });
    host.hidden = false;
    host.style.left = '0px';
    host.style.top = '0px';
    const r = host.getBoundingClientRect();
    host.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    host.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    host.scrollTop = 0;
    openMenu = o.name || 'menu';
    menuAnchor = o.anchor || null;
    guardHistory();
    /* Opened from the keyboard or rebuilt under the cursor — either way the
       first item is where a keyboard user needs to land. */
    const first = menuItems()[0];
    if (first) first.focus({ preventScroll: true });
  }

  function initMenuKeys() {
    const host = $('#context-menu');
    host.addEventListener('keydown', (e) => {
      const rows = menuItems();
      if (!rows.length) return;
      const at = rows.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = rows[(at + step + rows.length) % rows.length] || rows[0];
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        (e.key === 'Home' ? rows[0] : rows[rows.length - 1]).focus({ preventScroll: true });
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (at < 0) return;
        e.preventDefault();
        rows[at].click();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        closeMenu();
      }
    });
  }

  function personMenu(x, y, id) {
    const p = S.person(id);
    if (!p) return;
    const multi = C.selection.size > 1 && C.selection.has(id);
    menu(x, y, [
      { head: multi ? U.plural(C.selection.size, 'person', 'people') + ' selected' : (p.name || 'Unnamed') },
      { label: 'Add a son', icon: 'plus', run: () => quickRelative(id, 'child', 'm') },
      { label: 'Add a daughter', icon: 'plus', run: () => quickRelative(id, 'child', 'f') },
      { label: 'Add a parent', icon: 'plus', run: () => quickRelative(id, 'parent') },
      { label: 'Add a spouse', icon: 'link', run: () => quickRelative(id, 'spouse') },
      '-',
      { label: 'Link to an existing person…', icon: 'link', run: () => pickPerson(id, 'child') },
      { label: multi && C.selection.size === 2 ? 'Connect these two…' : 'Connect to someone…', icon: 'web',
        run: () => { const two = [...C.selection]; addBond(id, multi && two.length === 2 ? two.find(x => x !== id) : null); } },
      { label: C.trace && C.trace.id === id ? 'Stop tracing' : 'Trace this line', icon: 'trace', key: 'T', run: () => toggleTrace(id) },
      { label: 'Centre on this person', icon: 'target', run: () => C.focus(id, glide({ zoom: 0.95 })) },
      { label: 'Duplicate', icon: 'copy', key: '⌘D', run: () => duplicatePerson(id) },
      '-',
      { label: multi ? 'Delete these people' : 'Delete', icon: 'trash', key: '⌫', danger: true, run: deleteSelected },
    ]);
  }

  function canvasMenu(x, y, at) {
    menu(x, y, [
      { label: 'Add a person here', icon: 'plus', key: 'N', run: () => addPersonAt(at) },
      '-',
      { label: 'Tidy into generations', icon: 'layout', key: 'L', run: () => autoLayout() },
      { label: 'Fit everything on screen', icon: 'fit', key: 'F', run: () => C.fit(null, glide()) },
      { label: 'Select all', icon: 'people', key: '⌘A', run: () => C.select(Object.keys(S.doc.people)) },
      '-',
      { label: S.settings().showGrid ? 'Hide the grid' : 'Show the grid', icon: 'grid', key: 'G', run: toggleGrid },
    ]);
  }

  function linkMenu(x, y, linkId) {
    const link = S.doc.links[linkId];
    if (!link) return;
    const a = S.person(link.from), b = S.person(link.to);
    const label = link.type === 'other' ? BB.model.bondKind(link.kind).label
      : { parent: 'Parent → child', spouse: 'Spouse' }[link.type];
    menu(x, y, [
      { head: `${(a && a.name) || '?'} → ${(b && b.name) || '?'} · ${label}` },
      link.type === 'other'
        ? { label: 'Edit this connection…', icon: 'web', run: () => editBond(linkId) }
        : { label: 'Make it a connection…', icon: 'web', run: () => retype(linkId, 'other', true) },
      { label: 'Make it a spouse link', disabled: link.type === 'spouse', run: () => retype(linkId, 'spouse') },
      { label: 'Make it a parent link', disabled: link.type === 'parent', run: () => retype(linkId, 'parent') },
      '-',
      { label: 'Reverse the direction', run: () => reverse(linkId) },
      { label: 'Delete this link', icon: 'trash', danger: true, run: () => S.removeLink(linkId) },
    ]);
  }

  /* Retyping and reversing are a delete plus an add; the undo watcher must not
     read the halfway point as somebody losing a link. */
  function retype(linkId, type, thenEdit) {
    const link = S.doc.links[linkId];
    if (!link) return;
    const { from, to, label } = link;
    const res = quietly(() => {
      S.removeLink(linkId);
      return S.addLink(from, to, type, { label });
    });
    if (!res.ok) { S.undo(); U.toast(linkError(res.reason)); return; }
    if (thenEdit) editBond(res.link.id);
  }
  function reverse(linkId) {
    const link = S.doc.links[linkId];
    if (!link) return;
    const { from, to, type } = link;
    const res = quietly(() => {
      S.removeLink(linkId);
      return S.addLink(to, from, type);
    });
    if (!res.ok) { S.undo(); U.toast(linkError(res.reason)); }
  }

  /** How to install, for the browsers that will not offer to do it themselves. */
  function installHelp() {
    modal('Add Bible Bubble to your home screen', [
      el('p', { text: 'Installed, the board opens full screen with no address bar and keeps working with no signal. Everything still lives on this device only.' }),
      el('div.about-note', { html:
        '<strong>On iPhone and iPad.</strong> Tap the <strong>Share</strong> button in Safari — ' +
        'the square with an arrow out of it — then scroll to <strong>Add to Home Screen</strong>.' }),
      el('div.about-note', { html:
        '<strong>Elsewhere.</strong> Look for <strong>Install</strong> or <strong>Add to Home screen</strong> ' +
        'in the browser menu. Some browsers only offer it after a second visit.' }),
    ]);
  }

  function moreMenu(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    const st = S.settings();
    const pwa = BB.pwa;
    const items = [
      { head: 'Edit' },
      { label: 'Undo', icon: 'undo', key: '⌘Z', disabled: !S.canUndo, run: () => { if (!S.undo()) U.toast('Nothing to undo'); } },
      { label: 'Redo', icon: 'redo', key: '⇧⌘Z', disabled: !S.canRedo, run: () => { if (!S.redo()) U.toast('Nothing to redo'); } },
      '-',
      { label: 'Tidy into generations', icon: 'layout', key: 'L', run: () => autoLayout(C.selected().length > 1 ? C.selected() : null) },
      { label: 'Fit everything on screen', icon: 'fit', key: 'F', run: () => C.fit(null, glide()) },
      { label: 'Back to the head of the line', icon: 'target', key: '0', run: () => C.home(glide()) },
      { label: 'Switch theme', icon: 'sun', run: toggleTheme },
      '-',
      { head: 'Board' },
      { label: 'Board settings…', icon: 'book', run: boardSettings },
      { label: 'Load the starter lineage', icon: 'people', run: () => confirmSeed() },
      '-',
      { head: 'Save and share' },
      { label: 'Export as JSON', icon: 'download', run: BB.io.exportJSON },
      { label: 'Export as Markdown', icon: 'download', run: BB.io.exportMarkdown },
      { label: 'Export as CSV', icon: 'download', run: BB.io.exportCSV },
      { label: 'Import a JSON board…', icon: 'upload', run: () => $('#file-input').click() },
      '-',
      { head: 'View' },
      { label: 'Bubble size: ' + st.density, icon: 'grid', run: cycleDensity },
      /* A mouse wheel is not a thing you have on a phone. */
      coarse.matches ? null
        : { label: 'Mouse wheel: ' + (S.prefs().wheel === 'pan' ? 'pans' : 'zooms'), icon: 'fit', run: cycleWheel },
      { label: st.showGrid ? 'Hide the grid' : 'Show the grid', icon: 'grid', key: 'G', run: toggleGrid },
    ];

    /* The app itself. Every one of these is optional: with no service worker —
       from a file:// copy, say — BB.pwa is simply not there. */
    const install = [];
    if (pwa && pwa.updateReady && pwa.updateReady()) {
      install.push({ label: 'Update and reload', icon: 'redo', run: () => pwa.applyUpdate() });
    }
    if (pwa && pwa.canInstall && pwa.canInstall()) {
      install.push({ label: 'Install app', icon: 'download', run: () => pwa.install().then(out => {
        if (out === 'accepted') U.toast('Bible Bubble is on your home screen.');
        else if (out === 'unavailable') installHelp();
      }) });
    } else if (pwa && pwa.isIOS && pwa.isIOS()) {
      install.push({ label: 'Add to Home Screen…', icon: 'download', run: installHelp });
    }
    if (install.length) items.push('-', { head: 'App' }, ...install);

    items.push('-',
      { label: coarse.matches ? 'Gestures and shortcuts' : 'Keyboard shortcuts', icon: 'help', key: '?', run: helpModal },
      { label: 'About Bible Bubble', icon: 'book', run: aboutModal });

    menu(r.left - 130, r.bottom + 6, items, { name: 'more', anchor: anchorEl });
  }

  function boardMenu(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    const boards = S.boards();
    menu(r.left - 60, r.bottom + 6, [
      { head: 'This board' },
      { label: 'Rename…', run: renameBoard },
      { label: 'Duplicate', icon: 'copy', run: () => { S.duplicateBoard(); refreshBoards(); afterBoardChange(); U.toast('Board duplicated'); } },
      { label: 'Delete this board', icon: 'trash', danger: true, disabled: boards.length < 2, run: deleteBoard },
      '-',
      { label: 'New empty board', icon: 'plus', run: () => newBoard(false) },
      { label: 'New board from the starter lineage', icon: 'people', run: () => newBoard(true) },
    ], { name: 'board', anchor: anchorEl });
  }

  const toggleGrid = () => {
    S.setSetting('showGrid', !S.settings().showGrid);
    $('#viewport').classList.toggle('show-grid', S.settings().showGrid);
  };
  function cycleDensity() {
    const order = ['compact', 'normal', 'rich'];
    const next = order[(order.indexOf(S.settings().density) + 1) % order.length];
    S.setSetting('density', next);
    applyDensity();
    U.toast('Bubble size: ' + next);
  }
  function applyDensity() {
    const d = S.settings().density;
    const app = $('#app');
    app.classList.remove('density-compact', 'density-normal', 'density-rich');
    app.classList.add('density-' + d);
    C.invalidateSizes();
    C.render();
  }
  function cycleWheel() {
    const next = (S.prefs().wheel === 'pan') ? 'zoom' : 'pan';
    S.setPref('wheel', next);
    U.toast('Mouse wheel now ' + (next === 'pan' ? 'pans the canvas' : 'zooms in and out'));
  }

  /* ================= modals ================= */
  /* One at a time, and each one hands focus back where it found it. */
  const modalStack = [];

  function modal(title, bodyKids, footKids, opts) {
    const root = $('#modal-root');
    const o = opts || {};
    while (modalStack.length) modalStack[modalStack.length - 1].close();

    const titleId = U.uid('mt');
    const returnTo = document.activeElement;
    const entry = {};
    const close = () => {
      const i = modalStack.indexOf(entry);
      if (i < 0) return;
      modalStack.splice(i, 1);
      root.hidden = true;
      root.replaceChildren();
      root.onclick = null;
      if (returnTo && returnTo.isConnected && typeof returnTo.focus === 'function') returnTo.focus();
    };
    entry.close = close;

    const box = el('div.modal', {
      role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
    }, [
      el('div.modal-head', {}, [
        el('h3', { id: titleId, text: title }),
        el('button.btn.icon.ghost', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: close }, [icon('close')]),
      ]),
      el('div.modal-body', {}, bodyKids),
      footKids ? el('div.modal-foot', {}, footKids) : null,
    ]);
    root.replaceChildren(box);
    root.hidden = false;
    modalStack.push(entry);
    root.onclick = (e) => { if (e.target === root && !o.sticky) close(); };
    guardHistory();
    box.focus({ preventScroll: true });
    if (o.onOpen) requestAnimationFrame(() => o.onOpen(box, close));
    return close;
  }

  const closeModals = () => { while (modalStack.length) modalStack[modalStack.length - 1].close(); };

  /* ---------- focus ---------- */
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
    ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusablesIn = (root) => $$(FOCUSABLE, root)
    .filter(n => !n.hidden && n.offsetParent !== null && !n.closest('[hidden]'));

  /** Whatever is modal right now: a dialog, or a sheet with the backdrop up. */
  function trapRoot() {
    if (modalStack.length) return $('.modal', $('#modal-root'));
    if (isPhone() && anyPanelOpen()) {
      return $('#app').classList.contains('panel-details') ? $('#inspector') : $('#sidebar');
    }
    return null;
  }

  /** Keep Tab inside the thing that is covering the app. */
  function initFocusTrap() {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const root = trapRoot();
      if (!root) return;
      const items = focusablesIn(root);
      if (!items.length) { e.preventDefault(); root.focus({ preventScroll: true }); return; }
      const first = items[0], last = items[items.length - 1];
      const at = document.activeElement;
      if (!root.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
      if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    }, true);
  }

  function helpModal() {
    const groups = [
      coarse.matches ? ['Touch', [
        ['Drag empty space', 'Pan around'],
        ['Pinch', 'Zoom in and out'],
        ['Tap a bubble', 'Select it — the card at the bottom carries its actions'],
        ['Hold a bubble', 'Pick it up and move it'],
        ['Hold empty canvas', 'Open the canvas menu'],
        ['Double-tap empty space', 'Add a person there'],
        ['Drag a handle on a selected bubble', 'Link to someone, or drop on empty space for a new person'],
        ['Swipe down on the details sheet', 'Close it'],
      ]] : ['Canvas', [
        ['Drag empty space', 'Pan around'],
        ['Wheel / pinch', 'Zoom in and out'],
        ['Shift + drag', 'Select a group'],
        ['Double-click', 'Add a person there'],
        ['Drag a bubble handle', 'Link to someone, or drop on empty space for a new person'],
        ['Space + drag', 'Pan while over bubbles'],
      ]],
      ['Keys', [
        ['N', 'New person'],
        ['F', 'Fit everything on screen'],
        ['L', 'Tidy into generations'],
        ['T', 'Trace the selected line'],
        ['G', 'Toggle the grid'],
        ['/', 'Jump to search'],
        ['1 / 2 / 3', 'Canvas / web / timeline'],
        ['+ −', 'Zoom in and out'],
        ['0', 'Back to the head of the line'],
        ['Arrows', 'Nudge the selection'],
      ]],
      ['Editing', [
        ['⌘Z / Ctrl+Z', 'Undo'],
        ['⇧⌘Z / Ctrl+Y', 'Redo'],
        ['⌘A / Ctrl+A', 'Select all'],
        ['⌘D / Ctrl+D', 'Duplicate'],
        ['Delete', 'Remove the selection'],
        ['Esc', 'Clear selection or close'],
      ]],
    ];
    modal('Keyboard and canvas', [
      el('div.kbd-grid', {}, groups.map(([name, rows]) => el('div.kbd-sect', {}, [
        el('h4', { text: name }),
        ...rows.map(([k, d]) => el('div.kbd-row', {}, [el('kbd', { text: k }), el('span.d', { text: d })])),
      ]))),
      el('div.about-note', { html:
        '<strong>Tip.</strong> The fastest way to build a line is the ↓ handle under a bubble: ' +
        'drag it onto empty canvas and you get a new child, already linked and ready to name.' }),
    ]);
  }

  function aboutModal() {
    const st = L.stats(S.doc);
    modal('About Bible Bubble', [
      el('p', { text: 'An infinite canvas for mapping who came from who — bubbles for people, links for lineage, and one timeline that puts every life on the same axis.' }),
      el('div.about-note', { html:
        '<strong>Your notes stay yours.</strong> Everything is stored in this browser only ' +
        '(localStorage) — no account, no server, nothing sent anywhere. Export to JSON to back up ' +
        'or move a board to another machine.' }),
      el('div.about-note', { html:
        '<strong>About the dates.</strong> Years are held as AM — years from creation — because ' +
        'Genesis 5 and 11 give the early chain exactly. Later dates use the traditional anchor of ' +
        'AM 0 = 4004 BC and are marked “c.”. Kings of Judah are dated from their own accession ages ' +
        'and reign lengths. All of it is editable: this is your board, not a fixed reference.' }),
      el('div.about-note', { text: `This board: ${U.plural(st.people, 'person', 'people')}, ${U.plural(st.links, 'link')}, ${st.generations} generations.` }),
    ]);
  }

  function boardSettings() {
    const st = S.settings();
    const anchorIn = el('input', { type: 'number', value: String(st.anchor) });
    const modeSel = el('select', {}, [
      el('option', { value: 'both', text: 'Both — “AM 1656 · 2348 BC”' }),
      el('option', { value: 'am', text: 'Years from creation — “AM 1656”' }),
      el('option', { value: 'era', text: 'BC / AD — “2348 BC”' }),
    ]);
    modeSel.value = st.yearMode;
    const nameIn = el('input', { type: 'text', value: S.doc.name });
    const close = modal('Board settings', [
      el('div.field', {}, [el('label', { text: 'Board name' }), nameIn]),
      el('div.field', {}, [el('label', { text: 'How to show years' }), modeSel]),
      el('div.field', {}, [
        el('label', { text: 'Creation anchor — AM 0 equals this year BC' }), anchorIn,
        el('div.hint', { text: 'Traditional reckonings put creation at 4004 BC (Ussher) or 3760 BC (Hebrew calendar). This only changes how AM years are shown as BC/AD; the stored years do not move.' }),
      ]),
    ], [
      el('button.btn', { type: 'button', text: 'Cancel', onclick: () => close() }),
      el('button.btn.primary', { type: 'button', text: 'Save', onclick: () => {
        S.batch('settings', () => {
          S.renameBoard(nameIn.value);
          S.setSetting('yearMode', modeSel.value);
          const a = parseInt(anchorIn.value, 10);
          if (isFinite(a)) S.setSetting('anchor', a);
        });
        refreshBoards();
        C.invalidateSizes();
        C.render();
        close();
      } }),
    ], { onOpen: (box) => nameIn.focus() });
  }

  /** Pick an existing person to link to. */
  function pickPerson(anchorId, kind) {
    const anchor = S.person(anchorId);
    if (!anchor) return;
    const titles = { parent: 'a parent of ', child: 'a child of ', spouse: 'a spouse of ' };
    const search = el('input', { type: 'search', placeholder: 'Search people…', autocomplete: 'off' });
    const list = el('div.picker-list');
    let items = [], active = 0;

    const paint = () => {
      const f = U.fold(search.value.trim());
      items = S.people()
        .filter(p => p.id !== anchorId)
        .filter(p => !f || U.fold(p.name).includes(f) || p.aka.some(a => U.fold(a).includes(f)) || U.fold(p.role).includes(f))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .slice(0, 200);
      active = 0;
      list.replaceChildren(...(items.length ? items.map((p, i) => el('div.picker-item' + (i === 0 ? '.is-active' : ''), {
        onclick: () => choose(p.id),
      }, [
        el('span.tree-dot', { style: { background: `var(--c-${U.colorOf(p.color)})` } }),
        el('span.rel-name', { text: p.name || 'Unnamed' }),
        el('span.rel-meta', { text: p.role || p.era || '' }),
      ])) : [el('div.sr-empty', { text: 'Nobody matches that.' })]));
    };

    const choose = (otherId) => {
      const res = kind === 'parent' ? S.addLink(otherId, anchorId, 'parent')
        : kind === 'spouse' ? S.addLink(anchorId, otherId, 'spouse')
        : S.addLink(anchorId, otherId, 'parent');
      if (!res.ok) { U.toast(linkError(res.reason)); return; }
      close();
      BB.inspector.refresh(true);
      U.toast('Linked');
    };

    search.addEventListener('input', paint);
    search.addEventListener('keydown', (e) => {
      const rows = $$('.picker-item', list);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = U.clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1);
        rows.forEach((r, i) => r.classList.toggle('is-active', i === active));
        if (rows[active]) rows[active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && items[active]) { e.preventDefault(); choose(items[active].id); }
    });

    const close = modal('Link ' + (titles[kind] || 'to ') + (anchor.name || 'this person'),
      [search, list], null, { onOpen: () => search.focus() });
    paint();
  }

  /* ================= connections ================= */

  /** Chips for the relation kinds; the caller gets the id of whichever is picked. */
  function kindChips(current, onPick) {
    const row = el('div.kind-chips');
    BB.model.BOND_KINDS.forEach(k => {
      row.appendChild(el('button.chip', {
        type: 'button', text: k.label, title: k.out,
        dataset: { kind: k.id },
        style: { '--kind': `var(--c-${k.hue})` },
        onclick: () => {
          $$('button', row).forEach(c => c.classList.toggle('is-active', c.dataset.kind === k.id));
          onPick(k.id);
        },
      }));
    });
    $$('button', row).forEach(c => c.classList.toggle('is-active', c.dataset.kind === current));
    return row;
  }

  /** "Elijah — mentor of — Elisha", rebuilt whenever the ends or the kind change. */
  function bondSentence(host, fromId, toId, kind) {
    const a = S.person(fromId), b = S.person(toId);
    host.replaceChildren(
      el('strong', { text: (a && a.name) || 'Unnamed' }),
      el('em', { text: BB.model.bondKind(kind).out.toLowerCase() }),
      el('strong', { text: (b && b.name) || 'Unnamed' }),
    );
  }

  const bondError = (reason) => reason === 'duplicate'
    ? 'Those two already have that connection.' : linkError(reason);

  /**
   * Record a link that is not lineage. `otherId` pre-fills the far end, which is
   * how "connect these two" works from a two-person selection.
   */
  function addBond(anchorId, otherId) {
    const anchor = S.person(anchorId);
    if (!anchor) return;
    if (S.count() < 2) { U.toast('A connection needs two people — add somebody else first.'); return; }

    let target = S.person(otherId) ? otherId : null;
    let kind = 'other';
    let flipped = false;                       // which end of a directed relation the anchor is on

    const search = el('input', { type: 'search', placeholder: 'Search people…', autocomplete: 'off' });
    const list = el('div.picker-list');
    const label = el('input.bond-label', { type: 'text', maxlength: '60', placeholder: 'What happened between them?' });
    const note = el('input.bond-note', { type: 'text', maxlength: '500', placeholder: 'Reference — Gen 4:8' });
    const sentence = el('div.bond-sentence');
    const swap = el('button.btn.sm.ghost', { type: 'button', text: 'Swap ends', onclick: () => { flipped = !flipped; paintSentence(); } });
    const save = el('button.btn.primary', { type: 'button', text: 'Connect', onclick: () => commit() });

    const ends = () => (flipped ? { from: target, to: anchorId } : { from: anchorId, to: target });

    function paintSentence() {
      if (!target) sentence.replaceChildren(el('span.bond-hint', { text: 'Pick who to connect them to.' }));
      else { const e = ends(); bondSentence(sentence, e.from, e.to, kind); }
      swap.hidden = !target || BB.model.bondKind(kind).dir !== 'directed';
      save.disabled = !target;
    }

    function paintList() {
      const f = U.fold(search.value.trim());
      const items = S.people()
        .filter(p => p.id !== anchorId)
        .filter(p => !f || U.fold(p.name).includes(f) || p.aka.some(a => U.fold(a).includes(f)) || U.fold(p.role).includes(f))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .slice(0, 200);
      list.replaceChildren(...(items.length ? items.map(p => el('div.picker-item' + (p.id === target ? '.is-active' : ''), {
        onclick: () => { target = p.id; paintList(); paintSentence(); label.focus(); },
      }, [
        el('span.tree-dot', { style: { background: `var(--c-${U.colorOf(p.color)})` } }),
        el('span.rel-name', { text: p.name || 'Unnamed' }),
        el('span.rel-meta', { text: p.role || p.era || '' }),
      ])) : [el('div.sr-empty', { text: 'Nobody matches that.' })]));
    }

    function commit() {
      if (!target) return;
      const e = ends();
      const res = S.addLink(e.from, e.to, 'other', { kind, label: label.value.trim(), note: note.value.trim() });
      if (!res.ok) { U.toast(bondError(res.reason)); return; }
      close();
      BB.inspector.refresh(true);
      U.toast('Connected');
    }

    search.addEventListener('input', paintList);
    label.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });

    const close = modal('Connect ' + (anchor.name || 'this person'), [
      search,
      list,
      el('div.rel-label', { text: 'How are they connected?' }),
      kindChips(kind, (k) => { kind = k; paintSentence(); }),
      el('div.bond-row', {}, [sentence, swap]),
      label,
      note,
    ], [
      el('button.btn', { type: 'button', text: 'Cancel', onclick: () => close() }),
      save,
    ], { onOpen: () => (target ? label : search).focus() });

    paintList();
    paintSentence();
  }

  /** Change the kind, wording or direction of a connection that already exists. */
  function editBond(linkId) {
    let id = linkId;
    const link = S.doc.links[id];
    if (!link || link.type !== 'other') return;
    let kind = link.kind || 'other';

    const label = el('input.bond-label', { type: 'text', maxlength: '60', value: link.label || '', placeholder: 'What happened between them?' });
    const note = el('input.bond-note', { type: 'text', maxlength: '500', value: link.note || '', placeholder: 'Reference — Gen 4:8' });
    const sentence = el('div.bond-sentence');

    function paint() {
      const cur = S.doc.links[id];
      if (!cur) return;
      bondSentence(sentence, cur.from, cur.to, kind);
    }

    /* Reversing means a new link, so keep hold of the id it comes back with. */
    function swapEnds() {
      const cur = S.doc.links[id];
      if (!cur) return;
      S.removeLink(id);
      const res = S.addLink(cur.to, cur.from, 'other', { kind: cur.kind, label: cur.label, note: cur.note });
      if (!res.ok) { S.undo(); U.toast(bondError(res.reason)); return; }
      id = res.link.id;
      paint();
    }

    function commit() {
      const ok = S.updateLink(id, { kind, label: label.value.trim(), note: note.value.trim() });
      if (!ok) { U.toast('Those two already have that connection.'); return; }
      close();
      BB.inspector.refresh(true);
    }

    label.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });

    const close = modal('Edit this connection', [
      el('div.bond-row', {}, [sentence, el('button.btn.sm.ghost', { type: 'button', text: 'Swap ends', onclick: swapEnds })]),
      el('div.rel-label', { text: 'How are they connected?' }),
      kindChips(kind, (k) => { kind = k; paint(); }),
      label,
      note,
    ], [
      el('button.btn.danger', { type: 'button', text: 'Remove', onclick: () => {
        S.removeLink(id); close(); BB.inspector.refresh(true);
      } }),
      el('span.foot-spacer'),
      el('button.btn', { type: 'button', text: 'Cancel', onclick: () => close() }),
      el('button.btn.primary', { type: 'button', text: 'Save', onclick: commit }),
    ], { onOpen: () => label.focus() });

    paint();
  }

  /* ================= boards ================= */
  function refreshBoards() {
    const sel = $('#board-select');
    const boards = S.boards().sort((a, b) => b.updated - a.updated);
    sel.replaceChildren(...boards.map(b => el('option', { value: b.id, text: b.name || 'Untitled' })));
    sel.value = S.doc.id;
    if (sel.value !== S.doc.id) {
      sel.appendChild(el('option', { value: S.doc.id, text: S.doc.name }));
      sel.value = S.doc.id;
    }
    document.title = (S.doc.name ? S.doc.name + ' · ' : '') + 'Bible Bubble';
  }

  function newBoard(withSeed) {
    S.createBoard(withSeed ? 'Genesis → Gospel' : 'New board', withSeed ? BB.seed.build() : null);
    if (withSeed) layoutSeed();
    refreshBoards();
    afterBoardChange();
  }

  function renameBoard() {
    const input = el('input', { type: 'text', value: S.doc.name });
    const close = modal('Rename board', [el('div.field', {}, [el('label', { text: 'Board name' }), input])], [
      el('button.btn', { type: 'button', text: 'Cancel', onclick: () => close() }),
      el('button.btn.primary', { type: 'button', text: 'Rename', onclick: () => { S.renameBoard(input.value); refreshBoards(); close(); } }),
    ], { onOpen: () => { input.focus(); input.select(); } });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { S.renameBoard(input.value); refreshBoards(); close(); } });
  }

  function deleteBoard() {
    const name = S.doc.name;
    const close = modal('Delete this board?', [
      el('p', { text: `“${name}” and everything on it will be removed from this browser. This cannot be undone.` }),
      el('div.about-note', { text: 'Export it first if you might want it back.' }),
    ], [
      el('button.btn', { type: 'button', text: 'Cancel', onclick: () => close() }),
      el('button.btn', { type: 'button', text: 'Export first', onclick: () => BB.io.exportJSON() }),
      el('button.btn.primary', { type: 'button', text: 'Delete', style: { background: 'var(--danger)', borderColor: 'var(--danger)' }, onclick: () => {
        S.deleteBoard(S.doc.id); refreshBoards(); afterBoardChange(); close(); U.toast('Board deleted');
      } }),
    ]);
  }

  function afterBoardChange() {
    C.invalidateSizes();
    C.select([]);
    C.setTrace(null);
    applyDensity();
    $('#viewport').classList.toggle('show-grid', S.settings().showGrid);
    C.render();
    setTimeout(() => C.home({ animate: false }), 30);
    BB.sidebar.render();
    BB.timeline.fit();
    writeUrl('replace');
  }

  function layoutSeed() {
    C.invalidateSizes();
    C.render();
    const sizes = {};
    Object.keys(S.doc.people).forEach(id => { sizes[id] = C.sizeOf(id); });
    const pos = L.layout(S.doc, { sizes });
    S.movePeople(pos, 'seed-layout');
    S.seal();
  }

  function confirmSeed() {
    if (S.count() === 0) { loadSeedIntoBoard(); return; }
    const close = modal('Load the starter lineage?', [
      el('p', { text: 'This board already has people on it. The starter lineage can go on a new board, or replace what is here.' }),
    ], [
      el('button.btn', { type: 'button', text: 'Cancel', onclick: () => close() }),
      el('button.btn', { type: 'button', text: 'Replace this board', onclick: () => { loadSeedIntoBoard(); close(); } }),
      el('button.btn.primary', { type: 'button', text: 'Put it on a new board', onclick: () => { newBoard(true); close(); } }),
    ]);
  }

  function loadSeedIntoBoard() {
    S.replaceDoc(BB.seed.build(), { name: 'Genesis → Gospel' });
    layoutSeed();
    refreshBoards();
    afterBoardChange();
    U.toast(`Loaded ${U.plural(S.count(), 'person', 'people')} from Adam to Jesus`);
  }

  /* ================= search ================= */
  function initSearch() {
    const input = $('#search-input');
    const box = $('#search-results');
    let results = [], active = 0;

    /* Connections are searchable too, so "covenant" or "rival" finds people. */
    let bondCache = { rev: -1, map: new Map() };
    const bondText = (id) => {
      if (bondCache.rev !== S.rev) bondCache = { rev: S.rev, map: new Map() };
      if (!bondCache.map.has(id)) {
        bondCache.map.set(id, U.fold(L.bondsOf(id).map(b => {
          const k = BB.model.bondKind(b.kind);
          const other = S.person(b.id);
          return [k.label, k.out, b.label, b.note, other && other.name].filter(Boolean).join(' ');
        }).join(' ')));
      }
      return bondCache.map.get(id);
    };

    const score = (p, f) => {
      const name = U.fold(p.name);
      if (name === f) return 100;
      if (name.startsWith(f)) return 80;
      if (name.includes(f)) return 60;
      if (p.aka.some(a => U.fold(a).includes(f))) return 55;
      if (U.fold(p.role).includes(f)) return 40;
      if (p.refs.some(r => U.fold(r).includes(f))) return 34;
      if (p.tags.some(t => U.fold(t).includes(f)) || U.fold(p.era).includes(f)) return 30;
      if (p.highlights.some(h => U.fold(h).includes(f))) return 22;
      if (bondText(p.id).includes(f)) return 20;
      if (U.fold(p.notes).includes(f)) return 18;
      return 0;
    };

    /* The results are a listbox the input drives from a distance, so a screen
       reader hears the highlighted row without focus ever leaving the field. */
    box.setAttribute('role', 'listbox');
    box.setAttribute('aria-label', 'Search results');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', 'search-results');
    input.setAttribute('aria-autocomplete', 'list');

    const showBox = (open) => {
      box.hidden = !open;
      input.setAttribute('aria-expanded', String(!!open));
      if (!open) input.removeAttribute('aria-activedescendant');
    };

    const paint = () => {
      const f = U.fold(input.value.trim());
      if (!f) { showBox(false); return; }
      results = S.people()
        .map(p => ({ p, s: score(p, f) }))
        .filter(r => r.s > 0)
        .sort((a, b) => b.s - a.s || (a.p.name || '').localeCompare(b.p.name || ''))
        .slice(0, 12);
      active = 0;
      showBox(true);
      if (!results.length) {
        box.replaceChildren(el('div.sr-empty', { role: 'option', 'aria-disabled': 'true',
          text: 'Nobody matches “' + input.value.trim() + '”.' }));
        input.removeAttribute('aria-activedescendant');
        return;
      }
      box.replaceChildren(...results.map((r, i) => {
        const p = r.p;
        const st = S.settings();
        const sub = [p.role, p.era, U.formatSpan(p.birth, p.death, { mode: 'era', anchor: st.anchor, approx: p.approx })].filter(Boolean).join(' · ');
        return el('div.sr-item' + (i === 0 ? '.is-active' : ''), {
          id: 'sr-opt-' + i, role: 'option', 'aria-selected': String(i === 0),
          onclick: () => go(p.id),
          onmouseenter: () => { active = i; paintActive(); },
        }, [
          el('span.sr-swatch', { style: { background: `var(--c-${U.colorOf(p.color)})` } }),
          el('span.sr-name', { text: p.name || 'Unnamed' }),
          el('span.sr-sub', { text: sub }),
          i === 0 ? el('span.sr-kbd', { text: '↵' }) : null,
        ]);
      }));
      paintActive();
    };
    const paintActive = () => {
      $$('.sr-item', box).forEach((r, i) => {
        r.classList.toggle('is-active', i === active);
        r.setAttribute('aria-selected', String(i === active));
      });
      if (results.length) input.setAttribute('aria-activedescendant', 'sr-opt-' + active);
    };
    const go = (id) => {
      showBox(false);
      input.blur();
      if (isPhone()) toggleSearch(false);
      revealPerson(id);
    };

    input.addEventListener('input', U.debounce(paint, 90));
    input.addEventListener('focus', () => { if (input.value.trim()) paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; showBox(false); input.blur(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = U.clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, results.length - 1);
        paintActive();
        const row = $$('.sr-item', box)[active];
        if (row) row.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && results[active]) { e.preventDefault(); go(results[active].p.id); }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap')) showBox(false);
    });
  }

  /* ================= keyboard ================= */
  function initKeys() {
    window.addEventListener('keydown', (e) => {
      const typing = C.isTyping(e.target);
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === 'Escape') {
        if (modalStack.length) { closeModals(); return; }
        if (!$('#context-menu').hidden) { closeMenu(); return; }
        if ($('#app').classList.contains('search-open')) { toggleSearch(false); return; }
        if (isPhone() && anyPanelOpen()) { closePanels(); return; }
        if (BB.peek && BB.peek.isOpen && BB.peek.isOpen()) { BB.peek.hide(); return; }
        if (typing) { e.target.blur(); return; }
        if (C.trace) { C.setTrace(null); return; }
        C.select([]);
        return;
      }

      if (mod && e.key.toLowerCase() === 'z') {
        if (typing && e.target.value !== undefined && !e.shiftKey) return;   // let inputs handle their own undo
        e.preventDefault();
        if (e.shiftKey) { if (!S.redo()) U.toast('Nothing to redo'); }
        else if (!S.undo()) U.toast('Nothing to undo');
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); S.redo(); return; }
      if (typing) return;

      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); C.select(Object.keys(S.doc.people)); return; }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const sel = C.selected();
        if (sel.length === 1) duplicatePerson(sel[0]);
        return;
      }
      if (mod) return;

      const k = e.key;
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSelected(); }
      else if (k === '/') { e.preventDefault(); $('#search-input').focus(); }
      else if (k === '?') { e.preventDefault(); helpModal(); }
      else if (k.toLowerCase() === 'n') { e.preventDefault(); addAtCentre(); }
      else if (k.toLowerCase() === 'f') { e.preventDefault(); C.fit(C.selected().length > 1 ? C.selected() : null, glide()); }
      else if (k.toLowerCase() === 'l') { e.preventDefault(); autoLayout(C.selected().length > 1 ? C.selected() : null); }
      else if (k.toLowerCase() === 'g') { e.preventDefault(); toggleGrid(); }
      else if (k.toLowerCase() === 't') {
        const sel = C.selected();
        if (sel.length === 1) toggleTrace(sel[0]);
        else if (C.trace) C.setTrace(null);
      }
      else if (k === '1') setView('canvas');
      else if (k === '2') setView('web');
      else if (k === '3') setView('timeline');
      else if (k === '+' || k === '=') C.zoomAt(1.25);
      else if (k === '-' || k === '_') C.zoomAt(1 / 1.25);
      else if (k === '0') C.home(glide());
      else if (k.startsWith('Arrow')) {
        const sel = C.selected();
        if (!sel.length) return;
        e.preventDefault();
        const step = e.shiftKey ? 40 : 8;
        const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
        const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
        const pos = {};
        sel.forEach(id => { const p = S.person(id); if (p) pos[id] = { x: p.x + dx, y: p.y + dy }; });
        S.movePeople(pos, 'nudge');
      }
    });
  }

  function addAtCentre() {
    const r = $('#viewport').getBoundingClientRect();
    addPersonAt(C.toWorld(r.left + r.width / 2, r.top + r.height / 2));
  }

  /* ================= first run ================= */
  function welcome() {
    const close = modal('Welcome to Bible Bubble', [
      el('p', { text: 'A canvas for tracking who came from who — one bubble per person, links for lineage, and a timeline that lays every life on the same axis.' }),
      el('div.about-note', { html:
        'Start from <strong>Adam</strong> with the built-in line down to Jesus — ' +
        `${BB.seed.count} people with ages, references and highlights already filled in, ` +
        `and ${BB.seed.bonds} connections between them that are not lineage — ` +
        'or begin with an empty canvas and build your own.' }),
    ], [
      el('button.btn', { type: 'button', text: 'Empty canvas', onclick: () => { close(); S.renameBoard('My lineage'); refreshBoards(); } }),
      el('button.btn.primary', { type: 'button', text: 'Start from Adam', onclick: () => { close(); loadSeedIntoBoard(); } }),
    ], { sticky: true });
  }

  /* ================= phone layout ================= */
  const phoneQuery = window.matchMedia('(max-width: 700px)');
  const isPhone = () => phoneQuery.matches;

  const panelEl = (name) => $(name === 'lineage' ? '#sidebar' : '#inspector');
  let panelReturn = null;               // where focus was before a sheet took over
  let backdropAt = 0;                   // when the backdrop last appeared

  /** Only one sheet at a time, and the backdrop follows whichever is open. */
  function setPanel(name, open) {
    const app = $('#app');
    const cls = 'panel-' + name;
    const other = name === 'lineage' ? 'panel-details' : 'panel-lineage';
    const was = anyPanelOpen();
    if (open) { app.classList.add(cls); app.classList.remove(other); }
    else app.classList.remove(cls);
    const any = anyPanelOpen();
    $('#sheet-backdrop').hidden = !any;
    if (any && !was) backdropAt = Date.now();
    paintMobileBar();
    if (open && name === 'details') BB.inspector.refresh(true);
    if (!isPhone()) return;

    syncSheets();
    if (open) {
      if (!was) panelReturn = document.activeElement;
      guardHistory();
      /* Sliding the canvas clear of the sheet is peek.js's — it measures the
         sheet once it has finished coming up, which is the only honest moment. */
      /* The sheet itself takes focus, not the first field in it — landing on a
         text input would throw the keyboard up over the sheet you just opened. */
      const host = panelEl(name);
      if (host) { host.tabIndex = -1; host.focus({ preventScroll: true }); }
    } else if (was && !any) {
      if (panelReturn && panelReturn.isConnected && typeof panelReturn.focus === 'function') {
        panelReturn.focus({ preventScroll: true });
      }
      panelReturn = null;
    }
  }
  const closePanels = () => { setPanel('lineage', false); setPanel('details', false); };
  const anyPanelOpen = () => $('#app').classList.contains('panel-lineage') || $('#app').classList.contains('panel-details');

  /**
   * A closed sheet is off the side of the screen, not gone: without this it is
   * still in the tab order and still read out, from behind whatever is on top.
   */
  function syncSheets() {
    const app = $('#app');
    const phone = isPhone();
    [['lineage', '#sidebar'], ['details', '#inspector']].forEach(([name, sel]) => {
      const node = $(sel);
      if (!node) return;
      const shut = phone && !app.classList.contains('panel-' + name);
      if (shut) {
        if (node.contains(document.activeElement)) document.activeElement.blur();
        node.inert = true;
        node.setAttribute('aria-hidden', 'true');
      } else {
        node.inert = false;
        node.removeAttribute('aria-hidden');
      }
    });
  }

  /** A sheet left showing somebody who has just been deleted is only in the way. */
  function closeStaleDetails() {
    if (!isPhone() || !$('#app').classList.contains('panel-details')) return;
    const sel = C.selected();
    if (sel.length && sel.every(id => !S.person(id))) setPanel('details', false);
  }

  function paintMobileBar() {
    const app = $('#app');
    const state = {
      lineage: app.classList.contains('panel-lineage'),
      details: app.classList.contains('panel-details'),
      canvas: currentView === 'canvas',
      web: currentView === 'web',
      timeline: currentView === 'timeline',
    };
    $$('.mb-item').forEach(b => {
      const on = !!state[b.dataset.mb];
      b.classList.toggle('is-active', on);
      if (b.dataset.mb === 'lineage' || b.dataset.mb === 'details') {
        b.setAttribute('aria-expanded', String(on));
        b.setAttribute('aria-controls', b.dataset.mb === 'lineage' ? 'sidebar' : 'inspector');
      } else if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const label = $('#mb-details-label');
    if (label) {
      const sel = C.selected();
      const p = sel.length === 1 ? S.person(sel[0]) : null;
      label.textContent = sel.length > 1 ? sel.length + ' selected'
        : (p && p.name) ? p.name : 'Details';
    }
  }

  function toggleSearch(open) {
    const app = $('#app');
    app.classList.toggle('search-open', open);
    if (open) requestAnimationFrame(() => $('#search-input').focus());
    else { $('#search-input').blur(); $('#search-results').hidden = true; }
  }

  function initMobile() {
    $$('.mb-item').forEach(b => b.addEventListener('click', () => {
      const which = b.dataset.mb;
      if (which === 'canvas' || which === 'web' || which === 'timeline') { closePanels(); setView(which); }
      else setPanel(which, !$('#app').classList.contains('panel-' + which));
    }));
    /**
     * A tap on the canvas comes back a moment later as a click, and by then the
     * backdrop is under the finger — which is how double-tapping to add someone
     * used to shut the very sheet it had just opened to name them in.
     */
    const backdrop = $('#sheet-backdrop');
    /* Cancelling the default on mousedown keeps the focus where it is, so that
       stray click cannot take the keyboard away from the field either. */
    backdrop.addEventListener('mousedown', (e) => e.preventDefault());
    backdrop.addEventListener('click', () => {
      if (Date.now() - backdropAt < 400) return;
      closePanels();
    });

    // a swipe down on the details sheet header closes it
    const insp = $('#inspector');
    let sy = null;
    insp.addEventListener('touchstart', (e) => {
      sy = (insp.scrollTop <= 0 && e.touches.length === 1) ? e.touches[0].clientY : null;
    }, { passive: true });
    insp.addEventListener('touchmove', (e) => {
      if (sy == null) return;
      if (e.touches[0].clientY - sy > 70) { sy = null; setPanel('details', false); }
    }, { passive: true });

    /* "Double-click" is advice nobody can follow with a finger. */
    const emptyText = $('#empty-state p');
    const emptyDesktop = emptyText ? emptyText.textContent : '';
    const emptyPhone = 'Double-tap anywhere to make your first bubble — or load the ' +
      'Genesis → Gospel lineage to start from Adam.';

    const sync = () => {
      const phone = isPhone();
      $('#app').classList.toggle('is-phone', phone);
      if (!phone) { closePanels(); toggleSearch(false); }
      if (emptyText) emptyText.textContent = phone ? emptyPhone : emptyDesktop;
      syncSheets();
      paintMobileBar();
    };
    phoneQuery.addEventListener ? phoneQuery.addEventListener('change', sync) : phoneQuery.addListener(sync);
    window.addEventListener('orientationchange', () => setTimeout(sync, 120));
    sync();
  }

  /* ================= offering the undo ================= */
  /**
   * On a phone there is no ⌘Z and the toolbar has no room for an undo button, so
   * the offer has to come to the change rather than the other way round. One
   * offer at a time: a new one replaces the last, because an undo six edits ago
   * is not the undo anybody means.
   */
  let dropOffer = null;
  let quietDepth = 0;
  let justDropped = null;         // ids from a finger drag, waiting for their move to land
  let known = { people: new Map(), links: new Map() };

  /** Run a compound edit — a delete and an add — without offering an undo halfway. */
  function quietly(fn) {
    quietDepth++;
    try { return fn(); } finally { quietDepth--; }
  }

  function offerUndo(msg) {
    if (dropOffer) dropOffer();
    dropOffer = S.canUndo
      ? U.toast(msg, { ms: 5200, action: 'Undo', onAction: () => { dropOffer = null; S.undo(); } })
      : U.toast(msg);
  }

  const snapshotDoc = () => {
    known = {
      people: new Map(S.people().map(p => [p.id, p.name])),
      links: new Map(S.links().map(l => [l.id, l.type])),
    };
  };

  /** What the snapshot held that the document no longer does. */
  function lostFrom(map, live) {
    const out = [];
    map.forEach((val, id) => { if (!live[id]) out.push(val); });
    return out;
  }

  function watchEdits() {
    snapshotDoc();
    S.on('change', (e) => {
      const reasons = String((e && e.reason) || '').split('+');
      const has = (r) => reasons.indexOf(r) >= 0;
      /* Undo, redo, loading and board switches all move the ground under the
         snapshot without anybody losing anything. */
      if (has('history') || has('load') || has('board') || has('replace')) { snapshotDoc(); return; }
      if (quietDepth > 0) { snapshotDoc(); return; }

      if (has('people')) {
        const gone = lostFrom(known.people, S.doc.people);
        if (gone.length === 1) offerUndo('Deleted ' + (gone[0] || 'that person'));
        else if (gone.length) offerUndo('Deleted ' + U.plural(gone.length, 'person', 'people'));
      } else if (has('links')) {
        const gone = lostFrom(known.links, S.doc.links);
        if (gone.length === 1) offerUndo(gone[0] === 'other' ? 'Connection removed' : 'Link removed');
        else if (gone.length) offerUndo(U.plural(gone.length, 'link') + ' removed');
      } else if (has('positions') && justDropped) {
        /* A picked-up-and-dropped bubble is the one move that is easy to make by
           accident and hard to spot afterwards — and it happens on the screen
           with no ⌘Z. A tidy, a nudge or a mouse drag speaks for itself. */
        const ids = justDropped;
        justDropped = null;
        offerUndo(movedLabel(ids));
      }
      snapshotDoc();
    });

    /* 'drop' only fires for a finger that lifted a bubble, and it arrives just
       before the move reaches the store. */
    C.on('drop', ({ ids, moved }) => { if (moved) justDropped = ids; });
  }

  function movedLabel(ids) {
    if (ids.length === 1) {
      const p = S.person(ids[0]);
      return 'Moved ' + ((p && p.name) || 'that bubble');
    }
    return 'Moved ' + U.plural(ids.length || 1, 'bubble');
  }

  /* ================= reach ================= */
  /**
   * The phone toolbar drops undo for want of room, which leaves a mis-drag with
   * nowhere to go but the ☰ menu. This button only exists once there is
   * something to undo, so it costs the board name nothing until it is needed.
   */
  function initQuickUndo() {
    const actions = $('.topbar .actions');
    const more = $('#more-btn');
    if (!actions || !more) return;
    actions.insertBefore(el('button.btn.icon.ghost.undo-quick', {
      type: 'button', 'data-act': 'undo', title: 'Undo', 'aria-label': 'Undo',
    }, [icon('undo')]), more);
  }
  const paintUndoState = () => $('#app').classList.toggle('can-undo', S.canUndo);

  /** Subscribe once, whenever pwa.js turns up — it boots after this file does. */
  let pwaWatched = false;
  function watchPwa() {
    if (pwaWatched || !BB.pwa || !BB.pwa.onChange) return;
    pwaWatched = true;
    BB.pwa.onChange(() => { if (openMenu === 'more' && menuAnchor) moreMenu(menuAnchor); });
  }

  /**
   * The zoom control, the trace bar and the empty-state buttons sit inside the
   * viewport, and the canvas takes pointer capture on anything that lands on the
   * background — which retargets the mouseup and leaves the click on the
   * viewport, so a tap on any of them did nothing at all. Stopping the bubble at
   * the chrome keeps the canvas out of it; the minimap still hears its own
   * pointerdown first, because this fires on the way back up.
   */
  function shieldChrome() {
    $$('.canvas-hud, .trace-bar, .empty-actions').forEach(node => {
      node.addEventListener('pointerdown', (e) => e.stopPropagation());
    });
  }

  /* ================= accessibility ================= */
  function initA11y() {
    const panelFor = { canvas: 'viewport', web: 'web', timeline: 'timeline' };
    const tabs = $$('.viewtabs .tab');
    tabs.forEach(t => {
      const id = panelFor[t.dataset.view];
      const panel = id && document.getElementById(id);
      if (!panel) return;
      t.setAttribute('aria-controls', id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-label', t.textContent.trim() + ' view');
    });
    /* Roving focus: one stop for the whole tablist, arrows to move inside it. */
    const list = $('.viewtabs');
    if (list) {
      list.setAttribute('aria-label', 'View');
      list.addEventListener('keydown', (e) => {
        const at = tabs.indexOf(document.activeElement);
        if (at < 0) return;
        let next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % tabs.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabs.length - 1;
        if (next < 0) return;
        e.preventDefault();
        tabs[next].focus();
        setView(tabs[next].dataset.view);
      });
    }

    const label = (sel, text) => { const n = $(sel); if (n) n.setAttribute('aria-label', text); };
    label('#sidebar', 'Lineage and people');
    label('#inspector', 'Details');
    label('#trace-bar', 'Traced line');

    /* Save state and the running counts are worth hearing, quietly. */
    const status = $('#statusbar');
    if (status) { status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); }
    const toasts = $('#toasts');
    if (toasts) {
      toasts.setAttribute('role', 'status');
      toasts.setAttribute('aria-live', 'polite');
      toasts.setAttribute('aria-atomic', 'false');
    }
  }

  /* ================= boot ================= */
  function init() {
    S = BB.store; L = BB.lineage; C = BB.canvas;
    initTheme();

    const route = readRoute();
    const loaded = S.load();
    /* Board ids are this browser's own, so a link only opens a board that is
       already here; anything else quietly stays on whichever board was last up. */
    if (route.board && route.board !== S.doc.id) S.openBoard(route.board);
    BB.canvas.init();
    BB.io.init();
    BB.inspector.init();
    BB.timeline.init();
    BB.web.init();
    BB.sidebar.init();

    applyDensity();
    $('#viewport').classList.toggle('show-grid', S.settings().showGrid);
    refreshBoards();
    initA11y();
    shieldChrome();
    initSearch();
    initKeys();
    initMenuKeys();
    initFocusTrap();
    initQuickUndo();
    initMobile();
    initRouter();
    watchEdits();

    /* toolbar */
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) { if (!e.target.closest('.menu')) closeMenu(); return; }
      const act = btn.dataset.act;
      const run = {
        'add-person': addAtCentre,
        'layout': () => autoLayout(C.selected().length > 1 ? C.selected() : null),
        'fit': () => C.fit(null, glide()),
        'theme': toggleTheme,
        'more': () => { if (openMenu === 'more') closeMenu(); else moreMenu(btn); },
        'undo': () => { if (!S.undo()) U.toast('Nothing to undo'); },
        'redo': () => { if (!S.redo()) U.toast('Nothing to redo'); },
        'zoom-in': () => C.zoomAt(1.25),
        'zoom-out': () => C.zoomAt(1 / 1.25),
        'zoom-reset': () => { C.setView({ k: 1 }); },
        'toggle-grid': toggleGrid,
        'help': helpModal,
        'toggle-sidebar': () => $('#app').classList.toggle('sidebar-hidden'),
        'trace-off': () => C.setTrace(null),
        'load-seed': confirmSeed,
        'search-open': () => toggleSearch(true),
        'search-close': () => toggleSearch(false),
        'web-zoom-in': () => BB.web.zoomBy(1.25),
        'web-zoom-out': () => BB.web.zoomBy(1 / 1.25),
        'web-fit': () => BB.web.fit(),
      }[act];
      if (run) { e.preventDefault(); run(); }
    });

    $$('.viewtabs .tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));
    $('#board-select').addEventListener('change', (e) => {
      if (S.openBoard(e.target.value)) { refreshBoards(); afterBoardChange(); }
    });
    $('#board-menu-btn').addEventListener('click', (e) => { e.stopPropagation(); boardMenu(e.currentTarget); });

    /* file import */
    $('#file-input').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const raw = await BB.io.readFile(file);
        const count = Object.keys(raw.people || {}).length;
        if (!count) { U.toast('That file has no people in it.'); return; }
        const close = modal('Import ' + U.plural(count, 'person', 'people') + '?', [
          el('p', { text: `“${raw.name || file.name}” can replace this board, or arrive as a new one.` }),
        ], [
          el('button.btn', { type: 'button', text: 'Cancel', onclick: () => close() }),
          el('button.btn', { type: 'button', text: 'Replace this board', onclick: () => {
            S.replaceDoc(raw); refreshBoards(); afterBoardChange(); close(); U.toast('Imported');
          } }),
          el('button.btn.primary', { type: 'button', text: 'New board', onclick: () => {
            S.createBoard(raw.name || file.name.replace(/\.json$/i, ''), raw);
            refreshBoards(); afterBoardChange(); close(); U.toast('Imported');
          } }),
        ]);
      } catch (err) {
        U.toast(err.message || 'Could not import that file.');
      }
    });

    /* canvas events */
    C.on('dblclick-empty', (at) => addPersonAt(at));
    C.on('context', (info) => {
      if (info.id) personMenu(info.x, info.y, info.id);
      else if (info.link) linkMenu(info.x, info.y, info.link);
      else canvasMenu(info.x, info.y, info.at);
    });
    C.on('link-drop', ({ from, to, side }) => linkBySide(from, to, side));
    C.on('link-empty', ({ from, side, at, moved }) => {
      const kind = side === 'top' ? 'parent' : side === 'bottom' ? 'child' : 'spouse';
      quickRelative(from, kind, '', moved ? at : null);
    });
    C.on('trace', paintTraceBar);
    C.on('select', () => {
      if (currentView === 'timeline') BB.timeline.draw();
      paintMobileBar();
      writeUrlSoon();
    });

    /* status bar */
    const paintStatus = () => {
      const st = L.stats(S.doc);
      const bonds = st.bonds ? ` · ${U.plural(st.bonds, 'connection')}` : '';
      $('#status-count').textContent =
        `${U.plural(st.people, 'person', 'people')} · ${U.plural(st.links, 'link')}${bonds} · ${st.generations} generations`;
    };
    S.on('change', paintStatus);
    S.on('change', paintUndoState);
    S.on('change', closeStaleDetails);
    S.on('dirty', (d) => {
      const n = $('#status-save');
      n.textContent = d ? 'Saving…' : 'Saved';
      n.classList.toggle('is-dirty', d);
    });
    S.on('storage-error', () => U.toast('This browser would not let the board save. Export to JSON to be safe.', { ms: 8000 }));
    paintStatus();

    C.on('view', U.rafThrottle(() => {
      const z = $('.zoom-label');
      if (z) z.textContent = Math.round(C.view.k * 100) + '%';
    }));

    window.addEventListener('beforeunload', () => S.flush());
    document.addEventListener('visibilitychange', () => { if (document.hidden) S.flush(); });

    const savedView = S.prefs().view;
    setView(route.view || (VIEWS.includes(savedView) ? savedView : 'canvas'), { history: 'none' });
    paintUndoState();
    watchPwa();
    setTimeout(watchPwa, 0);          // pwa.js boots a moment after this file does

    if (loaded.fresh) {
      S.createBoard('My lineage');
      refreshBoards();
      welcome();
    } else if (route.person && S.person(route.person)) {
      /* Deep link: wait for the first render, or there is nothing to centre on. */
      requestAnimationFrame(() => { revealPerson(route.person); writeUrl('replace'); });
      return;
    } else if (S.count()) {
      const v = S.doc.view;
      const untouched = !v || (!v.x && !v.y && v.k === 1);
      if (untouched) setTimeout(() => C.home({ animate: false }), 60);
    }
    writeUrl('replace');
  }

  BB.app = {
    init, quickRelative, pickPerson, duplicatePerson, deleteSelected, autoLayout,
    toggleTrace, revealPerson, showOnCanvas, setView, helpModal, confirmSeed,
    addBond, editBond, isPhone, setPanel, closePanels,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.BB);
