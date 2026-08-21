/**
 * Bible Bubble — end-to-end smoke test.
 *
 *   npm install --no-save playwright
 *   node test/smoke.js
 *
 * Serves the app on a local port, drives it in a real browser, and fails on any
 * console error or unmet expectation. Set HEADED=1 to watch it run.
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* What the starter board should contain. Update these when the seed changes. */
const SEED = { people: 109, links: 178, bonds: 40 };

const PORT = Number(process.env.PORT || 8799);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Use CHROME_PATH if given, else a chromium already sitting in
 * PLAYWRIGHT_BROWSERS_PATH, else let Playwright find its own download.
 */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base).filter(d => d.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(base, dir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    executablePath: findChrome(),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  let failures = 0;
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const step = async (name, fn) => {
    const before = errors.length;
    try { await fn(); } catch (e) { errors.push(`"${name}": ${e.message}`); }
    await page.waitForTimeout(200);
    const fresh = errors.slice(before);
    if (fresh.length) failures++;
    console.log((fresh.length ? '  x ' : '  . ') + name + (fresh.length ? '\n      ' + fresh.join('\n      ') : ''));
  };
  const bubbles = () => page.locator('.bubble').count();
  /**
   * Bubbles live in a transformed world, so Playwright cannot scroll one into
   * view. Centre it through the app itself, and match on id rather than text
   * (someone else's highlight may well mention this person by name).
   */
  const centreOn = async (name) => {
    const id = await page.evaluate((n) => {
      const p = Object.values(window.BB.store.doc.people).find(x => x.name === n);
      if (!p) return null;
      window.BB.canvas.select([p.id]);
      window.BB.canvas.focus(p.id, { zoom: 1, animate: false, flash: false });
      return p.id;
    }, name);
    if (!id) throw new Error('no person named ' + name);
    await page.waitForTimeout(350);
    return page.locator(`.bubble[data-id="${id}"]`);
  };
  const links = () => page.evaluate(() => Object.keys(window.BB.store.doc.links).length);

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  console.log('\nfirst run');
  await step('welcome modal offers the starter lineage', async () => {
    const t = await page.textContent('.modal-head h3');
    if (!/Welcome/.test(t)) throw new Error('got: ' + t);
  });
  await step(`starter lineage loads ${SEED.people} people`, async () => {
    await page.click('button:has-text("Start from Adam")');
    await page.waitForTimeout(1400);
    const n = await bubbles();
    if (n !== SEED.people) throw new Error('bubbles: ' + n);
    if (await links() !== SEED.links) throw new Error('links: ' + await links());
  });
  await step('lands at a readable zoom on the head of the line', async () => {
    const z = parseInt(await page.textContent('.zoom-label'), 10);
    if (z < 50) throw new Error('landed at ' + z + '%');
    const onscreen = await page.evaluate(() => {
      const n = [...document.querySelectorAll('.bubble')].find(b => b.textContent.startsWith('Adam'));
      const r = n.getBoundingClientRect();
      return r.width > 120 && r.top > 40 && r.top < 900;
    });
    if (!onscreen) throw new Error('Adam is not legible on screen');
  });
  await step('sidebar lists deep generations without truncating', async () => {
    const names = await page.$$eval('.tree-row .tree-name', ns => ns.slice(0, 20).map(n => n.textContent));
    if (!names.includes('Abraham')) throw new Error('outline stops early: ' + names.join(','));
    const overflow = await page.evaluate(() => { const b = document.querySelector('#side-body'); return b.scrollWidth > b.clientWidth + 4; });
    if (overflow) throw new Error('sidebar overflows horizontally');
  });

  console.log('\nreading');
  await step('search jumps to a person', async () => {
    await page.fill('#search-input', 'methus');
    await page.waitForTimeout(300);
    await page.click('.sr-item');
    await page.waitForTimeout(600);
    if (await page.inputValue('.insp-name-input') !== 'Methuselah') throw new Error('wrong person');
  });
  await step('inspector shows the line of descent from Adam', async () => {
    const crumbs = await page.textContent('.path-crumbs');
    if (!/^Adam/.test(crumbs)) throw new Error(crumbs.slice(0, 60));
  });
  await step('trace lights the line and dims the rest', async () => {
    await page.click('button:has-text("Trace this line")');
    await page.waitForTimeout(400);
    const lit = await page.locator('.bubble.is-lit').count();
    const dim = await page.locator('.bubble.is-dim').count();
    if (!lit || !dim) throw new Error(`lit ${lit} dim ${dim}`);
    await page.click('#trace-bar button:has-text("Clear")');
  });

  console.log('\ntimeline');
  await step('lifespan bars render', async () => {
    await page.click('.tab[data-view="timeline"]');
    await page.waitForTimeout(800);
    if (await page.locator('.tl-bar').count() < 40) throw new Error('too few bars');
  });
  await step('lifespan bars are actually painted', async () => {
    // A custom property set through a style object is silently dropped, which
    // once left every bar transparent while still laying out correctly.
    const bar = await page.evaluate(() => {
      const b = document.querySelector('.tl-bar');
      if (!b) return null;
      const cs = getComputedStyle(b);
      return { bg: cs.backgroundColor, w: Math.round(b.getBoundingClientRect().width) };
    });
    if (!bar) throw new Error('no bars');
    if (/rgba\(0, 0, 0, 0\)|transparent/.test(bar.bg)) throw new Error('bars are invisible: ' + bar.bg);
    if (bar.w < 2) throw new Error('bar width ' + bar.w);
  });

  await step('scrubber reports who was alive', async () => {
    await page.check('#tl-scrub');
    await page.waitForTimeout(500);
    if (!/alive/.test(await page.textContent('#tl-alive'))) throw new Error('nothing reported');
  });
  await step('generation mode renders', async () => {
    await page.click('[data-tlmode="generations"]');
    await page.waitForTimeout(500);
    if (!(await page.locator('.tl-bar').count())) throw new Error('no bars');
    await page.click('[data-tlmode="years"]');
    await page.click('.tab[data-view="canvas"]');
    await page.waitForTimeout(400);
  });

  console.log('\nbuilding a line');
  await step('right-click menu action runs', async () => {
    const before = await bubbles();
    const adam = await centreOn('Adam');
    await adam.click({ button: 'right' });
    await page.waitForTimeout(300);
    await page.click('.menu-item:has-text("Add a son")');
    await page.waitForTimeout(500);
    if (await bubbles() !== before + 1) throw new Error('no person added');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(400);
  });
  await step('drag the down handle to make a linked child', async () => {
    const before = await bubbles(), beforeLinks = await links();
    const b = await centreOn('Abel');
    await b.hover();
    const h = await b.locator('.b-handle.h-bottom').boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 30, h.y + 220, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    if (await bubbles() !== before + 1) throw new Error('no child created');
    if (await links() !== beforeLinks + 1) throw new Error('not linked');
    await page.keyboard.press('Escape');          // leave the name field first
    await page.keyboard.press('Control+z');       // undo the link
    await page.keyboard.press('Control+z');       // undo the person
    await page.waitForTimeout(500);
    if (await bubbles() !== before) throw new Error('undo left ' + (await bubbles() - before) + ' behind');
    if (await links() !== beforeLinks) throw new Error('undo left a stray link');
  });
  await step('a cycle is refused', async () => {
    const res = await page.evaluate(() => {
      const d = window.BB.store.doc;
      const find = n => Object.values(d.people).find(p => p.name === n);
      return window.BB.store.addLink(find('Seth').id, find('Adam').id, 'parent');
    });
    if (res.ok || res.reason !== 'cycle') throw new Error(JSON.stringify(res));
  });
  await step('sex toggle and colour swatch update the panel', async () => {
    await page.fill('#search-input', 'Ruth');
    await page.waitForTimeout(300);
    await page.click('.sr-item');
    await page.waitForTimeout(500);
    await page.click('.seg button:has-text("Male")');
    await page.waitForTimeout(300);
    if ((await page.textContent('.seg button.is-on')).trim() !== 'Male') throw new Error('sex toggle stuck');
    await page.click('.seg button:has-text("Female")');
    await page.locator('.insp-swatch').nth(4).click();
    await page.waitForTimeout(300);
    const idx = await page.evaluate(() => [...document.querySelectorAll('.insp-swatch')].findIndex(s => s.classList.contains('is-on')));
    if (idx !== 4) throw new Error('swatch ring stuck at ' + idx);
  });
  await step('notes and highlights survive a reload', async () => {
    await page.click('button:has-text("+ Add a highlight")');
    await page.waitForTimeout(300);
    await page.keyboard.type('Gleaned in the field of Boaz.');
    await page.fill('#inspector textarea[placeholder^="Anything"]', 'Compare Ruth 1:16.');
    await page.waitForTimeout(900);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const p = await page.evaluate(() => Object.values(window.BB.store.doc.people).find(x => x.name === 'Ruth'));
    if (!p.highlights.some(h => /Gleaned/.test(h))) throw new Error('highlight lost');
    if (!/Ruth 1:16/.test(p.notes)) throw new Error('notes lost');
  });


  console.log('\nconnections');
  await step('the starter board carries non-lineage connections', async () => {
    const r = await page.evaluate(() => {
      const kinds = new Set(window.BB.model.BOND_KINDS.map(k => k.id));
      const bonds = window.BB.store.bonds();
      const bad = bonds.filter(b => !kinds.has(b.kind) || b.from === b.to ||
        !window.BB.store.person(b.from) || !window.BB.store.person(b.to));
      return { n: bonds.length, bad: bad.length, unlabelled: bonds.filter(b => !b.label).length,
        stats: window.BB.lineage.stats(window.BB.store.doc).bonds };
    });
    if (r.n !== SEED.bonds) throw new Error('connections: ' + r.n);
    if (r.bad) throw new Error(r.bad + ' malformed connections');
    if (r.unlabelled) throw new Error(r.unlabelled + ' connections with nothing written on them');
    if (r.stats !== r.n) throw new Error('stats disagree: ' + r.stats);
  });

  await step('a connection is drawn as a coloured arc, not a lineage line', async () => {
    const bond = await page.evaluate(() => {
      const b = window.BB.store.bonds()[0];
      window.BB.canvas.focus(b.from, { zoom: 0.7, animate: false, flash: false });
      return b.id;
    });
    await page.waitForTimeout(400);
    const e = await page.evaluate((id) => {
      const g = document.querySelector(`.edge[data-id="${id}"]`);
      if (!g) return null;
      const p = g.querySelector('.edge-path');
      return { cls: g.getAttribute('class'), d: p.getAttribute('d'),
        stroke: getComputedStyle(p).stroke, title: (g.querySelector('title') || {}).textContent };
    }, bond);
    if (!e) throw new Error('the connection is not on the canvas');
    if (!/kind-/.test(e.cls)) throw new Error('no kind on the edge: ' + e.cls);
    if (!/^M .* Q /.test(e.d)) throw new Error('not an arc: ' + e.d);
    // A custom property applied through a style object is dropped silently, and
    // that once left every one of these invisible while still laying out right.
    if (/rgba\(0, 0, 0, 0\)|transparent/.test(e.stroke)) throw new Error('invisible: ' + e.stroke);
    if (!e.title) throw new Error('no tooltip on the connection');
  });

  await step('the same link reads correctly from both ends', async () => {
    const r = await page.evaluate(() => {
      const b = window.BB.store.bonds()[0];
      const k = window.BB.model.bondKind(b.kind);
      const out = window.BB.lineage.bondsOf(b.from).find(x => x.linkId === b.id);
      const back = window.BB.lineage.bondsOf(b.to).find(x => x.linkId === b.id);
      return { out: out && out.dir, back: back && back.dir, from: k.out, to: k.in };
    });
    if (r.out !== 'out' || r.back !== 'in') throw new Error(JSON.stringify(r));
  });

  await step('making a connection through the dialog', async () => {
    const before = await links();
    await page.evaluate(() => {
      const p = Object.values(window.BB.store.doc.people).find(x => x.name === 'Enoch');
      window.BB.canvas.select([p.id]);
      window.BB.app.addBond(p.id);
    });
    await page.waitForTimeout(350);
    await page.fill('.modal input[type="search"]', 'Noah');
    await page.waitForTimeout(300);
    await page.click('.picker-item');
    await page.click('.kind-chips .chip[data-kind="mentor"]');
    await page.fill('.bond-label', 'Walked with God before him');
    await page.click('.modal-foot .btn.primary');
    await page.waitForTimeout(450);
    if (await links() !== before + 1) throw new Error('link not added');
    const made = await page.evaluate(() =>
      window.BB.store.bonds().find(b => b.label === 'Walked with God before him'));
    if (!made || made.kind !== 'mentor') throw new Error(JSON.stringify(made));
  });

  await step('the same pair can hold two different connections but not two of a kind', async () => {
    const r = await page.evaluate(() => {
      const b = window.BB.store.bonds().find(x => x.label === 'Walked with God before him');
      const second = window.BB.store.addLink(b.from, b.to, 'other', { kind: 'ally' });
      const repeat = window.BB.store.addLink(b.to, b.from, 'other', { kind: 'mentor' });
      return { second: second.ok, repeat: repeat.reason };
    });
    if (!r.second) throw new Error('a second kind was refused');
    if (r.repeat !== 'duplicate') throw new Error('a repeat was allowed: ' + r.repeat);
  });

  await step('deleting a person takes their connections with them', async () => {
    const r = await page.evaluate(() => {
      const p = window.BB.store.addPerson({ name: 'Passing acquaintance' });
      const anchor = Object.values(window.BB.store.doc.people).find(x => x.name === 'Noah');
      window.BB.store.addLink(anchor.id, p.id, 'other', { kind: 'met' });
      const mid = Object.keys(window.BB.store.doc.links).length;
      window.BB.store.removePeople([p.id]);
      return { mid, after: Object.keys(window.BB.store.doc.links).length };
    });
    if (r.after !== r.mid - 1) throw new Error(JSON.stringify(r));
    await page.evaluate(() => { window.BB.store.undo(); window.BB.store.undo(); window.BB.store.undo(); });
    await page.waitForTimeout(300);
  });

  console.log('\nthe web');
  await step('the web view draws every person', async () => {
    await page.click('.tab[data-view="web"]');
    await page.waitForTimeout(2600);
    const r = await page.evaluate(() => {
      const c = document.querySelector('#web-canvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) ink++;
      return { w: c.width, h: c.height, ink, rank: document.querySelector('#web-rank').textContent };
    });
    if (r.w < 200 || r.h < 200) throw new Error('canvas is ' + r.w + 'x' + r.h);
    if (r.ink < 20) throw new Error('the web is blank: ' + r.ink + ' samples with ink');
    if (!/Jacob/.test(r.rank)) throw new Error('ranking looks wrong: ' + r.rank.slice(0, 80));
  });

  await step('the most-connected list agrees with the graph', async () => {
    const r = await page.evaluate(() => {
      const top = window.BB.lineage.ranking(window.BB.store.doc, 3);
      return top.map(t => ({
        name: window.BB.store.person(t.id).name,
        degree: t.degree,
        counted: window.BB.lineage.neighbours(t.id).length,
      }));
    });
    r.forEach(x => { if (x.degree !== x.counted) throw new Error(JSON.stringify(x)); });
    if (r[0].degree < r[1].degree) throw new Error('not sorted: ' + JSON.stringify(r));
  });

  await step('how far apart counts the hops between two people', async () => {
    const r = await page.evaluate(() => {
      const byName = (n) => Object.values(window.BB.store.doc.people).find(p => p.name === n);
      const path = window.BB.lineage.connectionPath(byName('Adam').id, byName('Jesus').id);
      const none = window.BB.lineage.connectionPath(byName('Adam').id, 'nobody-at-all');
      return { hops: path && path.hops, len: path && path.ids.length,
        steps: path && path.steps.length, none };
    });
    if (!r.hops || r.hops < 40) throw new Error('Adam to Jesus in ' + r.hops + ' hops');
    if (r.len !== r.hops + 1 || r.steps !== r.hops) throw new Error(JSON.stringify(r));
    if (r.none !== null) throw new Error('a missing person found a path');
  });

  await step('the web survives a theme switch', async () => {
    await page.click('[data-act="theme"]');
    await page.waitForTimeout(700);
    await page.click('[data-act="theme"]');
    await page.waitForTimeout(700);
    await page.click('.tab[data-view="canvas"]');
    await page.waitForTimeout(400);
  });

  console.log('\nboards and files');
  await step('tidy layout leaves no overlapping bubbles', async () => {
    await page.click('[data-act="layout"]');
    await page.waitForTimeout(1400);
    const overlaps = await page.evaluate(() => {
      const bs = [...document.querySelectorAll('.bubble')].map(b => ({
        x: parseFloat(b.style.left), y: parseFloat(b.style.top), w: b.offsetWidth, h: b.offsetHeight,
      }));
      let n = 0;
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], c = bs[j];
        if (a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y) n++;
      }
      return n;
    });
    if (overlaps) throw new Error(overlaps + ' overlapping pairs');
  });
  await step('new board, then switch back', async () => {
    await page.click('#board-menu-btn');
    await page.waitForTimeout(250);
    await page.click('.menu-item:has-text("New empty board")');
    await page.waitForTimeout(700);
    if (await bubbles() !== 0) throw new Error('new board not empty');
    await page.selectOption('#board-select', { index: await page.evaluate(() =>
      [...document.querySelector('#board-select').options].findIndex(o => /Genesis/.test(o.textContent))) });
    await page.waitForTimeout(900);
    if (await bubbles() < 100) throw new Error('seed board did not come back');
  });
  await step('export round-trips without losing anyone', async () => {
    const out = await page.evaluate(() => {
      const before = { people: window.BB.store.count(), links: Object.keys(window.BB.store.doc.links).length };
      const raw = JSON.parse(JSON.stringify(window.BB.store.doc));
      window.BB.store.createBoard('Round trip', raw);
      return { before, after: { people: window.BB.store.count(), links: Object.keys(window.BB.store.doc.links).length } };
    });
    if (out.before.people < 100) throw new Error('unexpected board: ' + JSON.stringify(out.before));
    if (out.after.people !== out.before.people || out.after.links !== out.before.links) {
      throw new Error('lost data: ' + JSON.stringify(out));
    }
  });
  await step('malformed import is sanitised, not trusted', async () => {
    const r = await page.evaluate(() => {
      window.BB.store.createBoard('Junk', { people: [{ name: 'X' }, null, 'nope'], links: [{ from: 'a', to: 'b' }, 42] });
      return { people: window.BB.store.count(), links: Object.keys(window.BB.store.doc.links).length };
    });
    if (r.people !== 1 || r.links !== 0) throw new Error(JSON.stringify(r));
  });
  await step('markdown export carries the tree', async () => {
    await page.selectOption('#board-select', { index: await page.evaluate(() =>
      [...document.querySelector('#board-select').options].findIndex(o => /Genesis/.test(o.textContent))) });
    await page.waitForTimeout(800);
    const md = await page.evaluate(() => window.BB.io.toMarkdown());
    if (!/Adam/.test(md) || !/Jesus/.test(md)) throw new Error('incomplete outline');
    if (!/connection/.test(md.split('\n')[2])) throw new Error('no connection count in the summary');
  });

  const other = errors.length - errors.filter(e => /^"/.test(e)).length;
  console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${failures} failing step(s), ${other} console/page error(s)`);
  if (errors.length) errors.forEach(e => console.log('  ' + e));
  await browser.close();
  server.close();
  process.exit(errors.length ? 1 : 0);
})();
