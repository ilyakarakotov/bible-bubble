/* Bible Bubble — import, export and printable outlines. */
(function (BB) {
  'use strict';
  const U = BB.util;

  let S, L;

  const stamp = () => new Date().toISOString().slice(0, 10);
  const slug = (s) => String(s || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'board';

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 400);
  }

  /* ---------- handing the file over ---------- */
  /**
   * A download inside an installed app on iOS lands somewhere the reader cannot
   * see, and there is no downloads shelf to tell them it happened. Where the
   * device can take a file, hand it to the share sheet instead — "Save to
   * Files" is in there next to every app they might send it to. Everywhere else
   * — desktop, file:// — none of this exists and the download runs as before.
   */
  let shareable = null;
  function canShare() {
    if (shareable !== null) return shareable;
    shareable = false;
    try {
      if (typeof File === 'function' && navigator.share && navigator.canShare) {
        shareable = !!navigator.canShare({ files: [new File(['{}'], 'probe.json', { type: 'application/json' })] });
      }
    } catch (_) { shareable = false; }
    return shareable;
  }

  /** A phone, or the app installed on one: the two places a download is no use. */
  const handheld = () => !!((BB.app && BB.app.isPhone && BB.app.isPhone()) ||
    (BB.pwa && BB.pwa.isStandalone && BB.pwa.isStandalone()));

  function deliver(filename, text, mime, note, always) {
    const fallback = () => { download(filename, text, mime); if (note) U.toast(note); };
    if (!canShare() || !(always || handheld())) { fallback(); return; }
    let shared;
    try {
      shared = navigator.share({
        files: [new File([text], filename, { type: mime })],
        title: (S.doc && S.doc.name) || 'Bible Bubble',
      });
    } catch (_) { fallback(); return; }
    Promise.resolve(shared).catch((err) => {
      // Cancelling the sheet is an answer, not a failure. Anything else — no
      // gesture left, a target that refuses files — falls back to the file.
      if (err && err.name === 'AbortError') return;
      fallback();
    });
  }

  /* ---------- JSON ---------- */
  function exportJSON(always) {
    const doc = U.deepClone(S.doc);
    const payload = Object.assign({ app: 'bible-bubble', exported: new Date().toISOString() }, doc);
    deliver(`${slug(doc.name)}-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json',
      'Exported ' + U.plural(Object.keys(doc.people).length, 'person', 'people'), always === true);
  }

  /** "Share this board" — the same file, offered to the share sheet first. */
  const shareBoard = () => exportJSON(true);

  /**
   * Read a file the user picked. Returns a promise for the parsed object.
   */
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        try { resolve(JSON.parse(String(fr.result))); }
        catch (e) { reject(new Error('That file is not valid JSON.')); }
      };
      fr.onerror = () => reject(new Error('Could not read that file.'));
      fr.readAsText(file);
    });
  }

  /* ---------- Markdown ---------- */
  function toMarkdown(doc) {
    const d = doc || S.doc;
    const st = d.settings;
    const idx = L.index(d);
    const out = [];
    const fmt = (p) => {
      const span = U.formatSpan(p.birth, p.death, { mode: st.yearMode === 'am' ? 'am' : 'era', anchor: st.anchor, approx: p.approx });
      const bits = [];
      if (span) bits.push(span);
      if (U.isNum(p.age)) bits.push('lived ' + p.age);
      return bits.join(', ');
    };

    out.push('# ' + d.name, '');
    const s = L.stats(d);
    const bonds = s.bonds ? `, ${U.plural(s.bonds, 'connection')}` : '';
    out.push(`_${U.plural(s.people, 'person', 'people')}, ${U.plural(s.links, 'link')}${bonds}, ${s.generations} generations._`, '');

    const seen = new Set();
    const walk = (id, depth) => {
      const p = d.people[id];
      if (!p) return;
      const pad = '  '.repeat(depth);
      if (seen.has(id)) { out.push(`${pad}- **${p.name}** _(see above)_`); return; }
      seen.add(id);
      const meta = fmt(p);
      const spouses = (idx.spouses.get(id) || []).map(s2 => d.people[s2] && d.people[s2].name).filter(Boolean);
      let line = `${pad}- **${p.name}**`;
      if (p.role) line += ` — ${p.role}`;
      if (meta) line += ` (${meta})`;
      if (spouses.length) line += ` · with ${spouses.join(', ')}`;
      out.push(line);
      if (p.refs.length) out.push(`${pad}  - _${p.refs.join(' · ')}_`);
      p.highlights.forEach(h => out.push(`${pad}  - ${h}`));
      L.bondsOf(id, d).forEach(b => {
        const other = d.people[b.id];
        if (!other) return;
        const k = BB.model.bondKind(b.kind);
        const phrase = b.dir === 'out' ? k.out : k.in;
        const tail = [b.label, b.note].filter(Boolean).join(' · ');
        out.push(`${pad}  - ${phrase} **${other.name || 'Unnamed'}**${tail ? ' — ' + tail : ''}`);
      });
      if (p.notes && p.notes.trim()) {
        p.notes.trim().split(/\n+/).forEach(n => out.push(`${pad}  - > ${n}`));
      }
      (idx.children.get(id) || []).forEach(k => walk(k, depth + 1));
    };
    idx.roots.forEach(r => walk(r, 0));

    const orphans = Object.keys(d.people).filter(id => !seen.has(id));
    if (orphans.length) {
      out.push('', '## Not placed in a line', '');
      orphans.forEach(id => walk(id, 0));
    }
    out.push('', '---', `_Exported from Bible Bubble on ${stamp()}._`);
    return out.join('\n');
  }

  function exportMarkdown() {
    deliver(`${slug(S.doc.name)}-${stamp()}.md`, toMarkdown(), 'text/markdown', 'Exported a Markdown outline');
  }

  /* ---------- CSV (one row per person) ---------- */
  function toCSV(doc) {
    const d = doc || S.doc;
    const idx = L.index(d);
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const nameOf = (id) => (d.people[id] ? d.people[id].name : '');
    const head = ['name', 'aka', 'sex', 'role', 'era', 'generation', 'birth_am', 'death_am', 'age', 'approx',
      'parents', 'spouses', 'children', 'connections', 'refs', 'highlights', 'tags', 'notes'];
    const rows = [head.join(',')];
    Object.values(d.people).forEach(p => {
      rows.push([
        p.name, p.aka.join(' | '), p.sex, p.role, p.era, (idx.depth.get(p.id) || 0) + 1,
        p.birth, p.death, p.age, p.approx ? 'yes' : '',
        (idx.parents.get(p.id) || []).map(nameOf).join(' | '),
        (idx.spouses.get(p.id) || []).map(nameOf).join(' | '),
        (idx.children.get(p.id) || []).map(nameOf).join(' | '),
        L.bondsOf(p.id, d).map(b => {
          const k = BB.model.bondKind(b.kind);
          return `${b.dir === 'out' ? k.out : k.in} ${nameOf(b.id)}`;
        }).join(' | '),
        p.refs.join(' | '), p.highlights.join(' | '), p.tags.join(' | '), p.notes,
      ].map(esc).join(','));
    });
    return rows.join('\n');
  }

  function exportCSV() {
    deliver(`${slug(S.doc.name)}-${stamp()}.csv`, toCSV(), 'text/csv', 'Exported a spreadsheet');
  }

  function init() { S = BB.store; L = BB.lineage; }

  BB.io = {
    init, exportJSON, exportMarkdown, exportCSV, readFile, toMarkdown, toCSV, download,
    shareBoard, canShare,
  };
})(window.BB);
