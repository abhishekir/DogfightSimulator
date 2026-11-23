/**
 * Enemy direction indicators round the gun sight: places enemies at set geometries, draws
 * the HUD, checks what drawEnemyIndicators drew, and renders each case at three window
 * sizes for a person to look at.
 *
 *   node .github/tools/indicators.mjs [--page file.html] [--no-render] [--sizes 800x600,1366x625,1280x720]
 *
 * Nothing is simulated while the cases are drawn: enemies are put at offsets in the jet's
 * frame (ahead, right, up, in metres), the camera is snapped onto the jet, and drawHUD and
 * the composer are called directly, so every frame shows exactly the geometry asked for.
 * The game's own arrays (`_ind`: angle, range, tier, hollow, colour per arc, and the ring's
 * radius and centre) are read back after each draw.
 *
 * Checks, at every window size:
 *  - every live enemy has an arc, except one in the sight (on screen inside the ring, or
 *    the one under the target box), and none is drawn twice;
 *  - each arc's bearing: an enemy on screen is pointed at its own screen point, as
 *    three.js projects it (a different path from the HUD's own maths); one beside, above,
 *    below or behind the jet within 35 degrees of the direction it is in, in the jet's
 *    frame (the camera looks about 6 degrees down, so one behind the jet points lower), and
 *    one behind the camera exactly along its direction in the camera's frame;
 *  - continuity: an enemy passing from just in front of the camera to just behind it, out
 *    to the side, keeps its arc's direction (a pointer that projected a point behind the
 *    camera as if it were in front would flip to the other side here);
 *  - colour by range (red under 1,000 m, yellow under LOCK_RANGE, grey beyond), arcs
 *    longer for nearer enemies, hollow exactly for enemies behind the jet;
 *  - the ring clears the gun ring and its ticks, at every range the sight can show, and with
 *    INCOMING and the missile warning up no arc lands on their text boxes;
 *  - with eight enemies, five of them within a few degrees of each other, no two arcs on
 *    the same tier overlap along the ring;
 *  - no allocation: a sampling heap profile over 20,000 calls of drawEnemyIndicators, once
 *    it is optimised, finds nothing allocated in it (and, as a check of the instrument, does
 *    find gunSight's; --self-test-leak plants one, and must fail).
 *
 * Renders go to .github/tools/out/indicators-<case>-<w>x<h>.png. Exits 1 on a failed
 * check or a page error.
 */
import { join } from 'node:path';
import { openGame, stepper, splice, arg, flag, outDir } from './lib.mjs';

const SIZES = arg('sizes', '800x600,1366x625,1280x720').split(',').map(s => s.split('x').map(Number));
const RENDER = !flag('no-render');
const OUT = await outDir();

const transform = html => {
  html = stepper(html);
  html = splice(html, 'while (terrainQueue.length && performance.now() < deadline) {', 'while (terrainQueue.length) {');
  // For the allocation check: a copy of drawEnemyIndicators that stops before it draws, and
  // optionally a known leak planted in both, to show the check catches one.
  const END = '\n  hud.restore();\n}\n', f0 = html.indexOf('function drawEnemyIndicators('), f1 = html.indexOf(END, f0) + END.length;
  if (f0 < 0 || f1 < END.length) throw new Error('drawEnemyIndicators not found');
  let fn = html.slice(f0, f1);
  if (flag('self-test-leak')) fn = splice(fn, '  I.n=n;I.R=R;I.gx=gx;I.gy=gy;', '  I.n=n;I.R=R;I.gx=gx;I.gy=gy;window.__leak=new THREE.Vector3(n,R,gx);');
  const noDraw = splice(fn.replace('function drawEnemyIndicators(', 'function __indNoDraw('), "  hud.save();hud.lineCap='round';hud.shadowBlur=0;\n", '  return;\n');
  html = html.slice(0, f0) + fn + noDraw + html.slice(f1);
  return splice(html, 'window.__g = {', `window.__x = {
  ind: _ind, IND_GUN_RANGE, LOCK_RANGE, IND_RADIUS, IND_GAP,
  spawn(){ spawnEnemy({}); return enemies[enemies.length-1]; },
  clear(){ for(const e of enemies){ e.alive=false; scene.remove(e.mesh); } enemies.length=0; lockTarget=null; },
  snapCam(){ camInit=false; updateCamera(1/60); camera.updateMatrixWorld(); },
  threat(inc, msl){ incomingThreat=!!inc; threatDir.set(.3,-.2,-1).normalize().applyQuaternion(playerJet.quaternion);
    missileThreat=msl||0; missileThreatDir.set(-.6,-.3,.7).normalize().applyQuaternion(playerJet.quaternion); },
  draw(render){ drawHUD(); if(render) composer.render(); },
  sight: gunSight, nearest: findNearestEnemy,
  drawInd(){ drawEnemyIndicators(gunSight(), findNearestEnemy(), Infinity, 65); },
  noDraw(){ __indNoDraw(gunSight(), findNearestEnemy(), Infinity, 65); },
  // The sight's inRange for a target sat still at d metres straight ahead.
  reachAt(d){ const e=enemies[0], p=e.mesh.position.clone(), v=e.velocity.clone();
    e.mesh.position.set(0,0,-d).applyQuaternion(playerJet.quaternion).add(playerJet.position); e.velocity.set(0,0,0);
    const r=gunSolution(e).reach; e.mesh.position.copy(p); e.velocity.copy(v); return r; },
};
window.__g = {`);
};

