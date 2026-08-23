/* Bible Bubble — the timeline: every life laid on one axis. */
(function (BB) {
  'use strict';
  const U = BB.util;
  const { $, el } = U;

  const ROW_H = 24;
  const ROW_H_TOUCH = 30;   // a row a finger can hit without hitting its neighbour
  const TOP = 58;           // axis (38) + era band (20)
  const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];

  let S, L, C;
  let root, scroller, canvasEl, axisEl, erasEl, rowsEl, namesEl, namesInner, scrubEl, aliveEl, undatedEl;
  let optsEl, optsBtn;
  let ppy = 1;              // pixels per year
  let mode = 'years';
  let colorBy = 'era';
  let onlyDated = true;
  let scrubOn = false;
  let scrubYear = null;
  let built = false;
  let visible = false;
  let draggedAt = 0;        // when the names column was last dragged, not tapped

  const PHONE = window.matchMedia('(max-width: 700px)');
  const isPhone = () => PHONE.matches;
  const rowH = () => (isPhone() ? ROW_H_TOUCH : ROW_H);

  /**
   * Tap to pick someone out, tap them again to open them. Every name is already
   * written down the side here, so throwing a 70vh sheet over the chart at the
   * first touch would cost more than it told anyone.
   */
  function pickRow(id) {
    const sel = C.selected();
    const again = sel.length === 1 && sel[0] === id;
    C.select([id]);
    draw();
    if (again) surface(id);
  }

  /** Put a tapped person in front of the reader, as the other views now do. */
  function surface(id) {
    if (!isPhone()) return;
    if (BB.peek && typeof BB.peek.show === 'function') {
      BB.peek.show(id);
      if (BB.peek.isOpen && BB.peek.isOpen()) return;
    }
    if (BB.inspector && typeof BB.inspector.show === 'function') BB.inspector.show(id);
    else if (BB.app && typeof BB.app.setPanel === 'function') BB.app.setPanel('details', true);
  }

  /* ---------- data ---------- */
  function collect() {
    const st = S.settings();
    const people = S.people();
    const idx = L.index(S.doc);
    const rows = people.map(p => ({
      p,
      gen: idx.depth.get(p.id) || 0,
      start: U.isNum(p.birth) ? p.birth : (U.isNum(p.death) ? p.death : null),
      end: U.isNum(p.death) ? p.death : (U.isNum(p.birth) && U.isNum(p.age) ? p.birth + p.age : null),
    }));
    rows.forEach(r => { r.dated = U.isNum(r.start); r.point = r.dated && (!U.isNum(r.end) || r.end === r.start); });
    const dated = rows.filter(r => r.dated);
    const undated = rows.filter(r => !r.dated);
    dated.sort((a, b) => a.start - b.start || (a.gen - b.gen) || (a.p.name || '').localeCompare(b.p.name || ''));
    undated.sort((a, b) => a.gen - b.gen || (a.p.name || '').localeCompare(b.p.name || ''));
    const shown = onlyDated ? dated : dated.concat(undated);
    if (mode === 'generations') shown.sort((a, b) => a.gen - b.gen || (a.start ?? Infinity) - (b.start ?? Infinity));
    const span = dated.length
      ? { min: Math.min(...dated.map(r => r.start)), max: Math.max(...dated.map(r => U.isNum(r.end) ? r.end : r.start)) }
      : null;
    return { rows: shown, dated, undated, span, anchor: st.anchor, mode: st.yearMode };
  }

  const barColor = (r) => {
    if (colorBy === 'bubble') return `var(--c-${U.colorOf(r.p.color)})`;
    if (colorBy === 'sex') return r.p.sex === 'f' ? 'var(--c-rose)' : r.p.sex === 'm' ? 'var(--c-sky)' : 'var(--c-stone)';
    if (colorBy === 'generation') return `var(--c-${U.PALETTE_KEYS[r.gen % U.PALETTE_KEYS.length]})`;
    const eras = eraOrder();
    const i = Math.max(0, eras.indexOf(r.p.era || ''));
    return `var(--c-${U.PALETTE_KEYS[i % U.PALETTE_KEYS.length]})`;
  };

  let eraCache = null, eraCacheRev = -1;
  function eraOrder() {
    if (eraCacheRev === S.rev && eraCache) return eraCache;
    const seen = [];
    S.people().forEach(p => { const e = p.era || ''; if (!seen.includes(e)) seen.push(e); });
    eraCache = seen; eraCacheRev = S.rev;
    return seen;
  }

  /* ---------- layout maths ---------- */
  const xOf = (year, data) => (year - data.span.min) * ppy;
  const yearAt = (px, data) => data.span.min + px / ppy;

  function fit() {
    const data = collect();
    if (!data.span) return;
    const w = scroller.clientWidth || 800;
    const years = Math.max(1, data.span.max - data.span.min);
    ppy = U.clamp((w - 120) / years, 0.002, 60);
    draw();
    scroller.scrollLeft = 0;
  }

  function zoom(factor) {
    const data = collect();
    if (!data.span) return;
    const anchorPx = scroller.scrollLeft + scroller.clientWidth / 2;
    const anchorYear = yearAt(anchorPx, data);
    ppy = U.clamp(ppy * factor, 0.002, 60);
    draw();
    scroller.scrollLeft = xOf(anchorYear, data) - scroller.clientWidth / 2;
  }

  /* ---------- drawing ---------- */
  function draw() {
    if (!built || !visible) return;
    const data = collect();
    const st = S.settings();

    if (!data.rows.length) {
      rowsEl.replaceChildren(el('div.tl-empty', { text: data.undated.length ? 'No one on this board has dates yet — untick “Hide undated” to list them.' : 'Nothing to show yet. Add people with dates and they will appear here.' }));
      axisEl.replaceChildren(); erasEl.replaceChildren(); namesInner.replaceChildren();
      canvasEl.style.width = '100%';
      drawUndated(data);
      return;
    }

    const RH = rowH();
    const width = data.span ? Math.max(scroller.clientWidth, (data.span.max - data.span.min) * ppy + 160) : scroller.clientWidth;
    canvasEl.style.width = width + 'px';
    canvasEl.style.height = (TOP + data.rows.length * RH + 40) + 'px';

    /* axis */
    if (mode === 'years' && data.span) {
      const target = 96;
      let step = NICE.find(s => s * ppy >= target) || NICE[NICE.length - 1];
      while (step * ppy < target) step *= 2;
      const first = Math.ceil(data.span.min / step) * step;
      const ticks = [];
      for (let y = first; y <= data.span.max; y += step) {
        const major = (y % (step * 5) === 0);
        ticks.push(el('div.tl-tick' + (major ? '.major' : ''), {
          style: { left: xOf(y, data) + 'px' },
          text: st.yearMode === 'am' ? 'AM ' + y : U.amToEra(y, st.anchor),
        }));
      }
      axisEl.replaceChildren(...ticks);
    } else {
      const maxGen = Math.max(...data.rows.map(r => r.gen));
      const colW = Math.max(28, Math.min(120, (scroller.clientWidth - 60) / (maxGen + 1)));
      canvasEl.style.width = Math.max(scroller.clientWidth, (maxGen + 1) * colW + 80) + 'px';
      axisEl.replaceChildren(...Array.from({ length: maxGen + 1 }, (_, g) =>
        el('div.tl-tick' + (g % 5 === 0 ? '.major' : ''), { style: { left: (g * colW) + 'px' }, text: String(g + 1) })));
      data.colW = colW;
    }

    /* era bands */
    if (mode === 'years' && data.span) {
      const bands = new Map();
      data.rows.forEach(r => {
        const e = r.p.era || '';
        if (!e) return;
        const b = bands.get(e) || { min: Infinity, max: -Infinity };
        b.min = Math.min(b.min, r.start);
        b.max = Math.max(b.max, U.isNum(r.end) ? r.end : r.start);
        bands.set(e, b);
      });
      erasEl.replaceChildren(...Array.from(bands.entries()).map(([name, b]) => el('div.tl-era', {
        style: { left: xOf(b.min, data) + 'px', width: Math.max(30, (b.max - b.min) * ppy) + 'px' },
        title: name,
      }, [(b.max - b.min) * ppy > 56 ? name : ''])));
    } else erasEl.replaceChildren();

    /* bars + names */
    const sel = new Set(C.selected());
    const bars = [], names = [];
    data.rows.forEach((r, i) => {
      const top = TOP + i * RH + (RH - 17) / 2;
      let left, w;
      if (mode === 'generations') {
        left = r.gen * (data.colW || 60);
        w = Math.max(11, (data.colW || 60) * 0.72);
      } else {
        left = xOf(r.start, data);
        w = r.point ? 11 : Math.max(3, (r.end - r.start) * ppy);
      }
      const isPoint = mode === 'years' && r.point;
      const label = mode === 'generations'
        ? (r.p.name || 'Unnamed')
        : U.formatSpan(r.p.birth, r.p.death, { mode: st.yearMode === 'am' ? 'am' : 'era', anchor: st.anchor, approx: r.p.approx })
          + (U.isNum(r.p.age) ? ' · ' + r.p.age : '');
      const bar = el('div.tl-bar' + (isPoint ? '.is-point' : '') + (sel.has(r.p.id) ? '.is-sel' : ''), {
        style: { left: left + 'px', width: w + 'px', top: top + 'px', '--b-accent': barColor(r) },
        'data-id': r.p.id,
        title: (r.p.name || 'Unnamed') + (r.p.role ? ' — ' + r.p.role : ''),
      }, [el('span.lbl', { text: label })]);
      bars.push(bar);

      names.push(el('div.tl-name-row' + (sel.has(r.p.id) ? '.is-sel' : ''), {
        style: { top: (TOP + i * RH) + 'px', height: RH + 'px' },
        'data-id': r.p.id, title: r.p.name || 'Unnamed',
      }, [
        el('span.tree-dot', { style: { background: barColor(r) } }),
        el('span.n', { text: r.p.name || 'Unnamed' }),
        el('span.g', { text: 'g' + (r.gen + 1) }),
      ]));
    });
    rowsEl.replaceChildren();
    canvasEl.style.setProperty('--rows', String(data.rows.length));
    bars.forEach(b => rowsEl.appendChild(b));
    rowsEl.style.top = '0px';
    namesInner.replaceChildren(...names);
    namesInner.style.height = (TOP + data.rows.length * RH + 40) + 'px';

    drawScrubber(data);
    drawUndated(data);
  }

  /* ---------- scrubber ---------- */
  function drawScrubber(data) {
    scrubEl.hidden = !(scrubOn && mode === 'years' && data.span);
    aliveEl.hidden = scrubEl.hidden;
    if (scrubEl.hidden) return;
    if (scrubYear == null) scrubYear = Math.round((data.span.min + data.span.max) / 2);
    scrubYear = U.clamp(scrubYear, data.span.min, data.span.max);
    const st = S.settings();
    scrubEl.style.left = xOf(scrubYear, data) + 'px';
    scrubEl.style.height = (TOP + data.rows.length * rowH()) + 'px';
    $('#tl-scrub-handle').textContent = st.yearMode === 'am'
      ? 'AM ' + Math.round(scrubYear)
      : U.amToEra(Math.round(scrubYear), st.anchor);

    const y = scrubYear;
    const alive = data.rows.filter(r => r.dated && U.isNum(r.end) && r.start <= y && r.end >= y);
    alive.sort((a, b) => a.start - b.start);
    aliveEl.replaceChildren(
      el('span.lead', { text: alive.length ? U.plural(alive.length, 'person', 'people') + ' alive:' : 'No one recorded is alive in this year.' }),
      ...alive.map(r => el('span.who', {
        'data-id': r.p.id,
        onclick: () => { C.select([r.p.id]); BB.app.revealPerson(r.p.id); },
      }, [
        el('span.tree-dot', { style: { background: barColor(r) } }),
        r.p.name || 'Unnamed',
        el('span.age', { text: 'age ' + Math.round(y - r.start) }),
      ])),
    );
  }

  function drawUndated(data) {
    if (!onlyDated || !data.undated.length) { undatedEl.hidden = true; return; }
    undatedEl.hidden = false;
    undatedEl.replaceChildren(
      el('span', { text: U.plural(data.undated.length, 'person', 'people') + ' without dates:' }),
      ...data.undated.slice(0, 60).map(r => el('span.who', {
        'data-id': r.p.id, title: 'Select ' + (r.p.name || 'this person'),
        onclick: () => { C.select([r.p.id]); BB.app.revealPerson(r.p.id); },
      }, [r.p.name || 'Unnamed'])),
      data.undated.length > 60 ? el('span', { text: '+' + (data.undated.length - 60) + ' more' }) : null,
    );
  }

  /**
   * Switched on, the scrubber went to the middle of the whole span — which on a
   * phone is usually a screen or two off to the side. Start it in the middle of
   * what is actually on screen instead.
   */
  function centreScrub() {
    const data = collect();
    if (!data.span) return;
    scrubYear = U.clamp(yearAt(scroller.scrollLeft + scroller.clientWidth / 2, data),
      data.span.min, data.span.max);
  }

  /* ---------- events ---------- */
  function bindScrubDrag() {
    const handle = $('#tl-scrub-handle');
    let dragging = false;
    const move = (e) => {
      if (!dragging) return;
      const data = collect();
      if (!data.span) return;
      const r = canvasEl.getBoundingClientRect();
      scrubYear = U.clamp(yearAt(e.clientX - r.left, data), data.span.min, data.span.max);
      drawScrubber(data);
    };
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      // Capture keeps the drag alive past the edge of the handle, but a pointer
      // that has already been let go of throws rather than declining.
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault(); e.stopPropagation();
    });
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', (e) => {
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    // click anywhere on the canvas to move the scrubber
    canvasEl.addEventListener('click', (e) => {
      if (!scrubOn || e.target.closest('.tl-bar')) return;
      const data = collect();
      if (!data.span) return;
      const r = canvasEl.getBoundingClientRect();
      scrubYear = U.clamp(yearAt(e.clientX - r.left, data), data.span.min, data.span.max);
      drawScrubber(data);
    });
  }

  /**
   * The names are a mirror of the scroller rather than a scroller themselves,
   * so a finger dragging them had nothing to move and the list sat still.
   * Carry the drag across by hand.
   */
  function bindNameDrag() {
    let y0 = null, from = 0, moved = false;
    namesEl.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { y0 = null; return; }
      y0 = e.touches[0].clientY; from = scroller.scrollTop; moved = false;
    }, { passive: true });
    namesEl.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      if (!moved && Math.abs(dy) < 5) return;
      moved = true;
      draggedAt = Date.now();
      scroller.scrollTop = from - dy;
      e.preventDefault();
    }, { passive: false });
    const letGo = () => { if (moved) draggedAt = Date.now(); y0 = null; };
    namesEl.addEventListener('touchend', letGo);
    namesEl.addEventListener('touchcancel', letGo);
  }

  /* ---------- the toolbar on a phone ---------- */
  /**
   * Seven controls will not sit on a 390px row, and the two that matter while
   * reading — the mode and the zoom — were the ones scrolled out of sight. The
   * three that are set once move behind a button.
   */
  const stowable = [];
  let stowed = null;

  function buildOpts() {
    const bar = root.querySelector('.tl-toolbar');
    if (!bar) return;
    optsEl = el('div.tl-opts', { hidden: true });
    root.appendChild(optsEl);
    optsBtn = el('button.btn.sm.ghost.tl-opts-btn', {
      type: 'button', text: 'Options', 'aria-expanded': 'false',
      onclick: (e) => { e.stopPropagation(); showOpts(optsEl.hidden); },
    });
    bar.insertBefore(optsBtn, bar.querySelector('.tl-spacer'));
    ['#tl-color', '#tl-only-dated', '#tl-scrub'].forEach(sel => {
      const wrap = $(sel) && $(sel).closest('label');
      if (wrap && wrap.parentNode) stowable.push({ wrap: wrap, home: wrap.parentNode, after: wrap.nextSibling });
    });
    document.addEventListener('pointerdown', (e) => {
      if (!optsEl || optsEl.hidden) return;
      if (e.target.closest('.tl-opts') || e.target.closest('.tl-opts-btn')) return;
      showOpts(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && optsEl && !optsEl.hidden) showOpts(false);
    });
  }

  function showOpts(on) {
    if (!optsEl) return;
    optsEl.hidden = !on;
    if (optsBtn) optsBtn.setAttribute('aria-expanded', String(!!on));
    if (!on) return;
    const bar = root.querySelector('.tl-toolbar');
    optsEl.style.top = ((bar ? bar.offsetHeight : 52) + 5) + 'px';
  }

  function layoutControls() {
    const phone = isPhone();
    if (phone === stowed) return;
    stowed = phone;
    if (phone && optsEl) {
      stowable.forEach(st => optsEl.appendChild(st.wrap));
    } else {
      // Back to front, so each control still has its old neighbour to go before.
      for (let i = stowable.length - 1; i >= 0; i--) stowable[i].home.insertBefore(stowable[i].wrap, stowable[i].after);
      showOpts(false);
    }
    U.$$('[data-tlmode]', root).forEach(b => {
      const long = b.dataset.tlmode === 'years' ? 'By year' : 'By generation';
      const short = b.dataset.tlmode === 'years' ? 'Years' : 'Generations';
      b.textContent = phone ? short : long;
    });
  }

  function init() {
    S = BB.store; L = BB.lineage; C = BB.canvas;
    root = $('#timeline');
    scroller = $('#tl-scroll');
    canvasEl = $('#tl-canvas');
    axisEl = $('#tl-axis');
    erasEl = $('#tl-eras');
    rowsEl = $('#tl-rows');
    namesEl = $('#tl-names');
    scrubEl = $('#tl-scrubber');
    aliveEl = $('#tl-alive');
    undatedEl = $('#tl-undated');

    namesInner = el('div', { style: { position: 'absolute', left: '0', right: '0', top: '0' } });
    namesEl.style.paddingTop = '0';
    namesEl.appendChild(namesInner);
    built = true;

    scroller.addEventListener('scroll', () => {
      namesInner.style.transform = `translateY(${-scroller.scrollTop}px)`;
    });

    rowsEl.addEventListener('click', (e) => {
      const bar = e.target.closest('.tl-bar');
      if (bar) pickRow(bar.dataset.id);
    });
    namesEl.addEventListener('click', (e) => {
      const row = e.target.closest('.tl-name-row');
      if (!row) return;
      if (Date.now() - draggedAt < 400) return;   // that was a scroll, not a tap
      pickRow(row.dataset.id);
    });
    bindNameDrag();
    rowsEl.addEventListener('dblclick', (e) => {
      const bar = e.target.closest('.tl-bar');
      if (bar) BB.app.revealPerson(bar.dataset.id);
    });

    U.$$('[data-tlmode]').forEach(b => b.addEventListener('click', () => {
      mode = b.dataset.tlmode;
      U.$$('[data-tlmode]').forEach(x => x.classList.toggle('is-active', x === b));
      if (mode === 'years') fit(); else draw();
    }));
    $('#tl-color').addEventListener('change', (e) => { colorBy = e.target.value; draw(); });
    $('#tl-only-dated').addEventListener('change', (e) => { onlyDated = e.target.checked; draw(); });
    $('#tl-scrub').addEventListener('change', (e) => {
      scrubOn = e.target.checked;
      if (scrubOn) centreScrub();
      draw();
    });

    document.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'tl-zoom-in') zoom(1.5);
      else if (act.dataset.act === 'tl-zoom-out') zoom(1 / 1.5);
      else if (act.dataset.act === 'tl-fit') fit();
    });

    bindScrubDrag();
    buildOpts();
    layoutControls();
    const onWidth = () => { layoutControls(); if (visible) draw(); };
    if (PHONE.addEventListener) PHONE.addEventListener('change', onWidth);
    else if (PHONE.addListener) PHONE.addListener(onWidth);

    S.on('change', (p) => { if (p.reason !== 'positions') draw(); });
    C.on('select', () => { if (visible) draw(); });

    new ResizeObserver(() => { if (visible) draw(); }).observe(root);
  }

  /** Called when the timeline tab becomes active. */
  function show() {
    visible = true;
    if (ppy === 1) fit(); else draw();
  }
  function hide() { visible = false; }

  BB.timeline = { init, draw, fit, show, hide };
})(window.BB);
