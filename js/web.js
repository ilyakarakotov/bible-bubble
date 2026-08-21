/* Bible Bubble — the web: one circle per person, every link a thread between them. */
(function (BB) {
  'use strict';
  const U = BB.util;
  const { $, $$, el } = U;

  const MIN_K = 0.12, MAX_K = 4;
  const ALPHA_MIN = 0.008;        // below this the layout is settled and the loop stops
  const ALPHA_DECAY = 0.965;      // ~135 ticks from a full kick to rest
  const VELOCITY_DECAY = 0.62;
  const LINK_STRENGTH = 0.42;
  const CHARGE = 96;              // many-body repulsion, scaled by spread and radius
  const CENTER = 0.014;
  const HUB_LABELS = 16;          // how many names "Hubs" mode tries to show
  const R_MIN = 6, R_MAX = 26;

  let S, L, C;

  /* ---------- dom ---------- */
  let root, stage, cv, ctx, tipEl, emptyEl, sideBtn, rankEl, pathA, pathB, pathOut;
  let spreadEl, colorEl, labelsEl, isolatedEl;

  /* ---------- graph ---------- */
  let nodes = [], edges = [], byId = new Map(), adj = new Map();
  let maxDeg = 1, eraOrder = null;

  /* ---------- view + loop ---------- */
  const view = { x: 0, y: 0, k: 1 };
  let alpha = 0, frame = 0, paintFrame = 0, tween = null;
  let size = { w: 0, h: 0, dpr: 1 };
  let visible = false, dirty = true, ready = false, autoFit = true;

  /* ---------- interaction ---------- */
  let hoverId = null, drag = null, pan = null, pendingFocus = null;
  let flashId = null, flashUntil = 0, follow = null;
  let pathState = null;           // {ids:Set, links:Set, hops, steps}

  const opts = { show: 'all', color: 'era', labels: 'hubs', spread: 120, isolated: true, side: true };

  const isPhone = () => window.matchMedia('(max-width: 700px)').matches;

  /* ================= preferences ================= */
  function loadPrefs() {
    const p = S.prefs() || {};
    const get = (k, fb) => (p['web.' + k] === undefined ? fb : p['web.' + k]);
    const oneOf = (v, list, fb) => (list.includes(v) ? v : fb);
    opts.show = oneOf(get('show'), ['all', 'lineage', 'bonds'], 'all');
    opts.color = oneOf(get('color'), ['era', 'generation', 'bubble', 'degree'], 'era');
    opts.labels = oneOf(get('labels'), ['hubs', 'all', 'none'], 'hubs');
    opts.spread = U.clamp(+get('spread', 120) || 120, 40, 260);
    opts.isolated = get('isolated', true) !== false;
    opts.side = get('side', !isPhone()) !== false;
  }
  const savePref = (k, v) => S.setPref('web.' + k, v);

  /* ================= shared answers ================= */
  const bondKind = (id) => BB.model.bondKind(id);
  const degreeOf = (id) => L.degree(id, S.doc);
  const ranking = (limit) => L.ranking(S.doc, limit) || [];
  const connectionPath = (a, b) => L.connectionPath(a, b, S.doc);

  /* ================= graph building ================= */
  function keepsLink(l) {
    if (opts.show === 'lineage') return l.type !== 'other';
    if (opts.show === 'bonds') return l.type === 'other';
    return true;
  }

  function seedNode(p, i, total) {
    // A golden-angle spiral: an even, repeatable start that the forces can open out.
    const a = i * 2.399963229728653;
    const rad = 15 * Math.sqrt(i + 0.7) * U.clamp(Math.sqrt(total) / 9, 0.7, 2.2);
    return { id: p.id, p, x: Math.cos(a) * rad, y: Math.sin(a) * rad, vx: 0, vy: 0, fx: null, fy: null, deg: 0, r: R_MIN };
  }

  /** Rebuild nodes and edges from the store. Returns true when the shape changed. */
  function build() {
    const doc = S.doc;
    const was = nodes.length + '/' + edges.length;
    const live = S.links().filter(l => doc.people[l.from] && doc.people[l.to] && l.from !== l.to);
    const shown = live.filter(keepsLink);

    const deg = new Map();
    shown.forEach(l => {
      deg.set(l.from, (deg.get(l.from) || 0) + 1);
      deg.set(l.to, (deg.get(l.to) || 0) + 1);
    });

    const people = S.people().filter(p => opts.isolated || (deg.get(p.id) || 0) > 0);
    const next = new Map();
    let fresh = 0;
    people.forEach((p, i) => {
      const d = deg.get(p.id) || 0;
      const old = byId.get(p.id);
      const n = old || seedNode(p, i, people.length);
      if (!old) fresh++;
      n.p = p;
      n.deg = d;
      n.r = U.clamp(R_MIN + Math.sqrt(d) * 4, R_MIN, R_MAX);
      next.set(p.id, n);
    });

    byId = next;
    nodes = Array.from(next.values());
    edges = shown.filter(l => next.has(l.from) && next.has(l.to)).map(l => ({
      id: l.id, from: l.from, to: l.to, type: l.type, kind: l.kind || '', label: l.label || '', lane: 0,
    }));
    fanOut(edges);

    adj = new Map();
    nodes.forEach(n => adj.set(n.id, new Set()));
    edges.forEach(e => { adj.get(e.from).add(e.to); adj.get(e.to).add(e.from); });
    maxDeg = nodes.reduce((m, n) => Math.max(m, n.deg), 1);
    eraOrder = null;
    if (hoverId && !byId.has(hoverId)) hoverId = null;
    return fresh > 0 || was !== nodes.length + '/' + edges.length;
  }

  /**
   * Two people can be joined more than once — a father who is also a rival, a
   * pair holding two different bonds. Drawn straight they would sit on top of
   * each other and only one would ever show, so each link in a group takes its
   * own lane and bows out of the way. A lone link keeps lane 0 and stays straight.
   */
  function fanOut(list) {
    const groups = new Map();
    list.forEach(e => {
      const key = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    });
    groups.forEach(group => {
      if (group.length < 2) return;
      group.forEach((e, i) => { e.lane = i - (group.length - 1) / 2; });
    });
  }

  /** Where an edge bends: 0 for a straight line, else the apex offset in world units. */
  function laneBow(e, len) {
    return e.lane ? e.lane * U.clamp(len * 0.16, 11, 30) : 0;
  }

  /* ================= the simulation ================= */
  function tick() {
    const spread = opts.spread;

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      let dx = (b.x + b.vx) - (a.x + a.vx);
      let dy = (b.y + b.vy) - (a.y + a.vy);
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const target = (e.type === 'spouse' ? spread * 0.34 : spread * 0.55) + a.r + b.r;
      const l = ((d - target) / d) * alpha * LINK_STRENGTH;
      // The busier end holds still; the quieter one swings toward it.
      const wa = (1 + b.deg) / (2 + a.deg + b.deg);
      dx *= l; dy *= l;
      b.vx -= dx * (1 - wa); b.vy -= dy * (1 - wa);
      a.vx += dx * wa;       a.vy += dy * wa;
    }

    const charge = -CHARGE * (spread / 120);
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.02) { dx = 0.1 + i * 0.001; dy = 0.07 - j * 0.001; d2 = dx * dx + dy * dy; }
        const w = alpha / d2;
        a.vx += dx * charge * (0.5 + b.r / 14) * w;
        a.vy += dy * charge * (0.5 + b.r / 14) * w;
        b.vx -= dx * charge * (0.5 + a.r / 14) * w;
        b.vy -= dy * charge * (0.5 + a.r / 14) * w;

        const gap = a.r + b.r + 5;
        if (d2 < gap * gap) {
          const d = Math.sqrt(d2) || 0.01;
          const push = ((gap - d) / d) * 0.5;
          a.x -= dx * push; a.y -= dy * push;
          b.x += dx * push; b.y += dy * push;
        }
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      a.vx -= a.x * CENTER * alpha;
      a.vy -= a.y * CENTER * alpha;
      if (a.fx != null) { a.x = a.fx; a.y = a.fy; a.vx = 0; a.vy = 0; continue; }
      a.vx *= VELOCITY_DECAY; a.vy *= VELOCITY_DECAY;
      a.x += a.vx; a.y += a.vy;
    }
    alpha *= ALPHA_DECAY;
    if (alpha < ALPHA_MIN) alpha = 0;
  }

  function busy() {
    return alpha > 0 || !!tween || performance.now() < flashUntil;
  }

  function loop() {
    frame = requestAnimationFrame(loop);
    if (alpha > 0) tick();
    if (follow) holdFollowed();
    if (tween) advanceTween();
    draw();
    if (!busy()) {
      stopLoop();
      follow = null;
      if (autoFit && nodes.length) { autoFit = false; fit(); }
    }
  }

  /**
   * Keep a person the user asked for under the middle of the screen while the
   * layout is still moving — otherwise the view lands where they *were*.
   */
  function holdFollowed() {
    const n = byId.get(follow);
    if (!n) { follow = null; return; }
    const k = tween ? tween.to.k : view.k;
    const x = size.w / 2 - n.x * k;
    const y = size.h / 2 - n.y * k;
    if (tween) { tween.to.x = x; tween.to.y = y; }
    else { view.x = x; view.y = y; }
  }

  /** The user has taken the view into their own hands. */
  function letGo() { follow = null; autoFit = false; }

  function startLoop() {
    if (frame || !visible) return;
    frame = requestAnimationFrame(loop);
  }
  function stopLoop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }
  /** Warm the layout back up — after a drag, a filter change or new people. */
  function kick(a) {
    alpha = Math.max(alpha, a == null ? 0.5 : a);
    startLoop();
  }

  /** One repaint without running the simulation. */
  function requestPaint() {
    if (frame || paintFrame || !visible) return;
    paintFrame = requestAnimationFrame(() => { paintFrame = 0; draw(); });
  }

  /* ================= view ================= */
  function measure() {
    if (!stage) return false;
    const r = stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === size.w && h === size.h && dpr === size.dpr) return false;
    const prev = size;
    size = { w, h, dpr };
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    if (prev.w) { view.x += (w - prev.w) / 2; view.y += (h - prev.h) / 2; }
    return true;
  }

  const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });
  const toScreen = (wx, wy) => ({ x: wx * view.k + view.x, y: wy * view.k + view.y });

  function pointerAt(e) {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function advanceTween() {
    const t = U.clamp((performance.now() - tween.t0) / tween.ms, 0, 1);
    const e = 1 - Math.pow(1 - t, 3);
    view.x = tween.from.x + (tween.to.x - tween.from.x) * e;
    view.y = tween.from.y + (tween.to.y - tween.from.y) * e;
    view.k = tween.from.k + (tween.to.k - tween.from.k) * e;
    if (t >= 1) tween = null;
  }

  function glideTo(target, ms) {
    if (!ms) { view.x = target.x; view.y = target.y; view.k = target.k; requestPaint(); return; }
    tween = { from: { x: view.x, y: view.y, k: view.k }, to: target, t0: performance.now(), ms };
    startLoop();
  }

  function bounds() {
    if (!nodes.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    nodes.forEach(n => {
      x1 = Math.min(x1, n.x - n.r); y1 = Math.min(y1, n.y - n.r);
      x2 = Math.max(x2, n.x + n.r); y2 = Math.max(y2, n.y + n.r);
    });
    return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
  }

  function fit(o) {
    measure();
    const b = bounds();
    if (!b || !size.w) return;
    follow = null;
    const pad = (o && o.pad != null) ? o.pad : (isPhone() ? 34 : 60);
    const k = U.clamp(Math.min((size.w - pad * 2) / b.w, (size.h - pad * 2) / b.h), MIN_K, 1.6);
    glideTo({
      k,
      x: size.w / 2 - (b.x + b.w / 2) * k,
      y: size.h / 2 - (b.y + b.h / 2) * k,
    }, (o && o.animate === false) ? 0 : 300);
  }

  function zoomAt(factor, sx, sy) {
    const k = U.clamp(view.k * factor, MIN_K, MAX_K);
    const scale = k / view.k;
    view.x = sx - (sx - view.x) * scale;
    view.y = sy - (sy - view.y) * scale;
    view.k = k;
    letGo();
    requestPaint();
  }

  function zoomBy(factor) {
    measure();
    zoomAt(factor, size.w / 2, size.h / 2);
  }

  function focus(id) {
    if (!S.person(id)) return;
    if (!visible) { pendingFocus = id; return; }
    if (!byId.has(id)) {
      // Hidden by a filter — bring the whole board back so the person is there.
      if (!opts.isolated) { opts.isolated = true; if (isolatedEl) isolatedEl.checked = true; savePref('isolated', true); }
      if (opts.show !== 'all') setShow('all');
      build();
      paintSide();
    }
    const n = byId.get(id);
    if (!n) return;
    autoFit = false;
    flashId = id;
    flashUntil = performance.now() + 1500;
    follow = id;
    const k = Math.max(view.k, 0.75);
    glideTo({ k, x: size.w / 2 - n.x * k, y: size.h / 2 - n.y * k }, 320);
    startLoop();
  }

  /* ================= colours ================= */
  let themeCache = null, themeKey = '';
  /**
   * Colours come from the stylesheet at draw time so a theme switch repaints in
   * the new palette; the read is memoised per theme, not per frame.
   */
  function theme() {
    const key = (document.documentElement.getAttribute('data-theme') || '') + '|' + U.PALETTE_KEYS.length;
    if (themeCache && themeKey === key) return themeCache;
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => ((cs.getPropertyValue(name) || '').trim() || fb);
    const t = {
      bg: v('--bg', '#f4f0e8'),
      ink: v('--ink', '#2c2721'),
      ink2: v('--ink-2', '#5d5548'),
      ink3: v('--ink-3', '#8b8172'),
      accent: v('--accent', '#b4802f'),
      link: v('--link', '#a8935f'),
      serif: v('--serif', 'Georgia, "Times New Roman", serif'),
      sans: v('--font', 'system-ui, sans-serif'),
      hue: {},
    };
    U.PALETTE_KEYS.forEach(k => { t.hue[k] = v('--c-' + k, '#8d8b84'); });
    themeCache = t; themeKey = key;
    return t;
  }

  function parseHex(hex) {
    let s = String(hex || '').trim().replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    const n = parseInt(s, 16);
    if (s.length !== 6 || isNaN(n)) return [140, 138, 132];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mixHex(a, b, t) {
    const x = parseHex(a), y = parseHex(b);
    const c = (i) => Math.round(x[i] + (y[i] - x[i]) * t);
    return 'rgb(' + c(0) + ',' + c(1) + ',' + c(2) + ')';
  }

  function eras() {
    if (eraOrder) return eraOrder;
    const seen = [];
    S.people().forEach(p => { const e = p.era || ''; if (!seen.includes(e)) seen.push(e); });
    eraOrder = seen;
    return seen;
  }

  function nodeColor(n, t) {
    if (opts.color === 'bubble') return t.hue[U.colorOf(n.p.color)];
    if (opts.color === 'generation') {
      const g = L.generationOf(n.id, S.doc);
      return t.hue[U.PALETTE_KEYS[g % U.PALETTE_KEYS.length]];
    }
    if (opts.color === 'degree') {
      const f = maxDeg > 1 ? U.clamp(n.deg / maxDeg, 0, 1) : 0;
      return f < 0.5 ? mixHex(t.hue.sky, t.hue.sand, f * 2) : mixHex(t.hue.sand, t.hue.clay, (f - 0.5) * 2);
    }
    const i = Math.max(0, eras().indexOf(n.p.era || ''));
    return t.hue[U.PALETTE_KEYS[i % U.PALETTE_KEYS.length]];
  }

  function edgeStyle(e, t) {
    if (e.type === 'spouse') return { color: t.hue.rose, width: 1.5, dash: [5, 4] };
    if (e.type === 'other') return { color: t.hue[bondKind(e.kind).hue] || t.hue.stone, width: 1.6, dash: [2, 3.4] };
    return { color: t.link, width: 1.2, dash: null };
  }

  /* ================= drawing ================= */
  function litSet() {
    if (pathState) return pathState.ids;
    if (hoverId && byId.has(hoverId)) {
      const s = new Set([hoverId]);
      (adj.get(hoverId) || new Set()).forEach(id => s.add(id));
      return s;
    }
    return null;
  }

  function edgeIsLit(e, lit) {
    if (pathState) return pathState.links.has(e.id);
    if (!lit) return true;
    return e.from === hoverId || e.to === hoverId;
  }

  function draw() {
    if (!ready || !ctx) return;
    measure();
    const t = theme();
    const dpr = size.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!nodes.length) { drawNote(t); return; }

    const lit = litSet();
    const sel = new Set(C && C.selected ? C.selected() : []);
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
    ctx.lineCap = 'round';

    /* edges — quiet ones first so the lit threads sit on top */
    for (let pass = 0; pass < 2; pass++) {
      const wantLit = pass === 1;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const on = edgeIsLit(e, lit);
        if (on !== wantLit) continue;
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) continue;
        const st = edgeStyle(e, t);
        ctx.globalAlpha = on ? (lit ? 0.95 : 0.5) : 0.08;
        ctx.strokeStyle = st.color;
        ctx.lineWidth = (on && lit ? st.width + 0.7 : st.width) / view.k;
        ctx.setLineDash(st.dash ? st.dash.map(d => d / view.k) : []);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const bow = laneBow(e, len);
        if (bow) {
          // The curve peaks at half the control point, so aim it twice as far out.
          ctx.quadraticCurveTo(
            (a.x + b.x) / 2 - (dy / len) * bow * 2,
            (a.y + b.y) / 2 + (dx / len) * bow * 2,
            b.x, b.y);
        } else ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    /* nodes */
    const m = 40 / view.k;
    const w0 = -view.x / view.k - m, h0 = -view.y / view.k - m;
    const w1 = w0 + size.w / view.k + m * 2, h1 = h0 + size.h / view.k + m * 2;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.x < w0 || n.x > w1 || n.y < h0 || n.y > h1) continue;
      const on = !lit || lit.has(n.id);
      ctx.globalAlpha = on ? 1 : 0.16;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = nodeColor(n, t);
      ctx.fill();
      ctx.lineWidth = 1.5 / view.k;
      ctx.strokeStyle = t.bg;
      ctx.stroke();
      if (sel.has(n.id) || n.id === hoverId) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3.5 / view.k, 0, Math.PI * 2);
        ctx.strokeStyle = sel.has(n.id) ? t.accent : t.ink2;
        ctx.lineWidth = 2 / view.k;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    /* the flash left by focus() */
    const flash = flashId && byId.get(flashId) && performance.now() < flashUntil ? byId.get(flashId) : null;
    if (flash) {
      const life = U.clamp((flashUntil - performance.now()) / 1500, 0, 1);
      ctx.globalAlpha = life * 0.8;
      ctx.beginPath();
      ctx.arc(flash.x, flash.y, flash.r + (1 - life) * 26 + 4, 0, Math.PI * 2);
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 2.5 / view.k;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLabels(t, lit, sel);
  }

  function labelCandidates(sel) {
    const forced = new Set();
    const rest = [];
    nodes.forEach(n => {
      if (n.id === hoverId || sel.has(n.id) || (pathState && pathState.ids.has(n.id))) forced.add(n);
      else rest.push(n);
    });
    let mode = opts.labels;
    // Zoomed far out, names turn to mush — thin them out rather than pile them up.
    if (mode === 'all' && view.k < 0.5) mode = 'hubs';
    if (mode === 'hubs' && view.k < 0.2) mode = 'none';
    const list = Array.from(forced);
    if (mode !== 'none') {
      rest.sort((a, b) => b.deg - a.deg);
      list.push(...(mode === 'hubs' ? rest.filter(n => n.deg > 1) : rest));
    }
    // The budget counts names actually drawn, so zooming in spends it on what is
    // on screen rather than on hubs that sit somewhere off in the dark.
    return { list, forced, budget: mode === 'hubs' ? HUB_LABELS : Infinity };
  }

  function drawLabels(t, lit, sel) {
    const { list, forced, budget } = labelCandidates(sel);
    if (!list.length) return;
    const fs = view.k < 0.7 ? 11 : 12;
    ctx.font = '600 ' + fs + 'px ' + t.serif;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    const taken = [];
    let spent = 0;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (!forced.has(n) && spent >= budget) break;
      const on = !lit || lit.has(n.id);
      if (!on && n.id !== hoverId) continue;
      const s = toScreen(n.x, n.y);
      if (s.x < -60 || s.y < -20 || s.x > size.w + 60 || s.y > size.h + 20) continue;
      const text = n.p.name || 'Unnamed';
      const w = ctx.measureText(text).width;
      const box = { x: s.x - w / 2 - 3, y: s.y + n.r * view.k + 3, w: w + 6, h: fs + 4 };
      if (taken.some(r => U.rectsOverlap(box, r))) continue;
      taken.push(box);
      if (!forced.has(n)) spent++;
      ctx.globalAlpha = on ? 1 : 0.4;
      ctx.strokeStyle = t.bg;
      ctx.lineWidth = 3;
      ctx.strokeText(text, s.x, box.y);
      ctx.fillStyle = n.id === hoverId || sel.has(n.id) ? t.ink : t.ink2;
      ctx.fillText(text, s.x, box.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawNote(t) {
    if (!size.w || S.count() === 0) return;
    ctx.fillStyle = t.ink3;
    ctx.font = '13px ' + t.sans;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Nobody matches these filters.', size.w / 2, size.h / 2);
  }

  /* ================= hit testing ================= */
  function nodeAt(sx, sy) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const s = toScreen(n.x, n.y);
      const d = Math.hypot(s.x - sx, s.y - sy);
      const reach = Math.max(n.r * view.k, 7) + 6;
      if (d <= reach && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  /* ================= the tip ================= */
  function breakdown(id) {
    const d = degreeOf(id);
    const bits = [];
    if (d.children) bits.push(U.plural(d.children, 'child', 'children'));
    if (d.parents) bits.push(U.plural(d.parents, 'parent'));
    if (d.spouses) bits.push(U.plural(d.spouses, 'spouse'));
    if (d.bonds) bits.push(U.plural(d.bonds, 'connection'));
    return bits.length ? bits.join(' · ') : 'No links yet';
  }

  function showTip(n, at) {
    if (!tipEl) return;
    const st = S.settings();
    const span = U.formatSpan(n.p.birth, n.p.death, {
      mode: st.yearMode === 'am' ? 'am' : 'era', anchor: st.anchor, approx: n.p.approx,
    });
    tipEl.replaceChildren(
      el('strong', { text: n.p.name || 'Unnamed' }),
      n.p.role ? el('span.web-tip-role', { text: n.p.role }) : null,
      span ? el('span.web-tip-when', { text: span }) : null,
      el('span.web-tip-deg', { text: breakdown(n.id) }),
    );
    tipEl.hidden = false;
    const box = tipEl.getBoundingClientRect();
    const x = U.clamp(at.x + 14, 6, Math.max(6, size.w - box.width - 6));
    const y = U.clamp(at.y + 16, 6, Math.max(6, size.h - box.height - 6));
    U.setStyle(tipEl, { left: x + 'px', top: y + 'px' });
  }

  function hideTip() { if (tipEl) tipEl.hidden = true; }

  function setHover(id, at) {
    if (id === hoverId && !at) return;
    hoverId = id;
    const n = id ? byId.get(id) : null;
    if (n && at) showTip(n, at);
    else if (!n) hideTip();
    requestPaint();
  }

  /* ================= pointer ================= */
  const touches = new Map();
  let pinch = null, holdTimer = 0, tapAt = 0, tapPos = null;

  function cancelHold() { if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; } }

  function onDown(e) {
    if (trackTouch(e, 'down')) return;
    const at = pointerAt(e);
    const n = nodeAt(at.x, at.y);
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    if (n) {
      // Pin where it stands: a plain click must not stir the layout, only a drag.
      drag = { id: n.id, moved: false, at };
      n.fx = n.x; n.fy = n.y;
      letGo();
      if (e.pointerType === 'touch') {
        holdTimer = setTimeout(() => { holdTimer = 0; setHover(n.id, at); }, 380);
      }
    } else {
      pan = { x: at.x, y: at.y, vx: view.x, vy: view.y, moved: false };
      letGo();
    }
    e.preventDefault();
  }

  function onMove(e) {
    if (trackTouch(e, 'move')) return;
    const at = pointerAt(e);
    if (drag) {
      const n = byId.get(drag.id);
      if (!n) return;
      if (Math.hypot(at.x - drag.at.x, at.y - drag.at.y) > 3) { drag.moved = true; cancelHold(); }
      const w = toWorld(at.x, at.y);
      n.fx = w.x; n.fy = w.y;
      kick(0.32);
      if (hoverId === n.id) showTip(n, at);
      return;
    }
    if (pan) {
      if (Math.hypot(at.x - pan.x, at.y - pan.y) > 3) pan.moved = true;
      view.x = pan.vx + (at.x - pan.x);
      view.y = pan.vy + (at.y - pan.y);
      requestPaint();
      return;
    }
    if (e.pointerType === 'touch') return;
    const n = nodeAt(at.x, at.y);
    if (n) { setHover(n.id, at); cv.style.cursor = 'pointer'; }
    else { setHover(null); cv.style.cursor = ''; }
  }

  function onUp(e) {
    trackTouch(e, 'up');
    cancelHold();
    try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
    if (drag) {
      const n = byId.get(drag.id);
      if (n) { n.fx = null; n.fy = null; }
      if (!drag.moved && n) {
        if (C) C.select([n.id]);
        if (e.pointerType === 'touch') setHover(n.id, pointerAt(e));
        const now = Date.now();
        if (e.pointerType === 'touch' && now - tapAt < 340 && tapPos && Math.hypot(tapPos.x - e.clientX, tapPos.y - e.clientY) < 26) {
          openOnCanvas(n.id);
          tapAt = 0;
        } else { tapAt = now; tapPos = { x: e.clientX, y: e.clientY }; }
      }
      const moved = drag.moved;
      drag = null;
      if (moved) kick(0.18);
      return;
    }
    if (pan) {
      const wasTap = !pan.moved;
      pan = null;
      if (wasTap) { setHover(null); if (C) C.select([]); }
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const at = pointerAt(e);
    zoomAt(Math.exp(-delta * 0.0018), at.x, at.y);
  }

  function openOnCanvas(id) {
    if (BB.app && typeof BB.app.showOnCanvas === 'function') BB.app.showOnCanvas(id);
  }

  /** Two fingers pan and pinch together; one finger falls through to the usual handlers. */
  function trackTouch(e, phase) {
    if (e.pointerType !== 'touch') return false;
    if (phase === 'down') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    else if (phase === 'up') { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; }
    else if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (touches.size === 2) {
      const [a, b] = Array.from(touches.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const r = stage.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      if (!pinch) {
        pinch = { dist, mid };
        cancelHold();
        if (drag) { const n = byId.get(drag.id); if (n) { n.fx = null; n.fy = null; } drag = null; }
        pan = null;
      } else if (phase === 'move') {
        if (pinch.dist > 0) zoomAt(dist / pinch.dist, mid.x, mid.y);
        view.x += mid.x - pinch.mid.x;
        view.y += mid.y - pinch.mid.y;
        pinch = { dist, mid };
        requestPaint();
      }
      return true;
    }
    return false;
  }

  /* ================= side panel ================= */
  function nameOf(id) {
    const p = S.person(id);
    return (p && p.name) || 'Unnamed';
  }

  function paintRank() {
    if (!rankEl) return;
    const rows = ranking(12).filter(r => r.degree > 0);
    if (!rows.length) {
      rankEl.replaceChildren(el('p.web-none', { text: 'No links yet. Join a few people up and the busiest will list here.' }));
      return;
    }
    rankEl.replaceChildren(...rows.map(r => el('button.web-rank-row', {
      type: 'button',
      'data-id': r.id,
      title: 'Show ' + nameOf(r.id) + ' in the web',
      onclick: () => { if (C) C.select([r.id]); focus(r.id); },
    }, [
      el('span.tree-dot', { style: { background: 'var(--c-' + U.colorOf((S.person(r.id) || {}).color) + ')' } }),
      el('span.n', { text: nameOf(r.id) }),
      el('span.c', { text: String(r.degree) }),
    ])));
  }

  function fillPickers() {
    if (!pathA || !pathB) return;
    const people = S.people().slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    [pathA, pathB].forEach(sel => {
      const had = sel.value;
      sel.replaceChildren(
        el('option', { value: '', text: sel === pathA ? 'Choose someone' : '…and someone else' }),
        ...people.map(p => el('option', { value: p.id, text: p.name || 'Unnamed' })),
      );
      if (had && S.person(had)) sel.value = had;
      else sel.value = '';
    });
  }

  /** How one step of a path reads out loud, taken from the link itself. */
  function stepPhrase(step) {
    const link = S.doc.links[step.linkId];
    const type = link ? link.type : (step.via === 'bond' ? 'other' : step.via);
    if (type === 'spouse') return 'married to';
    if (type === 'other') {
      const row = bondKind(link ? link.kind : step.kind);
      const forward = !link || link.from === step.from;
      const said = forward ? row.out : row.in;
      return said.charAt(0).toLowerCase() + said.slice(1);
    }
    // A parent link reads either way round; the step names how `from` stands to `to`.
    const parentFirst = link ? link.from === step.from : step.via === 'child';
    const who = S.person(step.from);
    const sex = who ? who.sex : '';
    if (parentFirst) return sex === 'f' ? 'mother of' : sex === 'm' ? 'father of' : 'parent of';
    return sex === 'f' ? 'daughter of' : sex === 'm' ? 'son of' : 'child of';
  }

  function runPath() {
    if (!pathOut) return;
    const a = pathA.value, b = pathB.value;
    if (!a || !b || !S.person(a) || !S.person(b)) {
      pathState = null;
      pathOut.replaceChildren(el('p.web-none', { text: 'Choose two people to see how far apart they are.' }));
      requestPaint();
      return;
    }
    if (a === b) {
      pathState = null;
      pathOut.replaceChildren(el('p.web-none', { text: 'That is the same person twice — pick someone else for one end.' }));
      requestPaint();
      return;
    }
    const res = connectionPath(a, b);
    if (!res) {
      pathState = null;
      pathOut.replaceChildren(el('p.web-none', {
        text: 'No route between ' + nameOf(a) + ' and ' + nameOf(b) + ' — nothing on this board joins them yet.',
      }));
      requestPaint();
      return;
    }
    pathState = {
      ids: new Set(res.ids || []),
      links: new Set((res.steps || []).map(s => s.linkId)),
      hops: res.hops,
    };
    // "step", not "connection": a connection means a bond everywhere else in the
    // app, and these hops run along lineage links as well.
    const lead = el('p.web-path-lead', {
      text: nameOf(b) + ' is ' + U.plural(res.hops, 'step') + ' from ' + nameOf(a) + '.',
    });
    const rows = (res.steps || []).map(s => el('div.web-step', {}, [
      el('button.web-step-name', { type: 'button', 'data-id': s.from, text: nameOf(s.from), onclick: () => focus(s.from) }),
      el('span.web-step-via', { text: stepPhrase(s) }),
      el('button.web-step-name', { type: 'button', 'data-id': s.to, text: nameOf(s.to), onclick: () => focus(s.to) }),
    ]));
    pathOut.replaceChildren(lead, ...rows);
    requestPaint();
  }

  function paintSide() {
    paintRank();
    fillPickers();
    if (pathState) runPath();
  }

  function setSide(open, save) {
    opts.side = !!open;
    if (root) root.classList.toggle('is-side-open', opts.side);
    if (sideBtn) sideBtn.setAttribute('aria-expanded', String(opts.side));
    if (save !== false) savePref('side', opts.side);
    if (visible) requestPaint();
  }

  /* ================= controls ================= */
  function setShow(mode) {
    opts.show = mode;
    $$('[data-webshow]', root).forEach(b => b.classList.toggle('is-active', b.dataset.webshow === mode));
    savePref('show', mode);
  }

  function applyControls() {
    setShow(opts.show);
    if (colorEl) colorEl.value = opts.color;
    if (labelsEl) labelsEl.value = opts.labels;
    if (spreadEl) spreadEl.value = String(opts.spread);
    if (isolatedEl) isolatedEl.checked = opts.isolated;
    setSide(opts.side, false);
  }

  function wire() {
    $$('[data-webshow]', root).forEach(b => b.addEventListener('click', () => {
      setShow(b.dataset.webshow);
      build();
      paintSide();
      kick(0.6);
    }));

    if (colorEl) colorEl.addEventListener('change', () => {
      opts.color = colorEl.value; savePref('color', opts.color); requestPaint();
    });
    if (labelsEl) labelsEl.addEventListener('change', () => {
      opts.labels = labelsEl.value; savePref('labels', opts.labels); requestPaint();
    });
    if (spreadEl) spreadEl.addEventListener('input', () => {
      opts.spread = U.clamp(+spreadEl.value || 120, 40, 260);
      savePref('spread', opts.spread);
      kick(0.5);
    });
    if (isolatedEl) isolatedEl.addEventListener('change', () => {
      opts.isolated = isolatedEl.checked;
      savePref('isolated', opts.isolated);
      build();
      kick(0.5);
    });
    if (sideBtn) sideBtn.addEventListener('click', () => setSide(!opts.side));

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('pointerleave', () => { if (!drag && !pan) setHover(null); });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('dblclick', (e) => {
      const at = pointerAt(e);
      const n = nodeAt(at.x, at.y);
      if (n) openOnCanvas(n.id);
    });

    if (pathA) pathA.addEventListener('change', runPath);
    if (pathB) pathB.addEventListener('change', runPath);
  }

  /* ================= lifecycle ================= */
  function onStoreChange(p) {
    const reason = p && p.reason;
    if (reason === 'positions' || reason === 'settings') return;   // canvas-only news
    if (!visible) { dirty = true; return; }
    refresh();
  }

  function paintEmpty() {
    if (emptyEl) emptyEl.hidden = S.count() > 0;
  }

  function refresh() {
    if (!ready) return;
    if (!visible) { dirty = true; return; }
    const changed = build();
    paintSide();
    paintEmpty();
    if (changed) kick(0.45); else requestPaint();
  }

  function init() {
    S = BB.store; L = BB.lineage; C = BB.canvas;
    root = $('#web');
    stage = $('#web-stage');
    cv = $('#web-canvas');
    if (!root || !stage || !cv || !cv.getContext) return;
    ctx = cv.getContext('2d');

    tipEl = $('#web-tip');
    emptyEl = $('#web-empty');
    sideBtn = $('#web-side-btn');
    rankEl = $('#web-rank');
    pathA = $('#web-path-a');
    pathB = $('#web-path-b');
    pathOut = $('#web-path-out');
    spreadEl = $('#web-spread');
    colorEl = $('#web-color');
    labelsEl = $('#web-labels');
    isolatedEl = $('#web-isolated');

    loadPrefs();
    applyControls();
    wire();

    S.on('change', onStoreChange);
    if (C && typeof C.on === 'function') C.on('select', () => { if (visible) requestPaint(); });

    if (typeof ResizeObserver === 'function') {
      // Switching views resizes the stage to nothing; show() measures again on
      // the way back, so a hidden view has nothing to do here.
      new ResizeObserver(() => {
        if (visible && measure()) requestPaint();
      }).observe(stage);
    }
    window.addEventListener('resize', () => { if (visible && measure()) requestPaint(); });

    // Nothing else tells a settled canvas that the palette changed under it.
    if (typeof MutationObserver === 'function') {
      new MutationObserver(() => { themeCache = null; requestPaint(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    ready = true;
    dirty = true;
  }

  function show() {
    if (!ready) return;
    visible = true;
    measure();
    if (dirty || !nodes.length) {
      const first = !nodes.length;
      build();
      dirty = false;
      paintSide();
      if (first) autoFit = true;
      kick(first ? 1 : 0.5);
    } else {
      requestPaint();
    }
    paintEmpty();
    if (pendingFocus) { const id = pendingFocus; pendingFocus = null; focus(id); }
  }

  function hide() {
    visible = false;
    stopLoop();
    if (paintFrame) { cancelAnimationFrame(paintFrame); paintFrame = 0; }
    cancelHold();
    if (drag) { const n = byId.get(drag.id); if (n) { n.fx = null; n.fy = null; } drag = null; }
    pan = null; pinch = null; touches.clear(); follow = null;
    setHover(null);
    hideTip();
  }

  const isOpen = () => visible;

  BB.web = { init, show, hide, draw, refresh, fit, focus, zoomBy, isOpen };
})(window.BB);
