/**
 * Bible Bubble — phone and touch end-to-end test.
 *
 *   npm install --no-save playwright
 *   node test/touch.js
 *
 * Drives the app at 390x844 with touch emulation: the bottom bar, the sheets,
 * finger-sized handles, long-press, pinch and double-tap. Set SHOTS=<dir> to
 * drop screenshots as it goes, HEADED=1 to watch.
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8801);
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
  const browser = await chromium.launch({ headless: !process.env.HEADED, executablePath: findChrome() });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();

  const errors = [];
  let failures = 0;
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const step = async (name, fn) => {
    const before = errors.length;
    try { await fn(); } catch (e) { errors.push(`"${name}": ${e.message}`); }
    await page.waitForTimeout(220);
    const fresh = errors.slice(before);
    if (fresh.length) failures++;
    console.log((fresh.length ? '  x ' : '  . ') + name + (fresh.length ? '\n      ' + fresh.join('\n      ') : ''));
  };
  const shot = async (name) => {
    if (!process.env.SHOTS) return;
    fs.mkdirSync(process.env.SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.SHOTS, name + '.png') });
  };
  const cls = () => page.evaluate(() => document.querySelector('#app').className);
  const cs = (sel, prop) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [sel, prop]);
  /** Select and centre someone, and hand back their bubble on screen. */
  const centre = async (name) => {
    const id = await page.evaluate((n) => {
      const p = Object.values(window.BB.store.doc.people).find(x => x.name === n);
      if (!p) return null;
      window.BB.canvas.select([p.id]);
      window.BB.canvas.focus(p.id, { zoom: 0.9, animate: false, flash: false });
      return p.id;
    }, name);
    if (!id) throw new Error('no person named ' + name);
    await page.waitForTimeout(400);
    return id;
  };
  /** Where to put a finger on someone's bubble. */
  const bubbleAt = (id) => page.evaluate((pid) => {
    const b = document.querySelector(`.bubble[data-id="${pid}"]`).getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + 20) };
  }, id);
  /* Raw pointer events, because half the gesture vocabulary is now about holding
     still and Playwright's touchscreen can only tap and swipe. */
  const finger = (type, x, y, onTarget) => page.evaluate(([t, px, py, hit]) => {
    const at = hit ? (document.elementFromPoint(px, py) || document.querySelector('#viewport'))
      : document.querySelector('#viewport');
    at.dispatchEvent(new PointerEvent(t, {
      pointerId: 1, pointerType: 'touch', isPrimary: true,
      clientX: px, clientY: py, bubbles: true, button: 0,
    }));
  }, [type, Math.round(x), Math.round(y), !!onTarget]);
  const down = (x, y) => finger('pointerdown', x, y, true);
  const move = (x, y) => finger('pointermove', x, y);
  const lift = (x, y) => finger('pointerup', x, y);
  const shutSheets = async () => {
    await page.evaluate(() => {
      window.BB.app.closePanels();
      if (window.BB.canvas.isPicking()) window.BB.canvas.endLinkMode();
      if (window.BB.peek) window.BB.peek.hide();
    });
    await page.waitForTimeout(300);
  };
  const emptySpot = () => page.evaluate(() => {
    const vp = document.querySelector('#viewport').getBoundingClientRect();
    for (let x = vp.left + 30; x < vp.right - 30; x += 26) {
      for (let y = vp.top + 90; y < vp.bottom - 160; y += 26) {
        const e = document.elementFromPoint(x, y);
        if (e && !e.closest('.bubble') && !e.closest('.canvas-hud') && !e.closest('.edge')) return { x, y };
      }
    }
    return null;
  });
  const pageScrollsSideways = () => page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.tap('button:has-text("Start from Adam")');
  await page.waitForTimeout(1500);

  console.log('\nphone layout');
  await step('the phone layout is active and nothing scrolls sideways', async () => {
    if (!(await cls()).includes('is-phone')) throw new Error('no is-phone class: ' + await cls());
    if (await cs('.mobilebar', 'display') === 'none') throw new Error('bottom bar hidden');
    if (await pageScrollsSideways()) throw new Error('the page scrolls sideways at 390px');
  });

  await step('both sheets start closed, canvas full width', async () => {
    const c = await cls();
    if (/panel-(lineage|details)/.test(c)) throw new Error('a panel is open: ' + c);
    const w = await page.evaluate(() => Math.round(document.querySelector('#viewport').getBoundingClientRect().width));
    if (w !== 390) throw new Error('canvas width ' + w);
  });

  console.log('\ntouching the canvas');
  await step('tapping a bubble selects it and names it in the bottom bar', async () => {
    const id = await centre('Adam');
    const at = await page.evaluate((pid) => {
      const b = document.querySelector(`.bubble[data-id="${pid}"]`).getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + 22 };
    }, id);
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(400);
    const label = await page.textContent('#mb-details-label');
    if (label !== 'Adam') throw new Error('bottom bar says "' + label + '"');
    if (/panel-details/.test(await cls())) throw new Error('details auto-opened and covered the canvas');
  });

  await step('link handles are finger-sized once selected', async () => {
    const h = await page.evaluate(() => {
      const el = document.querySelector('.bubble.is-sel .b-handle.h-bottom');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), opacity: getComputedStyle(el).opacity };
    });
    if (!h) throw new Error('no handle on the selected bubble');
    if (h.opacity === '0') throw new Error('handle invisible on touch');
    if (h.w < 24) throw new Error('handle only ' + h.w + 'px on screen');
  });

  await step('tapping a bubble says who it is, right where you tapped', async () => {
    // The whole point of the rework. Selecting someone used to rename a button at
    // the bottom of the screen and nothing else, so finding out who you had hold
    // of meant going looking for the answer.
    const id = await centre('Noah');
    const at = await bubbleAt(id);
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(500);
    if (await page.isHidden('#peek')) throw new Error('no card after tapping a bubble');
    const card = await page.evaluate(() => ({
      name: (document.querySelector('.peek-name') || {}).textContent,
      sub: (document.querySelector('.peek-sub') || {}).textContent || '',
      stats: Array.from(document.querySelectorAll('.peek-stats span')).map(n => n.textContent),
      acts: Array.from(document.querySelectorAll('#peek [data-peek]')).map(n => n.dataset.peek),
      small: Array.from(document.querySelectorAll('#peek [data-peek]'))
        .filter(n => n.getBoundingClientRect().height < 40).length,
    }));
    if (card.name !== 'Noah') throw new Error('the card says "' + card.name + '"');
    if (!/\d/.test(card.sub)) throw new Error('no years on the card: "' + card.sub + '"');
    if (!card.stats.some(t => /link/.test(t))) throw new Error('no link count: ' + card.stats.join(' / '));
    ['details', 'trace', 'link', 'more'].forEach(k => {
      if (!card.acts.includes(k)) throw new Error('no "' + k + '" action: ' + card.acts.join(', '));
    });
    if (card.small) throw new Error(card.small + ' actions are under 40px tall');
    if (/panel-details/.test(await cls())) throw new Error('a tap threw the whole sheet up');
    await shot('phone-peek');
  });

  await step('the card opens the details, and keeps its subject above the sheet', async () => {
    await page.tap('#peek [data-peek="details"]');
    await page.waitForTimeout(900);
    if (!/panel-details/.test(await cls())) throw new Error('details did not open');
    const room = await page.evaluate(() => {
      const id = window.BB.canvas.selected()[0];
      const b = document.querySelector(`.bubble[data-id="${id}"]`);
      const sheet = document.querySelector('#inspector');
      if (!b) return null;
      return {
        bottom: Math.round(b.getBoundingClientRect().bottom),
        sheet: Math.round(sheet.getBoundingClientRect().top),
        top: Math.round(b.getBoundingClientRect().top),
        bar: Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom),
      };
    });
    if (!room) throw new Error('the selected bubble vanished');
    // A full bubble is taller than the strip a 70vh sheet leaves behind, so it
    // cannot clear it outright. What matters is that its head — the row with the
    // name on it — is showing, so you can see who the sheet is talking about.
    const seen = Math.min(room.bottom, room.sheet) - Math.max(room.top, room.bar);
    if (seen < 56) throw new Error('only ' + seen + 'px of the bubble is left showing');
    if (room.top < room.bar) throw new Error('the bubble was pushed up under the top bar');
    if (room.top > room.sheet) throw new Error('the bubble is entirely behind the sheet');
    await shutSheets();
  });

  await step('the card reaches the same menu a right-click gives on a desktop', async () => {
    await shutSheets();
    const id = await centre('Ruth');
    await page.touchscreen.tap(...Object.values(await bubbleAt(id)));
    await page.waitForTimeout(450);
    await page.tap('#peek [data-peek="more"]');
    await page.waitForTimeout(400);
    if (!await page.isVisible('#context-menu')) throw new Error('no menu from the card');
    const txt = await page.textContent('#context-menu');
    if (!/Add a son/.test(txt)) throw new Error('wrong menu: ' + txt.slice(0, 40));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  });

  await step('linking is two taps, where a hairline drag never worked', async () => {
    await shutSheets();
    const a = await centre('Ruth');
    await page.touchscreen.tap(...Object.values(await bubbleAt(a)));
    await page.waitForTimeout(450);
    const links = await page.evaluate(() => Object.keys(window.BB.store.doc.links).length);
    await page.tap('#peek [data-peek="link"]');
    await page.waitForTimeout(450);
    if (!await page.isVisible('.peek-banner')) throw new Error('no banner in link mode');
    const picking = await page.evaluate(() => ({
      on: document.querySelector('#viewport').classList.contains('is-picking'),
      targets: document.querySelectorAll('.bubble.is-target').length,
    }));
    if (!picking.on) throw new Error('the canvas is not in target-pick mode');
    if (picking.targets < 2) throw new Error('only ' + picking.targets + ' bubbles offered as targets');
    // Everyone near Ruth is already related to her, and the graph refuses both a
    // cycle and a second link of the same kind — so linking to a neighbour would
    // prove nothing. Go and find a stranger, which is exactly what the banner
    // tells you to do: "drag to look around". Panning has to keep working inside
    // link mode for that instruction to be honest.
    const b = await page.evaluate((from) => {
      const S = window.BB.store, L = window.BB.lineage;
      const ids = (v) => Array.from(v || []).map(x => (x && x.id) || x);
      const barred = new Set([from]
        .concat(ids(L.ancestors(from)))
        .concat(ids(L.descendants(from)))
        .concat(ids(L.neighbours(from))));
      const me = S.person(from);
      const near = S.people()
        .filter(p => !barred.has(p.id))
        .sort((p, q) => Math.hypot(p.x - me.x, p.y - me.y) - Math.hypot(q.x - me.x, q.y - me.y))[0];
      return near ? { id: near.id, name: near.name } : null;
    }, a);
    if (!b) throw new Error('nobody on this board is a stranger to Ruth');
    await page.evaluate((id) => window.BB.canvas.focus(id, { zoom: 0.9, animate: false, flash: false }), b.id);
    await page.waitForTimeout(500);
    if (!await page.evaluate(() => window.BB.canvas.isPicking())) {
      throw new Error('looking around dropped out of link mode');
    }
    const reachable = await page.evaluate((id) => {
      const n = document.querySelector(`.bubble[data-id="${id}"]`);
      if (!n || !n.classList.contains('is-target')) return false;
      const r = n.getBoundingClientRect();
      const vp = document.querySelector('#viewport').getBoundingClientRect();
      const banner = document.querySelector('#peek').getBoundingClientRect();
      return r.top > vp.top + 20 && r.bottom < banner.top - 10;
    }, b.id);
    if (!reachable) throw new Error(b.name + ' is not offered as a target after looking around');
    await page.touchscreen.tap(...Object.values(await bubbleAt(b.id)));
    await page.waitForTimeout(500);
    if (!await page.isVisible('.peek-ask')) throw new Error('no chooser after picking a target');
    await page.tap('.peek-choice:first-child');
    await page.waitForTimeout(600);
    const now = await page.evaluate(() => Object.keys(window.BB.store.doc.links).length);
    if (now !== links + 1) throw new Error('links ' + links + ' -> ' + now);
    await page.evaluate(() => window.BB.store.undo());
    await page.waitForTimeout(350);
  });

  await step('a hold on a bubble picks the person up and carries them', async () => {
    await shutSheets();
    // A hold used to open the context menu, which fought every other gesture and
    // hid per-person actions behind something nobody discovers. The card carries
    // those now, so the hold can do what a hold does on every other phone app.
    const id = await centre('Ruth');
    const at = await bubbleAt(id);
    const before = await page.evaluate((pid) => {
      const p = window.BB.store.person(pid);
      return { x: p.x, y: p.y, view: Math.round(window.BB.canvas.view.x) };
    }, id);
    await down(at.x, at.y);
    await page.waitForTimeout(620);
    if (!await page.isVisible('.bubble.is-lifted')) throw new Error('nothing was picked up after holding');
    if (await page.isVisible('#context-menu')) throw new Error('a hold still opens the old menu');
    for (const d of [30, 60, 90]) await move(at.x + d, at.y + d * 0.6);
    await lift(at.x + 90, at.y + 54);
    await page.waitForTimeout(450);
    const after = await page.evaluate((pid) => {
      const p = window.BB.store.person(pid);
      return { x: p.x, y: p.y, view: Math.round(window.BB.canvas.view.x) };
    }, id);
    if (Math.abs(after.x - before.x) < 20) throw new Error('they did not move: ' + before.x + ' -> ' + after.x);
    if (Math.abs(after.view - before.view) > 2) throw new Error('the canvas panned as well as carrying them');
    await page.evaluate(() => window.BB.store.undo());
    await page.waitForTimeout(350);
  });

  await step('a drag that starts on a bubble pans, and leaves them where they were', async () => {
    await shutSheets();
    // On a phone your finger lands on somebody constantly. Moving them by default
    // meant you could not pan across a crowded board without wrecking it.
    const id = await centre('Ruth');
    const at = await bubbleAt(id);
    const before = await page.evaluate((pid) => {
      const p = window.BB.store.person(pid);
      return { x: p.x, y: p.y, view: Math.round(window.BB.canvas.view.x) };
    }, id);
    await down(at.x, at.y);
    for (const d of [12, 40, 80, 120]) await move(at.x - d, at.y);
    await lift(at.x - 120, at.y);
    await page.waitForTimeout(700);
    const after = await page.evaluate((pid) => {
      const p = window.BB.store.person(pid);
      return { x: p.x, y: p.y, view: Math.round(window.BB.canvas.view.x) };
    }, id);
    if (after.x !== before.x || after.y !== before.y) throw new Error('the drag moved them to ' + after.x + ',' + after.y);
    if (Math.abs(after.view - before.view) < 60) throw new Error('the canvas barely panned: ' + before.view + ' -> ' + after.view);
  });

  await step('a hold on empty canvas still opens its own menu', async () => {
    await shutSheets();
    const spot = await emptySpot();
    if (!spot) throw new Error('no empty spot to hold');
    await down(spot.x, spot.y);
    await page.waitForTimeout(700);
    if (!await page.isVisible('#context-menu')) throw new Error('no menu after holding empty canvas');
    const txt = await page.textContent('#context-menu');
    if (!/Add a person/.test(txt)) throw new Error('wrong menu: ' + txt.slice(0, 40));
    await lift(spot.x, spot.y);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  });

  await step('a flick keeps gliding after the finger leaves', async () => {
    await shutSheets();
    const spot = await emptySpot();
    if (!spot) throw new Error('no empty spot to flick');
    const parked = await page.evaluate(() => ({ ...window.BB.canvas.view }));
    const flick = await page.evaluate(async ([px, py]) => {
      const vp = document.querySelector('#viewport');
      const fire = (type, x) => vp.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: py, bubbles: true, button: 0,
      }));
      const before = window.BB.canvas.view.x;
      fire('pointerdown', px);
      for (let i = 1; i <= 6; i++) {
        await new Promise(r => setTimeout(r, 14));
        fire('pointermove', px - i * 22);
      }
      fire('pointerup', px - 132);
      return { before: Math.round(before), at: Math.round(window.BB.canvas.view.x) };
    }, [spot.x, spot.y]);
    if (Math.abs(flick.at - flick.before) < 100) {
      throw new Error('the flick did not even pan: ' + flick.before + ' -> ' + flick.at);
    }
    const atLift = flick.at;
    await page.waitForTimeout(350);
    const settled = await page.evaluate(() => Math.round(window.BB.canvas.view.x));
    if (Math.abs(settled - atLift) < 15) {
      throw new Error('the canvas stopped dead on lift: ' + atLift + ' -> ' + settled);
    }
    await page.evaluate((v) => window.BB.canvas.setView(v), parked);
    await page.waitForTimeout(400);
  });

  await step('pinch zooms the canvas', async () => {
    const before = await page.evaluate(() => window.BB.canvas.view.k);
    await page.evaluate(() => {
      const vp = document.querySelector('#viewport');
      const mk = (type, id, x, y) => vp.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1,
      }));
      mk('pointerdown', 1, 150, 400); mk('pointerdown', 2, 250, 400);
      for (let i = 1; i <= 8; i++) { mk('pointermove', 1, 150 - i * 8, 400); mk('pointermove', 2, 250 + i * 8, 400); }
      mk('pointerup', 1, 70, 400); mk('pointerup', 2, 330, 400);
    });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.BB.canvas.view.k);
    if (!(after > before * 1.2)) throw new Error(`zoom ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  });

  await step('double-tap on empty canvas adds a person', async () => {
    const n0 = await page.locator('.bubble').count();
    const spot = await page.evaluate(() => {
      const vp = document.querySelector('#viewport').getBoundingClientRect();
      for (let x = vp.left + 30; x < vp.right - 30; x += 30) {
        for (let y = vp.top + 80; y < vp.bottom - 120; y += 30) {
          const e = document.elementFromPoint(x, y);
          if (e && !e.closest('.bubble') && !e.closest('.canvas-hud') && !e.closest('.edge')) return { x, y };
        }
      }
      return null;
    });
    if (!spot) throw new Error('no empty spot to tap');
    await page.touchscreen.tap(spot.x, spot.y);
    await page.waitForTimeout(90);
    await page.touchscreen.tap(spot.x, spot.y);
    await page.waitForTimeout(600);
    const n1 = await page.locator('.bubble').count();
    if (n1 !== n0 + 1) throw new Error(`bubbles ${n0} -> ${n1}`);
    await page.evaluate(() => window.BB.store.undo());
    await page.waitForTimeout(300);
  });

  console.log('\nsheets and panels');
  await step('the details sheet opens from the bottom bar', async () => {
    await centre('Adam');
    await page.tap('[data-mb="details"]');
    await page.waitForTimeout(500);
    if (!/panel-details/.test(await cls())) throw new Error('sheet did not open');
    if (await page.isHidden('#sheet-backdrop')) throw new Error('no backdrop');
    const top = await page.evaluate(() => Math.round(document.querySelector('#inspector').getBoundingClientRect().top));
    if (top > 800 || top < 100) throw new Error('sheet top at ' + top);
    const name = await page.inputValue('.insp-name-input');
    if (name !== 'Adam') throw new Error('sheet shows ' + name);
    await shot('phone-details');
  });

  await step('a tap above the sheet closes it', async () => {
    await page.touchscreen.tap(195, 90);
    await page.waitForTimeout(450);
    if (/panel-details/.test(await cls())) throw new Error('still open');
  });

  await step('the lineage drawer opens and jumps to a person', async () => {
    await page.tap('[data-mb="lineage"]');
    await page.waitForTimeout(450);
    if (!/panel-lineage/.test(await cls())) throw new Error('drawer did not open');
    await page.tap('.tree-row:has-text("Noah")');
    await page.waitForTimeout(600);
    if (/panel-lineage/.test(await cls())) throw new Error('drawer stayed open over the canvas');
    if (await page.textContent('#mb-details-label') !== 'Noah') throw new Error('selection did not follow');
  });

  await step('search expands over the bar and finds someone', async () => {
    await page.tap('[data-act="search-open"]');
    await page.waitForTimeout(350);
    if (!/search-open/.test(await cls())) throw new Error('search did not expand');
    const fs2 = await cs('#search-input', 'fontSize');
    if (parseFloat(fs2) < 16) throw new Error('input at ' + fs2 + ' — iOS will zoom the page');
    await page.fill('#search-input', 'Ruth');
    await page.waitForTimeout(400);
    await page.tap('.sr-item');
    await page.waitForTimeout(700);
    if (/search-open/.test(await cls())) throw new Error('search stayed open');
    if (await page.textContent('#mb-details-label') !== 'Ruth') throw new Error('did not jump to Ruth');
  });

  console.log('\nthe other views');
  await step('the web view opens from the bottom bar and draws', async () => {
    await page.tap('[data-mb="web"]');
    await page.waitForTimeout(1600);
    if (!/view-web/.test(await cls())) throw new Error('view did not switch');
    const c = await page.evaluate(() => {
      const n = document.querySelector('#web-canvas');
      const r = n.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    if (c.w < 300 || c.h < 200) throw new Error('canvas is ' + c.w + 'x' + c.h);
    if (await pageScrollsSideways()) throw new Error('the web view scrolls the page sideways');
    await shot('phone-web');
  });

  await step('the timeline via the bottom bar', async () => {
    await page.tap('[data-mb="timeline"]');
    await page.waitForTimeout(900);
    const bars = await page.locator('.tl-bar').count();
    if (bars < 20) throw new Error('only ' + bars + ' bars');
    const names = await page.evaluate(() => Math.round(document.querySelector('.tl-names').getBoundingClientRect().width));
    if (names > 130) throw new Error('names column ' + names + 'px on a 390px screen');
    if (await pageScrollsSideways()) throw new Error('the timeline overflows the page');
    await page.tap('[data-mb="canvas"]');
    await page.waitForTimeout(500);
    await shot('phone-canvas');
  });

  const other = errors.length - errors.filter(e => /^"/.test(e)).length;
  console.log(`\n${failures || other ? 'FAIL' : 'PASS'} — ${failures} failing step(s), ${other} console/page error(s)`);
  if (errors.length) errors.forEach(e => console.log('  ' + e));
  await browser.close();
  server.close();
  process.exit(errors.length ? 1 : 0);
})();
