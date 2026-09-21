/**
 * Smoke test: load the game in a headless browser, start it, and fail on anything
 * that says it is broken.
 *
 * There is no unit test suite here and rendering cannot be checked by reading a
 * diff, but a whole class of failure is mechanically detectable: a syntax error, a
 * shader that will not compile, a CDN URL that has stopped resolving, an exception
 * in the first frames, or a scene that draws nothing at all. This catches those.
 *
 *   node .github/smoke-test.mjs
 *
 * Set SMOKE_VENDOR_DIR to a local three.js package directory to serve the CDN
 * imports from disk instead of the network (for working offline). Leave it unset
 * in CI: fetching the pinned CDN URLs for real is part of what is being tested.
 *
 * SMOKE_PLAYWRIGHT can point at a playwright install that is not resolvable from
 * here - NODE_PATH does not apply to ES module resolution.
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const { chromium } = await import(process.env.SMOKE_PLAYWRIGHT || 'playwright');

const ROOT = new URL('..', import.meta.url).pathname;
const VENDOR = process.env.SMOKE_VENDOR_DIR || null;
const WIDTH = 640, HEIGHT = 360;
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS || 30000);
const PAGE = process.env.SMOKE_PAGE || 'index.html';

const TYPES = { '.html': 'text/html', '.js': 'application/javascript',
                '.mjs': 'application/javascript', '.json': 'application/json',
                '.md': 'text/markdown' };

const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

if (VENDOR) {
  if (!existsSync(VENDOR)) { console.error(`SMOKE_VENDOR_DIR does not exist: ${VENDOR}`); process.exit(2); }
  await page.route('https://cdn.jsdelivr.net/npm/three@*/**', route => {
    const rel = new URL(route.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, '');
    route.fulfill({ path: join(VENDOR, rel), headers: { 'Content-Type': 'application/javascript' } });
  });
}

page.on('pageerror', e => problems.push(`uncaught exception: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
page.on('requestfailed', r => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });

const checks = [];
let shotBuf = null;
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); if (!ok) problems.push(`${name}: ${detail}`); };

try {
  await page.goto(`${origin}/${PAGE}`, { waitUntil: 'load', timeout: 60000 });
  // The module builds terrain and bakes shadows before the first frame; give it room.
  await page.waitForTimeout(8000);

  // Clicking the blocker calls startGame(). If the module threw part-way through,
  // the listener was never attached and the overlay stays up - a precise signal
  // that the script did not run to the end.
  await page.mouse.click(WIDTH / 2, HEIGHT / 2);
  await page.waitForTimeout(SETTLE_MS);

  const dom = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const blocker = document.getElementById('blocker');
    return {
      hasCanvas: !!c,
      canvasSize: c ? [c.width, c.height] : [0, 0],
      blockerHidden: !!blocker && getComputedStyle(blocker).display === 'none',
      webgl2: !!(c && (c.getContext('webgl2') || document.createElement('canvas').getContext('webgl2')))
    };
  });

  check('canvas present', dom.hasCanvas);
  check('canvas has size', dom.canvasSize[0] > 0 && dom.canvasSize[1] > 0, `got ${dom.canvasSize.join('x')}`);
  check('webgl2 context', dom.webgl2);
  check('game started (blocker dismissed)', dom.blockerHidden,
        'the overlay is still up, so the module did not finish executing');

  // A scene that failed to draw is uniform. Measuring the spread of luminance
  // separates "rendered something" from "cleared to one colour".
  shotBuf = await page.screenshot();
  const shot = shotBuf.toString('base64');
  const probe = await browser.newPage();
  const stats = await probe.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').drawImage(img, 0, 0);
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const seen = new Set();
    let sum = 0, sumSq = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      seen.add(l >> 2); sum += l; sumSq += l * l; n++;
    }
    const mean = sum / n;
    return { buckets: seen.size, stddev: Math.sqrt(sumSq / n - mean * mean), mean };
  }, shot);
  await probe.close();

  // Margins measured against the real thing and against a deliberately blanked
  // build: a working frame gives ~62 buckets and stddev ~80, a cleared one that
  // still draws the HUD gives 4 and 5.4.
  check('frame is not blank', stats.buckets >= 16 && stats.stddev >= 12,
        `only ${stats.buckets} luminance buckets, stddev ${stats.stddev.toFixed(1)} - the scene looks blank`);

  console.log('\nchecks');
  for (const c of checks) console.log(`  ${c.ok ? 'pass' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : ' - ' + c.detail}`);
  console.log(`\nframe: ${stats.buckets} luminance buckets, mean ${stats.mean.toFixed(1)}, stddev ${stats.stddev.toFixed(1)}`);
} catch (e) {
  problems.push(`harness error: ${e.message}`);
  // A failure before the variance check leaves nothing to look at, so grab
  // whatever is on screen: in CI this artifact is the only evidence available.
  try { if (!shotBuf) shotBuf = await page.screenshot(); } catch {}
} finally {
  if (problems.length && shotBuf) {
    const out = new URL('smoke-failure.png', import.meta.url).pathname;
    try { await writeFile(out, shotBuf); console.error(`wrote ${out}`); } catch {}
  }
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nsmoke test passed');
