/**
 * Shared harness for the local test tools in this directory: load a generated copy of
 * the game in headless Chromium, with hooks spliced into the source, and collect
 * everything that says it is broken.
 *
 * Same environment as .github/smoke-test.mjs:
 *   SMOKE_PLAYWRIGHT  a playwright install not resolvable from here (path to its index.mjs)
 *   SMOKE_VENDOR_DIR  a local three.js package directory, to serve the CDN imports from
 *                     disk instead of the network (for working offline)
 *
 * Every tool takes `--page <file>` to test another copy of the game instead of
 * index.html, which is how a before/after comparison is done: check out the old file
 * somewhere and point a run at it.
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = new URL('../../', import.meta.url).pathname;
export const OUT = new URL('out/', import.meta.url).pathname;
const VENDOR = process.env.SMOKE_VENDOR_DIR || null;

/** `--name value` from argv, or the fallback. */
export function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
export const flag = name => process.argv.includes('--' + name);

/** Replace exactly one occurrence of `from`, or fail: a hook that silently stops matching
 *  after the game changes would make a tool test nothing. */
export function splice(html, from, to) {
  const n = html.split(from).length - 1;
  if (n !== 1) throw new Error(`hook point found ${n} times, expected 1: ${from.slice(0, 80)}`);
  return html.replace(from, to);
}

/** Expose the sound engine and three.js on window. */
export const exposeSound = html => splice(html, 'const snd = new SoundEngine();',
  'const snd = new SoundEngine(); window.__snd = snd; window.__THREE = THREE;');

/** Stop the render loop, for tools that only need the module's definitions. */
export const stopLoop = html => splice(html, 'function animate(){requestAnimationFrame(animate);', 'function animate(){return;');

/**
 * Turn animate() into a stepper, window.__g.frame(dt, render), that runs one frame of
 * simulation at a fixed dt and only renders when asked, and expose the game state the
 * soak bot reads. This is what lets the soak cover minutes of game time in seconds.
 */
export function stepper(html) {
  const a0 = html.indexOf('function animate(){requestAnimationFrame(animate);');
  const a1 = html.indexOf('animate();\n</script>');
  if (a0 < 0 || a1 < 0) throw new Error('animate() not found');
  let body = html.slice(a0, a1);
  body = splice(body, 'function animate(){requestAnimationFrame(animate);', 'function __frame(__dt,__render){');
  body = splice(body, 'if (paused) { updateWorldAnchors(clock.getElapsedTime()); drawHUD(); composer.render(); return; }',
                'if (paused) { if(__render){drawHUD();composer.render();} return; }');
  body = splice(body, 'const dt=Math.min(clock.getDelta(),.05);const elapsed=clock.getElapsedTime();',
                'const dt=__dt;const elapsed=(window.__el=(window.__el||0)+__dt);');
  body = splice(body, 'renderWaterReflection();\n  drawHUD();composer.render();}',
                'if(__render){renderWaterReflection();drawHUD();composer.render();}}');
  const api = `
window.__g = {
  frame: __frame, THREE,
  get player(){return player}, get jet(){return playerJet}, get enemies(){return enemies}, keys,
  get bullets(){return bulletPool}, get missiles(){return missilePool}, get particles(){return activeParticles}, get freeParticles(){return freeParticles},
  get emitters(){return emitters},
  get snd(){return snd}, get gameOver(){return gameOver}, get gameStarted(){return gameStarted}, get paused(){return paused},
  get wave(){return waveNumber}, get waveState(){return waveState}, get score(){return score}, get kills(){return kills},
  get lockProgress(){return lockProgress}, get deathCamTimer(){return deathCamTimer},
  get terrainQueue(){return terrainQueue.length}, get camera(){return camera},
  ground: getGroundHeight, togglePause,
  start(){document.getElementById('blocker').style.display='none';gameStarted=true;startGame()},
  restart(){startGame()},
  MAX_BULLETS, MAX_PLAYER_HP, MAX_MISSILE_AMMO, MAX_PARTICLES,
};
`;
  return html.slice(0, a0) + body + api + splice(html.slice(a1), 'animate();\n</script>', '</script>');
}

/**
 * Load the game with `transform` applied to its source. Returns the browser, the page and
 * `errors`, a Map of everything the page reported as broken (uncaught exceptions, console
 * errors, WebGL errors, failed requests) with a count for each.
 */
export async function openGame({ transform = h => h, viewport = { width: 640, height: 360 }, args = [] } = {}) {
  const page = arg('page', join(ROOT, 'index.html'));
  const html = transform(await readFile(page, 'utf8'));
  const { chromium } = await import(process.env.SMOKE_PLAYWRIGHT || 'playwright');
  const server = createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', ...args] });
  const context = await browser.newContext({ viewport });
  if (VENDOR) {
    if (!existsSync(VENDOR)) throw new Error(`SMOKE_VENDOR_DIR does not exist: ${VENDOR}`);
    await context.route('https://cdn.jsdelivr.net/npm/three@*/**', route => {
      const rel = new URL(route.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, '');
      route.fulfill({ path: join(VENDOR, rel), headers: { 'Content-Type': 'application/javascript' } });
    });
  }
  const p = await context.newPage();
  const errors = new Map(), note = k => errors.set(k, (errors.get(k) || 0) + 1);
  p.on('pageerror', e => note('uncaught: ' + e.message));
  p.on('console', m => { const t = m.text();
    if (m.type() === 'error') note('console.error: ' + t);
    else if (/GL_INVALID_\w+|WebGL: INVALID_\w+|GL_OUT_OF_MEMORY|CONTEXT_LOST/.test(t)) note('webgl: ' + t); });
  p.on('requestfailed', r => note(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  await p.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
  return { browser, page: p, errors, async close() { await browser.close(); server.close(); } };
}

export async function outDir() { await mkdir(OUT, { recursive: true }); return OUT; }
