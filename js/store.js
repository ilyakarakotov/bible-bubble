/* Bible Bubble — document model, persistence and undo history. */
(function (BB) {
  'use strict';
  const U = BB.util;

  const SCHEMA = 1;
  const LS = {
    index:  'bb.boards',
    board:  (id) => 'bb.board.' + id,
    active: 'bb.active',
    prefs:  'bb.prefs',
  };
  const HISTORY_CAP = 120;
  const COALESCE_MS = 700;

  const LINK_TYPES = ['parent', 'spouse', 'other'];

  /* ---------- shapes ---------- */
  function blankPerson(props) {
    const p = Object.assign({
      id: U.uid('p'),
      name: '',
      aka: [],
      sex: '',
      role: '',
      era: '',
      birth: null,
      death: null,
      age: null,
      approx: false,
      refs: [],
      highlights: [],
      notes: '',
      tags: [],
      color: 'sand',
      x: 0,
      y: 0,
      updated: Date.now(),
    }, props || {});
    return normalizePerson(p);
  }

  function normalizePerson(raw) {
    const arr = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(s => s.trim()) : [];
    const num = (v) => (U.isNum(v) ? v : (typeof v === 'number' ? null : (v === null || v === undefined || v === '' ? null : (isFinite(+v) ? +v : null))));
    const p = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : U.uid('p'),
      name: String(raw.name || '').slice(0, 120),
      aka: arr(raw.aka).slice(0, 12),
      sex: raw.sex === 'm' || raw.sex === 'f' ? raw.sex : '',
      role: String(raw.role || '').slice(0, 160),
      era: String(raw.era || '').slice(0, 60),
      birth: num(raw.birth),
      death: num(raw.death),
      age: num(raw.age),
      approx: !!raw.approx,
      refs: arr(raw.refs).slice(0, 24),
      highlights: arr(raw.highlights).slice(0, 40),
      notes: String(raw.notes || '').slice(0, 20000),
      tags: arr(raw.tags).slice(0, 24),
      color: U.colorOf(raw.color),
      x: U.isNum(+raw.x) ? +raw.x : 0,
      y: U.isNum(+raw.y) ? +raw.y : 0,
      updated: U.isNum(+raw.updated) ? +raw.updated : Date.now(),
    };
    // Derive whichever of birth/death/age is missing but implied by the other two.
    deriveYears(p);
    return p;
  }

  /** Keep birth / death / age consistent. `changed` names the field the user just edited. */
  function deriveYears(p, changed) {
    const has = (v) => U.isNum(v);
    if (changed === 'age' && has(p.age) && has(p.birth)) p.death = p.birth + p.age;
    else if (changed === 'birth' && has(p.birth) && has(p.age)) p.death = p.birth + p.age;
    else if (changed === 'death' && has(p.death) && has(p.birth)) p.age = p.death - p.birth;
    else if (has(p.birth) && has(p.death)) p.age = p.death - p.birth;
    else if (has(p.birth) && has(p.age)) p.death = p.birth + p.age;
    else if (has(p.death) && has(p.age)) p.birth = p.death - p.age;
    return p;
  }

  function blankDoc(name) {
    return {
      schema: SCHEMA,
      id: U.uid('b'),
      name: name || 'Untitled board',
      created: Date.now(),
      updated: Date.now(),
      settings: {
        anchor: U.DEFAULT_AM_ZERO_BC,
        yearMode: 'both',   // am | era | both
        density: 'normal',  // compact | normal | rich
        showGrid: true,
      },
      people: {},
      links: {},
      view: { x: 0, y: 0, k: 1 },
    };
  }

  /** Accept anything that looks like a board and return a safe document. */
  function normalizeDoc(raw, fallbackName) {
    const d = blankDoc(fallbackName);
    if (!raw || typeof raw !== 'object') return d;
    if (typeof raw.id === 'string' && raw.id) d.id = raw.id;
    if (raw.name) d.name = String(raw.name).slice(0, 120);
    if (U.isNum(+raw.created)) d.created = +raw.created;
    if (U.isNum(+raw.updated)) d.updated = +raw.updated;

    const s = raw.settings || {};
    if (U.isNum(+s.anchor)) d.settings.anchor = +s.anchor;
    if (['am', 'era', 'both'].includes(s.yearMode)) d.settings.yearMode = s.yearMode;
    if (['compact', 'normal', 'rich'].includes(s.density)) d.settings.density = s.density;
    if (typeof s.showGrid === 'boolean') d.settings.showGrid = s.showGrid;

    // people may arrive as a map or an array
    const list = Array.isArray(raw.people) ? raw.people : Object.values(raw.people || {});
    list.forEach(pr => {
      if (!pr || typeof pr !== 'object') return;
      const p = normalizePerson(pr);
      d.people[p.id] = p;
    });

    const links = Array.isArray(raw.links) ? raw.links : Object.values(raw.links || {});
    links.forEach(lr => {
      if (!lr || typeof lr !== 'object') return;
      const from = String(lr.from || '');
      const to = String(lr.to || '');
      if (!d.people[from] || !d.people[to] || from === to) return;      // drop dangling links
      const type = LINK_TYPES.includes(lr.type) ? lr.type : 'parent';
      const id = typeof lr.id === 'string' && lr.id ? lr.id : U.uid('l');
      // collapse duplicates (and mirrored spouse links)
      const dup = Object.values(d.links).some(x =>
        x.type === type && ((x.from === from && x.to === to) ||
          (type !== 'parent' && x.from === to && x.to === from)));
      if (dup) return;
      d.links[id] = { id, from, to, type, label: String(lr.label || '').slice(0, 60) };
    });

    const v = raw.view || {};
    if (U.isNum(+v.x) && U.isNum(+v.y) && U.isNum(+v.k)) {
      d.view = { x: +v.x, y: +v.y, k: U.clamp(+v.k, 0.05, 4) };
    }
    return d;
  }

  /* ---------- storage ---------- */
  const safeParse = (s, fb) => { try { return JSON.parse(s); } catch (_) { return fb; } };

  function lsGet(key, fb) {
    try { const v = localStorage.getItem(key); return v == null ? fb : safeParse(v, fb); }
    catch (_) { return fb; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { console.warn('[bible-bubble] storage write failed', e); return false; }
  }

  /* ---------- store ---------- */
  const listeners = new Map();
  let doc = blankDoc();
  let rev = 0;                       // bumped on every change; used to invalidate caches
  let past = [], future = [];
  let lastLabel = null, lastStamp = 0;
  let storageOK = true;
  let suspendDepth = 0, pendingReasons = null;

  const store = {
    get doc() { return doc; },
    get rev() { return rev; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get storageOK() { return storageOK; },

    people: () => Object.values(doc.people),
    links: () => Object.values(doc.links),
    person: (id) => doc.people[id] || null,
    count: () => Object.keys(doc.people).length,
    settings: () => doc.settings,

    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt).delete(fn);
    },
    emit(evt, payload) {
      const set = listeners.get(evt);
      if (set) set.forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
    },
  };

  /** Announce a change (batched inside store.batch). */
  function changed(reason) {
    rev++;
    doc.updated = Date.now();
    if (suspendDepth > 0) { (pendingReasons = pendingReasons || new Set()).add(reason); return; }
    scheduleSave();
    store.emit('change', { reason });
  }

  /** Run several mutations, emitting a single change event at the end. */
  store.batch = function (label, fn) {
    snapshot(label);
    suspendDepth++;
    try { return fn(); }
    finally {
      suspendDepth--;
      if (suspendDepth === 0) {
        const reasons = pendingReasons; pendingReasons = null;
        if (reasons) { scheduleSave(); store.emit('change', { reason: [...reasons].join('+') }); }
      }
    }
  };

  /* ---------- history ---------- */
  function snapshot(label) {
    const now = Date.now();
    // Repeated same-kind edits within a moment collapse into one undo step.
    if (label && label === lastLabel && now - lastStamp < COALESCE_MS && past.length) {
      lastStamp = now;
      return;
    }
    past.push(JSON.stringify(doc));
    if (past.length > HISTORY_CAP) past.shift();
    future.length = 0;
    lastLabel = label || null;
    lastStamp = now;
  }

  store.undo = function () {
    if (!past.length) return false;
    future.push(JSON.stringify(doc));
    doc = JSON.parse(past.pop());
    lastLabel = null;
    changed('history');
    return true;
  };
  store.redo = function () {
    if (!future.length) return false;
    past.push(JSON.stringify(doc));
    doc = JSON.parse(future.pop());
    lastLabel = null;
    changed('history');
    return true;
  };
  /** Break the coalescing window so the next edit starts a fresh undo step. */
  store.seal = function () { lastLabel = null; lastStamp = 0; };

  /* ---------- persistence ---------- */
  let dirty = false;
  const debouncedSave = U.debounce(() => store.save(), 450);

  function markDirty(v) {
    if (dirty === v) return;
    dirty = v;
    store.emit('dirty', dirty);
  }

  /** Queue a write to localStorage and flag the document as unsaved. */
  function scheduleSave() {
    markDirty(true);
    debouncedSave();
  }

  store.isDirty = () => dirty;

  store.save = function () {
    const ok = lsSet(LS.board(doc.id), doc);
    storageOK = ok;
    if (ok) {
      const idx = boardIndex();
      const meta = { id: doc.id, name: doc.name, updated: doc.updated, count: Object.keys(doc.people).length };
      const row = idx.find(b => b.id === doc.id);
      if (row) Object.assign(row, meta); else idx.push(meta);
      lsSet(LS.index, idx);
      lsSet(LS.active, doc.id);
      markDirty(false);
    } else {
      store.emit('storage-error');
    }
    return ok;
  };

  /** Write immediately, cancelling any pending debounce. */
  store.flush = function () {
    debouncedSave.cancel();
    return store.save();
  };

  function boardIndex() {
    const idx = lsGet(LS.index, []);
    return Array.isArray(idx) ? idx.filter(b => b && typeof b.id === 'string') : [];
  }
  store.boards = boardIndex;

  store.load = function () {
    const idx = boardIndex();
    const activeId = lsGet(LS.active, null);
    const wanted = (activeId && idx.some(b => b.id === activeId)) ? activeId : (idx[0] && idx[0].id);
    if (wanted) {
      const raw = lsGet(LS.board(wanted), null);
      if (raw) {
        doc = normalizeDoc(raw, 'Board');
        resetHistory();
        changed('load');
        return { fresh: false };
      }
    }
    return { fresh: true };
  };

  function resetHistory() { past = []; future = []; lastLabel = null; }

  store.openBoard = function (id) {
    if (id === doc.id) return false;
    store.flush();
    const raw = lsGet(LS.board(id), null);
    if (!raw) return false;
    doc = normalizeDoc(raw, 'Board');
    resetHistory();
    lsSet(LS.active, doc.id);
    changed('board');
    return true;
  };

  store.createBoard = function (name, source) {
    store.flush();
    doc = source ? normalizeDoc(source, name) : blankDoc(name);
    doc.id = U.uid('b');
    if (name) doc.name = name;
    doc.created = Date.now();
    resetHistory();
    store.save();
    changed('board');
    return doc.id;
  };

  store.renameBoard = function (name) {
    doc.name = String(name || '').slice(0, 120) || 'Untitled board';
    changed('board-name');
  };

  store.deleteBoard = function (id) {
    try { localStorage.removeItem(LS.board(id)); } catch (_) {}
    lsSet(LS.index, boardIndex().filter(b => b.id !== id));
    if (id === doc.id) {
      const idx = boardIndex();
      if (idx.length) store.openBoard(idx[0].id);
      else { doc = blankDoc('My lineage'); resetHistory(); store.save(); changed('board'); }
    }
  };

  store.duplicateBoard = function () {
    const copy = U.deepClone(doc);
    return store.createBoard(doc.name.replace(/\s*\(copy\)$/, '') + ' (copy)', copy);
  };

  /** Replace the whole document (import). */
  store.replaceDoc = function (raw, opts) {
    const o = opts || {};
    snapshot(null);
    const next = normalizeDoc(raw, o.name || 'Imported board');
    next.id = o.keepId ? next.id : doc.id;      // import into the current board slot by default
    if (o.name) next.name = o.name;
    doc = next;
    changed('replace');
  };

  /* ---------- mutations ---------- */
  store.addPerson = function (props, opts) {
    const p = blankPerson(props);
    store.batch('add-person', () => {
      doc.people[p.id] = p;
      changed('people');
    });
    if (!(opts && opts.quiet)) store.seal();
    return p;
  };

  store.addPeople = function (list) {
    const made = [];
    store.batch('add-people', () => {
      list.forEach(props => { const p = blankPerson(props); doc.people[p.id] = p; made.push(p); });
      changed('people');
    });
    return made;
  };

  store.updatePerson = function (id, patch, opts) {
    const p = doc.people[id];
    if (!p) return null;
    const o = opts || {};
    snapshot(o.label || ('edit:' + id + ':' + Object.keys(patch).join(',')));
    Object.assign(p, patch);
    if ('birth' in patch || 'death' in patch || 'age' in patch) deriveYears(p, o.changed);
    p.color = U.colorOf(p.color);
    p.updated = Date.now();
    changed(o.reason || 'person');
    return p;
  };

  /** Bulk position update from a drag or a layout pass. */
  store.movePeople = function (positions, label) {
    snapshot(label || 'move');
    for (const id in positions) {
      const p = doc.people[id];
      if (!p) continue;
      p.x = Math.round(positions[id].x);
      p.y = Math.round(positions[id].y);
    }
    changed('positions');
  };

  store.removePeople = function (ids) {
    const set = new Set(ids);
    if (!set.size) return;
    store.batch('remove', () => {
      set.forEach(id => delete doc.people[id]);
      for (const lid in doc.links) {
        const l = doc.links[lid];
        if (set.has(l.from) || set.has(l.to)) delete doc.links[lid];
      }
      changed('people');
    });
    store.seal();
  };

  /** True when adding parent->child would close a loop in the ancestry graph. */
  function wouldCycle(parentId, childId) {
    if (parentId === childId) return true;
    const stack = [parentId], seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (cur === childId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const lid in doc.links) {
        const l = doc.links[lid];
        if (l.type === 'parent' && l.to === cur) stack.push(l.from);
      }
    }
    return false;
  }
  store.wouldCycle = wouldCycle;

  store.linkExists = function (from, to, type) {
    return Object.values(doc.links).some(l =>
      l.type === type && ((l.from === from && l.to === to) ||
        (type !== 'parent' && l.from === to && l.to === from)));
  };

  /**
   * Create a link. Returns {ok, link, reason}.
   * parent: from = parent, to = child.
   */
  store.addLink = function (from, to, type, opts) {
    type = LINK_TYPES.includes(type) ? type : 'parent';
    if (!doc.people[from] || !doc.people[to]) return { ok: false, reason: 'missing' };
    if (from === to) return { ok: false, reason: 'self' };
    if (store.linkExists(from, to, type)) return { ok: false, reason: 'duplicate' };
    if (type === 'parent' && wouldCycle(from, to)) return { ok: false, reason: 'cycle' };
    const link = { id: U.uid('l'), from, to, type, label: (opts && opts.label) || '' };
    store.batch('link', () => { doc.links[link.id] = link; changed('links'); });
    store.seal();
    return { ok: true, link };
  };

  store.removeLink = function (id) {
    if (!doc.links[id]) return false;
    store.batch('unlink', () => { delete doc.links[id]; changed('links'); });
    store.seal();
    return true;
  };

  /** Remove any link (either direction) between two people. */
  store.unlinkPair = function (a, b, type) {
    let n = 0;
    store.batch('unlink', () => {
      for (const id in doc.links) {
        const l = doc.links[id];
        if (type && l.type !== type) continue;
        if ((l.from === a && l.to === b) || (l.from === b && l.to === a)) { delete doc.links[id]; n++; }
      }
      if (n) changed('links');
    });
    return n;
  };

  store.setSetting = function (key, value) {
    snapshot('setting');
    doc.settings[key] = value;
    changed('settings');
  };

  store.setView = function (v) {
    // View position is saved, but must never enter the undo stack.
    doc.view = { x: v.x, y: v.y, k: v.k };
    scheduleSave();
  };

  /* ---------- preferences (app-level, not per board) ---------- */
  store.prefs = function () {
    const p = lsGet(LS.prefs, {});
    return (p && typeof p === 'object') ? p : {};
  };
  store.setPref = function (key, value) {
    const p = store.prefs();
    p[key] = value;
    lsSet(LS.prefs, p);
  };

  BB.store = store;
  BB.model = { blankPerson, blankDoc, normalizeDoc, normalizePerson, deriveYears, SCHEMA, LINK_TYPES };
})(window.BB);