const [W0, H0] = SIZES[0];
const game = await openGame({ transform: h => transform(h), viewport: { width: W0, height: H0 } });
const p = game.page;
await p.waitForFunction(() => window.__g && window.__x, null, { timeout: 90000 });
await p.evaluate(() => { window.__g.snd.init = () => {}; window.__g.start(); });
await p.evaluate(() => { window.__g.jet.position.y += 900; });
for (let i = 0; i < 40; i++) await p.evaluate(() => window.__g.frame(0, false));
await p.evaluate(() => { for (let i = 0; i < 60; i++) window.__g.frame(1 / 60, false); });

// Cases: [ahead, right, up] in the jet's frame. `onScreen` marks enemies the case expects to
// be in the sight and so to have no arc; `dir` is the screen direction (degrees clockwise
// from up, in the jet's frame) an off-screen enemy's arc must point within 35 degrees of.
const CASES = {
  ahead:  [{ at: [1400, 520, 260] }, { at: [900, -380, -60] }, { at: [700, 0, 25], inSight: true }],
  beside: [{ at: [30, 800, 0], dir: 90 }, { at: [30, -2500, 0], dir: -90 }, { at: [30, 0, 1200], dir: 0 }, { at: [30, 0, -900], dir: 180 }],
  behind: [{ at: [-1500, 300, 0], dir: 90 }, { at: [-2000, -600, 100], dir: -90 }, { at: [-1200, 0, 0], dir: 180 }, { at: [-1000, 0, 500], dir: 0 }],
  range:  [{ at: [30, 300, 0], dir: 90 }, { at: [30, 0, 1300], dir: 0 }, { at: [30, -2600, 0], dir: -90 }, { at: [30, 0, -4000], dir: 180 }],
  eight:  [{ at: [0, -400, 0] }, { at: [-60, -900, 20] }, { at: [40, -1400, 60] }, { at: [-30, -2100, -40] }, { at: [0, -2800, 120] },
           { at: [-1500, 600, 200] }, { at: [200, 1100, -300] }, { at: [0, 0, 1800] }],
  warnings: [{ at: [-1500, 0, 0], dir: 180 }, { at: [0, 0, -600], dir: 180 }, { at: [0, 700, -200] }, { at: [-200, -1100, 300] }],
};

const fails = [];
const check = (ok, what) => { if (!ok) fails.push(what); return ok; };
const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

