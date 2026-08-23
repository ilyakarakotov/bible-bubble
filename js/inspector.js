/* Bible Bubble — the detail panel: everything you can record about a person. */
(function (BB) {
  'use strict';
  const U = BB.util;
  const { el, icon } = U;

  let host, S, L, C;
  let currentId = null;

  const ERA_SUGGESTIONS = ['Before the Flood', 'After the Flood', 'The patriarchs', 'The twelve tribes',
    'Egypt and the Exodus', 'The judges', 'The united kingdom', 'Kings of Judah', 'Kings of Israel',
    'Exile and return', 'Between the testaments', 'The Gospel', 'The early church'];

  const PHONE = window.matchMedia('(max-width: 700px)');
  const isPhone = () => PHONE.matches;

  /**
   * On a phone this panel is a sheet over the canvas rather than a full-height
   * column, and its seven sections run to several screens of scrolling in it.
   * There they split into four pages, so the part you came for is a tap away
   * rather than a hunt, and the page each person was left on is remembered.
   */
  const PAGES = [
    { id: 'about', label: 'About', of: ['swatches', 'identity', 'years', 'highlights'] },
    { id: 'family', label: 'Family', of: ['rel', 'lineage'] },
    { id: 'links', label: 'Connections', of: ['connections'] },
    { id: 'notes', label: 'Notes', of: ['notes'] },
  ];
  const COLUMN = ['identity', 'years', 'highlights', 'notes', 'rel', 'connections', 'lineage'];

  const pageById = new Map();      // person -> the page they were reading
  const scrollBy = new Map();      // person|page -> how far down they had got
  let shown = { id: null, page: null };

  const pageFor = (id) => (pageById.get(id) || 'about');
  const scrollKey = (id, page) => id + '|' + page;

  /* ---------- small builders ---------- */
  function field(label, control, hint) {
    return el('div.field', {}, [label ? el('label', { text: label }) : null, control, hint ? el('div.hint', { text: hint }) : null]);
  }

  function section(title, kids, headAction) {
    return el('div.insp-sect', {}, [
      el('h4', {}, [title, headAction || null]),
      ...kids.filter(Boolean),
    ]);
  }

  /** A text input that writes through to the store as you type. */
  function boundInput(p, key, opts) {
    const o = opts || {};
    const input = el(o.textarea ? 'textarea' : 'input', {
      type: o.type || 'text',
      value: o.value != null ? o.value : (p[key] == null ? '' : p[key]),
      placeholder: o.placeholder || '',
      rows: o.rows,
      spellcheck: o.spellcheck === false ? 'false' : 'true',
      class: o.class,
    });
    if (o.textarea) input.value = o.value != null ? o.value : (p[key] || '');
    const commit = () => {
      const raw = input.value;
      const val = o.parse ? o.parse(raw) : raw;
      if (val === undefined) return;
      S.updatePerson(p.id, { [key]: val }, { label: 'field:' + p.id + ':' + key, changed: o.changed });
    };
    input.addEventListener('input', commit);
    input.addEventListener('blur', () => { S.seal(); if (o.reformat) refresh(true); });
    if (o.textarea) autoGrow(input);
    return input;
  }

  function autoGrow(ta) {
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(460, ta.scrollHeight + 2) + 'px'; };
    ta.addEventListener('input', grow);
    requestAnimationFrame(grow);
  }

  /** Chip-style editor for arrays of short strings (references, tags). */
  function tagBox(p, key, placeholder, cls) {
    const box = el('div.tagbox');
    const input = el('input', { type: 'text', placeholder, spellcheck: 'false' });
    const paint = () => {
      box.replaceChildren(
        ...p[key].map((t, i) => el('span.tg' + (cls ? '.' + cls : ''), {}, [
          t,
          el('button', {
            type: 'button', text: '×', title: 'Remove',
            onclick: () => {
              const next = p[key].slice(); next.splice(i, 1);
              S.updatePerson(p.id, { [key]: next }, { label: 'tags:' + p.id + ':' + key });
              S.seal(); paint();
            },
          }),
        ])),
        input,
      );
    };
    const add = () => {
      const parts = input.value.split(/[;\n]/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return;
      S.updatePerson(p.id, { [key]: p[key].concat(parts) }, { label: 'tags-add:' + p.id });
      S.seal();
      input.value = '';
      paint();
      input.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || (e.key === ',' && key === 'tags')) { e.preventDefault(); add(); }
      else if (e.key === 'Backspace' && !input.value && p[key].length) {
        const next = p[key].slice(); next.pop();
        S.updatePerson(p.id, { [key]: next }, { label: 'tags:' + p.id });
        paint(); input.focus();
      }
    });
    input.addEventListener('blur', add);
    paint();
    return box;
  }

  /* ---------- relations ---------- */
  /**
   * Follow a link to someone else. On a phone the sheet stays open and lands on
   * the same page it was on, so walking a family or a chain of connections is
   * one tap per step rather than a tap and a scroll.
   */
  function goTo(id) {
    if (isPhone() && currentId && S.person(id)) pageById.set(id, pageFor(currentId));
    C.select([id]);
    C.focus(id, { zoom: 0.9 });
  }

  function personRow(id, opts) {
    const o = opts || {};
    const p = S.person(id);
    if (!p) return null;
    const st = S.settings();
    const meta = U.isNum(p.age) ? p.age + ' yrs'
      : U.formatSpan(p.birth, p.death, { mode: 'era', anchor: st.anchor, approx: p.approx });
    return el('div.rel-item', { title: 'Go to ' + (p.name || 'this person'), onclick: (e) => {
      if (e.target.closest('button')) return;
      goTo(id);
    } }, [
      el('span.tree-dot', { style: { background: `var(--c-${U.colorOf(p.color)})` } }),
      el('span.rel-name', { text: p.name || 'Unnamed' }),
      meta ? el('span.rel-meta', { text: meta }) : null,
      o.onRemove ? el('button.btn.icon.ghost.sm', {
        type: 'button', title: o.removeTitle || 'Remove this link',
        onclick: (e) => { e.stopPropagation(); o.onRemove(); },
      }, [icon('close')]) : null,
    ]);
  }

  function relGroup(label, ids, opts) {
    const o = opts || {};
    return el('div.rel-group', {}, [
      el('div.rel-label', {}, [label, el('span.count', { text: String(ids.length) })]),
      ...(ids.length
        ? ids.map(id => personRow(id, {
            removeTitle: o.removeTitle,
            onRemove: o.onRemove ? () => o.onRemove(id) : null,
          })).filter(Boolean)
        : [el('div.rel-none', { text: o.empty || 'None recorded' })]),
      o.actions || null,
    ]);
  }

  /* ---------- connections ---------- */
  /** Kind first, in the order the vocabulary lists them, then by name. */
  function sortBonds(list) {
    const order = new Map(BB.model.BOND_KINDS.map((k, i) => [k.id, i]));
    const rank = (b) => (order.has(b.kind) ? order.get(b.kind) : order.size);
    const named = (b) => { const q = S.person(b.id); return U.fold(q ? q.name : ''); };
    return list.slice().sort((a, b) => rank(a) - rank(b) || named(a).localeCompare(named(b)));
  }

  /** One connection, read from this person's end: "Mentor of — Elisha". */
  function bondRow(b) {
    const q = S.person(b.id);
    if (!q) return null;
    const kind = BB.model.bondKind(b.kind);
    const phrase = b.dir === 'out' ? kind.out : kind.in;
    const who = q.name || 'this person';
    return el('div.rel-item.rel-bond', {
      title: 'Go to ' + who + (b.note ? ' — ' + b.note : ''),
      style: {
        '--bond': `var(--c-${kind.hue}, var(--c-stone))`,
        '--bond-bg': `var(--c-${kind.hue}-bg, var(--c-stone-bg))`,
        '--bond-ink': `var(--c-${kind.hue}-ink, var(--c-stone-ink))`,
      },
      onclick: (e) => {
        if (e.target.closest('button')) return;
        goTo(b.id);
      },
    }, [
      el('div.bond-main', {}, [
        el('div.bond-head', {}, [
          el('span.bond-kind', { text: phrase }),
          el('span.rel-name', { text: q.name || 'Unnamed' }),
        ]),
        b.label ? el('div.bond-label', { text: b.label }) : null,
      ]),
      el('button.btn.icon.ghost.sm', {
        type: 'button', title: 'Edit this connection',
        onclick: (e) => { e.stopPropagation(); BB.app.editBond(b.linkId); },
      }, [icon('link')]),
      el('button.btn.icon.ghost.sm', {
        type: 'button', title: 'Remove this connection',
        onclick: (e) => { e.stopPropagation(); S.removeLink(b.linkId); refresh(true); },
      }, [icon('close')]),
    ]);
  }

  /* ---------- the panel ---------- */
  function render() {
    const sel = C.selected();
    host.hidden = false;

    if (sel.length === 0) { renderEmpty(); return; }
    if (sel.length > 1) { renderMulti(sel); return; }

    const p = S.person(sel[0]);
    if (!p) { renderEmpty(); return; }
    currentId = p.id;

    const st = S.settings();
    const idx = L.index(S.doc);
    const parents = L.parentsOf(p.id);
    const kids = L.childrenOf(p.id);
    const spouses = L.spousesOf(p.id);
    const bonds = sortBonds(L.bondsOf(p.id));
    const deg = L.degree(p.id);
    const gen = L.generationOf(p.id);
    const descendants = L.descendants(p.id).size;
    const path = L.pathToRoot(p.id);

    /* header */
    const phone = isPhone();
    const page = phone ? pageFor(p.id) : null;
    const nameInput = boundInput(p, 'name', { placeholder: 'Name', class: 'insp-name-input' });
    const swatches = el('div.insp-swatches', {}, U.PALETTE.map(c => el('button.insp-swatch' + (p.color === c.key ? '.is-on' : ''), {
      type: 'button', title: c.label, style: { background: `var(--c-${c.key})` },
      onclick: () => { S.updatePerson(p.id, { color: c.key }, { label: 'color' }); S.seal(); refresh(); },
    })));
    const counts = { family: parents.length + spouses.length + kids.length, links: bonds.length };
    const strip = el('div.insp-pages', { role: 'tablist' }, PAGES.map(pg => el('button.insp-page' + (pg.id === page ? '.is-on' : ''), {
      type: 'button', role: 'tab', 'aria-selected': String(pg.id === page), 'aria-controls': 'insp-page',
      onclick: () => { pageById.set(p.id, pg.id); render(); },
    }, [pg.label, counts[pg.id] ? el('span.count', { text: String(counts[pg.id]) }) : null])));

    const head = el('div.insp-head', {}, [
      el('div.insp-head-top', {}, [
        el('div.insp-title', {}, [
          nameInput,
          el('div.insp-sub', {}, [
            el('span', { text: 'Generation ' + (gen + 1) }),
            el('span', { text: '·' }),
            el('span', { text: U.plural(descendants, 'descendant') }),
            p.era ? el('span', { text: '·' }) : null,
            p.era ? el('span', { text: p.era }) : null,
          ]),
        ]),
        el('button.btn.icon.ghost.sm', { type: 'button', title: 'Centre on canvas', onclick: () => C.focus(p.id, { zoom: 0.95 }) }, [icon('target')]),
        // On a phone the cross dismisses the sheet: the selection is what the
        // canvas, the bottom bar and the peek card are all showing, and losing
        // it just to put the sheet away is never what the tap meant.
        el('button.btn.icon.ghost.sm', {
          type: 'button', title: phone ? 'Close' : 'Close panel',
          onclick: () => { if (phone && BB.app) BB.app.setPanel('details', false); else C.select([]); },
        }, [icon('close')]),
      ]),
      phone ? strip : swatches,
    ]);

    /* identity */
    const sexSeg = el('div.seg', {}, [
      ['m', 'Male'], ['f', 'Female'], ['', 'Unset'],
    ].map(([v, lbl]) => el('button' + (p.sex === v ? '.is-on' : ''), {
      type: 'button', text: lbl,
      onclick: () => { S.updatePerson(p.id, { sex: v }, { label: 'sex' }); S.seal(); refresh(); },
    })));

    const eraList = el('datalist', { id: 'era-list' }, ERA_SUGGESTIONS.map(e => el('option', { value: e })));
    const eraInput = boundInput(p, 'era', { placeholder: 'e.g. The patriarchs' });
    eraInput.setAttribute('list', 'era-list');

    const identity = section('Who they were', [
      field('Role or title', boundInput(p, 'role', { placeholder: 'e.g. King of Judah' })),
      field('Also known as', tagBox(p, 'aka', 'Add another name…')),
      el('div.field-row', {}, [field('Sex', sexSeg), field('Era', eraInput)]),
      eraList,
    ]);

    /* years */
    const yearHint = st.yearMode === 'am'
      ? 'Years count from creation (AM).'
      : `Type “1656”, “1010 BC” or “AD 30”. Anchor: AM 0 = ${st.anchor} BC.`;
    const birthIn = boundInput(p, 'birth', {
      placeholder: 'Born', value: yearValue(p.birth, p), reformat: true, changed: 'birth',
      parse: (raw) => raw.trim() === '' ? null : parseOr(raw, st.anchor),
    });
    const deathIn = boundInput(p, 'death', {
      placeholder: 'Died', value: yearValue(p.death, p), reformat: true, changed: 'death',
      parse: (raw) => raw.trim() === '' ? null : parseOr(raw, st.anchor),
    });
    const ageIn = boundInput(p, 'age', {
      placeholder: 'Age', type: 'text', value: p.age == null ? '' : String(p.age), changed: 'age',
      parse: (raw) => { const t = raw.trim(); if (!t) return null; const n = parseInt(t, 10); return isFinite(n) ? n : undefined; },
    });

    const lifeBits = [];
    if (U.isNum(p.birth)) lifeBits.push('born ' + U.formatYear(p.birth, { mode: 'both', anchor: st.anchor, approx: p.approx }));
    if (U.isNum(p.death)) lifeBits.push('died ' + U.formatYear(p.death, { mode: 'both', anchor: st.anchor, approx: p.approx }));

    const years = section('When they lived', [
      el('div.field-row', {}, [field('Born', birthIn), field('Died', deathIn), field('Age', ageIn)]),
      el('label.tl-toggle', {}, [
        el('input', {
          type: 'checkbox', checked: p.approx || null,
          onchange: (e) => { S.updatePerson(p.id, { approx: e.target.checked }, { label: 'approx' }); S.seal(); refresh(); },
        }),
        el('span', { text: 'Dates are approximate' }),
      ]),
      lifeBits.length ? el('div.hint', { text: lifeBits.join(' · ') }) : el('div.hint', { text: yearHint }),
    ]);

    /* highlights */
    const hlItems = p.highlights.map((h, i) => {
      const ta = el('textarea', { rows: 2, value: h, placeholder: 'What they did…' });
      ta.value = h;
      ta.addEventListener('input', () => {
        const next = p.highlights.slice(); next[i] = ta.value;
        S.updatePerson(p.id, { highlights: next }, { label: 'hl:' + p.id + ':' + i });
      });
      ta.addEventListener('blur', () => {
        S.seal();
        if (!ta.value.trim()) removeHighlight(p, i);
      });
      autoGrow(ta);
      return el('div.hl-item', {}, [
        el('span.hl-bullet', { text: '·' }),
        ta,
        el('button.btn.icon.ghost.sm', { type: 'button', title: 'Remove', onclick: () => removeHighlight(p, i) }, [icon('close')]),
      ]);
    });

    const highlights = section('Highlights', [
      ...hlItems,
      el('button.btn.mini-add', {
        type: 'button', text: '+ Add a highlight',
        onclick: () => {
          S.updatePerson(p.id, { highlights: p.highlights.concat(['']) }, { label: 'hl-add' });
          S.seal(); refresh();
          const boxes = host.querySelectorAll('.hl-item textarea');
          if (boxes.length) boxes[boxes.length - 1].focus();
        },
      }),
    ]);

    /* references + notes */
    const notesTa = boundInput(p, 'notes', { textarea: true, rows: 4, placeholder: 'Anything you want to remember…' });
    const notes = section('References and notes', [
      field('Scripture', tagBox(p, 'refs', 'e.g. Gen 5:21–24', 'ref')),
      field('Notes', notesTa),
      field('Tags', tagBox(p, 'tags', 'Add a tag…')),
    ]);

    /* relations */
    const rel = section('Family', [
      relGroup('Parents', parents, {
        empty: 'No parents recorded',
        removeTitle: 'Unlink this parent',
        onRemove: (pid) => { S.unlinkPair(pid, p.id, 'parent'); refresh(true); },
        actions: el('div.quick-rel', {}, [
          el('button.btn.sm', { type: 'button', text: '+ Add parent', onclick: () => BB.app.quickRelative(p.id, 'parent') }),
          el('button.btn.sm.ghost', { type: 'button', text: 'Link existing', onclick: () => BB.app.pickPerson(p.id, 'parent') }),
        ]),
      }),
      relGroup('Spouses', spouses, {
        empty: 'No spouse recorded',
        removeTitle: 'Unlink this spouse',
        onRemove: (sid) => { S.unlinkPair(p.id, sid, 'spouse'); refresh(true); },
        actions: el('div.quick-rel', {}, [
          el('button.btn.sm', { type: 'button', text: '+ Add spouse', onclick: () => BB.app.quickRelative(p.id, 'spouse') }),
          el('button.btn.sm.ghost', { type: 'button', text: 'Link existing', onclick: () => BB.app.pickPerson(p.id, 'spouse') }),
        ]),
      }),
      relGroup('Children', kids, {
        empty: 'No children recorded',
        removeTitle: 'Unlink this child',
        onRemove: (cid) => { S.unlinkPair(p.id, cid, 'parent'); refresh(true); },
        actions: el('div.quick-rel', {}, [
          el('button.btn.sm', { type: 'button', text: '+ Add son', onclick: () => BB.app.quickRelative(p.id, 'child', 'm') }),
          el('button.btn.sm', { type: 'button', text: '+ Add daughter', onclick: () => BB.app.quickRelative(p.id, 'child', 'f') }),
          el('button.btn.sm.ghost', { type: 'button', text: 'Link existing', onclick: () => BB.app.pickPerson(p.id, 'child') }),
        ]),
      }),
    ]);

    /* connections */
    const connections = section('Connections', [
      bonds.length
        ? el('div.rel-bonds', {}, bonds.map(b => bondRow(b)).filter(Boolean))
        : el('div.rel-none', { text: 'No connections recorded — link them to the people they met, taught, fought or followed.' }),
      el('button.btn.mini-add.bond-add', {
        type: 'button', text: '+ Add a connection',
        onclick: () => BB.app.addBond(p.id),
      }),
    ], bonds.length ? el('span.count', { text: String(bonds.length) }) : null);

    /* lineage */
    const crumbs = el('div.path-crumbs');
    path.forEach((id, i) => {
      // Spaces around the chevron: without one the whole line of descent is a
      // single unbreakable run and a long chain scrolls the panel sideways.
      if (i) crumbs.appendChild(el('span.crumb-sep', { text: ' › ' }));
      const q = S.person(id);
      if (id === p.id) crumbs.appendChild(el('strong', { text: q ? q.name : '?' }));
      else crumbs.appendChild(el('a', { text: q ? q.name : '?', onclick: () => goTo(id) }));
    });

    const lineage = section('Line of descent', [
      path.length > 1 ? crumbs : el('div.rel-none', { text: 'This person has no recorded ancestors — they start a line.' }),
      el('div.stat-grid', { style: { marginTop: '10px' } }, [
        el('div.stat', {}, [el('div.k', { text: 'Generation' }), el('div.v', { text: String(gen + 1) })]),
        el('div.stat', {}, [el('div.k', { text: 'Descendants' }), el('div.v', { text: String(descendants) })]),
        el('div.stat', {}, [el('div.k', { text: 'Children' }), el('div.v', { text: String(kids.length) })]),
        el('div.stat', {}, [el('div.k', { text: 'Age' }), el('div.v', { text: U.isNum(p.age) ? String(p.age) : '—' })]),
        el('div.stat.wide', {}, [el('div.k', { text: 'Connections' }), el('div.v', { text: String(deg.bonds) })]),
      ]),
      el('button.btn.sm', {
        type: 'button', style: { marginTop: '9px', width: '100%', justifyContent: 'center' },
        text: C.trace && C.trace.id === p.id ? 'Stop tracing this line' : 'Trace this line',
        onclick: () => BB.app.toggleTrace(p.id),
      }),
    ]);

    const foot = el('div.insp-foot', {}, [
      el('button.btn.sm', { type: 'button', title: 'Duplicate', onclick: () => BB.app.duplicatePerson(p.id) }, [icon('copy'), el('span', { text: 'Duplicate' })]),
      el('div', { style: { flex: '1' } }),
      el('button.btn.sm.danger', { type: 'button', title: 'Delete (⌫)', onclick: () => BB.app.deleteSelected() }, [icon('trash'), el('span', { text: 'Delete' })]),
    ]);

    const parts = { swatches, identity, years, highlights, notes, rel, connections, lineage };
    const order = phone ? (PAGES.find(pg => pg.id === page) || PAGES[0]).of : COLUMN;
    const body = el('div.insp-body' + (phone ? '.is-paged' : ''),
      phone ? { id: 'insp-page', role: 'tabpanel' } : {}, order.map(k => parts[k]));

    // A redraw must not throw the reader back to the top: hold the scroll where
    // they left it, per person and per page.
    const same = shown.id === p.id && shown.page === page;
    const back = same ? host.scrollTop : (scrollBy.get(scrollKey(p.id, page)) || 0);
    host.replaceChildren(head, body, foot);
    shown = { id: p.id, page };
    if (back) host.scrollTop = back;
  }

  function removeHighlight(p, i) {
    const next = p.highlights.slice();
    next.splice(i, 1);
    S.updatePerson(p.id, { highlights: next }, { label: 'hl-del' });
    S.seal();
    refresh();
  }

  const yearValue = (v, p) => (U.isNum(v) ? displayYear(v, p) : '');
  function displayYear(v, p) {
    const st = S.settings();
    if (st.yearMode === 'am') return String(v);
    if (st.yearMode === 'era') return U.amToEra(v, st.anchor);
    // 'both': show whichever form reads more naturally for this person
    return p && p.approx ? U.amToEra(v, st.anchor) : String(v);
  }
  function parseOr(raw, anchor) {
    const v = U.parseYear(raw, anchor);
    return v === null ? undefined : v;    // undefined = leave unchanged (mid-typing)
  }

  function renderEmpty() {
    currentId = null;
    shown = { id: null, page: null };
    const n = S.count();
    host.replaceChildren(el('div.insp-empty', {}, [
      icon('people'),
      el('p', { text: n ? 'Select a bubble to see and edit who they were.' : 'No one on this board yet.' }),
      el('p', { style: { marginTop: '8px', fontSize: '12px' }, text: n ? 'Drag from a bubble’s ↓ handle to add a child.' : 'Double-click the canvas to begin.' }),
    ]));
  }

  function renderMulti(sel) {
    currentId = null;
    shown = { id: null, page: null };
    host.replaceChildren(
      el('div.insp-head', {}, [
        el('div.insp-head-top', {}, [
          el('div.insp-title', {}, [
            el('div', { class: 'insp-name-input', text: sel.length + ' selected', style: { fontFamily: 'var(--serif)', fontSize: '18px', fontWeight: '600' } }),
          ]),
          el('button.btn.icon.ghost.sm', { type: 'button', title: 'Clear selection', onclick: () => C.select([]) }, [icon('close')]),
        ]),
      ]),
      el('div.insp-body.multi-note', {}, [
        section('Colour them all', [
          el('div.insp-swatches', {}, U.PALETTE.map(c => el('button.insp-swatch', {
            type: 'button', title: c.label, style: { background: `var(--c-${c.key})` },
            onclick: () => {
              S.batch('bulk-color', () => sel.forEach(id => S.updatePerson(id, { color: c.key }, { label: 'bulk-color' })));
              S.seal();
            },
          }))),
        ]),
        section('Actions', [
          sel.length === 2
            ? el('button.btn.mini-add', { type: 'button', text: 'Connect these two', onclick: () => BB.app.addBond(sel[0], sel[1]) })
            : null,
          el('button.btn.mini-add', { type: 'button', style: sel.length === 2 ? { marginTop: '6px' } : null, text: 'Tidy just these into a lineage', onclick: () => BB.app.autoLayout(sel) }),
          el('button.btn.mini-add', { type: 'button', style: { marginTop: '6px' }, text: 'Fit these on screen', onclick: () => C.fit(sel) }),
          el('button.btn.mini-add.danger', { type: 'button', style: { marginTop: '6px' }, text: 'Delete ' + U.plural(sel.length, 'person', 'people'), onclick: () => BB.app.deleteSelected() }),
        ]),
      ]),
    );
  }

  /**
   * Re-render, unless the user is mid-edit inside the panel.
   * Only a focused *text field* blocks the redraw — a focused button must not,
   * or clicking "add a highlight" (or a colour, or the sex toggle) would change
   * the data without ever showing the result.
   */
  function refresh(force) {
    if (!host) return;
    const a = document.activeElement;
    const typing = a && host.contains(a) &&
      (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
    if (!force && typing) return;
    render();
  }

  /**
   * A soft keyboard covers the bottom of the screen and this sheet is anchored
   * there, so the field being typed in ends up underneath it. Lift the sheet by
   * however much the keyboard takes — the stylesheet shrinks it to match — and
   * keep the focused field clear of the sheet's own head and foot.
   */
  function watchKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;                       // no way to know: leave the sheet alone
    const app = U.$('#app');
    const apply = () => {
      const over = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const typing = document.activeElement && host.contains(document.activeElement);
      const on = isPhone() && over > 90 && typing && app && app.classList.contains('panel-details');
      document.documentElement.style.setProperty('--insp-kb', (on ? Math.round(over) : 0) + 'px');
      if (on) keepFieldInView();
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    host.addEventListener('focusin', () => setTimeout(apply, 260));
    host.addEventListener('focusout', () => setTimeout(apply, 60));
  }

  function keepFieldInView() {
    const a = document.activeElement;
    if (!a || !host.contains(a)) return;
    const box = host.getBoundingClientRect();
    const head = host.querySelector('.insp-head');
    const foot = host.querySelector('.insp-foot');
    const top = (head ? head.getBoundingClientRect().bottom : box.top) + 6;
    const bottom = (foot ? foot.getBoundingClientRect().top : box.bottom) - 6;
    const r = a.getBoundingClientRect();
    if (r.bottom > bottom) host.scrollTop += r.bottom - bottom;
    else if (r.top < top) host.scrollTop -= top - r.top;
  }

  function init() {
    S = BB.store; L = BB.lineage; C = BB.canvas;
    host = U.$('#inspector');
    host.addEventListener('scroll', () => {
      if (shown.id) scrollBy.set(scrollKey(shown.id, shown.page), host.scrollTop);
    }, { passive: true });
    // Crossing the phone breakpoint changes the panel from a column to pages.
    const onWidth = () => { shown = { id: null, page: null }; refresh(true); };
    if (PHONE.addEventListener) PHONE.addEventListener('change', onWidth);
    else if (PHONE.addListener) PHONE.addListener(onWidth);
    watchKeyboard();
    C.on('select', () => render());
    C.on('trace', () => refresh());
    S.on('change', (p) => {
      if (p.reason === 'positions') return;
      if (currentId && !S.person(currentId)) { render(); return; }
      refresh();
    });
    render();
  }

  /** Open the sheet on a given page — 'about', 'family', 'links' or 'notes'. */
  function show(id, page) {
    if (!S.person(id)) return;
    if (page && PAGES.some(pg => pg.id === page)) pageById.set(id, page);
    if (C.selected().length !== 1 || C.selected()[0] !== id) C.select([id]);
    else render();
    if (isPhone() && BB.app) BB.app.setPanel('details', true);
  }

  BB.inspector = { init, render, refresh, show };
})(window.BB);
