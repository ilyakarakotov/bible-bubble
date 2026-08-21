/* Bible Bubble — genealogy graph: relations, generations, layout. */
(function (BB) {
  'use strict';
  const U = BB.util;

  /* ---------- relation index (memoised per store revision) ---------- */
  let cache = { rev: -1, idx: null };

  function build(doc) {
    const parents = new Map();   // childId  -> [parentId]
    const children = new Map();  // parentId -> [childId]
    const spouses = new Map();   // id -> [id]
    const other = new Map();     // id -> [{id, label}]
    const ids = Object.keys(doc.people);
    ids.forEach(id => { parents.set(id, []); children.set(id, []); spouses.set(id, []); other.set(id, []); });

    Object.values(doc.links).forEach(l => {
      if (!doc.people[l.from] || !doc.people[l.to]) return;
      if (l.type === 'parent') {
        children.get(l.from).push(l.to);
        parents.get(l.to).push(l.from);
      } else if (l.type === 'spouse') {
        spouses.get(l.from).push(l.to);
        spouses.get(l.to).push(l.from);
      } else {
        other.get(l.from).push({ id: l.to, label: l.label, dir: 'out' });
        other.get(l.to).push({ id: l.from, label: l.label, dir: 'in' });
      }
    });

    // A stable reading order: fathers before mothers, older children first.
    const byOrder = (a, b) => {
      const pa = doc.people[a], pb = doc.people[b];
      if (!pa || !pb) return 0;
      const ba = U.isNum(pa.birth) ? pa.birth : Infinity;
      const bb = U.isNum(pb.birth) ? pb.birth : Infinity;
      if (ba !== bb) return ba - bb;
      return (pa.name || '').localeCompare(pb.name || '');
    };
    children.forEach(list => list.sort(byOrder));
    parents.forEach(list => list.sort((a, b) => {
      const sa = doc.people[a].sex === 'm' ? 0 : 1;
      const sb = doc.people[b].sex === 'm' ? 0 : 1;
      return sa !== sb ? sa - sb : byOrder(a, b);
    }));

    const roots = ids.filter(id => parents.get(id).length === 0).sort(byOrder);

    /* generation depth — longest chain from any root, cycle-safe */
    const depth = new Map();
    const state = new Map();
    function calcDepth(id) {
      if (depth.has(id)) return depth.get(id);
      if (state.get(id) === 1) return 0;           // defensive: a cycle slipped in
      state.set(id, 1);
      const ps = parents.get(id) || [];
      let d = 0;
      for (const p of ps) d = Math.max(d, calcDepth(p) + 1);
      state.set(id, 2);
      depth.set(id, d);
      return d;
    }
    ids.forEach(calcDepth);

    return { parents, children, spouses, other, roots, depth, ids, byOrder };
  }

  function index(doc) {
    const S = BB.store;
    if (cache.rev === S.rev && cache.idx) return cache.idx;
    const idx = build(doc || S.doc);
    cache = { rev: S.rev, idx };
    return idx;
  }

  /* ---------- queries ---------- */
  const parentsOf  = (id, doc) => (index(doc).parents.get(id) || []).slice();
  const childrenOf = (id, doc) => (index(doc).children.get(id) || []).slice();
  const spousesOf  = (id, doc) => Array.from(new Set(index(doc).spouses.get(id) || []));
  const othersOf   = (id, doc) => (index(doc).other.get(id) || []).slice();
  const generationOf = (id, doc) => index(doc).depth.get(id) || 0;

  /** Every ancestor of `id` (not including `id`). */
  function ancestors(id, doc) {
    const idx = index(doc), out = new Set(), stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const p of idx.parents.get(cur) || []) {
        if (out.has(p)) continue;
        out.add(p); stack.push(p);
      }
    }
    return out;
  }

  /** Every descendant of `id` (not including `id`). */
  function descendants(id, doc) {
    const idx = index(doc), out = new Set(), stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const c of idx.children.get(cur) || []) {
        if (out.has(c)) continue;
        out.add(c); stack.push(c);
      }
    }
    return out;
  }

  /**
   * The line of descent down to `id`, root first, father-preferred.
   * This is the "who came from who" chain shown in the inspector.
   */
  function pathToRoot(id, doc) {
    const idx = index(doc);
    const chain = [id];
    const seen = new Set([id]);
    let cur = id;
    while (true) {
      const ps = idx.parents.get(cur) || [];
      const next = ps.find(p => !seen.has(p));
      if (!next) break;
      chain.push(next); seen.add(next); cur = next;
    }
    return chain.reverse();
  }

  /** Direct line between two people, if one descends from the other. */
  function lineBetween(fromId, toId, doc) {
    const idx = index(doc);
    const prev = new Map([[fromId, null]]);
    const queue = [fromId];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === toId) {
        const out = [];
        for (let n = toId; n != null; n = prev.get(n)) out.push(n);
        return out.reverse();
      }
      for (const c of idx.children.get(cur) || []) {
        if (prev.has(c)) continue;
        prev.set(c, cur); queue.push(c);
      }
    }
    return null;
  }

  /* ---------- layout ----------
     A tidy generational chart: one row per generation, children centred beneath
     their parent, and in-married spouses parked alongside their partner.        */
  function layout(doc, opts) {
    const o = opts || {};
    const idx = index(doc);
    const sizes = o.sizes || {};
    const gapX = o.gapX == null ? 34 : o.gapX;
    const gapY = o.gapY == null ? 74 : o.gapY;
    const defW = o.defaultW || 188;
    const defH = o.defaultH || 96;
    const sizeOf = (id) => sizes[id] || { w: defW, h: defH };

    const ids = o.ids ? o.ids.filter(id => doc.people[id]) : idx.ids.slice();
    if (!ids.length) return {};
    const inSet = new Set(ids);

    /* 1. in-married spouses ride along with their partner instead of taking a slot */
    const satelliteOf = new Map();      // satelliteId -> anchorId
    const satellites = new Map();       // anchorId -> [satelliteId]
    const isSat = (id) => satelliteOf.has(id);

    ids.forEach(id => {
      if (idx.parents.get(id).length) return;                    // has parents: belongs to the tree
      const partners = spousesOf(id, doc).filter(s => inSet.has(s));
      if (!partners.length) return;
      // Anchor on a partner that is itself rooted in the tree. If neither has
      // parents (Adam and Eve), the one that sorts first anchors, so the line
      // reads from the elder rather than from whoever was iterated first.
      const anchor = partners.find(s => idx.parents.get(s).length && !isSat(s)) ||
                     partners.find(s => !isSat(s) && !satellites.has(id) && idx.byOrder(s, id) < 0);
      if (!anchor || anchor === id || isSat(anchor)) return;
      satelliteOf.set(id, anchor);
      if (!satellites.has(anchor)) satellites.set(anchor, []);
      satellites.get(anchor).push(id);
    });

    /* a satellite must never be some child's only route into the tree */
    let changedPass = true;
    while (changedPass) {
      changedPass = false;
      for (const satId of Array.from(satelliteOf.keys())) {
        const kids = idx.children.get(satId) || [];
        const orphaning = kids.some(k => inSet.has(k) &&
          !(idx.parents.get(k) || []).some(p => inSet.has(p) && p !== satId && !isSat(p)));
        if (orphaning) {
          const anchor = satelliteOf.get(satId);
          satelliteOf.delete(satId);
          const list = satellites.get(anchor) || [];
          const at = list.indexOf(satId);
          if (at >= 0) list.splice(at, 1);
          changedPass = true;
        }
      }
    }

    /* 2. primary parent per node → a forest we can walk */
    const primaryKids = new Map();
    ids.forEach(id => primaryKids.set(id, []));
    const roots = [];
    ids.forEach(id => {
      if (isSat(id)) return;
      const ps = (idx.parents.get(id) || []).filter(p => inSet.has(p) && !isSat(p));
      if (!ps.length) roots.push(id);
      else primaryKids.get(ps[0]).push(id);
    });
    roots.sort(idx.byOrder);
    primaryKids.forEach(list => list.sort(idx.byOrder));

    /* 3. rows: depth in the primary forest (keeps parents strictly above children) */
    const rowOf = new Map();
    (function assignRows() {
      const walk = (id, d, guard) => {
        if (guard.has(id)) return;
        guard.add(id);
        rowOf.set(id, Math.max(rowOf.get(id) || 0, d));
        (primaryKids.get(id) || []).forEach(k => walk(k, d + 1, guard));
        guard.delete(id);
      };
      roots.forEach(r => walk(r, 0, new Set()));
      ids.forEach(id => { if (!rowOf.has(id) && !isSat(id)) rowOf.set(id, 0); });
      satelliteOf.forEach((anchor, sat) => rowOf.set(sat, rowOf.get(anchor) || 0));
    })();

    /* 4. horizontal placement, pixel cursors per row */
    const pos = {};
    const rowCursor = new Map();
    const cursor = (r) => (rowCursor.has(r) ? rowCursor.get(r) : -Infinity);

    const subtreeNodes = (id, acc) => {
      acc.push(id);
      (satellites.get(id) || []).forEach(s => acc.push(s));
      (primaryKids.get(id) || []).forEach(k => subtreeNodes(k, acc));
      return acc;
    };

    function place(id) {
      const kids = primaryKids.get(id) || [];
      kids.forEach(place);
      const row = rowOf.get(id);
      const w = sizeOf(id).w;
      let x;
      if (!kids.length) {
        x = cursor(row) === -Infinity ? 0 : cursor(row);
      } else {
        const first = pos[kids[0]], last = pos[kids[kids.length - 1]];
        const kidsSpanStart = first.x;
        const kidsSpanEnd = last.x + sizeOf(kids[kids.length - 1]).w;
        // centre over the children, counting our own satellites as part of our width
        const ownWidth = w + (satellites.get(id) || []).reduce((s, sid) => s + sizeOf(sid).w + gapX, 0);
        x = (kidsSpanStart + kidsSpanEnd) / 2 - ownWidth / 2;
        const min = cursor(row);
        if (min !== -Infinity && x < min) {
          // no room: slide this whole subtree right instead of overlapping a sibling
          const shift = min - x;
          subtreeNodes(id, []).forEach(n => { if (pos[n]) pos[n].x += shift; });
          x = min;
          subtreeNodes(id, []).forEach(n => {
            if (!pos[n]) return;
            const r = rowOf.get(n);
            rowCursor.set(r, Math.max(cursor(r) === -Infinity ? -Infinity : cursor(r), pos[n].x + sizeOf(n).w + gapX));
          });
        }
      }
      pos[id] = { x, y: 0 };
      let cur = x + w + gapX;
      (satellites.get(id) || []).forEach(sid => {
        pos[sid] = { x: cur, y: 0 };
        cur += sizeOf(sid).w + gapX;
      });
      rowCursor.set(row, cur);
    }
    roots.forEach(place);
    ids.forEach(id => { if (!pos[id]) pos[id] = { x: 0, y: 0 }; });   // safety net

    /* 5. vertical placement — each row is as tall as its tallest bubble */
    const rowHeights = new Map();
    ids.forEach(id => {
      const r = rowOf.get(id) || 0;
      rowHeights.set(r, Math.max(rowHeights.get(r) || 0, sizeOf(id).h));
    });
    const rowY = new Map();
    const maxRow = Math.max(0, ...Array.from(rowHeights.keys()));
    let y = 0;
    for (let r = 0; r <= maxRow; r++) {
      rowY.set(r, y);
      y += (rowHeights.get(r) || defH) + gapY;
    }
    ids.forEach(id => { pos[id].y = rowY.get(rowOf.get(id) || 0) || 0; });

    /* 6. normalise so the chart starts at the origin offset */
    const originX = o.originX == null ? 0 : o.originX;
    const originY = o.originY == null ? 0 : o.originY;
    const minX = Math.min(...ids.map(id => pos[id].x));
    const minY = Math.min(...ids.map(id => pos[id].y));
    ids.forEach(id => {
      pos[id].x = Math.round(pos[id].x - minX + originX);
      pos[id].y = Math.round(pos[id].y - minY + originY);
    });
    return pos;
  }

  /* ---------- reading order for the sidebar tree ---------- */
  function outline(doc) {
    const idx = index(doc);
    const seen = new Set();
    const build = (id) => {
      if (seen.has(id)) return { id, kids: [], repeat: true };
      seen.add(id);
      const kids = (idx.children.get(id) || []).map(build);
      return { id, kids, repeat: false };
    };
    return idx.roots.map(build);
  }

  /* ---------- board statistics ---------- */
  function stats(doc) {
    const idx = index(doc);
    const people = Object.values(doc.people);
    const dated = people.filter(p => U.isNum(p.birth) || U.isNum(p.death));
    const ages = people.filter(p => U.isNum(p.age)).map(p => p.age);
    const gens = idx.ids.length ? Math.max(...idx.ids.map(id => idx.depth.get(id) || 0)) + 1 : 0;
    return {
      people: people.length,
      links: Object.keys(doc.links).length,
      generations: gens,
      dated: dated.length,
      roots: idx.roots.length,
      oldest: ages.length ? Math.max(...ages) : null,
      span: dated.length ? {
        min: Math.min(...dated.map(p => U.isNum(p.birth) ? p.birth : p.death)),
        max: Math.max(...dated.map(p => U.isNum(p.death) ? p.death : p.birth)),
      } : null,
    };
  }

  BB.lineage = {
    index, parentsOf, childrenOf, spousesOf, othersOf, generationOf,
    ancestors, descendants, pathToRoot, lineBetween, layout, outline, stats,
  };
})(window.BB);