async function place(list) {
  return p.evaluate(list => { const X = window.__x, G = window.__g, T = G.THREE, j = G.jet;
    X.clear();
    for (const c of list) { const e = X.spawn();
      e.mesh.position.set(c.at[1], c.at[2], -c.at[0]).applyQuaternion(j.quaternion).add(j.position);
      e.velocity.set(0, 0, -150).applyQuaternion(j.quaternion); e.mesh.quaternion.copy(j.quaternion); e.mesh.updateMatrixWorld(); }
    X.snapCam(); }, list);
}
async function read() {
  return p.evaluate(() => { const X = window.__x, G = window.__g, I = X.ind, cam = G.camera, T = G.THREE;
    const w = innerWidth, h = innerHeight, gs = X.sight(), nearest = X.nearest();
    const arcs = [];
    for (let i = 0; i < I.n; i++) arcs.push({ a: I.a[i] * 180 / Math.PI, d: I.d[i], len: I.len[i], th: I.th[i], rr: I.rr[i], tier: I.tier[i], behind: I.behind[i], col: I.col[i] });
    // Each enemy's screen point by three.js's own projection, and whether it is behind the jet.
    const fwd = new T.Vector3(0, 0, -1).applyQuaternion(G.jet.quaternion);
    // Behind the camera, the direction in its frame, by worldToLocal (which inverts matrixWorld
    // afresh, where the HUD uses the cached matrixWorldInverse).
    const en = G.enemies.map(e => { const v = e.mesh.position.clone().project(cam), rel = e.mesh.position.clone().sub(G.jet.position);
      const loc = cam.worldToLocal(e.mesh.position.clone());
      return { d: rel.length(), front: loc.z < -1, sx: (v.x * .5 + .5) * w, sy: (-v.y * .5 + .5) * h, camDir: Math.atan2(loc.x, loc.y) * 180 / Math.PI,
        behindJet: rel.dot(fwd) < 0, nearest: e === nearest }; });
    return { arcs, en, R: I.R, gx: I.gx, gy: I.gy, keepTop: I.keepTop, ring: gs.ring, w, h, IND_GUN_RANGE: X.IND_GUN_RANGE, LOCK_RANGE: X.LOCK_RANGE }; });
}

function verify(name, list, r, size) {
  const tag = `${name} ${size}`;
  check(r.R >= r.ring + 16 + 6, `${tag}: ring ${r.R.toFixed(0)} px is not clear of the gun ring's ticks (${(r.ring + 16).toFixed(0)} px)`);
  const used = new Set();
  r.en.forEach((e, k) => {
    const c = list[k];
    // The arc for this enemy: matched by range, which is unique within each case.
    const ai = r.arcs.findIndex((a, i) => !used.has(i) && Math.abs(a.d - e.d) < 0.5);
    const onScreen = e.front && e.sx >= 0 && e.sx <= r.w && e.sy >= 0 && e.sy <= r.h;
    const inRing = e.front && Math.hypot(e.sx - r.gx, e.sy - r.gy) < r.R;
    const inSight = inRing || (onScreen && e.nearest);
    if (c.inSight) check(inSight, `${tag}: enemy ${k} was meant to be in the sight and is not`);
    if (inSight) { check(ai < 0, `${tag}: enemy ${k} is in the sight but has an arc`); return; }
    if (!check(ai >= 0, `${tag}: enemy ${k} at ${e.d.toFixed(0)} m has no arc`)) return;
    used.add(ai); const a = r.arcs[ai];
    if (e.front) { const want = Math.atan2(e.sx - r.gx, -(e.sy - r.gy)) * 180 / Math.PI;
      check(angDiff(a.a, want) < 1, `${tag}: enemy ${k} on screen: arc at ${a.a.toFixed(1)}°, its screen point is at ${want.toFixed(1)}°`); }
    else check(angDiff(a.a, e.camDir) < 1, `${tag}: enemy ${k} behind the camera: arc at ${a.a.toFixed(1)}°, its direction in the camera's frame ${e.camDir.toFixed(1)}°`);
    if (c.dir !== undefined) check(angDiff(a.a, c.dir) < 35, `${tag}: enemy ${k}: arc at ${a.a.toFixed(1)}°, expected about ${c.dir}°`);
    const col = e.d < r.IND_GUN_RANGE ? '#ff3b30' : e.d < r.LOCK_RANGE ? '#ffd21f' : '#d2d8de';
    check(a.col === col, `${tag}: enemy ${k} at ${e.d.toFixed(0)} m drawn ${a.col}, expected ${col}`);
    check(!!a.behind === e.behindJet, `${tag}: enemy ${k}: hollow ${!!a.behind}, behind the jet ${e.behindJet}`);
  });
  check(used.size === r.arcs.length, `${tag}: ${r.arcs.length} arcs drawn for ${used.size} enemies`);
  const byD = [...r.arcs].sort((x, y) => x.d - y.d);
  for (let i = 1; i < byD.length; i++) check(byD[i].len <= byD[i - 1].len, `${tag}: a farther enemy has a longer arc`);
  // Overlap: two arcs closer along the ring than their half-lengths and closer across it than
  // their half-widths (the last tier takes whatever is left, so it may overlap).
  for (let i = 0; i < r.arcs.length; i++) for (let j = i + 1; j < r.arcs.length; j++) {
    const A = r.arcs[i], B = r.arcs[j]; if (A.tier === 3 && B.tier === 3) continue;
    const along = angDiff(A.a, B.a) * Math.PI / 180 * Math.min(A.rr, B.rr), across = Math.abs(A.rr - B.rr);
    check(along >= (A.len + B.len) / 2 + 2 || across >= (A.th + B.th) / 2 + 1,
      `${tag}: arcs at ${A.a.toFixed(0)}° and ${B.a.toFixed(0)}° overlap (${along.toFixed(1)} px along, ${across.toFixed(1)} px across)`);
  }
  // Clear of the warnings' text boxes: no arc's middle inside the box's columns below its top.
  if (r.keepTop < 1e9) for (const A of r.arcs) { const t = A.a * Math.PI / 180, x = r.gx + A.rr * Math.sin(t), y = r.gy - A.rr * Math.cos(t);
    if (Math.abs(x - r.w / 2) < 90) check(y + A.th / 2 <= r.keepTop, `${tag}: the arc at ${A.a.toFixed(0)}° lands on a warning box (${(y + A.th / 2).toFixed(0)} against its top at ${r.keepTop.toFixed(0)})`); }
}

