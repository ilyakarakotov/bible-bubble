/* Bible Bubble — small helpers shared by every module. */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  /* ---------- DOM ---------- */
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** el('div.foo', {attr}, [children|string]) */
  function el(spec, attrs, kids) {
    const [tagAndId, ...classes] = String(spec).split('.');
    const [tag, id] = tagAndId.split('#');
    const node = document.createElement(tag || 'div');
    if (id) node.id = id;
    if (classes.length) node.className = classes.join(' ');
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') setStyle(node, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    if (kids) (Array.isArray(kids) ? kids : [kids]).forEach(k => {
      if (k === null || k === undefined || k === false) return;
      node.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
    });
    return node;
  }

  /**
   * Apply a style object. Custom properties need setProperty — assigning them
   * onto the style object does nothing at all, silently.
   */
  function setStyle(node, styles) {
    for (const k in styles) {
      const v = styles[k];
      if (v === null || v === undefined) continue;
      if (k.startsWith('--')) node.style.setProperty(k, String(v));
      else node.style[k] = v;
    }
  }

  /** Inline <svg><use href="#id"></svg> */
  function icon(name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (cls) svg.setAttribute('class', cls);
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  const svgEl = (tag, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    return n;
  };

  /* ---------- misc ---------- */
  let seq = 0;
  const uid = (p) => (p || 'p') + '_' + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const deepClone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function debounce(fn, ms) {
    let t;
    const wrapped = function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
    wrapped.cancel = () => clearTimeout(t);
    wrapped.flush = function (...a) { clearTimeout(t); fn.apply(this, a); };
    return wrapped;
  }

  /** Coalesce repeated calls into one per animation frame. */
  function rafThrottle(fn) {
    let queued = false, lastArgs;
    return function (...args) {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn.apply(this, lastArgs); });
    };
  }

  const plural = (n, one, many) => n === 1 ? `1 ${one}` : `${n} ${many || one + 's'}`;

  /** Fold accents so "Asa" matches "Āsā", and lowercase. */
  const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  /* ---------- colour palette ---------- */
  const PALETTE = [
    { key: 'sand',  label: 'Sand' },
    { key: 'olive', label: 'Olive' },
    { key: 'sky',   label: 'Sky' },
    { key: 'rose',  label: 'Rose' },
    { key: 'plum',  label: 'Plum' },
    { key: 'clay',  label: 'Clay' },
    { key: 'teal',  label: 'Teal' },
    { key: 'stone', label: 'Stone' },
  ];
  const PALETTE_KEYS = PALETTE.map(p => p.key);
  const colorOf = (key) => (PALETTE_KEYS.includes(key) ? key : 'sand');
  /** Resolved hex for the accent of a palette key (reads the live CSS variable). */
  function colorHex(key) {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--c-' + colorOf(key));
    return (v || '#c8963e').trim();
  }

  /* ---------- chronology ----------
     Years are stored internally as AM ("anno mundi" — years since creation),
     because the Genesis 5 / 11 genealogies give exact AM figures. A board-level
     anchor converts AM to BC/AD for everything after. Default anchor: AM 0 = 4004 BC
     (the traditional Ussher reckoning) — editable per board.                     */
  const DEFAULT_AM_ZERO_BC = 4004;

  /** BC year -> AM. There is no year zero: 1 BC is AM (anchor - 1), AD 1 is AM anchor. */
  const bcToAm = (bc, anchor) => (anchor == null ? DEFAULT_AM_ZERO_BC : anchor) - bc;
  const adToAm = (ad, anchor) => (anchor == null ? DEFAULT_AM_ZERO_BC : anchor) + ad - 1;

  /** Parse a year the user typed: "1656", "AM 1656", "1010 BC", "AD 30", "30 CE". */
  function parseYear(raw, anchor) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;
    let m;
    if ((m = s.match(/^(?:am\s*)?(-?\d{1,5})$/i))) return parseInt(m[1], 10);
    if ((m = s.match(/^(\d{1,5})\s*(?:bce?|b\.c\.?)$/i))) return bcToAm(parseInt(m[1], 10), anchor);
    if ((m = s.match(/^(?:bce?|b\.c\.?)\s*(\d{1,5})$/i))) return bcToAm(parseInt(m[1], 10), anchor);
    if ((m = s.match(/^(\d{1,5})\s*(?:ad|ce|a\.d\.?)$/i))) return adToAm(parseInt(m[1], 10), anchor);
    if ((m = s.match(/^(?:ad|ce|a\.d\.?)\s*(\d{1,5})$/i))) return adToAm(parseInt(m[1], 10), anchor);
    return null;
  }

  /** AM -> "2348 BC" / "AD 30" */
  function amToEra(am, anchor) {
    const a = anchor == null ? DEFAULT_AM_ZERO_BC : anchor;
    const bc = a - am;
    return bc >= 1 ? `${bc} BC` : `AD ${1 - bc}`;
  }

  /**
   * Format a stored AM year for display.
   * mode: 'am' | 'era' | 'both'
   */
  function formatYear(am, opts) {
    if (!isNum(am)) return '';
    const o = opts || {};
    const mode = o.mode || 'both';
    const c = o.approx ? 'c. ' : '';
    if (mode === 'am') return `${c}AM ${am}`;
    if (mode === 'era') return c + amToEra(am, o.anchor);
    return `${c}AM ${am} · ${amToEra(am, o.anchor)}`;
  }

  /** Compact form for bubbles: "AM 0–930" or "c. 1040–970 BC" */
  function formatSpan(birth, death, opts) {
    const o = opts || {};
    const mode = o.mode || 'era';
    const c = o.approx ? 'c. ' : '';
    if (!isNum(birth) && !isNum(death)) return '';
    if (mode === 'am') {
      if (isNum(birth) && isNum(death)) return `${c}AM ${birth}–${death}`;
      return isNum(birth) ? `${c}AM ${birth}–` : `${c}–AM ${death}`;
    }
    const a = o.anchor;
    const eb = isNum(birth) ? a - birth : null;
    const ed = isNum(death) ? a - death : null;
    const lab = (v) => (v >= 1 ? `${v} BC` : `AD ${1 - v}`);
    if (eb !== null && ed !== null) {
      // Same era on both ends → print the suffix once: "1040–970 BC".
      if (eb >= 1 && ed >= 1) return `${c}${eb}–${ed} BC`;
      if (eb < 1 && ed < 1) return `${c}AD ${1 - eb}–${1 - ed}`;
      return `${c}${lab(eb)} – ${lab(ed)}`;
    }
    return c + (eb !== null ? lab(eb) + '–' : '–' + lab(ed));
  }

  /* ---------- toasts ---------- */
  let toastHost = null;
  function toast(msg, opts) {
    const o = opts || {};
    if (!toastHost) toastHost = document.getElementById('toasts');
    if (!toastHost) return;
    const node = el('div.toast', {}, [msg]);
    if (o.action && o.onAction) {
      node.appendChild(el('button', { type: 'button', text: o.action, onclick: () => { o.onAction(); dismiss(); } }));
    }
    toastHost.appendChild(node);
    let done = false;
    const dismiss = () => {
      if (done) return; done = true;
      node.style.transition = 'opacity .18s, transform .18s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(() => node.remove(), 200);
    };
    setTimeout(dismiss, o.ms || (o.action ? 6500 : 2600));
    return dismiss;
  }

  /* ---------- geometry ---------- */
  const rectsOverlap = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  /** Point where a line toward `to` exits the rectangle centred on `from`. */
  function edgeAnchor(from, to) {
    const cx = from.x + from.w / 2, cy = from.y + from.h / 2;
    const dx = to.x - cx, dy = to.y - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const hw = from.w / 2, hh = from.h / 2;
    const sx = dx === 0 ? Infinity : hw / Math.abs(dx);
    const sy = dy === 0 ? Infinity : hh / Math.abs(dy);
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  BB.util = {
    $, $$, el, icon, svgEl, setStyle, uid, clamp, isNum, deepClone, escapeHtml, debounce, rafThrottle,
    plural, fold, PALETTE, PALETTE_KEYS, colorOf, colorHex,
    DEFAULT_AM_ZERO_BC, bcToAm, adToAm, parseYear, amToEra, formatYear, formatSpan,
    toast, rectsOverlap, edgeAnchor,
  };
})(window.BB);
