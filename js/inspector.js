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
  function personRow(id, opts) {
    const o = opts || {};
    const p = S.person(id);
    if (!p) return null;
    const st = S.settings();
    const meta = U.isNum(p.age) ? p.age + ' yrs'
      : U.formatSpan(p.birth, p.death, { mode: 'era', anchor: st.anchor, approx: p.approx });
    return el('div.rel-item', { title: 'Go to ' + (p.name || 'this person'), onclick: (e) => {
      if (e.target.closest('button')) return;
      C.select([id]); C.focus(id, { zoom: 0.9 });
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
    const others = L.othersOf(p.id);
    const gen = L.generationOf(p.id);
    const descendants = L.descendants(p.id).size;
    const path = L.pathToRoot(p.id);

    /* header */
    const nameInput = boundInput(p, 'name', { placeholder: 'Name', class: 'insp-name-input' });
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
        el('button.btn.icon.ghost.sm', { type: 'button', title: 'Close panel', onclick: () => C.select([]) }, [icon('close')]),
      ]),
      el('div.insp-swatches', {}, U.PALETTE.map(c => el('button.insp-swatch' + (p.color === c.key ? '.is-on' : ''), {
        type: 'button', title: c.label, style: { background: `var(--c-${c.key})` },
        onclick: () => { S.updatePerson(p.id, { color: c.key }, { label: 'color' }); S.seal(); refresh(); },
      }))),
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
      others.length ? relGroup('Other links', others.map(o => o.id), { empty: '' }) : null,
    ]);

    /* lineage */
    const crumbs = el('div.path-crumbs');
    path.forEach((id, i) => {
      if (i) crumbs.appendChild(el('span.crumb-sep', { text: '›' }));
      const q = S.person(id);
      if (id === p.id) crumbs.appendChild(el('strong', { text: q ? q.name : '?' }));
      else crumbs.appendChild(el('a', { text: q ? q.name : '?', onclick: () => { C.select([id]); C.focus(id, { zoom: 0.9 }); } }));
    });

    const lineage = section('Line of descent', [
      path.length > 1 ? crumbs : el('div.rel-none', { text: 'This person has no recorded ancestors — they start a line.' }),
      el('div.stat-grid', { style: { marginTop: '10px' } }, [
        el('div.stat', {}, [el('div.k', { text: 'Generation' }), el('div.v', { text: String(gen + 1) })]),
        el('div.stat', {}, [el('div.k', { text: 'Descendants' }), el('div.v', { text: String(descendants) })]),
        el('div.stat', {}, [el('div.k', { text: 'Children' }), el('div.v', { text: String(kids.length) })]),
        el('div.stat', {}, [el('div.k', { text: 'Age' }), el('div.v', { text: U.isNum(p.age) ? String(p.age) : '—' })]),
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

    host.replaceChildren(head, el('div.insp-body', {}, [identity, years, highlights, notes, rel, lineage]), foot);
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
    const n = S.count();
    host.replaceChildren(el('div.insp-empty', {}, [
      icon('people'),
      el('p', { text: n ? 'Select a bubble to see and edit who they were.' : 'No one on this board yet.' }),
      el('p', { style: { marginTop: '8px', fontSize: '12px' }, text: n ? 'Drag from a bubble’s ↓ handle to add a child.' : 'Double-click the canvas to begin.' }),
    ]));
  }

  function renderMulti(sel) {
    currentId = null;
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
          el('button.btn.mini-add', { type: 'button', text: 'Tidy just these into a lineage', onclick: () => BB.app.autoLayout(sel) }),
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

  function init() {
    S = BB.store; L = BB.lineage; C = BB.canvas;
    host = U.$('#inspector');
    C.on('select', () => render());
    C.on('trace', () => refresh());
    S.on('change', (p) => {
      if (p.reason === 'positions') return;
      if (currentId && !S.person(currentId)) { render(); return; }
      refresh();
    });
    render();
  }

  BB.inspector = { init, render, refresh };
})(window.BB);
