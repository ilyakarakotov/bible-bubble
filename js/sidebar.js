/* Bible Bubble — the side panel: lineage outline and people list. */
(function (BB) {
  'use strict';
  const U = BB.util;
  const { $, el, icon } = U;

  let S, L, C;
  let bodyEl, footEl, filterEl, sortEl;
  let tab = 'outline';
  let filter = '';
  let collapsed = new Set();

  function metaOf(p) {
    const st = S.settings();
    if (U.isNum(p.age)) return p.age + 'y';
    const span = U.formatSpan(p.birth, p.death, { mode: 'era', anchor: st.anchor });
    return span || '';
  }

  const matches = (p) => {
    if (!filter) return true;
    const f = U.fold(filter);
    return U.fold(p.name).includes(f) ||
      p.aka.some(a => U.fold(a).includes(f)) ||
      U.fold(p.role).includes(f) ||
      U.fold(p.era).includes(f) ||
      p.tags.some(t => U.fold(t).includes(f));
  };

  function row(p, depth, hasKids, isOpen, onTwist) {
    const sel = C.selection.has(p.id);
    return el('div.tree-row' + (sel ? '.is-sel' : ''), {
      'data-id': p.id, title: (p.name || 'Unnamed') + (p.role ? ' — ' + p.role : ''),
      onclick: (e) => {
        if (e.target.closest('.tree-twist')) return;
        C.select([p.id]);
        BB.app.revealPerson(p.id);
      },
    }, [
      el('span.tree-twist' + (hasKids ? (isOpen ? '.is-open' : '') : '.is-leaf'), {
        onclick: (e) => { e.stopPropagation(); if (hasKids && onTwist) onTwist(); },
      }, [icon('chev')]),
      el('span.tree-dot', { style: { background: `var(--c-${U.colorOf(p.color)})` } }),
      el('span.tree-name', { text: p.name || 'Unnamed' }),
      el('span.tree-meta', { text: metaOf(p) }),
    ]);
  }

  /* A flat list with capped indentation: a 64-generation line nested in real
     divs pushed names straight off the panel. */
  function renderOutline() {
    const idx = L.index(S.doc);
    const frag = document.createDocumentFragment();
    const drawn = new Set();
    const INDENT = 11, MAX_INDENT = 9;

    // when filtering, keep a branch if it or anything under it matches
    const keep = new Set();
    if (filter) {
      const visit = (id, seen) => {
        if (seen.has(id)) return false;
        seen.add(id);
        const p = S.person(id);
        let any = p ? matches(p) : false;
        (idx.children.get(id) || []).forEach(k => { if (visit(k, seen)) any = true; });
        seen.delete(id);
        if (any) keep.add(id);
        return any;
      };
      idx.roots.forEach(r => visit(r, new Set()));
    }

    const walk = (id, depth) => {
      if (filter && !keep.has(id)) return;
      const p = S.person(id);
      if (!p) return;
      const repeat = drawn.has(id);
      drawn.add(id);
      const kidIds = repeat ? [] : (idx.children.get(id) || []).filter(k => !filter || keep.has(k));
      const open = filter ? true : !collapsed.has(id);
      const r = row(p, depth, kidIds.length > 0, open, () => {
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        render();
      });
      r.style.paddingLeft = (6 + Math.min(depth, MAX_INDENT) * INDENT) + 'px';
      if (repeat) { r.style.opacity = '.55'; r.title = (p.name || 'Unnamed') + ' (already shown above)'; }
      frag.appendChild(r);
      if (open) kidIds.forEach(k => walk(k, depth + 1));
    };
    idx.roots.forEach(r => walk(r, 0));

    if (!frag.childNodes.length) {
      bodyEl.replaceChildren(el('div.side-note', { text: filter ? 'Nobody matches \u201C' + filter + '\u201D.' : 'No people yet. Double-click the canvas to add the first one.' }));
      return;
    }
    bodyEl.replaceChildren(frag);
  }

  function renderList() {
    const idx = L.index(S.doc);
    let people = S.people().filter(matches);
    const sort = sortEl.value;
    const cmp = {
      name: (a, b) => (a.name || '').localeCompare(b.name || ''),
      birth: (a, b) => (U.isNum(a.birth) ? a.birth : Infinity) - (U.isNum(b.birth) ? b.birth : Infinity),
      age: (a, b) => (U.isNum(b.age) ? b.age : -1) - (U.isNum(a.age) ? a.age : -1),
      recent: (a, b) => b.updated - a.updated,
      lineage: (a, b) => (idx.depth.get(a.id) || 0) - (idx.depth.get(b.id) || 0) ||
        ((U.isNum(a.birth) ? a.birth : Infinity) - (U.isNum(b.birth) ? b.birth : Infinity)) ||
        (a.name || '').localeCompare(b.name || ''),
    }[sort] || ((a, b) => 0);
    people.sort(cmp);

    if (!people.length) {
      bodyEl.replaceChildren(el('div.side-note', { text: filter ? 'Nobody matches “' + filter + '”.' : 'No people yet.' }));
      return;
    }
    bodyEl.replaceChildren(...people.map(p => {
      const r = row(p, 0, false, false, null);
      r.querySelector('.tree-twist').remove();
      return r;
    }));
  }

  function renderFoot() {
    const st = L.stats(S.doc);
    const bits = [
      U.plural(st.people, 'person', 'people'),
      U.plural(st.links, 'link'),
      st.bonds ? U.plural(st.bonds, 'connection') : null,
      st.generations ? st.generations + ' generations' : null,
    ].filter(Boolean);
    footEl.replaceChildren(el('span', { text: bits.join(' · ') }));
  }

  function render() {
    if (!bodyEl) return;
    if (tab === 'outline') renderOutline(); else renderList();
    renderFoot();
  }

  function init() {
    S = BB.store; L = BB.lineage; C = BB.canvas;
    bodyEl = $('#side-body');
    footEl = $('#side-foot');
    filterEl = $('#side-filter-input');
    sortEl = $('#side-sort');

    U.$$('.side-tab').forEach(b => b.addEventListener('click', () => {
      tab = b.dataset.side;
      U.$$('.side-tab').forEach(x => x.classList.toggle('is-active', x === b));
      $('#side-sort').style.display = tab === 'list' ? '' : 'none';
      render();
    }));
    $('#side-sort').style.display = 'none';

    filterEl.addEventListener('input', U.debounce(() => { filter = filterEl.value.trim(); render(); }, 120));
    sortEl.addEventListener('change', render);

    S.on('change', (p) => { if (p.reason !== 'positions') render(); });
    C.on('select', render);
    render();
  }

  BB.sidebar = {
    init, render,
    collapseAll: () => { collapsed = new Set(S.people().map(p => p.id)); render(); },
    expandAll: () => { collapsed = new Set(); render(); },
  };
})(window.BB);
