/* Bible Bubble — the infinite canvas: viewport, bubbles, links. */
(function (BB) {
  'use strict';
  const U = BB.util;
  const { $, el, svgEl } = U;

  const MIN_K = 0.08, MAX_K = 3;
  const GRID = 24;
  const DRAG_SLOP = 4;
  const LIFT_MS = 380;            // hold this long on a bubble to pick it up
  const MENU_MS = 480;            // hold this long on empty canvas or a link for its menu
  const TAP_SLOP = 7;             // how far outside a bubble a fingertip still counts
  const FLING_MIN = 0.09;         // px/ms below which a lift is a stop, not a throw

  const phoneQuery = window.matchMedia('(max-width: 700px)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let viewport, world, nodesHost, edgesG, draftSvg, draftPath, marqueeEl, emptyState;
  let S, L;

  const view = { x: 0, y: 0, k: 1 };
  const nodeEls = new Map();      // personId -> element
  const edgeEls = new Map();      // linkId   -> <g>
  const sizeCache = new Map();    // personId -> {w,h}
  let selection = new Set();
  let selectedLink = null;
  let trace = null;               // {id, up:Set, down:Set}
  let spaceDown = false;
  let listeners = new Map();

  const emit = (evt, payload) => (listeners.get(evt) || []).forEach(fn => fn(payload));
  const on = (evt, fn) => {
    if (!listeners.has(evt)) listeners.set(evt, []);
    listeners.get(evt).push(fn);
  };

  /* ---------- coordinate helpers ---------- */
  const toWorld = (sx, sy) => {
    const r = viewport.getBoundingClientRect();
    return { x: (sx - r.left - view.x) / view.k, y: (sy - r.top - view.y) / view.k };
  };
  const toScreen = (wx, wy) => ({ x: wx * view.k + view.x, y: wy * view.k + view.y });

  function sizeOf(id) {
    const cached = sizeCache.get(id);
    if (cached) return cached;
    const node = nodeEls.get(id);
    const s = node
      ? { w: node.offsetWidth || 188, h: node.offsetHeight || 96 }
      : { w: 188, h: 96 };
    sizeCache.set(id, s);
    return s;
  }
  const rectOf = (p) => { const s = sizeOf(p.id); return { x: p.x, y: p.y, w: s.w, h: s.h }; };

  /* ---------- viewport ---------- */
  const applyView = U.rafThrottle(() => {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    const g = GRID * view.k;
    viewport.style.setProperty('--grid-size', g + 'px');
    viewport.style.setProperty('--grid-x', (view.x % g) + 'px');
    viewport.style.setProperty('--grid-y', (view.y % g) + 'px');
    // A phone screen is a third the width: bubbles turn to grey mush sooner, so
    // the point at which they shed their detail comes sooner too.
    viewport.classList.toggle('zoom-far', view.k < (phoneQuery.matches ? 0.62 : 0.5));
    drawMinimap();
    emit('view', view);
  });

  function setView(v, opts) {
    const o = opts || {};
    view.k = U.clamp(v.k == null ? view.k : v.k, MIN_K, MAX_K);
    view.x = v.x == null ? view.x : v.x;
    view.y = v.y == null ? view.y : v.y;
    applyView();
    if (!o.transient) saveView();
  }
  const saveView = U.debounce(() => S.setView({ x: view.x, y: view.y, k: view.k }), 700);

  function zoomAt(factor, cx, cy) {
    const r = viewport.getBoundingClientRect();
    const px = cx == null ? r.width / 2 : cx - r.left;
    const py = cy == null ? r.height / 2 : cy - r.top;
    const k = U.clamp(view.k * factor, MIN_K, MAX_K);
    const scale = k / view.k;
    setView({ k, x: px - (px - view.x) * scale, y: py - (py - view.y) * scale });
  }

  let animHandle = null;
  function animateTo(target, ms) {
    cancelAnimationFrame(animHandle);
    stopGlide();
    const from = { x: view.x, y: view.y, k: view.k };
    const dur = ms == null ? 320 : ms;
    if (!dur) { setView(target); return; }
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const t = U.clamp((now - t0) / dur, 0, 1);
      const e = ease(t);
      setView({
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        k: from.k + (target.k - from.k) * e,
      }, { transient: t < 1 });
      if (t < 1) animHandle = requestAnimationFrame(step);
    };
    animHandle = requestAnimationFrame(step);
  }

  /** Bounding box of the given people (or all of them) in world space. */
  function boundsOf(ids) {
    const list = (ids && ids.length ? ids : Object.keys(S.doc.people))
      .map(id => S.doc.people[id]).filter(Boolean);
    if (!list.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    list.forEach(p => {
      const r = rectOf(p);
      x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
      x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
    });
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function fit(ids, opts) {
    const o = opts || {};
    const b = boundsOf(ids);
    if (!b) return;
    const r = viewport.getBoundingClientRect();
    const pad = o.pad == null ? 70 : o.pad;
    const k = U.clamp(Math.min((r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1)),
      MIN_K, o.maxK == null ? 1.1 : o.maxK);
    animateTo({
      k,
      x: r.width / 2 - (b.x + b.w / 2) * k,
      y: r.height / 2 - (b.y + b.h / 2) * k,
    }, o.animate === false ? 0 : 380);
  }

  /** Centre one person, optionally zooming in to a comfortable reading scale. */
  function focus(id, opts) {
    const o = opts || {};
    const p = S.doc.people[id];
    if (!p) return;
    const r = viewport.getBoundingClientRect();
    const rect = rectOf(p);
    const k = o.zoom === false ? view.k : Math.max(view.k, o.zoom || 0.85);
    animateTo({
      k,
      x: r.width / 2 - (rect.x + rect.w / 2) * k,
      y: r.height / 2 - (rect.y + rect.h / 2) * k,
    }, o.animate === false ? 0 : 360);
    if (o.flash !== false) flash(id);
  }

  /**
   * Land at the head of the line: a long genealogy is far taller than it is wide,
   * so fitting it all just zooms to an unreadable sliver. Start at the first root.
   */
  function home(opts) {
    const o = opts || {};
    const idx = L.index(S.doc);
    const rootId = (o.id && S.doc.people[o.id]) ? o.id : idx.roots[0];
    if (!rootId) { fit(null, o); return; }
    const p = S.doc.people[rootId];
    const r = viewport.getBoundingClientRect();
    const rect = rectOf(p);
    // A readable scale, not a fit: the widest row of a genealogy is usually far
    // below the head of the line, and fitting to it makes the text unreadable.
    const k = o.zoom || 0.9;
    animateTo({
      k,
      x: r.width / 2 - (rect.x + rect.w / 2) * k,
      y: 96 - rect.y * k,
    }, o.animate === false ? 0 : 420);
    return rootId;
  }

  function flash(id) {
    const node = nodeEls.get(id);
    if (!node) return;
    node.classList.remove('is-hit');
    void node.offsetWidth;
    node.classList.add('is-hit');
    setTimeout(() => node.classList.remove('is-hit'), 1200);
  }

  /* ---------- selection ---------- */
  function select(ids, opts) {
    const o = opts || {};
    const next = new Set(o.add ? selection : []);
    (Array.isArray(ids) ? ids : ids == null ? [] : [ids]).forEach(id => {
      if (o.toggle && next.has(id)) next.delete(id); else next.add(id);
    });
    selection = next;
    selectedLink = null;
    paintSelection();
    emit('select', Array.from(selection));
  }
  const selected = () => Array.from(selection);

  function paintSelection() {
    nodeEls.forEach((node, id) => node.classList.toggle('is-sel', selection.has(id)));
    edgeEls.forEach((g, id) => g.classList.toggle('is-sel', selectedLink === id));
  }

  function selectLink(id) {
    selectedLink = id;
    selection = new Set();
    paintSelection();
    emit('select', []);
  }

  /* ---------- trace ---------- */
  function setTrace(id) {
    if (!id) { trace = null; paintTrace(); emit('trace', null); return; }
    trace = { id, up: L.ancestors(id, S.doc), down: L.descendants(id, S.doc) };
    paintTrace();
    emit('trace', trace);
  }

  function paintTrace() {
    const on = !!trace;
    viewport.classList.toggle('is-tracing', on);
    const inTrace = (id) => on && (id === trace.id || trace.up.has(id) || trace.down.has(id));
    nodeEls.forEach((node, id) => {
      node.classList.toggle('is-dim', on && !inTrace(id));
      node.classList.toggle('is-lit', on && inTrace(id));
    });
    edgeEls.forEach((g) => {
      const from = g.dataset.from, to = g.dataset.to;
      const lit = on && inTrace(from) && inTrace(to) && g.dataset.type === 'parent';
      g.classList.toggle('is-lit', lit);
      g.classList.toggle('is-dim', on && !lit);
    });
  }

  /* ---------- rendering ---------- */
  function bubbleContent(p) {
    const st = S.settings();
    const kids = [];
    const nameRow = el('div.b-name', {}, [
      document.createTextNode(p.name || 'Unnamed'),
      p.sex ? el('span.b-sex', { text: p.sex === 'm' ? '♂' : '♀' }) : null,
    ]);
    kids.push(nameRow);
    if (p.role) kids.push(el('div.b-role', { text: p.role }));

    const meta = [];
    if (U.isNum(p.age)) meta.push(el('span.b-tag', { text: p.age + ' yrs' }));
    const span = U.formatSpan(p.birth, p.death, {
      mode: st.yearMode === 'am' ? 'am' : 'era', anchor: st.anchor, approx: p.approx,
    });
    if (span) meta.push(el('span.b-tag.plain', { text: span }));
    if (meta.length) kids.push(el('div.b-meta', {}, meta));

    if (p.highlights.length) {
      const shown = p.highlights.slice(0, 2);
      kids.push(el('div.b-hl', {}, [
        el('ul', {}, shown.map(h => el('li', { text: h.length > 96 ? h.slice(0, 95) + '…' : h }))),
        p.highlights.length > shown.length
          ? el('div.b-more', { text: '+' + (p.highlights.length - shown.length) + ' more' })
          : null,
      ]));
    }
    if (p.refs.length) kids.push(el('div.b-refs', { text: p.refs.slice(0, 2).join(' · ') + (p.refs.length > 2 ? ' …' : '') }));
    if (p.notes && p.notes.trim()) kids.push(el('div.b-note-flag', { title: 'Has notes' }));

    ['top', 'bottom', 'left', 'right'].forEach(side => {
      const titles = { top: 'Add or link a parent', bottom: 'Add or link a child', left: 'Add or link a spouse', right: 'Add or link a spouse' };
      kids.push(el('button.b-handle.h-' + side, {
        'data-handle': side, title: titles[side], type: 'button', tabindex: -1,
        text: side === 'top' ? '↑' : side === 'bottom' ? '↓' : '∞',
      }));
    });
    return kids;
  }

  function styleBubble(node, p) {
    const c = U.colorOf(p.color);
    node.style.setProperty('--b-bg', `var(--c-${c}-bg)`);
    node.style.setProperty('--b-accent', `var(--c-${c})`);
    node.style.setProperty('--b-ink', `var(--c-${c}-ink)`);
    node.style.setProperty('--b-line', `color-mix(in srgb, var(--c-${c}) 38%, transparent)`);
    node.className = 'bubble' + (p.sex ? ' sex-' + p.sex : '');
  }

  function renderNodes() {
    const people = S.doc.people;
    const ids = new Set(Object.keys(people));
    nodeEls.forEach((node, id) => {
      if (!ids.has(id)) { node.remove(); nodeEls.delete(id); sizeCache.delete(id); }
    });
    const idx = L.index(S.doc);
    ids.forEach(id => {
      const p = people[id];
      let node = nodeEls.get(id);
      if (!node) {
        node = el('div.bubble', { 'data-id': id });
        nodesHost.appendChild(node);
        nodeEls.set(id, node);
      }
      const sig = JSON.stringify([p.name, p.role, p.sex, p.color, p.age, p.birth, p.death, p.approx,
        p.highlights, p.refs, !!(p.notes && p.notes.trim()), S.settings().yearMode, S.settings().anchor]);
      if (node.dataset.sig !== sig) {
        node.dataset.sig = sig;
        node.replaceChildren(...bubbleContent(p));
        styleBubble(node, p);
        sizeCache.delete(id);
      } else {
        styleBubble(node, p);
      }
      node.classList.toggle('is-root', (idx.parents.get(id) || []).length === 0);
      node.style.left = p.x + 'px';
      node.style.top = p.y + 'px';
    });
    paintSelection();
    paintPicking();
  }

  function edgeGeometry(link) {
    const a = S.doc.people[link.from], b = S.doc.people[link.to];
    if (!a || !b) return null;
    const ra = rectOf(a), rb = rectOf(b);
    if (link.type === 'parent') {
      const x1 = ra.x + ra.w / 2, y1 = ra.y + ra.h;
      const x2 = rb.x + rb.w / 2, y2 = rb.y;
      const dy = Math.max(26, Math.abs(y2 - y1) * 0.42);
      return {
        d: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`,
        arrow: `M ${x2 - 4.5} ${y2 - 8} L ${x2 + 4.5} ${y2 - 8} L ${x2} ${y2 - 0.5} Z`,
        mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
      };
    }
    if (link.type === 'other') {
      // A bowed arc: reads as a connection rather than lineage, and stays clear
      // of a spouse line running between the same two bubbles.
      const p1 = U.edgeAnchor(ra, rb), p2 = U.edgeAnchor(rb, ra);
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(70, len * 0.18);
      const cx = (p1.x + p2.x) / 2 - (dy / len) * bow;
      const cy = (p1.y + p2.y) / 2 + (dx / len) * bow;
      const geo = {
        d: `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`,
        mid: { x: (p1.x + 2 * cx + p2.x) / 4, y: (p1.y + 2 * cy + p2.y) / 4 },
      };
      if (BB.model.bondKind(link.kind).dir === 'directed') {
        const tl = Math.hypot(p2.x - cx, p2.y - cy) || 1;
        const ux = (p2.x - cx) / tl, uy = (p2.y - cy) / tl;
        const bx = p2.x - ux * 9.5, by = p2.y - uy * 9.5;
        geo.arrow = `M ${bx - uy * 4.4} ${by + ux * 4.4} L ${bx + uy * 4.4} ${by - ux * 4.4} L ${p2.x} ${p2.y} Z`;
      }
      return geo;
    }

    // spouse: shortest side-to-side hop
    const left = ra.x <= rb.x ? ra : rb;
    const right = left === ra ? rb : ra;
    const sameRow = Math.abs(ra.y - rb.y) < Math.max(ra.h, rb.h) * 0.8;
    if (sameRow) {
      const y1 = left.y + left.h / 2, y2 = right.y + right.h / 2;
      const x1 = left.x + left.w, x2 = right.x;
      const mx = (x1 + x2) / 2;
      return { d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, mid: { x: mx, y: (y1 + y2) / 2 } };
    }
    const p1 = U.edgeAnchor(ra, rb), p2 = U.edgeAnchor(rb, ra);
    return { d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
  }

  /** "Elijah mentor of Elisha — took him from the plough (1 Kgs 19:19)". */
  function bondStory(link, kind) {
    const a = S.doc.people[link.from], b = S.doc.people[link.to];
    const names = `${(a && a.name) || 'Someone'} ${kind.out.toLowerCase()} ${(b && b.name) || 'someone'}`;
    const tail = [link.label, link.note].filter(Boolean).join(' · ');
    return tail ? `${names} — ${tail}` : names;
  }

  function renderEdges() {
    const links = S.doc.links;
    const ids = new Set(Object.keys(links));
    edgeEls.forEach((g, id) => { if (!ids.has(id)) { g.remove(); edgeEls.delete(id); } });
    ids.forEach(id => {
      const link = links[id];
      const geo = edgeGeometry(link);
      if (!geo) return;
      let g = edgeEls.get(id);
      if (!g) {
        g = svgEl('g', { class: 'edge' });
        g.appendChild(svgEl('path', { class: 'edge-hit' }));
        g.appendChild(svgEl('path', { class: 'edge-path' }));
        edgesG.appendChild(g);
        edgeEls.set(id, g);
      }
      const kind = link.type === 'other' ? BB.model.bondKind(link.kind) : null;
      g.setAttribute('class', 'edge type-' + link.type +
        (kind ? ' kind-' + kind.id : '') + (selectedLink === id ? ' is-sel' : ''));
      g.dataset.id = id; g.dataset.from = link.from; g.dataset.to = link.to; g.dataset.type = link.type;
      if (kind) g.style.setProperty('--kind', 'var(--c-' + kind.hue + ')');
      else g.style.removeProperty('--kind');
      const [hit, path] = g.querySelectorAll('path.edge-hit, path.edge-path');
      hit.setAttribute('d', geo.d);
      path.setAttribute('d', geo.d);

      let arrow = g.querySelector('.edge-arrow');
      if (geo.arrow) {
        if (!arrow) { arrow = svgEl('path', { class: 'edge-arrow' }); g.appendChild(arrow); }
        arrow.setAttribute('d', geo.arrow);
      } else if (arrow) arrow.remove();

      // On the canvas a bond wears its kind; the sentence behind it lives in the
      // tooltip and in the inspector, where there is room to read it.
      const caption = kind ? kind.label : link.label;
      let label = g.querySelector('.edge-label');
      if (caption) {
        if (!label) { label = svgEl('text', { class: 'edge-label' }); g.appendChild(label); }
        label.setAttribute('x', geo.mid.x);
        label.setAttribute('y', geo.mid.y - 4);
        label.textContent = caption;
      } else if (label) label.remove();

      let tip = g.querySelector('title');
      const story = kind ? bondStory(link, kind) : '';
      if (story) {
        if (!tip) { tip = svgEl('title'); g.insertBefore(tip, g.firstChild); }
        tip.textContent = story;
      } else if (tip) tip.remove();
    });
    paintTrace();
  }

  const renderEdgesSoon = U.rafThrottle(renderEdges);

  function render() {
    renderNodes();
    renderEdges();
    const count = S.count();
    emptyState.hidden = count > 0;
    drawMinimap();
  }

  /* ---------- minimap ---------- */
  const drawMinimap = U.rafThrottle(() => {
    const cv = $('#minimap-canvas');
    if (!cv || !cv.getContext) return;
    const box = cv.parentElement.getBoundingClientRect();
    if (!box.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(box.width * dpr)) {
      cv.width = Math.round(box.width * dpr);
      cv.height = Math.round(box.height * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, box.width, box.height);
    const b = boundsOf(null);
    const viewRect = $('#minimap-view');
    if (!b) { ctx.restore(); if (viewRect) viewRect.style.display = 'none'; return; }
    const pad = 8;
    const k = Math.min((box.width - pad * 2) / Math.max(b.w, 1), (box.height - pad * 2) / Math.max(b.h, 1));
    const ox = pad + (box.width - pad * 2 - b.w * k) / 2;
    const oy = pad + (box.height - pad * 2 - b.h * k) / 2;
    const mx = (wx) => ox + (wx - b.x) * k;
    const my = (wy) => oy + (wy - b.y) * k;

    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--link').trim() || '#aaa';
    ctx.globalAlpha = 0.5; ctx.lineWidth = 0.6;
    ctx.beginPath();
    Object.values(S.doc.links).forEach(l => {
      const a = S.doc.people[l.from], c = S.doc.people[l.to];
      if (!a || !c) return;
      const ra = rectOf(a), rc = rectOf(c);
      ctx.moveTo(mx(ra.x + ra.w / 2), my(ra.y + ra.h / 2));
      ctx.lineTo(mx(rc.x + rc.w / 2), my(rc.y + rc.h / 2));
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
    Object.values(S.doc.people).forEach(p => {
      const r = rectOf(p);
      ctx.fillStyle = U.colorHex(p.color);
      ctx.globalAlpha = selection.has(p.id) ? 1 : 0.78;
      const w = Math.max(2, r.w * k), h = Math.max(1.6, r.h * k);
      ctx.fillRect(mx(r.x), my(r.y), w, h);
    });
    ctx.restore();

    if (viewRect) {
      const vr = viewport.getBoundingClientRect();
      const tl = { x: -view.x / view.k, y: -view.y / view.k };
      const w = vr.width / view.k, h = vr.height / view.k;
      viewRect.style.display = '';
      viewRect.style.left = mx(tl.x) + 'px';
      viewRect.style.top = my(tl.y) + 'px';
      viewRect.style.width = Math.max(4, w * k) + 'px';
      viewRect.style.height = Math.max(4, h * k) + 'px';
    }
    minimapMap = { b, k, ox, oy };
  });
  let minimapMap = null;

  /* ---------- momentum ---------- */
  /**
   * A flick should coast to a stop. We keep the last handful of samples rather
   * than the final delta, because the frame right before a lift is often a slow
   * one and taking it alone kills the throw.
   */
  let panSamples = [];
  let glide = null;

  function stopGlide() { if (glide) { cancelAnimationFrame(glide.raf); glide = null; } }

  function startGlide() {
    const samples = panSamples;
    panSamples = [];
    if (reduceMotion.matches || samples.length < 2) return;
    const now = performance.now();
    const recent = samples.filter(s => now - s.t < 110);
    if (recent.length < 2) return;
    const a = recent[0], b = recent[recent.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0) return;
    let vx = U.clamp((b.x - a.x) / dt, -4, 4);
    let vy = U.clamp((b.y - a.y) / dt, -4, 4);
    if (Math.hypot(vx, vy) < FLING_MIN) return;
    let last = now;
    const step = (t) => {
      const d = Math.min(34, t - last);
      last = t;
      setView({ x: view.x + vx * d, y: view.y + vy * d }, { transient: true });
      const decay = Math.exp(-d / 260);
      vx *= decay; vy *= decay;
      if (!glide) return;                          // something else took the wheel
      if (Math.hypot(vx, vy) < 0.02) { glide = null; saveView(); return; }
      glide.raf = requestAnimationFrame(step);
    };
    glide = { raf: requestAnimationFrame(step) };
  }

  /* ---------- pointer interaction ---------- */
  let drag = null;
  let longPress = null;      // empty canvas and links have no other route to a menu
  let lift = null;           // hold on a bubble to pick it up
  let picking = null;        // {from} — two-tap linking, the phone's answer to a hairline
  let lastTap = 0, lastTapAt = null, touchDoubleAt = 0;

  const buzz = (ms) => { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (_) {} } };
  /** Capturing a pointer the browser has already let go of throws. */
  const capture = (e) => { try { viewport.setPointerCapture(e.pointerId); } catch (_) {} };

  /**
   * A fingertip covers far more than the one pixel it reports, so a touch that
   * lands just outside a bubble — or beside a link, which is a hairline once the
   * world is scaled down — still counts as a hit. The mouse gets no such help.
   */
  function hitAt(e) {
    const closest = (sel) => (e.target && e.target.closest ? e.target.closest(sel) : null);
    const hit = { handle: closest('.b-handle'), bubble: closest('.bubble'), edge: closest('.edge'), near: false };
    if (e.pointerType !== 'touch' || hit.bubble || hit.edge) return hit;
    const r = TAP_SLOP;
    const ring = [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]];
    let edge = null;
    for (let i = 0; i < ring.length; i++) {
      const n = document.elementFromPoint(e.clientX + ring[i][0], e.clientY + ring[i][1]);
      if (!n || !n.closest) continue;
      const b = n.closest('.bubble');
      if (b) { hit.bubble = b; hit.near = true; return hit; }
      if (!edge) edge = n.closest('.edge');
    }
    if (edge) { hit.edge = edge; hit.near = true; }
    return hit;
  }

  function armLongPress(e, hit) {
    cancelLongPress();
    if (e.pointerType !== 'touch' || picking) return;
    if (hit.bubble) return;                          // a person's menu lives on the peek card now
    const { clientX, clientY } = e;
    const edge = hit.edge;
    longPress = setTimeout(() => {
      longPress = null;
      drag = null;                                   // abandon the pan this would have been
      viewport.classList.remove('is-panning');
      buzz(12);
      emit('context', {
        x: clientX, y: clientY,
        id: null,
        link: edge ? edge.dataset.id : null,
        at: toWorld(clientX, clientY),
      });
    }, MENU_MS);
  }
  function cancelLongPress() {
    if (longPress) { clearTimeout(longPress); longPress = null; }
  }

  /**
   * Pan-first: a finger that lands on someone still drags the canvas, because
   * that is what dragging a map means. Holding still picks the person up.
   */
  function armLift(e, bubble) {
    cancelLift();
    if (e.pointerType !== 'touch' || !bubble || picking) return;
    const id = bubble.dataset.id;
    lift = setTimeout(() => {
      lift = null;
      if (!drag || drag.moved || drag.mode !== 'pan') return;
      pickUp(id);
    }, LIFT_MS);
  }
  function cancelLift() { if (lift) { clearTimeout(lift); lift = null; } }

  function pickUp(id) {
    if (!S.doc.people[id]) return;
    if (!selection.has(id)) select([id]);
    const ids = selection.has(id) ? Array.from(selection) : [id];
    drag = {
      mode: 'move', id, ids, lifted: true,
      sx: drag.sx, sy: drag.sy, moved: false,
      origin: ids.reduce((m, pid) => {
        const p = S.doc.people[pid];
        if (p) m[pid] = { x: p.x, y: p.y };
        return m;
      }, {}),
    };
    viewport.classList.remove('is-panning');
    ids.forEach(pid => {
      const n = nodeEls.get(pid);
      if (n) n.classList.add('is-dragging', 'is-lifted');
    });
    buzz(12);
    emit('lift', { id, ids });
  }

  function onPointerDown(e) {
    if (e.button === 2) return;                       // context menu handles right-click
    stopGlide();
    const hit = hitAt(e);
    const bubble = hit.bubble;
    const start = { sx: e.clientX, sy: e.clientY, moved: false };
    const asPan = () => Object.assign({ mode: 'pan', vx: view.x, vy: view.y }, start);

    // While picking a link target, tapping is the whole gesture — but a drag has
    // to keep panning, or you cannot go and find whoever you meant to link to.
    if (picking) {
      drag = Object.assign(asPan(), { holdId: bubble ? bubble.dataset.id : null, near: hit.near });
      capture(e);
      e.preventDefault();
      return;
    }

    if (hit.handle && bubble) {
      const from = bubble.dataset.id;
      drag = Object.assign({ mode: 'link', from, side: hit.handle.dataset.handle }, start);
      hit.handle.classList.add('is-live');
      drag.handleEl = hit.handle;
      document.getElementById('app').classList.add('is-linking');
      capture(e);
      e.preventDefault();
      return;
    }

    if (bubble && !spaceDown && e.button === 0) {
      const id = bubble.dataset.id;
      if (e.pointerType === 'touch') {
        drag = Object.assign(asPan(), { holdId: id, near: hit.near });
        armLift(e, bubble);
        capture(e);
        e.preventDefault();
        return;
      }
      if (e.shiftKey || e.metaKey || e.ctrlKey) select([id], { add: true, toggle: true });
      else if (!selection.has(id)) select([id]);
      const ids = selection.has(id) ? Array.from(selection) : [id];
      drag = {
        mode: 'move', id, ids, ...start,
        origin: ids.reduce((m, pid) => {
          const p = S.doc.people[pid];
          if (p) m[pid] = { x: p.x, y: p.y };
          return m;
        }, {}),
      };
      ids.forEach(pid => nodeEls.get(pid) && nodeEls.get(pid).classList.add('is-dragging'));
      capture(e);
      e.preventDefault();
      return;
    }

    if (hit.edge && e.button === 0 && !spaceDown) {
      if (e.pointerType !== 'touch') { selectLink(hit.edge.dataset.id); return; }
      armLongPress(e, hit);
      drag = Object.assign(asPan(), { holdEdge: hit.edge.dataset.id, near: hit.near });
      capture(e);
      return;
    }

    // background
    armLongPress(e, hit);
    if (e.button === 1 || spaceDown || !(e.shiftKey)) {
      drag = asPan();
      viewport.classList.add('is-panning');
    } else {
      const w = toWorld(e.clientX, e.clientY);
      drag = { mode: 'marquee', ...start, wx: w.x, wy: w.y, additive: e.metaKey || e.ctrlKey };
      marqueeEl.hidden = false;
    }
    capture(e);
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_SLOP) drag.moved = true;
    if (drag.moved) { cancelLongPress(); cancelLift(); }

    if (drag.mode === 'pan') {
      // A press that landed on a bubble or a link waits for the slop before it
      // pans, so a tap never nudges the canvas out from under itself.
      if (!drag.moved && (drag.holdId || drag.holdEdge)) return;
      if (!drag.wasPan) { drag.wasPan = true; viewport.classList.add('is-panning'); }
      panSamples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      if (panSamples.length > 6) panSamples.shift();
      setView({ x: drag.vx + dx, y: drag.vy + dy }, { transient: true });
    } else if (drag.mode === 'move') {
      const wdx = dx / view.k, wdy = dy / view.k;
      drag.ids.forEach(pid => {
        const o = drag.origin[pid];
        if (!o) return;
        const p = S.doc.people[pid];
        if (!p) return;
        p.x = Math.round(o.x + wdx);
        p.y = Math.round(o.y + wdy);
        const node = nodeEls.get(pid);
        if (node) { node.style.left = p.x + 'px'; node.style.top = p.y + 'px'; }
      });
      renderEdgesSoon();
      drawMinimap();
    } else if (drag.mode === 'marquee') {
      const w = toWorld(e.clientX, e.clientY);
      const a = toScreen(Math.min(drag.wx, w.x), Math.min(drag.wy, w.y));
      const b = toScreen(Math.max(drag.wx, w.x), Math.max(drag.wy, w.y));
      Object.assign(marqueeEl.style, {
        left: a.x + 'px', top: a.y + 'px', width: (b.x - a.x) + 'px', height: (b.y - a.y) + 'px',
      });
      const box = { x: Math.min(drag.wx, w.x), y: Math.min(drag.wy, w.y), w: Math.abs(w.x - drag.wx), h: Math.abs(w.y - drag.wy) };
      const hits = Object.values(S.doc.people).filter(p => U.rectsOverlap(rectOf(p), box)).map(p => p.id);
      selection = new Set(drag.additive ? [...selection, ...hits] : hits);
      paintSelection();
    } else if (drag.mode === 'link') {
      const r = viewport.getBoundingClientRect();
      const from = S.doc.people[drag.from];
      if (!from) return;
      const rect = rectOf(from);
      const anchor = drag.side === 'top' ? { x: rect.x + rect.w / 2, y: rect.y }
        : drag.side === 'bottom' ? { x: rect.x + rect.w / 2, y: rect.y + rect.h }
        : drag.side === 'left' ? { x: rect.x, y: rect.y + rect.h / 2 }
        : { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
      const a = toScreen(anchor.x, anchor.y);
      const bx = e.clientX - r.left, by = e.clientY - r.top;
      const vertical = drag.side === 'top' || drag.side === 'bottom';
      const c1 = vertical ? `${a.x} ${(a.y + by) / 2}` : `${(a.x + bx) / 2} ${a.y}`;
      const c2 = vertical ? `${bx} ${(a.y + by) / 2}` : `${(a.x + bx) / 2} ${by}`;
      draftPath.setAttribute('d', `M ${a.x} ${a.y} C ${c1}, ${c2}, ${bx} ${by}`);
      draftSvg.hidden = false;
      const overEl = document.elementFromPoint(e.clientX, e.clientY);
      const overBubble = overEl && overEl.closest && overEl.closest('.bubble');
      nodeEls.forEach(n => n.classList.remove('is-lit'));
      if (overBubble && overBubble.dataset.id !== drag.from) overBubble.classList.add('is-lit');
    }
  }

  /** A touch that never travelled: select, link, add — never a pan. */
  function tapUp(d, e) {
    if (picking) {
      if (d.holdId && d.holdId !== picking.from) emit('pick-target', { from: picking.from, to: d.holdId });
      else endLinkMode();
      return;
    }
    // A near miss still counts as a hit, but not so much that it swallows the
    // double-tap that adds someone beside an existing bubble.
    if (d.holdId && !d.near) { lastTap = 0; select([d.holdId]); return; }
    if (d.holdEdge && !d.near) { lastTap = 0; selectLink(d.holdEdge); return; }

    if (e.pointerType === 'touch') {
      const now = Date.now();
      const near = lastTapAt && Math.hypot(e.clientX - lastTapAt.x, e.clientY - lastTapAt.y) < 28;
      if (now - lastTap < 320 && near) {
        lastTap = 0;
        touchDoubleAt = now;
        emit('dblclick-empty', toWorld(e.clientX, e.clientY));
        return;
      }
      lastTap = now; lastTapAt = { x: e.clientX, y: e.clientY };
    }
    if (d.holdId) { select([d.holdId]); return; }
    if (d.holdEdge) { selectLink(d.holdEdge); return; }
    if (!e.shiftKey) { select([]); selectedLink = null; paintSelection(); }
  }

  function onPointerUp(e) {
    cancelLongPress();
    cancelLift();
    if (!drag) return;
    const d = drag;
    drag = null;
    viewport.classList.remove('is-panning');
    try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}

    if (d.mode === 'pan') {
      if (!d.moved) tapUp(d, e);
      else if (e.pointerType === 'touch') startGlide();
      saveView();
    } else if (d.mode === 'move') {
      d.ids.forEach(pid => {
        const n = nodeEls.get(pid);
        if (n) n.classList.remove('is-dragging', 'is-lifted');
      });
      if (d.lifted) emit('drop', { id: d.id, ids: d.ids, moved: !!d.moved });
      if (d.moved) {
        const positions = {};
        d.ids.forEach(pid => { const p = S.doc.people[pid]; if (p) positions[pid] = { x: p.x, y: p.y }; });
        // put the pre-drag state on the undo stack, then re-apply
        d.ids.forEach(pid => { const p = S.doc.people[pid]; if (p && d.origin[pid]) { p.x = d.origin[pid].x; p.y = d.origin[pid].y; } });
        S.movePeople(positions, 'drag');
        S.seal();
      }
    } else if (d.mode === 'marquee') {
      marqueeEl.hidden = true;
      emit('select', Array.from(selection));
    } else if (d.mode === 'link') {
      draftSvg.hidden = true;
      if (d.handleEl) d.handleEl.classList.remove('is-live');
      document.getElementById('app').classList.remove('is-linking');
      nodeEls.forEach(n => n.classList.remove('is-lit'));
      paintTrace();
      const overEl = document.elementFromPoint(e.clientX, e.clientY);
      const overBubble = overEl && overEl.closest && overEl.closest('.bubble');
      if (overBubble && overBubble.dataset.id !== d.from) {
        emit('link-drop', { from: d.from, to: overBubble.dataset.id, side: d.side });
      } else {
        const w = toWorld(e.clientX, e.clientY);
        emit('link-empty', { from: d.from, side: d.side, at: w, moved: d.moved });
      }
    }
  }

  /* ---------- two-tap linking ---------- */
  /**
   * Dragging a hairline out of a 30px handle is a mouse gesture. On a phone you
   * tap Link, then tap whoever it goes to; the chooser that follows routes the
   * answer back through the very same 'link-drop' the handle drag ends with.
   */
  function linkMode(fromId) {
    if (!S.doc.people[fromId]) return false;
    cancelLift(); cancelLongPress(); stopGlide();
    picking = { from: fromId };
    paintPicking();
    emit('pick-start', { from: fromId });
    return true;
  }
  function endLinkMode() {
    if (!picking) return;
    const from = picking.from;
    picking = null;
    paintPicking();
    emit('pick-end', { from });
  }
  const isPicking = () => !!picking;
  const linkTo = (from, to, side) => emit('link-drop', { from, to, side });

  function paintPicking() {
    const on = !!picking;
    viewport.classList.toggle('is-picking', on);
    nodeEls.forEach((node, id) => {
      node.classList.toggle('is-target', on && id !== picking.from);
      node.classList.toggle('is-source', on && id === picking.from);
    });
  }

  /** The menu a long-press used to open, from wherever the caller wants it. */
  function contextAt(x, y, id) {
    emit('context', { x, y, id: id || null, link: null, at: toWorld(x, y) });
  }

  /**
   * Slide the view so a person clears whatever is covering the canvas — the
   * details sheet, the peek card — without changing the zoom. Never while a
   * finger is down: nothing is worse than the map moving mid-drag.
   */
  function keepVisible(id, opts) {
    const o = opts || {};
    if (drag) return false;
    const p = S.doc.people[id];
    if (!p) return false;
    const r = viewport.getBoundingClientRect();
    const rect = rectOf(p);
    const s = toScreen(rect.x, rect.y);
    const w = rect.w * view.k, h = rect.h * view.k;
    const pad = o.pad == null ? 14 : o.pad;
    const top = (o.top || 0) + pad;
    const bottom = r.height - (o.bottom || 0) - pad;
    let dy = 0;
    // A bubble taller than the strip cannot fit: show its head, where the name
    // is, rather than centring it and losing the name off the top.
    if (h >= bottom - top) dy = top - s.y;
    else if (s.y + h > bottom) dy = bottom - (s.y + h);
    else if (s.y < top) dy = top - s.y;
    let dx = 0;
    if (w >= r.width - pad * 2) dx = r.width / 2 - (s.x + w / 2);
    else if (s.x + w > r.width - pad) dx = (r.width - pad) - (s.x + w);
    else if (s.x < pad) dx = pad - s.x;
    if (!dx && !dy) return false;
    animateTo({ x: view.x + dx, y: view.y + dy, k: view.k },
      reduceMotion.matches || o.animate === false ? 0 : 300);
    return true;
  }

  function onWheel(e) {
    e.preventDefault();
    stopGlide();
    const pref = S.prefs().wheel || 'zoom';
    const wantZoom = e.ctrlKey || e.metaKey ||
      (pref === 'zoom' ? Math.abs(e.deltaX) < 1 : false);
    if (wantZoom) {
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-delta * 0.0016), e.clientX, e.clientY);
    } else {
      setView({ x: view.x - e.deltaX, y: view.y - e.deltaY });
    }
  }

  /* pinch on touch devices */
  const touches = new Map();
  let pinch = null;
  function trackTouch(e, phase) {
    if (e.pointerType !== 'touch') return false;
    if (phase === 'down') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    else if (phase === 'up') { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; }
    else if (phase === 'move' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (touches.size === 2) {
      const [a, b] = Array.from(touches.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (!pinch) {
        pinch = { dist, mid };
        drag = null; panSamples = [];
        cancelLongPress(); cancelLift(); stopGlide();
        viewport.classList.remove('is-panning');
      } else if (phase === 'move') {
        if (pinch.dist > 0) zoomAt(dist / pinch.dist, mid.x, mid.y);
        setView({ x: view.x + (mid.x - pinch.mid.x), y: view.y + (mid.y - pinch.mid.y) }, { transient: true });
        pinch = { dist, mid };
      }
      return true;
    }
    return false;
  }

  /* ---------- init ---------- */
  function init() {
    S = BB.store; L = BB.lineage;
    viewport = $('#viewport');
    world = $('#world');
    nodesHost = $('#nodes');
    edgesG = $('#edges-g');
    draftSvg = $('#draft-link');
    draftPath = $('#draft-path');
    marqueeEl = $('#marquee');
    emptyState = $('#empty-state');

    viewport.addEventListener('pointerdown', (e) => { if (trackTouch(e, 'down')) return; onPointerDown(e); });
    viewport.addEventListener('pointermove', (e) => { if (trackTouch(e, 'move')) return; onPointerMove(e); });
    viewport.addEventListener('pointerup', (e) => { trackTouch(e, 'up'); onPointerUp(e); });
    viewport.addEventListener('pointercancel', (e) => { trackTouch(e, 'up'); onPointerUp(e); });
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('dblclick', (e) => {
      if (e.target.closest('.bubble') || e.target.closest('.edge')) return;
      // Touch browsers synthesise dblclick on top of our own double-tap; taking
      // both would add two people for one gesture.
      if (Date.now() - touchDoubleAt < 700) return;
      emit('dblclick-empty', toWorld(e.clientX, e.clientY));
    });
    viewport.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const bubble = e.target.closest('.bubble');
      const edge = e.target.closest('.edge');
      emit('context', {
        x: e.clientX, y: e.clientY,
        id: bubble ? bubble.dataset.id : null,
        link: edge ? edge.dataset.id : null,
        at: toWorld(e.clientX, e.clientY),
      });
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e.target)) { spaceDown = true; viewport.classList.add('is-space'); }
      else if (e.key === 'Escape' && picking) endLinkMode();
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { spaceDown = false; viewport.classList.remove('is-space'); }
    });
    window.addEventListener('blur', () => { spaceDown = false; viewport.classList.remove('is-space'); });

    // minimap navigation
    const mini = $('#minimap');
    mini.addEventListener('pointerdown', (e) => {
      if (!minimapMap) return;
      stopGlide();
      const r = mini.getBoundingClientRect();
      const { b, k, ox, oy } = minimapMap;
      const wx = b.x + (e.clientX - r.left - ox) / k;
      const wy = b.y + (e.clientY - r.top - oy) / k;
      const vr = viewport.getBoundingClientRect();
      animateTo({ k: view.k, x: vr.width / 2 - wx * view.k, y: vr.height / 2 - wy * view.k }, 260);
      e.preventDefault();
    });

    const ro = new ResizeObserver(() => { drawMinimap(); });
    ro.observe(viewport);

    S.on('change', (p) => {
      if (p.reason === 'positions') { renderNodes(); renderEdgesSoon(); drawMinimap(); }
      else render();
    });

    const v = S.doc.view || { x: 0, y: 0, k: 1 };
    view.x = v.x; view.y = v.y; view.k = U.clamp(v.k, MIN_K, MAX_K);
    applyView();
    render();
  }

  const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

  BB.canvas = {
    init, render, renderEdges: renderEdgesSoon, view, setView, animateTo, zoomAt, fit, focus, home, flash,
    select, selected, selectLink, setTrace,
    get trace() { return trace; },
    sizeOf, rectOf, toWorld, toScreen, boundsOf, on,
    get selection() { return selection; },
    invalidateSizes: () => sizeCache.clear(),
    isTyping,
    contextAt, keepVisible, linkMode, endLinkMode, isPicking, linkTo,
    isDragging: () => !!drag,
    MIN_K, MAX_K,
  };
})(window.BB);