const shots = [];
for (const [w, h] of SIZES) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(200);
  for (const [name, list] of Object.entries(CASES)) {
    await place(list);
    await p.evaluate(n => window.__x.threat(n === 'warnings', n === 'warnings' ? 1400 : 0), name);
    await p.evaluate(r => window.__x.draw(r), RENDER);
    const r = await read();
    verify(name, list, r, `${w}x${h}`);
    if (name === 'eight') check(r.arcs.some(a => a.tier > 0), `${w}x${h}: the eight-enemy case stacked nothing`);
    if (RENDER) { const f = join(OUT, `indicators-${name}-${w}x${h}.png`); await p.screenshot({ path: f }); shots.push(f); }
    console.log(`${w}x${h} ${name.padEnd(8)} ring ${r.R.toFixed(0)} px about (${r.gx.toFixed(0)}, ${r.gy.toFixed(0)}), centre (${w / 2}, ${h / 2}): ` +
      r.arcs.map(a => `${a.a.toFixed(0)}°/${a.d.toFixed(0)}m${a.behind ? 'h' : ''}${a.tier ? '+' + a.tier : ''}${Math.abs(a.rr - r.R - a.tier * 7) > .5 ? '@' + a.rr.toFixed(0) : ''}`).join(' '));
  }
}

// Continuity across the camera's plane: the camera sits 46 m behind the jet, so an enemy
// 600 m out to the side moves from in front of it to behind it between 30 and 60 m astern.
await p.setViewportSize({ width: 1280, height: 720 });
for (const side of [600, -600]) {
  const angs = [];
  for (const ahead of [-20, -40, -45, -47, -50, -70, -120]) {
    await place([{ at: [ahead, side, 30] }]);
    await p.evaluate(() => window.__x.draw(false));
    const r = await read(); angs.push(r.arcs.length ? r.arcs[0].a : NaN);
  }
  console.log(`across the camera plane, ${side > 0 ? 'right' : 'left'}: ${angs.map(a => a.toFixed(1) + '°').join(' ')}`);
  for (let i = 1; i < angs.length; i++) check(angDiff(angs[i], angs[i - 1]) < 10, `continuity, side ${side}: arc jumps from ${angs[i - 1].toFixed(1)}° to ${angs[i].toFixed(1)}°`);
  check(angs.every(a => angDiff(a, side > 0 ? 90 : -90) < 30), `continuity, side ${side}: arc not at the ${side > 0 ? 'right' : 'left'} throughout`);
}

