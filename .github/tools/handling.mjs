/**
 * Handling: how the jet answers the keys, measured in the real game loop at 60 and 30 fps.
 * For each axis it holds the key from rest, wings level at about 1,500 m and 70% throttle,
 * and reports the steady turn rate, the time to reach 63% of it, and the time to turn
 * through 90 degrees, then lets go and reports how far the jet keeps turning.
 *
 *   node .github/tools/handling.mjs [--page file.html]
 *
 * Checks the roll against "Roll response is sluggish": 90 degrees from wings level in
 * 0.45-0.55 s, and the same at 30 and 60 fps (within 20 ms). Pitch and yaw are reported, not
 * checked: they are the knob in "The flight model allows 30+ G". Exits 1 on a failed check or
 * a page error.
 */
import { openGame, stepper, arg } from './lib.mjs';

const game = await openGame({ transform: stepper });
const p = game.page;
await p.waitForFunction(() => window.__g, null, { timeout: 90000 });
await p.evaluate(() => { window.__g.snd.init = () => {}; window.__g.start(); });
const rows = await p.evaluate(() => {
  const G = window.__g, T = G.THREE, out = [];
  const AXES = { roll: ['ArrowLeft', new T.Vector3(0, 0, 1)], pitch: ['ArrowDown', new T.Vector3(1, 0, 0)], yaw: ['KeyA', new T.Vector3(0, 1, 0)] };
  for (const fps of [60, 30]) for (const [axis, [key, ax]] of Object.entries(AXES)) {
    const dt = 1 / fps;
    G.restart();
    for (let i = 0; i < 60; i++) { G.jet.position.set(0, 1500, 0); G.jet.quaternion.identity(); G.player.velocity.set(0, 0, -327); G.player.throttle = 0.7; G.frame(1 / 60, false); }
    G.jet.quaternion.identity(); G.player.rollRate = G.player.pitchRate = G.player.yawRate = 0;
    // The angle turned about the axis since q0, unwrapped across whole turns.
    const q0 = G.jet.quaternion.clone(); let total = 0, last = 0;
    const turned = () => { const q = q0.clone().invert().multiply(G.jet.quaternion), a = 2 * Math.atan2(new T.Vector3(q.x, q.y, q.z).dot(ax), q.w);
      total += Math.atan2(Math.sin(a - last), Math.cos(a - last)); last = a; return total; };
    const rest = () => { q0.copy(G.jet.quaternion); total = last = 0; };
    let t = 0, t90 = null, t63 = null, prev = 0, rates = [];
    G.keys[key] = true;
    while (t < 2.5) { G.jet.position.y = 1500; G.frame(dt, false); t += dt; const a = turned(); rates.push((a - prev) / dt); prev = a;
      if (t90 === null && Math.abs(a) >= Math.PI / 2) t90 = t; }
    const steady = Math.abs(rates[rates.length - 1]);
    // Time to 63% of the steady rate, from a second start at rest.
    G.keys[key] = false; G.jet.quaternion.identity(); G.player.rollRate = G.player.pitchRate = G.player.yawRate = 0;
    rest(); prev = 0; t = 0; G.keys[key] = true;
    while (t < 1 && t63 === null) { G.jet.position.y = 1500; G.frame(dt, false); t += dt; const a = turned();
      if (Math.abs(a - prev) / dt >= 0.632 * steady) t63 = t; prev = a; }
    // From rest again, let go after 90 degrees: how far it keeps turning.
    G.keys[key] = false; G.jet.quaternion.identity(); G.player.rollRate = G.player.pitchRate = G.player.yawRate = 0;
    rest(); G.keys[key] = true;
    while (Math.abs(turned()) < Math.PI / 2) { G.jet.position.y = 1500; G.frame(dt, false); }
    const at = turned(); G.keys[key] = false;
    for (let i = 0; i < fps; i++) { G.jet.position.y = 1500; G.frame(dt, false); }
    out.push({ axis, fps, steadyDegS: +(steady * 180 / Math.PI).toFixed(1), t63: t63 && +t63.toFixed(3), t90: t90 && +t90.toFixed(3),
      overrunDeg: +(Math.abs(turned() - at) * 180 / Math.PI).toFixed(1) });
  }
  return out;
});
await game.close();
console.log('axis    fps   steady deg/s   63% of it   90 degrees   keeps turning after release');
for (const r of rows) console.log(`${r.axis.padEnd(7)} ${String(r.fps).padStart(3)}   ${String(r.steadyDegS).padStart(10)}   ${String(r.t63 ?? '-').padStart(7)} s   ${String(r.t90 ?? '-').padStart(8)} s   ${String(r.overrunDeg).padStart(6)} deg`);
const results = [], check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const roll = fps => rows.find(r => r.axis === 'roll' && r.fps === fps);
console.log('');
check('roll: 90 degrees from wings level in 0.45-0.55 s at 60 fps', roll(60).t90 >= 0.45 && roll(60).t90 <= 0.55, roll(60).t90);
check('roll: 90 degrees from wings level in 0.45-0.55 s at 30 fps', roll(30).t90 >= 0.45 && roll(30).t90 <= 0.55, roll(30).t90);
check('roll: the same at 30 and 60 fps (within 20 ms)', Math.abs(roll(30).t90 - roll(60).t90) <= 0.02, [roll(60).t90, roll(30).t90]);
const errors = [...game.errors], failed = results.filter(ok => !ok).length;
for (const [k, n] of errors) console.error(`  ${k} x${n}`);
if (failed || errors.length) { console.error(`\nFAIL: ${failed} of ${results.length} checks failed, ${errors.length} page errors`); process.exit(1); }
console.log(`\nall ${results.length} checks passed`);
