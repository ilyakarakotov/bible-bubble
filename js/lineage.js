/* Bible Bubble — genealogy graph: relations, generations, layout. */
(function (BB) {
  'use strict';
  const U = BB.util;

  /* ---------- relation index (memoised per store revision) ---------- */
  let cache = { rev: -1, doc: null, idx: null };

  /* Heavier answers computed on demand and thrown away with their index. */
  const derived = new WeakMap();
  function derivedOf(idx) {
    let d = derived.get(idx);
    if (!d) derived.set(idx, d = { comps: null, rank: null, paths: new Map() });
    return d;
  }

  function build(doc) {
    const parents = new Map();   // childId  -> [parentId]
    const children = new Map();  // parentId -> [childId]
    const spouses = new Map();   // id -> [id]
    const bonds = new Map();     // id -> [{id, linkId, kind, label, note, dir}]
    const adj = new Map();       // id -> [{id, via, kind, linkId, label}] — one entry per link
    const ids = Object.keys(doc.people);
    ids.forEach(id => {
      parents.set(id, []); children.set(id, []); spouses.set(id, []);
      bonds.set(id, []); adj.set(id, []);
    });

    // The undirected walk every graph query rides on: built once, here, so no
    // query ever has to walk doc.links again.
    const edgeSeen = new Map();                   // id -> Set(linkId)
    const touch = (a, b, via, kind, l) => {
      let seen = edgeSeen.get(a);
      if (!seen) edgeSeen.set(a, seen = new Set());
      if (seen.has(l.id)) return;                 // one link is one neighbour
      seen.add(l.id);
      adj.get(a).push({ id: b, via, kind, linkId: l.id, label: l.label || '' });
    };

    Object.values(doc.links).forEach(l => {
      if (!doc.people[l.from] || !doc.people[l.to]) return;
      if (l.type === 'parent') {
        children.get(l.from).push(l.to);
        parents.get(l.to).push(l.from);
        touch(l.to, l.from, 'parent', '', l);
        touch(l.from, l.to, 'child', '', l);
      } else if (l.type === 'spouse') {
        spouses.get(l.from).push(l.to);
        spouses.get(l.to).push(l.from);
        touch(l.from, l.to, 'spouse', '', l);
        touch(l.to, l.from, 'spouse', '', l);
      } else {
        const kind = BB.model.bondKind(l.kind).id;
        const note = l.note || '';
        bonds.get(l.from).push({ id: l.to, linkId: l.id, kind, label: l.label || '', note, dir: 'out' });
        bonds.get(l.to).push({ id: l.from, linkId: l.id, kind, label: l.label || '', note, dir: 'in' });
        touch(l.from, l.to, 'bond', kind, l);
        touch(l.to, l.from, 'bond', kind, l);
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

    // `other` is the old name for `bonds` — same map, so both readings agree.
    return { parents, children, spouses, bonds, other: bonds, adj, roots, depth, ids, byOrder };
  }

  function index(doc) {
    const S = BB.store;
    const d = doc || S.doc;
    if (cache.rev === S.rev && cache.doc === d && cache.idx) return cache.idx;
    const idx = build(d);
    cache = { rev: S.rev, doc: d, idx };
    return idx;
  }

  /* ---------- queries ---------- */
  const parentsOf  = (id, doc) => (index(doc).parents.get(id) || []).slice();
  const childrenOf = (id, doc) => (index(doc).children.get(id) || []).slice();
  const spousesOf  = (id, doc) => Array.from(new Set(index(doc).spouses.get(id) || []));
  const bondsOf    = (id, doc) => (index(doc).bonds.get(id) || []).slice();
  const othersOf   = bondsOf;                      // the name this had before bonds
  const generationOf = (id, doc) => index(doc).depth.get(id) || 0;

  /** Every link touching this person, once per link. */
  const neighbours = (id, doc) => (index(doc).adj.get(id) || []).slice();

  /** How many links of each sort this person has. */
  function degree(id, doc) {
    const list = index(doc).adj.get(id) || [];
    const out = { parents: 0, children: 0, spouses: 0, bonds: 0, total: list.length };
    for (let i = 0; i < list.length; i++) {
      const via = list[i].via;
      if (via === 'parent') out.parents++;
      else if (via === 'child') out.children++;
      else if (via === 'spouse') out.spouses++;
      else out.bonds++;
    }
    return out;
  }

  /* ---------- how far apart ---------- */
  const VIA_NAMES = { parent: 'parent', child: 'child', spouse: 'spouse', bond: 'bond', other: 'bond' };

  /** opts.via -> a Set of relations we may walk, or null for all of them. */
  function viaFilter(via) {
    if (via === null || via === undefined) return null;
    // Anything iterable: an array, a Set, one bare name. instanceof would miss a
    // Set made in another frame.
    const iterable = typeof via !== 'string' && via[Symbol.iterator];
    const list = iterable ? Array.from(via) : [via];
    const set = new Set();
    list.forEach(v => { const name = VIA_NAMES[v]; if (name) set.add(name); });
    return set;
  }

  function walkBack(prev, a, b) {
    const steps = [];
    let cur = b;
    while (cur !== a) {
      const back = prev.get(cur), e = back.edge;
      steps.push({ from: back.from, to: cur, via: e.via, kind: e.kind || '', linkId: e.linkId, label: e.label || '' });
      cur = back.from;
    }
    steps.reverse();
    return { hops: steps.length, ids: [a].concat(steps.map(s => s.to)), steps };
  }

  function breadthFirst(idx, a, b, allow) {
    if (a === b) return { hops: 0, ids: [a], steps: [] };
    const prev = new Map([[a, null]]);
    const queue = [a];
    for (let head = 0; head < queue.length; head++) {
      const list = idx.adj.get(queue[head]) || [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (allow && !allow.has(e.via)) continue;
        if (prev.has(e.id)) continue;
        prev.set(e.id, { from: queue[head], edge: e });
        if (e.id === b) return walkBack(prev, a, b);
        queue.push(e.id);
      }
    }
    return null;
  }

  /**
   * Fewest hops between two people over the undirected union of every link —
   * "how many connections apart are these two". opts.via limits which relations
   * may be walked. Null when there is no route at all.
   */
  function connectionPath(a, b, doc, opts) {
    const idx = index(doc);
    if (!idx.adj.has(a) || !idx.adj.has(b)) return null;      // not on this board
    const allow = viaFilter((opts || {}).via);
    const memo = derivedOf(idx).paths;
    const key = a + '>' + b + '|' + (allow ? Array.from(allow).sort().join(',') : '*');
    let found;
    if (memo.has(key)) found = memo.get(key);
    else { found = breadthFirst(idx, a, b, allow); memo.set(key, found); }
    return found ? { hops: found.hops, ids: found.ids.slice(), steps: found.steps.slice() } : null;
  }

  /** Islands of people joined by any link, largest first. */
  function componentList(idx) {
    const d = derivedOf(idx);
    if (d.comps) return d.comps;
    const seen = new Set(), out = [];
    idx.ids.forEach(start => {
      if (seen.has(start)) return;
      seen.add(start);
      const group = [start];
      for (let head = 0; head < group.length; head++) {
        const list = idx.adj.get(group[head]) || [];
        for (let i = 0; i < list.length; i++) {
          const next = list[i].id;
          if (seen.has(next)) continue;
          seen.add(next); group.push(next);
        }
      }
      out.push(group);
    });
    out.sort((x, y) => y.length - x.length);
    d.comps = out;
    return out;
  }
  const components = (doc) => componentList(index(doc)).map(g => g.slice());

  /** People by how many links they have, most first, then by name. */
  function ranking(doc, limit) {
    const src = doc || BB.store.doc;
    const idx = index(src);
    const d = derivedOf(idx);
    if (!d.rank) {
      const nameOf = (id) => (src.people[id] && src.people[id].name) || '';
      const rows = idx.ids.map(id => ({ id, degree: (idx.adj.get(id) || []).length }));
      rows.sort((x, y) => (y.degree - x.degree) || nameOf(x.id).localeCompare(nameOf(y.id)));
      d.rank = rows;
    }
    const n = (limit === null || limit === undefined || limit < 0) ? d.rank.length : limit;
    return d.rank.slice(0, n).map(r => ({ id: r.id, degree: r.degree }));
  }

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
    const d = doc || BB.store.doc;
    const idx = index(d);
    const people = Object.values(d.people);
    const links = Object.values(d.links);
    const dated = people.filter(p => U.isNum(p.birth) || U.isNum(p.death));
    const ages = people.filter(p => U.isNum(p.age)).map(p => p.age);
    const gens = idx.ids.length ? Math.max(...idx.ids.map(id => idx.depth.get(id) || 0)) + 1 : 0;
    return {
      people: people.length,
      links: links.length,
      bonds: links.filter(l => l.type === 'other').length,
      components: componentList(idx).length,
      topConnected: ranking(d, 5),
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
    index, parentsOf, childrenOf, spousesOf, othersOf, bondsOf, generationOf,
    ancestors, descendants, pathToRoot, lineBetween, layout, outline, stats,
    degree, neighbours, connectionPath, components, ranking,
  };
})(window.BB);
