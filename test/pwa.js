/**
 * Bible Bubble — installable and offline end-to-end test.
 *
 *   npm install --no-save playwright
 *   node test/pwa.js
 *
 * Serves the app over http (127.0.0.1 counts as a secure origin, so the worker
 * registers) and checks the three things a broken PWA gets wrong quietly: a
 * manifest that names icons nobody shipped, a precache list that has drifted
 * away from what index.html actually loads, and a second visit that only looks
 * offline-ready because the HTTP cache still had everything. Set HEADED=1 to
 * watch.
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8803);
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

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

/** Width and height straight out of a PNG's IHDR, so a stub file cannot pass. */
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('binary', 1, 4) !== 'PNG') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** Everything index.html pulls in, as site-relative paths. */
function shellAssets() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const out = [];
  const re = /(?:href|src)="([^"#:]+\.(?:css|js))"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: !process.env.HEADED, executablePath: findChrome() });
  const errors = [];
  let failures = 0;
  const step = async (name, fn) => {
    const before = errors.length;
    try { await fn(); } catch (e) { errors.push(`"${name}": ${e.message}`); }
    const fresh = errors.slice(before);
    if (fresh.length) failures++;
    console.log((fresh.length ? '  x ' : '  . ') + name + (fresh.length ? '\n      ' + fresh.join('\n      ') : ''));
  };

  console.log('\nthe manifest');

  let manifest = null;
  await step('the manifest is valid JSON and names the app', async () => {
    const raw = fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8');
    manifest = JSON.parse(raw);
    for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons', 'theme_color', 'background_color']) {
      if (manifest[key] == null) throw new Error('no "' + key + '"');
    }
    if (manifest.display !== 'standalone') throw new Error('display is ' + manifest.display);
    if (!/bible/i.test(manifest.name)) throw new Error('name is ' + manifest.name);
  });

  await step('every path in it is relative, because the site lives in a subfolder', async () => {
    // GitHub Pages serves this from /bible-bubble/, so a leading slash would
    // point the installed app at the domain root and it would open a 404.
    const paths = [manifest.start_url, manifest.scope, manifest.id]
      .concat(manifest.icons.map(i => i.src))
      .concat((manifest.shortcuts || []).map(s => s.url))
      .filter(Boolean);
    const bad = paths.filter(p => p.startsWith('/') || /^https?:/.test(p));
    if (bad.length) throw new Error('absolute: ' + bad.join(', '));
  });

  await step('the icons it promises are on disk at the sizes it claims', async () => {
    const seen = [];
    manifest.icons.forEach(icon => {
      const file = path.join(ROOT, icon.src.replace(/^\.\//, ''));
      if (!fs.existsSync(file)) throw new Error('missing ' + icon.src);
      const size = pngSize(file);
      if (!size) throw new Error(icon.src + ' is not a PNG');
      const want = String(icon.sizes).split('x').map(Number);
      if (size.w !== want[0] || size.h !== want[1]) {
        throw new Error(`${icon.src} is ${size.w}x${size.h}, declared ${icon.sizes}`);
      }
      seen.push(icon.sizes + ' ' + (icon.purpose || 'any'));
    });
    const has = (px) => manifest.icons.some(i => String(i.sizes).split(/\s+/).includes(px + 'x' + px));
    if (!has(192)) throw new Error('no 192px icon: ' + seen.join(', '));
    if (!has(512)) throw new Error('no 512px icon: ' + seen.join(', '));

    // A shortcut whose icon 404s shows up as a blank square in the launcher menu.
    (manifest.shortcuts || []).forEach(sc => {
      (sc.icons || []).forEach(icon => {
        const file = path.join(ROOT, icon.src.replace(/^\.\//, ''));
        if (!fs.existsSync(file)) throw new Error('shortcut "' + sc.name + '" wants missing ' + icon.src);
        const size = pngSize(file);
        const want = String(icon.sizes).split('x').map(Number);
        if (!size || size.w !== want[0] || size.h !== want[1]) {
          throw new Error(icon.src + ' is ' + (size ? size.w + 'x' + size.h : 'not a PNG') + ', declared ' + icon.sizes);
        }
      });
    });
    // Android masks any non-maskable icon into a circle and crops the corners off.
    if (!manifest.icons.some(i => /maskable/.test(i.purpose || ''))) throw new Error('no maskable icon: ' + seen.join(', '));
  });

  await step('the icon iOS asks for exists and is opaque', async () => {
    const file = path.join(ROOT, 'icons/apple-touch-icon.png');
    if (!fs.existsSync(file)) throw new Error('no icons/apple-touch-icon.png');
    const size = pngSize(file);
    if (!size || size.w !== 180 || size.h !== 180) throw new Error('it is ' + (size ? size.w + 'x' + size.h : 'not a PNG'));
  });

  console.log('\nthe service worker');

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const url = `http://127.0.0.1:${PORT}/index.html`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.click('button:has-text("Start from Adam")').catch(() => {});
  await page.waitForTimeout(1200);

  await step('it registers and reaches activated', async () => {
    const state = await page.evaluate(async () => {
      if (!navigator.serviceWorker) return 'unsupported';
      const reg = await Promise.race([
        navigator.serviceWorker.ready.catch(() => null),
        new Promise(r => setTimeout(() => r(null), 8000)),
      ]);
      return reg && reg.active ? reg.active.state : 'none';
    });
    if (state !== 'activated') throw new Error('worker state is ' + state);
  });

  await step('it takes control of the page on the next visit', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const controlled = await page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller));
    if (!controlled) throw new Error('no controller after a reload');
  });

  await step('its precache covers every file index.html actually loads', async () => {
    // The list in sw.js is written by hand, so it drifts the moment someone adds
    // a module. A missing entry does not fail loudly — it just means one file
    // goes to the network, and offline breaks on a plane instead of in a test.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const all = [];
      for (const n of names) {
        const keys = await caches.open(n).then(c => c.keys());
        keys.forEach(r => all.push(new URL(r.url).pathname));
      }
      return all;
    });
    const missing = shellAssets().filter(a => !cached.includes('/' + a));
    if (missing.length) throw new Error('not precached: ' + missing.join(', '));
    if (!cached.some(p => p === '/' || p.endsWith('/index.html'))) {
      throw new Error('the page itself is not precached: ' + cached.join(', '));
    }
  });

  await step('the whole app still opens with the network cut', async () => {
    // Chromium's own HTTP cache will happily serve a disk copy while offline, which
    // would let this pass with no worker at all. Turn it off, so the only thing
    // that can answer is Cache Storage.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await ctx.setOffline(true);
    try { await page.reload({ waitUntil: 'load', timeout: 15000 }); }
    catch (e) { await ctx.setOffline(false); throw new Error('the page never loaded offline'); }
    await page.waitForTimeout(1600);
    const state = await page.evaluate(async () => ({
      people: document.querySelectorAll('.bubble').length,
      stored: window.BB && window.BB.store ? window.BB.store.count() : 0,
      links: document.querySelectorAll('link[rel="stylesheet"]').length,
      sheets: document.styleSheets.length,
      rules: Array.from(document.styleSheets).reduce((n, s) => n + s.cssRules.length, 0),
      controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      shelved: !!(await caches.match('css/app.css') || await caches.match('./css/app.css')),
    }));
    if (!state.controlled) throw new Error('no worker was in charge of the offline load');
    if (!state.shelved) throw new Error('css/app.css is not in Cache Storage');
    if (!state.stored) throw new Error('the store came back empty');
    if (!state.people) throw new Error('no bubbles rendered offline');
    // Proves the stylesheets came out of the cache too, not just the markup.
    if (state.sheets < state.links) throw new Error(state.sheets + ' of ' + state.links + ' stylesheets survived offline');
    if (state.rules < 100) throw new Error('only ' + state.rules + ' css rules offline');
    await ctx.setOffline(false);
  });

  console.log('\nthe install glue');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  await step('BB.pwa offers the surface the rest of the app calls', async () => {
    const shape = await page.evaluate(() => {
      const p = window.BB && window.BB.pwa;
      if (!p) return null;
      return ['isStandalone', 'canInstall', 'install', 'isIOS', 'onChange', 'updateReady', 'applyUpdate']
        .filter(k => typeof p[k] !== 'function');
    });
    if (shape === null) throw new Error('BB.pwa is not defined');
    if (shape.length) throw new Error('not functions: ' + shape.join(', '));
  });

  await step('it reports honestly when nothing is installable', async () => {
    // Headless Chromium never fires beforeinstallprompt, so this is the state
    // every desktop browser is in — it must answer false rather than throw.
    const out = await page.evaluate(async () => ({
      canInstall: window.BB.pwa.canInstall(),
      standalone: window.BB.pwa.isStandalone(),
      install: await window.BB.pwa.install(),
      update: window.BB.pwa.updateReady(),
    }));
    if (out.canInstall !== false) throw new Error('canInstall() is ' + out.canInstall);
    if (out.standalone !== false) throw new Error('isStandalone() is ' + out.standalone);
    if (out.install !== 'unavailable') throw new Error('install() resolved ' + out.install);
    if (out.update !== false) throw new Error('updateReady() is ' + out.update);
  });

  await step('the status bar colour follows the theme', async () => {
    const read = () => page.evaluate(() => {
      const metas = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
      const live = metas.find(m => !m.media || matchMedia(m.media).matches) || metas[0];
      return live ? live.getAttribute('content') : null;
    });
    const before = await read();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(300);
    const after = await read();
    if (!before || !after) throw new Error('no theme-color meta');
    if (before === after) throw new Error('still ' + after + ' after switching to dark');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.waitForTimeout(200);
  });

  console.log('\nopened straight off the disk');

  await step('file:// still runs, and quietly declines to register a worker', async () => {
    const bare = await browser.newContext();
    const solo = await bare.newPage();
    const noise = [];
    solo.on('pageerror', e => noise.push('PAGEERROR: ' + e.message));
    solo.on('console', m => { if (m.type() === 'error') noise.push('CONSOLE: ' + m.text()); });
    await solo.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });
    await solo.waitForTimeout(1400);
    const out = await solo.evaluate(() => ({
      booted: !!(window.BB && window.BB.store),
      controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      pwa: !!(window.BB && window.BB.pwa),
    }));
    await bare.close();
    if (!out.booted) throw new Error('the app did not boot from file://');
    if (out.controller) throw new Error('a worker took control on file://');
    if (!out.pwa) throw new Error('BB.pwa should still exist, just inert');
    if (noise.length) throw new Error(noise.join(' | '));
  });

  const other = errors.length - errors.filter(e => /^"/.test(e)).length;
  console.log(`\n${failures || other ? 'FAIL' : 'PASS'} — ${failures} failing step(s), ${other} console/page error(s)`);
  if (errors.length) errors.forEach(e => console.log('  ' + e));
  await browser.close();
  server.close();
  process.exit(errors.length ? 1 : 0);
})();
