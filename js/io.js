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

  /* ---------- JSON ---------- */
  function exportJSON() {
    const doc = U.deepClone(S.doc);
    const payload = Object.assign({ app: 'bible-bubble', exported: new Date().toISOString() }, doc);
    download(`${slug(doc.name)}-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
    U.toast('Exported ' + U.plural(Object.keys(doc.people).length, 'person', 'people'));
  }

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
    download(`${slug(S.doc.name)}-${stamp()}.md`, toMarkdown(), 'text/markdown');
    U.toast('Exported a Markdown outline');
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
    download(`${slug(S.doc.name)}-${stamp()}.csv`, toCSV(), 'text/csv');
    U.toast('Exported a spreadsheet');
  }

  function init() { S = BB.store; L = BB.lineage; }

  BB.io = { init, exportJSON, exportMarkdown, exportCSV, readFile, toMarkdown, toCSV, download };
})(window.BB);
