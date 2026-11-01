/**
 * Calibration for the person-like pilot (person.mjs): how well it holds a target that is
 * not trying to get away. One enemy flies a straight line at constant speed, its AI frozen
 * and its hit points made endless, while the pilot tracks it and shoots for 20 s; the rest
 * of the wave is taken out of play. Reports the angle between the target and the HUD's aim
 * point (median, 90th percentile, share of the time under 2 degrees), how much of the time
 * the trigger was held, and rounds and hits.
 *
 *   node .github/tools/track.mjs [--cases '[[range, crossing m/s, seconds], ...]'] [--opts '{"noiseDeg":0}'] [--page file.html]
 *
 * --opts overrides the pilot's constants (PERSON in person.mjs), so `{"noiseDeg":0.01}`
 * shows its tracking with the aim noise turned off. The aim point is the gun cross when the
 * page defines gunSight(), and the centre of the screen before that; the error is measured
 * to the mark the pilot steers for, the lead marker when there is one and the target box
 * otherwise. Exits 1 on page errors.
 */
import { openGame, stepper, gameStats, arg } from './lib.mjs';
import { installPerson, PERSON } from './person.mjs';

const CASES = JSON.parse(arg('cases', '[[500,0,20],[500,100,20],[800,60,20]]'));
const game = await openGame({ transform: h => gameStats(stepper(h)), viewport: { width: 1280, height: 720 } });
const p = game.page;
await p.waitForFunction(() => window.__g, null, { timeout: 90000 });
await p.evaluate(() => { window.__g.snd.init = () => {}; window.__g.start(); });
await p.evaluate(installPerson, { ...PERSON, ...JSON.parse(arg('opts', '{}')) });
const rows = [];
for (const [range, cross, secs] of CASES) rows.push(await p.evaluate(([range, cross, secs]) => {
  const G = window.__g, T = G.THREE, P = window.__person, DT = 1 / 60, SPEED = 327;   // 70% throttle
  const hold = () => { G.jet.position.set(0, 1500, 0); G.jet.quaternion.identity(); G.player.velocity.set(0, 0, -SPEED); G.player.throttle = 0.7; };
  G.restart();
  for (let i = 0; i < 420; i++) { hold(); G.frame(DT, false); }   // the intermission, and wave 1 spawning
  if (G.gameOver || !G.enemies.length) throw new Error('no wave to borrow a target from');
  P.reset();
  const e = G.enemies[0]; for (const x of G.enemies.slice(1)) x.alive = false;
  e.hp = Infinity;
  const vel = new T.Vector3(cross, 0, -SPEED), q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, -1), vel.clone().normalize());
  e.mesh.position.set(-cross * 2, 1500, -range);
  let hits = 0; window.__stats = { hit() { hits++; }, kill() {} };
  const rounds0 = G.player.gunRound, errs = []; let firing = 0;
  const aimErr = () => {
    G.camera.updateMatrixWorld();
    const s = G.sight ? G.sight() : null, w = innerWidth, h = innerHeight;
    const aim = s ? s.cross : { x: w / 2, y: h / 2 };
    let mark = s ? s.lead || s.box : null;
    if (!s) { const v = e.mesh.position.clone().project(G.camera); mark = v.z < 1 ? { x: (v.x * .5 + .5) * w, y: (-v.y * .5 + .5) * h } : null; }
    const f = (h / 2) / Math.tan(G.camera.fov * Math.PI / 360);
    return mark ? Math.min(Math.atan(Math.hypot(mark.x - aim.x, mark.y - aim.y) / f), Math.PI / 2) * 180 / Math.PI : 90;
  };
  for (let i = 0; i < secs * 60; i++) {
    const next = e.mesh.position.clone().addScaledVector(vel, DT);
    e.prevPosition.copy(e.mesh.position); e.mesh.position.copy(next); e.mesh.quaternion.copy(q);
    P.step(DT);
    G.frame(DT, false);
    // Undo whatever the frozen enemy's AI did to it this frame.
    e.mesh.position.copy(next); e.mesh.quaternion.copy(q); e.state = 'reposition'; e.stateTimer = 0; e.wasHit = false;
    if (G.gameOver) throw new Error('the pilot died during the track');
    if (G.keys.Space) firing++;
    if (i >= 120) errs.push(aimErr());
  }
  errs.sort((a, b) => a - b);
  const pct = q => +errs[Math.floor(errs.length * q)].toFixed(2);
  return { range, crossing: cross, medianDeg: pct(0.5), p90Deg: pct(0.9), under2: +(errs.filter(x => x < 2).length / errs.length).toFixed(2),
    firing: +(firing / (secs * 60)).toFixed(2), rounds: G.player.gunRound - rounds0, hits,
    endRange: Math.round(e.mesh.position.distanceTo(G.jet.position)) };
}, [range, cross, secs]));
await game.close();
console.log('start range m, crossing m/s: error from the aim point (median, 90th pct, share under 2 deg), trigger held, rounds, hits');
for (const r of rows) console.log(`  ${String(r.range).padStart(5)} m ${String(r.crossing).padStart(4)} m/s:  ${r.medianDeg.toFixed(2).padStart(5)} ${r.p90Deg.toFixed(2).padStart(6)} deg ${String(Math.round(100 * r.under2)).padStart(3)}%   firing ${String(Math.round(100 * r.firing)).padStart(3)}%  ${String(r.rounds).padStart(5)} rounds ${String(r.hits).padStart(4)} hits  (ends at ${r.endRange} m)`);
const errors = [...game.errors];
if (errors.length) { console.error('FAIL'); for (const [k, n] of errors) console.error(`  ${k} x${n}`); process.exit(1); }
