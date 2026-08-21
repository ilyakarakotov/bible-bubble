/* Bible Bubble — wiring: toolbar, menus, search, shortcuts, first run. */
(function (BB) {
  'use strict';
  const U = BB.util;
  const { $, $$, el, icon } = U;

  let S, L, C;
  let currentView = 'canvas';

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

  /* ================= views ================= */
  function setView(v) {
    currentView = v;
    const app = $('#app');
    app.classList.toggle('view-canvas', v === 'canvas');
    app.classList.toggle('view-timeline', v === 'timeline');
    $$('.viewtabs .tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === v));
    if (v === 'timeline') { BB.timeline.show(); } else { BB.timeline.hide(); C.render(); }
    S.setPref('view', v);
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
    focusNameField();
    return p;
  }

  function focusNameField() {
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
    focusNameField();
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
  function deleteSelected() {
    const ids = C.selected();
    if (!ids.length) return;
    const names = ids.map(id => (S.person(id) || {}).name).filter(Boolean);
    const backup = { people: ids.map(id => U.deepClone(S.person(id))).filter(Boolean),
      links: S.links().filter(l => ids.includes(l.from) || ids.includes(l.to)).map(U.deepClone) };
    S.removePeople(ids);
    C.select([]);
    U.toast(`Deleted ${ids.length === 1 ? (names[0] || 'that person') : U.plural(ids.length, 'person', 'people')}`, {
      action: 'Undo', onAction: () => { S.undo(); },
    });
    return backup;
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
    focusNameField();
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
    setTimeout(() => C.fit(ids && ids.length ? ids : null), 40);
    U.toast('Tidied into generations', { action: 'Undo', onAction: () => S.undo() });
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
    if (currentView === 'canvas') C.focus(id, { zoom: 0.95 });
    else BB.timeline.draw();
  }
  function showOnCanvas(id) {
    setView('canvas');
    requestAnimationFrame(() => C.focus(id, { zoom: 0.95 }));
  }

  /* ================= menus ================= */
  let openMenu = null;
  /** `#context-menu` is a fixture in the page — empty and hide it, never remove it. */
  function closeMenu() {
    const m = $('#context-menu');
    if (m) { m.hidden = true; m.replaceChildren(); }
    openMenu = null;
  }

  function menu(x, y, items) {
    const host = $('#context-menu');
    host.replaceChildren();
    items.forEach(it => {
      if (it === '-') { host.appendChild(el('div.menu-sep')); return; }
      if (it.head) { host.appendChild(el('div.menu-head', { text: it.head })); return; }
      host.appendChild(el('div.menu-item' + (it.danger ? '.danger' : '') + (it.disabled ? '.is-off' : ''), {
        onclick: () => { closeMenu(); it.run && it.run(); },
      }, [
        it.icon ? icon(it.icon) : el('span', { style: { width: '15px' } }),
        el('span', { text: it.label }),
        it.key ? el('span.k', { text: it.key }) : null,
      ]));
    });
    host.hidden = false;
    const r = host.getBoundingClientRect();
    host.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    host.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    openMenu = host;
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
      { label: C.trace && C.trace.id === id ? 'Stop tracing' : 'Trace this line', icon: 'trace', key: 'T', run: () => toggleTrace(id) },
      { label: 'Centre on this person', icon: 'target', run: () => C.focus(id, { zoom: 0.95 }) },
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
      { label: 'Fit everything on screen', icon: 'fit', key: 'F', run: () => C.fit() },
      { label: 'Select all', icon: 'people', key: '⌘A', run: () => C.select(Object.keys(S.doc.people)) },
      '-',
      { label: S.settings().showGrid ? 'Hide the grid' : 'Show the grid', icon: 'grid', key: 'G', run: toggleGrid },
    ]);
  }

  function linkMenu(x, y, linkId) {
    const link = S.doc.links[linkId];
    if (!link) return;
    const a = S.person(link.from), b = S.person(link.to);
    const label = { parent: 'Parent → child', spouse: 'Spouse', other: 'Other' }[link.type];
    menu(x, y, [
      { head: `${(a && a.name) || '?'} → ${(b && b.name) || '?'} · ${label}` },
      { label: 'Make it a spouse link', disabled: link.type === 'spouse', run: () => retype(linkId, 'spouse') },
      { label: 'Make it a parent link', disabled: link.type === 'parent', run: () => retype(linkId, 'parent') },
      { label: 'Make it another kind of link', disabled: link.type === 'other', run: () => retype(linkId, 'other') },
      '-',
      { label: 'Reverse the direction', run: () => reverse(linkId) },
      { label: 'Delete this link', icon: 'trash', danger: true, run: () => { S.removeLink(linkId); U.toast('Link removed', { action: 'Undo', onAction: () => S.undo() }); } },
    ]);
  }

  function retype(linkId, type) {
    const link = S.doc.links[linkId];
    if (!link) return;
    const { from, to } = link;
    S.removeLink(linkId);
    const res = S.addLink(from, to, type);
    if (!res.ok) { S.undo(); U.toast(linkError(res.reason)); }
  }
  function reverse(linkId) {
    const link = S.doc.links[linkId];
    if (!link) return;
    const { from, to, type } = link;
    S.removeLink(linkId);
    const res = S.addLink(to, from, type);
    if (!res.ok) { S.undo(); U.toast(linkError(res.reason)); }
  }

  function moreMenu(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    const st = S.settings();
    menu(r.left - 130, r.bottom + 6, [
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
      { label: 'Mouse wheel: ' + (S.prefs().wheel === 'pan' ? 'pans' : 'zooms'), icon: 'fit', run: cycleWheel },
      { label: st.showGrid ? 'Hide the grid' : 'Show the grid', icon: 'grid', key: 'G', run: toggleGrid },
      '-',
      { label: 'Keyboard shortcuts', icon: 'help', key: '?', run: helpModal },
      { label: 'About Bible Bubble', icon: 'book', run: aboutModal },
    ]);
  }

  function boardMenu(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    const boards = S.boards();
    menu(r.left - 60, r.bottom + 6, [
      { head: 'This board' },
      { label: 'Rename…', run: renameBoard },
      { label: 'Duplicate', icon: 'copy', run: () => { S.duplicateBoard(); refreshBoards(); U.toast('Board duplicated'); } },
      { label: 'Delete this board', icon: 'trash', danger: true, disabled: boards.length < 2, run: deleteBoard },
      '-',
      { label: 'New empty board', icon: 'plus', run: () => newBoard(false) },
      { label: 'New board from the starter lineage', icon: 'people', run: () => newBoard(true) },
    ]);
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
  function modal(title, bodyKids, footKids, opts) {
    const root = $('#modal-root');
    const o = opts || {};
    const close = () => { root.hidden = true; root.replaceChildren(); };
    const box = el('div.modal', { role: 'dialog', 'aria-modal': 'true' }, [
      el('div.modal-head', {}, [
        el('h3', { text: title }),
        el('button.btn.icon.ghost', { type: 'button', title: 'Close', onclick: close }, [icon('close')]),
      ]),
      el('div.modal-body', {}, bodyKids),
      footKids ? el('div.modal-foot', {}, footKids) : null,
    ]);
    root.replaceChildren(box);
    root.hidden = false;
    root.onclick = (e) => { if (e.target === root && !o.sticky) close(); };
    if (o.onOpen) requestAnimationFrame(() => o.onOpen(box, close));
    return close;
  }

  function helpModal() {
    const groups = [
      ['Canvas', [
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
        ['1 / 2', 'Canvas / timeline'],
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
      if (U.fold(p.notes).includes(f)) return 18;
      return 0;
    };

    const paint = () => {
      const f = U.fold(input.value.trim());
      if (!f) { box.hidden = true; return; }
      results = S.people()
        .map(p => ({ p, s: score(p, f) }))
        .filter(r => r.s > 0)
        .sort((a, b) => b.s - a.s || (a.p.name || '').localeCompare(b.p.name || ''))
        .slice(0, 12);
      active = 0;
      box.hidden = false;
      if (!results.length) { box.replaceChildren(el('div.sr-empty', { text: 'Nobody matches “' + input.value.trim() + '”.' })); return; }
      box.replaceChildren(...results.map((r, i) => {
        const p = r.p;
        const st = S.settings();
        const sub = [p.role, p.era, U.formatSpan(p.birth, p.death, { mode: 'era', anchor: st.anchor, approx: p.approx })].filter(Boolean).join(' · ');
        return el('div.sr-item' + (i === 0 ? '.is-active' : ''), {
          onclick: () => go(p.id),
          onmouseenter: () => { active = i; paintActive(); },
        }, [
          el('span.sr-swatch', { style: { background: `var(--c-${U.colorOf(p.color)})` } }),
          el('span.sr-name', { text: p.name || 'Unnamed' }),
          el('span.sr-sub', { text: sub }),
          i === 0 ? el('span.sr-kbd', { text: '↵' }) : null,
        ]);
      }));
    };
    const paintActive = () => $$('.sr-item', box).forEach((r, i) => r.classList.toggle('is-active', i === active));
    const go = (id) => {
      box.hidden = true;
      input.blur();
      C.select([id]);
      if (currentView === 'canvas') C.focus(id, { zoom: 0.95 });
      else BB.timeline.draw();
    };

    input.addEventListener('input', U.debounce(paint, 90));
    input.addEventListener('focus', () => { if (input.value.trim()) paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; box.hidden = true; input.blur(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = U.clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, results.length - 1);
        paintActive();
      } else if (e.key === 'Enter' && results[active]) { e.preventDefault(); go(results[active].p.id); }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap')) box.hidden = true;
    });
  }

  /* ================= keyboard ================= */
  function initKeys() {
    window.addEventListener('keydown', (e) => {
      const typing = C.isTyping(e.target);
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === 'Escape') {
        if (!$('#modal-root').hidden) { $('#modal-root').hidden = true; $('#modal-root').replaceChildren(); return; }
        closeMenu();
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
      else if (k.toLowerCase() === 'f') { e.preventDefault(); C.fit(C.selected().length > 1 ? C.selected() : null); }
      else if (k.toLowerCase() === 'l') { e.preventDefault(); autoLayout(C.selected().length > 1 ? C.selected() : null); }
      else if (k.toLowerCase() === 'g') { e.preventDefault(); toggleGrid(); }
      else if (k.toLowerCase() === 't') {
        const sel = C.selected();
        if (sel.length === 1) toggleTrace(sel[0]);
        else if (C.trace) C.setTrace(null);
      }
      else if (k === '1') setView('canvas');
      else if (k === '2') setView('timeline');
      else if (k === '+' || k === '=') C.zoomAt(1.25);
      else if (k === '-' || k === '_') C.zoomAt(1 / 1.25);
      else if (k === '0') C.home();
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
        'Start from <strong>Adam</strong> with the built-in line down to Jesus — 105 people with ages, ' +
        'references and highlights already filled in — or begin with an empty canvas and build your own.' }),
    ], [
      el('button.btn', { type: 'button', text: 'Empty canvas', onclick: () => { close(); S.renameBoard('My lineage'); refreshBoards(); } }),
      el('button.btn.primary', { type: 'button', text: 'Start from Adam', onclick: () => { close(); loadSeedIntoBoard(); } }),
    ], { sticky: true });
  }

  /* ================= boot ================= */
  function init() {
    S = BB.store; L = BB.lineage; C = BB.canvas;
    initTheme();

    const loaded = S.load();
    BB.canvas.init();
    BB.io.init();
    BB.inspector.init();
    BB.timeline.init();
    BB.sidebar.init();

    applyDensity();
    $('#viewport').classList.toggle('show-grid', S.settings().showGrid);
    refreshBoards();
    initSearch();
    initKeys();

    /* toolbar */
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) { if (!e.target.closest('.menu')) closeMenu(); return; }
      const act = btn.dataset.act;
      const run = {
        'add-person': addAtCentre,
        'layout': () => autoLayout(C.selected().length > 1 ? C.selected() : null),
        'fit': () => C.fit(),
        'theme': toggleTheme,
        'more': () => moreMenu(btn),
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
    C.on('select', () => { if (currentView === 'timeline') BB.timeline.draw(); });

    /* status bar */
    const paintStatus = () => {
      const st = L.stats(S.doc);
      $('#status-count').textContent =
        `${U.plural(st.people, 'person', 'people')} · ${U.plural(st.links, 'link')} · ${st.generations} generations`;
    };
    S.on('change', paintStatus);
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
    if (savedView === 'timeline') setView('timeline'); else setView('canvas');

    if (loaded.fresh) {
      S.createBoard('My lineage');
      refreshBoards();
      welcome();
    } else if (S.count()) {
      const v = S.doc.view;
      const untouched = !v || (!v.x && !v.y && v.k === 1);
      if (untouched) setTimeout(() => C.home({ animate: false }), 60);
    }
  }

  BB.app = {
    init, quickRelative, pickPerson, duplicatePerson, deleteSelected, autoLayout,
    toggleTrace, revealPerson, showOnCanvas, setView, helpModal, confirmSeed,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.BB);
