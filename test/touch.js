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
  const centre = async (name) => {
    const ok = await page.evaluate((n) => {
      const p = Object.values(window.BB.store.doc.people).find(x => x.name === n);
      if (!p) return false;
      window.BB.canvas.focus(p.id, { zoom: 0.9, animate: false, flash: false });
      return true;
    }, name);
    if (!ok) throw new Error('no person named ' + name);
    await page.waitForTimeout(400);
  };
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
    await centre('Adam');
    const at = await page.evaluate(() => {
      const b = document.querySelector('.bubble.is-sel, .bubble').getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + 22 };
    });
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

  await step('long-press opens the context menu', async () => {
    await centre('Ruth');
    const at = await page.evaluate(() => {
      const b = document.querySelector('.bubble.is-sel').getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + 20 };
    });
    await page.evaluate(([x, y]) => {
      const t = document.elementFromPoint(x, y);
      t.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, button: 0,
      }));
    }, [at.x, at.y]);
    await page.waitForTimeout(750);
    if (!await page.isVisible('#context-menu')) throw new Error('no menu after holding');
    const txt = await page.textContent('#context-menu');
    if (!/Add a son/.test(txt)) throw new Error('wrong menu: ' + txt.slice(0, 40));
    await page.evaluate(([x, y]) => {
      document.querySelector('#viewport').dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true,
      }));
    }, [at.x, at.y]);
    await page.keyboard.press('Escape');
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