// The ring against the gun ring at its widest: the sight's ring grows as the range falls.
{ await place([{ at: [60, 0, 0] }]); await p.evaluate(() => window.__x.draw(false));
  const r = await read();
  console.log(`target at 60 m: gun ring ${r.ring.toFixed(0)} px, indicator ring ${r.R.toFixed(0)} px`);
  check(r.R >= Math.min(r.ring + 16 + 6, r.h * .42), `at 60 m the indicator ring (${r.R.toFixed(0)}) does not clear the gun ring (${r.ring.toFixed(0)})`); }

// What the sight's inRange means in metres, against a target sat still ahead, at full and no throttle.
{ await place([{ at: [800, 300, 0] }]);
  const reach = await p.evaluate(() => { const G = window.__g, X = window.__x, out = {};
    for (const thr of [0, 1]) { G.player.throttle = thr; let d = 100; while (d < 5000 && X.reachAt(d)) d += 50; out[thr] = d; }
    G.player.throttle = .5; return out; });
  console.log(`the sight's inRange against a still target ends at ${reach[0]} m at no throttle, ${reach[1]} m at full`); }

// No allocation in drawEnemyIndicators: a sampling heap profile over 20,000 calls with
// eight enemies placed, garbage included, after 20,000 calls to warm it up (until it is
// optimised, every number in it is boxed on the heap, which says nothing about play). It
// fails over 1 B a call on average, against 24 B or more for any object made each call. It
// profiles the whole function and a copy that stops before it draws, and is checked on
// gunSight, which builds objects every call; --self-test-leak plants a Vector3 a call in
// both, which must fail.
async function profile(page, fn) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  // Garbage included: by default the profile keeps only what is still alive at the end.
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await page.evaluate(fn);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  await cdp.detach();
  const by = {};
  (function walk(n) { const f = n.callFrame.functionName || '(anon)'; by[f] = (by[f] || 0) + n.selfSize; n.children.forEach(walk); })(profile.head);
  return by;
}
// Each profiled after 20,000 unprofiled calls, so that it runs optimised: before that every
// number in it is boxed, which says nothing about the game in play.
const many = name => p.evaluate(n => { const X = window.__x; for (let i = 0; i < 20000; i++) { X[n](); X.sight(); } }, name);
await place(CASES.eight);
for (const n of ['drawInd', 'noDraw']) await many(n);
const real = await profile(p, () => { const X = window.__x; for (let i = 0; i < 20000; i++) { X.drawInd(); X.sight(); } });
const nd = await profile(p, () => { const X = window.__x; for (let i = 0; i < 20000; i++) { X.noDraw(); X.sight(); } });
{ const own = (nd.__indNoDraw || 0) + (nd.indicatorColour || 0), sight = nd.gunSight || 0, drawn = (real.drawEnemyIndicators || 0) + (real.indicatorColour || 0);
  console.log(`sampled allocations, 20,000 calls with eight enemies: drawEnemyIndicators ${drawn} B, up to its drawing ${own} B; ` +
    `gunSight ${sight} B (instrument check)`);
  check(sight > 100000, 'the heap profile found little or no allocation in gunSight: the instrument does not work');
  check(own < 20000, `drawEnemyIndicators allocates before it draws: ${(own / 20000).toFixed(1)} B a call`);
  check(drawn < 20000, `drawEnemyIndicators allocates: ${(drawn / 20000).toFixed(1)} B a call`); }

const errors = [...game.errors];
await game.close();
if (RENDER) console.log(`renders in ${OUT}`);
for (const [k, n] of errors) fails.push(`page: ${k} x${n}`);
if (fails.length) { console.error(`FAIL (${fails.length})`); for (const f of fails) console.error('  ' + f); process.exit(1); }
console.log('PASS');
