/**
 * Scripted fight scene: a seeded run that renders the same frames every time, for
 * before/after comparisons of anything visual.
 *
 *   node .github/tools/scene.mjs [--page file.html] [--tag name] [--out dir] [--seed 7]
 *
 * Level flight at about 1,200 m, then six missiles crossing the nose, a second of cannon
 * hits on a point 110 m ahead, a kill nearby partway through, and the kill on that point,
 * which leaves the particle pool under the pressure of a heavy fight. Writes calm-<tag>.png
 * (before anything happens) and kill-<tag>.png (50 ms after the kill) to .github/tools/out/,
 * prints what held the pool just before the kill and what each emitter was granted, and
 * saves those as scene-<tag>.json. Run it on two copies of the game with different tags:
 * their frames match until the copies behave differently.
 *
 * A normal headless run is not repeatable even with Math.random seeded, because three
 * things run on the wall clock: three.js takes a random number for every UUID, inside a
 * terrain build that is budgeted at 4 ms a frame, so the stream shifts by however many
 * chunks the clock allowed; the sound engine draws random numbers on the audio clock; and
 * the HUD's radar sweep and warning blinks follow Date.now(). So this seeds Math.random,
 * builds the whole terrain queue each frame, never starts the AudioContext, and hides the
 * HUD. Exits 1 on page errors.
 */
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { openGame, stepper, splice, arg, outDir } from './lib.mjs';

const TAG = arg('tag', 'scene'), OUT = arg('out', null) || await outDir();
const SEED = `window.__seed=s=>{let a=s;Math.random=()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}};window.__seed(${Number(arg('seed', 7))});\n`;
const transform = html => {
  html = stepper(html);
  html = splice(html, '<script type="module">', '<script type="module">\n' + SEED);
  html = splice(html, 'while (terrainQueue.length && performance.now() < deadline) {', 'while (terrainQueue.length) {');
  // A copy of the game from before the per-emitter counters still runs, without them.
  return splice(html, 'window.__g = {', `window.__x = { spawnMissile, emitters: (()=>{try{return emitters}catch{return null}})(),
  ex: (p,c,k)=>{ try { return spawnExplosion(p,c,emitters[k]) } catch { return spawnExplosion(p,c) } } };
window.__g = {`);
};
const game = await openGame({ transform, viewport: { width: 960, height: 540 } });
const p = game.page;
await p.waitForFunction(() => window.__g, null, { timeout: 90000 });
await p.evaluate(() => { window.__g.snd.init = () => {}; window.__g.start(); });
const DT = 1 / 60;
const run = (n, render = false) => p.evaluate(([n, dt, r]) => { for (let i = 0; i < n; i++) window.__g.frame(dt, r && i === n - 1); }, [n, DT, render]);
// Climb clear of the terrain, then let terrain and clouds stream in.
await p.evaluate(() => { window.__g.jet.position.y += 900; });
for (let i = 0; i < 40; i++) await p.evaluate(() => { window.__g.frame(0, false); });
await run(300);
await p.evaluate(() => { document.getElementById('hud').style.display = 'none'; });

const at = (ahead, right, up) => p.evaluate(([a, r, u]) => {
  const G = window.__g, T = G.THREE, j = G.jet;
  return new T.Vector3(r, u, -a).applyQuaternion(j.quaternion).add(j.position).toArray(); }, [ahead, right, up]);
const shoot = async name => { await run(1, true); await p.screenshot({ path: join(OUT, `${name}-${TAG}.png`) }); };
const ex = (t, c, k, jitter = 0) => p.evaluate(([t, c, k, j]) => { const T = window.__g.THREE;
  window.__x.ex(new T.Vector3(...t).add(new T.Vector3((Math.random() - .5) * j, (Math.random() - .5) * j, (Math.random() - .5) * j)), c, k); }, [t, c, k, jitter]);
await p.evaluate(() => window.__seed(99));
await shoot('calm');
// Six missiles crossing the nose 130-280 m out, so their trails fill the trail budget.
await p.evaluate(() => { const G = window.__g, T = G.THREE, j = G.jet;
  for (let k = 0; k < 6; k++) { const pos = new T.Vector3(-200, -10 + k * 12, -130 - k * 30).applyQuaternion(j.quaternion).add(j.position);
    const dir = new T.Vector3(1, 0.05 * (k - 2.5), 0.25 * (k % 2 ? 1 : -1)).normalize().applyQuaternion(j.quaternion);
    window.__x.spawnMissile(pos, dir, G.player.velocity, null, false); } });
await run(90);
// Hosing a target 110 m ahead: a tracer strike every other frame, a kill nearby partway
// through, then this target's kill.
const tgt = await at(110, 40, -12), other = await at(260, -70, 30);
for (let f = 0; f < 40; f++) {
  if (f % 2 === 0) await ex(tgt, 4, 'spark', 8);
  if (f === 10) await ex(other, 40, 'explosion');
  await run(1);
}
const pool = await p.evaluate(() => { const using = {};
  for (const q of window.__g.particles) { const k = q.emitter ? q.emitter.name : q.type; using[k] = (using[k] || 0) + 1; }
  return { free: window.__g.freeParticles.length, using }; });
await ex(tgt, 55, 'explosion');
await run(2);
await shoot('kill');
const granted = await p.evaluate(() => { const E = window.__x.emitters;
  return E && Object.fromEntries(Object.values(E).filter(e => e.requested).map(e => [e.name, `${e.requested - e.dropped}/${e.requested}`])); });
const result = { beforeTheKill: pool, granted }, errors = [...game.errors];
console.log(`${TAG}: ${JSON.stringify(result)}\nframes in ${OUT}`);
await writeFile(join(OUT, `scene-${TAG}.json`), JSON.stringify(result, null, 1));
await game.close();
if (errors.length) { console.error('FAIL'); for (const [k, n] of errors) console.error(`  ${k} x${n}`); process.exit(1); }
