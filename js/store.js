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

  /* ---------- bond kinds ----------
     Links that are not lineage. out/in are how the relation reads from each end;
     dir 'mutual' means the arrow is meaningless. hue names a colour that already
     exists as --c-<hue> in the stylesheet.                                      */
  const BOND_KINDS = [
    { id:'ally',     label:'Ally',        out:'Ally of',          in:'Ally of',          dir:'mutual',   hue:'olive' },
    { id:'rival',    label:'Rival',       out:'Rival of',         in:'Rival of',         dir:'mutual',   hue:'clay'  },
    { id:'mentor',   label:'Mentor',      out:'Mentor of',        in:'Taught by',        dir:'directed', hue:'sky'   },
    { id:'prophet',  label:'Prophet to',  out:'Prophet to',       in:'Warned by',        dir:'directed', hue:'plum'  },
    { id:'anointed', label:'Anointed',    out:'Anointed',         in:'Anointed by',      dir:'directed', hue:'sand'  },
    { id:'servant',  label:'Servant of',  out:'Servant of',       in:'Served by',        dir:'directed', hue:'stone' },
    { id:'covenant', label:'Covenant',    out:'In covenant with', in:'In covenant with', dir:'mutual',   hue:'teal'  },
    { id:'kin',      label:'Kin',         out:'Kin of',           in:'Kin of',           dir:'mutual',   hue:'rose'  },
    { id:'rescued',  label:'Rescued',     out:'Rescued',          in:'Rescued by',       dir:'directed', hue:'olive' },
    { id:'harmed',   label:'Harmed',      out:'Harmed',           in:'Harmed by',        dir:'directed', hue:'clay'  },
    { id:'met',      label:'Met',         out:'Met',              in:'Met',              dir:'mutual',   hue:'stone' },
    { id:'other',    label:'Connected',   out:'Connected to',     in:'Connected to',     dir:'mutual',   hue:'stone' },
  ];
  const BOND_BY_ID = new Map(BOND_KINDS.map(k => [k.id, k]));
  const BOND_FALLBACK = BOND_BY_ID.get('other');

  /** The row for a bond kind. Anything unknown reads as the plain "connected" bond. */
  function bondKind(id) {
    return (typeof id === 'string' && BOND_BY_ID.get(id)) || BOND_FALLBACK;
  }

  /** A kind only means something on a bond; lineage links carry ''. */
  function normalizeKind(type, kind) {
    if (type !== 'other') return '';
    return (typeof kind === 'string' && BOND_BY_ID.has(kind)) ? kind : 'other';
  }

  const clampText = (v, n) => String(v == null ? '' : v).slice(0, n);

  /**
   * The key two links share when they are the same relation: parent links are
   * ordered, spouse and bond links are unordered pairs, and two bonds only clash
   * when they are the same kind — the same pair may be both rival and kin.
   */
  function linkKey(from, to, type, kind) {
    const pair = type === 'parent' ? from + '>' + to
      : (from < to ? from + '~' + to : to + '~' + from);
    return type + '|' + pair + (type === 'other' ? '|' + kind : '');
  }

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
    const seenLinks = new Set();
    links.forEach(lr => {
      if (!lr || typeof lr !== 'object') return;
      const from = String(lr.from || '');
      const to = String(lr.to || '');
      if (!d.people[from] || !d.people[to] || from === to) return;      // drop dangling links
      const type = LINK_TYPES.includes(lr.type) ? lr.type : 'parent';
      const kind = normalizeKind(type, lr.kind);       // boards saved before bonds carry none
      const key = linkKey(from, to, type, kind);
      if (seenLinks.has(key)) return;                  // collapse duplicates (and mirrored spouse links)
      seenLinks.add(key);
      let id = typeof lr.id === 'string' && lr.id ? lr.id : U.uid('l');
      if (d.links[id]) id = U.uid('l');                // two rows claiming one id
      d.links[id] = {
        id, from, to, type, kind,
        label: clampText(lr.label, 60),
        note: clampText(lr.note, 500),
      };
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

  /**
   * Is there already a link of this type between these two? `kind` is only
   * consulted for bonds; leave it out to ask about a bond of any kind.
   */
  store.linkExists = function (from, to, type, kind) {
    const wanted = (type === 'other' && kind != null && kind !== '') ? normalizeKind(type, kind) : null;
    return Object.values(doc.links).some(l => {
      if (l.type !== type) return false;
      const pair = type === 'parent'
        ? (l.from === from && l.to === to)
        : ((l.from === from && l.to === to) || (l.from === to && l.to === from));
      if (!pair) return false;
      return wanted === null || normalizeKind('other', l.kind) === wanted;
    });
  };

  /**
   * Create a link. Returns {ok, link} or {ok:false, reason}.
   * parent: from = parent, to = child. opts: {label, kind, note}.
   */
  store.addLink = function (from, to, type, opts) {
    type = LINK_TYPES.includes(type) ? type : 'parent';
    const o = opts || {};
    if (!doc.people[from] || !doc.people[to]) return { ok: false, reason: 'missing' };
    if (from === to) return { ok: false, reason: 'self' };
    const kind = normalizeKind(type, o.kind);
    if (store.linkExists(from, to, type, kind)) return { ok: false, reason: 'duplicate' };
    if (type === 'parent' && wouldCycle(from, to)) return { ok: false, reason: 'cycle' };
    const link = {
      id: U.uid('l'), from, to, type, kind,
      label: clampText(o.label, 60),
      note: clampText(o.note, 500),
    };
    store.batch('link', () => { doc.links[link.id] = link; changed('links'); });
    store.seal();
    return { ok: true, link };
  };

  /**
   * Edit a link in place: kind (bonds only), label, note. Returns the link, or
   * null when the id is unknown, a kind was asked for on a lineage link, or the
   * new kind would duplicate a bond these two already have.
   */
  store.updateLink = function (id, patch) {
    const l = doc.links[id];
    if (!l || !patch || typeof patch !== 'object') return null;
    const next = {};
    if ('kind' in patch) {
      const wants = patch.kind == null ? '' : String(patch.kind);
      if (l.type !== 'other') {
        if (wants) return null;                      // a kind means nothing on lineage
      } else {
        const kind = normalizeKind('other', wants);
        if (kind !== l.kind && store.linkExists(l.from, l.to, 'other', kind)) return null;
        next.kind = kind;
      }
    }
    if ('label' in patch) next.label = clampText(patch.label, 60);
    if ('note' in patch) next.note = clampText(patch.note, 500);
    const keys = Object.keys(next);
    if (!keys.length) return l;
    // Same label as updatePerson uses, so typing into one field is one undo step.
    snapshot('link:' + id + ':' + keys.join(','));
    Object.assign(l, next);
    changed('links');
    return l;
  };

  /** Every link joining two people, either direction, any type. */
  store.linksBetween = function (a, b) {
    return Object.values(doc.links).filter(l =>
      (l.from === a && l.to === b) || (l.from === b && l.to === a));
  };

  /** Every connection — the links that are not lineage. */
  store.bonds = function () {
    return Object.values(doc.links).filter(l => l.type === 'other');
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
  BB.model = {
    blankPerson, blankDoc, normalizeDoc, normalizePerson, deriveYears,
    SCHEMA, LINK_TYPES, BOND_KINDS, bondKind,
  };
})(window.BB);
