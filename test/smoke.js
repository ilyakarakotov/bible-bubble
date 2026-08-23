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

  await step('two connections between the same pair draw as two threads', async () => {
    // The starter board has 18 pairs carrying more than one link, 13 of them a
    // connection sharing a pair with a lineage line. Drawn as plain segments the
    // two land on the same pixels and the second cannot be seen at all — which
    // is the one thing this view exists to show. Checked on a board of its own,
    // so the only ink on the canvas is the two circles and the threads.
    const home = await page.evaluate(() => {
      const S = window.BB.store, was = S.doc.id;
      const twin = S.createBoard('Twin threads');
      const a = S.addPerson({ name: 'Ay', x: -170, y: 0 }).id;
      const b = S.addPerson({ name: 'Bee', x: 170, y: 0 }).id;
      S.addLink(a, b, 'other', { kind: 'ally' });
      return { was, twin, a, b };
    });
    await page.selectOption('#web-labels', 'none');
    await page.waitForTimeout(2200);
    // The view keeps the last board's zoom, and two people at the zoom that
    // fitted 109 of them are specks. Fit before measuring.
    await page.evaluate(() => window.BB.web.fit());
    await page.waitForTimeout(900);

    // Find the two circles — ink with more ink 4px away on every side, which a
    // hairline thread never has — then measure how far the thread ink strays
    // from the straight line joining their centres.
    const spread = () => page.evaluate(() => {
      const c = document.querySelector('#web-canvas');
      const W = c.width, H = c.height;
      const d = c.getContext('2d').getImageData(0, 0, W, H).data;
      const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] > 0;
      const ink = [], disk = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!on(x, y)) continue;
        ink.push([x, y]);
        if (on(x - 4, y) && on(x + 4, y) && on(x, y - 4) && on(x, y + 4)) disk.push([x, y]);
      }
      if (disk.length < 2 || !ink.length) return null;
      const mid = (list, i) => list.reduce((sum, q) => sum + q[i], 0) / list.length;
      let A = disk[0];
      for (let i = 0; i < 3; i++) {
        const near = disk.filter(q => Math.hypot(q[0] - A[0], q[1] - A[1]) < 40);
        if (!near.length) break;
        A = [mid(near, 0), mid(near, 1)];
      }
      const far = disk.filter(q => Math.hypot(q[0] - A[0], q[1] - A[1]) >= 40);
      if (!far.length) return null;
      const B = [mid(far, 0), mid(far, 1)];
      const vx = B[0] - A[0], vy = B[1] - A[1], len = Math.hypot(vx, vy) || 1;
      let worst = 0;
      ink.forEach(([x, y]) => {
        const t = ((x - A[0]) * vx + (y - A[1]) * vy) / (len * len);
        if (t < 0.25 || t > 0.75) return;                 // skip the circles at each end
        worst = Math.max(worst, Math.abs((x - A[0]) * vy - (y - A[1]) * vx) / len);
      });
      return { worst: Math.round(worst), apart: Math.round(len) };
    });

    const one = await spread();
    if (!one) throw new Error('could not find the two circles');
    await page.evaluate((h) => window.BB.store.addLink(h.a, h.b, 'other', { kind: 'rival' }), home);
    await page.waitForTimeout(2200);
    await page.evaluate(() => window.BB.web.fit());
    await page.waitForTimeout(900);
    const two = await spread();
    if (!two) throw new Error('could not find the two circles after the second connection');
    if (two.worst < 4 || two.worst <= one.worst + 2) {
      throw new Error('the second connection is hidden under the first: thread ink strays '
        + one.worst + 'px from the centre line with one connection, ' + two.worst
        + 'px with two, over ' + two.apart + 'px between the circles');
    }

    await page.selectOption('#web-labels', 'hubs');
    await page.evaluate((h) => { window.BB.store.openBoard(h.was); window.BB.store.deleteBoard(h.twin); }, home);
    await page.waitForTimeout(1800);
  });

  await step('every control in the web toolbar does something', async () => {
    const shot = () => page.evaluate(() => {
      const c = document.querySelector('#web-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4 * 53) if (d[i] > 0) ink++;
      return ink;
    });
    const all = await shot();
    await page.click('[data-webshow="bonds"]');
    await page.waitForTimeout(1600);
    const bondsOnly = await shot();
    if (bondsOnly >= all) throw new Error(`filtering to connections did not thin the web: ${all} -> ${bondsOnly}`);
    await page.click('[data-webshow="all"]');
    await page.waitForTimeout(1200);

    await page.selectOption('#web-color', 'degree');
    await page.selectOption('#web-labels', 'all');
    await page.waitForTimeout(500);
    const labelled = await page.evaluate(() => document.querySelector('#web-labels').value);
    if (labelled !== 'all') throw new Error('label mode did not stick');
    await page.selectOption('#web-labels', 'hubs');
    await page.selectOption('#web-color', 'era');

    await page.uncheck('#web-isolated');
    await page.waitForTimeout(900);
    await page.check('#web-isolated');
    await page.waitForTimeout(900);

    await page.click('[data-act="web-zoom-in"]');
    await page.waitForTimeout(500);
    await page.click('[data-act="web-fit"]');
    await page.waitForTimeout(800);
    const after = await shot();
    if (after < 20) throw new Error('the web went blank after the toolbar was used');
  });

  await step('the web remembers how it was left', async () => {
    await page.selectOption('#web-labels', 'all');
    await page.waitForTimeout(400);
    const saved = await page.evaluate(() => window.BB.store.prefs()['web.labels']);
    if (saved !== 'all') throw new Error('not remembered: ' + saved);
    await page.selectOption('#web-labels', 'hubs');
    await page.waitForTimeout(300);
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

  console.log('\nthe address bar');

  await step('a view can be opened straight from a link', async () => {
    // The installed app's shortcuts point at ./?view=web and ./?view=timeline,
    // so this is not decoration — it is how those menu items work.
    await page.goto(`http://127.0.0.1:${PORT}/index.html?view=web`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);
    const open = await page.evaluate(() => ({
      cls: document.querySelector('#app').className,
      web: !!(window.BB.web && window.BB.web.isOpen()),
    }));
    if (!open.web || !/view-web/.test(open.cls)) throw new Error('landed on ' + open.cls);
  });

  await step('the person you are looking at is in the URL, and survives a reload', async () => {
    const id = await page.evaluate(() => {
      const p = Object.values(window.BB.store.doc.people).find(x => x.name === 'Noah');
      window.BB.app.setView('canvas');
      window.BB.canvas.select([p.id]);
      return p.id;
    });
    await page.waitForTimeout(900);
    const url = page.url();
    if (!url.includes(id)) throw new Error('the URL is ' + url);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);
    const back = await page.evaluate(() => window.BB.canvas.selected());
    if (back.length !== 1 || back[0] !== id) throw new Error('came back with ' + JSON.stringify(back));
  });

  await step('back steps between views instead of leaving the app', async () => {
    // An installed app has nothing behind its first page, so a back press that
    // walked out of it would look like the app crashing.
    await page.evaluate(() => window.BB.app.setView('timeline'));
    await page.waitForTimeout(900);
    await page.goBack({ waitUntil: 'load' });
    await page.waitForTimeout(1100);
    const cls = await page.evaluate(() => document.querySelector('#app').className);
    if (/view-timeline/.test(cls)) throw new Error('back did nothing: ' + cls);
    if (!/view-canvas|view-web/.test(cls)) throw new Error('back landed on ' + cls);
    await page.evaluate(() => window.BB.app.setView('canvas'));
    await page.waitForTimeout(700);
  });

  await step('deleting someone offers the way back where it happened', async () => {
    // A dragged bubble deliberately gets no toast on a desktop — ⌘Z is right
    // there, and a toast per drag would be noise. Losing a person is different,
    // and a phone has no keyboard at all: test/touch.js covers the finger path.
    const gone = await page.evaluate(() => {
      const p = Object.values(window.BB.store.doc.people).find(x => x.name === 'Ruth');
      window.BB.canvas.select([p.id]);
      return { id: p.id, name: p.name };
    });
    await page.waitForTimeout(400);
    const n0 = await page.evaluate(() => window.BB.store.count());
    await page.evaluate(() => window.BB.app.deleteSelected());
    await page.waitForTimeout(700);
    if (await page.evaluate(() => window.BB.store.count()) !== n0 - 1) throw new Error('nobody was deleted');
    const undo = page.locator('.toast button', { hasText: /undo/i });
    if (!(await undo.count())) throw new Error('a deletion passed without an offer to undo it');
    await undo.first().click();
    await page.waitForTimeout(600);
    if (!await page.evaluate((id) => !!window.BB.store.person(id), gone.id)) {
      throw new Error(gone.name + ' did not come back');
    }
  });

  await step('the view tabs say which one is chosen, out loud', async () => {
    const aria = await page.evaluate(() => {
      window.BB.app.setView('web');
      return null;
    });
    void aria;
    await page.waitForTimeout(900);
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.viewtabs .tab'))
      .map(t => [t.dataset.view, t.getAttribute('aria-selected'), t.tabIndex]));
    const on = tabs.filter(t => t[1] === 'true');
    if (on.length !== 1 || on[0][0] !== 'web') throw new Error('aria-selected is ' + JSON.stringify(tabs));
    // Roving tabindex: one stop for the whole group, not three.
    if (tabs.filter(t => t[2] === 0).length !== 1) throw new Error('tabindex is ' + JSON.stringify(tabs));
    await page.evaluate(() => window.BB.app.setView('canvas'));
    await page.waitForTimeout(700);
  });

  await step('the buttons floating over the canvas actually do something', async () => {
    // They did not: the canvas takes pointer capture on a background pointerdown,
    // so the mouseup retargeted to the viewport and the click never arrived.
    const before = await page.evaluate(() => window.BB.canvas.view.k);
    await page.click('.zoomctl [data-act="zoom-out"]');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.BB.canvas.view.k);
    if (!(after < before)) throw new Error(`zoom ${before.toFixed(2)} -> ${after.toFixed(2)}`);
    await page.click('.zoomctl [data-act="toggle-grid"]');
    await page.waitForTimeout(300);
    await page.click('.zoomctl [data-act="toggle-grid"]');
    await page.waitForTimeout(300);
  });

  const other = errors.length - errors.filter(e => /^"/.test(e)).length;
  console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${failures} failing step(s), ${other} console/page error(s)`);
  if (errors.length) errors.forEach(e => console.log('  ' + e));
  await browser.close();
  server.close();
  process.exit(errors.length ? 1 : 0);
})();
