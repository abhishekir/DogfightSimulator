/**
 * How the enemies fly: the person-like pilot (person.mjs) fights the game at a fixed
 * timestep while every live enemy is sampled every frame, and the tool reports how fast
 * their noses turn, how fast they roll, how hard their commanded speed changes, and how
 * often the ground rules move them instead of their own flying. It is the measurement
 * behind "Enemies fly twitchily" in TODO.md, and the check for its Done-when.
 *
 *   node .github/tools/enemy-flight.mjs [--minutes 5] [--fps 60] [--low] [--check] [--page file.html]
 *
 * --low holds the player within 400 m of the ground (its height is clamped after every
 * frame), so the fight is low and the enemies' terrain avoidance runs; at altitude it never
 * does.
 *
 * Per enemy, per frame:
 *  - turn rate: the angle between this frame's nose direction and the last, over dt;
 *  - roll rate: the twist about the nose in the rotation from last frame to this, over dt;
 *  - speed change: the change in `currentSpeed` over dt, in g, and the largest change in a
 *    single frame in m/s (a step has no meaningful acceleration: its g figure is the step
 *    over one frame time). Before flyEnemy, `currentSpeed` was what the AI state set each
 *    frame, so a state change was a step; since, it is the speed flown, which follows the
 *    state's `speedCmd` at a bounded acceleration;
 *  - lifted: vertical movement its own flying does not account for, counted when it exceeds
 *    60 m/s: before flyEnemy, the terrain clamp and the low-altitude climb; since, only its
 *    last-resort floor, which the pull-up for the ground ahead should never leave to it.
 *  - roll reversals, per enemy-minute: every change of the roll's direction while above
 *    0.5 rad/s (rolling into a turn and out again is one); of those, snaps, where the roll
 *    rate is above 0.5 rad/s one way in one frame and the other way in the next, and rocks,
 *    which come within 0.5 s of the one before; and how many came while avoiding terrain;
 *  - terrain avoidance: the share of enemy-frames with the climb blended in (`e.ground` > 0).
 * Each is reported as the median, the 95th and 99th percentiles and the peak over all
 * enemy-frames, with the turn rate again by AI state. The percentiles repeat from run to
 * run; a peak is one frame of one enemy and does not, so compare peaks over several runs.
 * A frame's rates are that frame's change over dt, so run it at 30 as well as 60 fps:
 * anything applied per frame rather than per second shows up as a difference.
 *
 * --check fails the run unless the enemies stay inside the limits that task sets: nose
 * turn rate at most 60 deg/s (the player's pitch rate), roll rate at most 270 deg/s, speed
 * change at most 2 g, nothing lifted, and at most 5 snaps and 24 rocks per enemy-minute (see
 * LIMITS). Snaps are counted between frames, so they come easier at 30 fps; run both, and
 * with --low, which is where the terrain code runs. Without it the tool only measures. Exits 1 on a
 * failed check or a page error.
 */
import { openGame, stepper, arg, flag } from './lib.mjs';
import { installPerson, PERSON } from './person.mjs';

const MINUTES = Number(arg('minutes', 5)), FPS = Number(arg('fps', 60)), CHECK = flag('check'), LOW = flag('low');
// Snaps and rocks: some rocking is ordinary flying (13-16 rocks per enemy-minute at altitude,
// 19-21 in a low fight, at 60 and at 30 fps). When the terrain pull-up switched on and off at
// 150 m, a low fight at 30 fps gave 37 rocks and 24 snaps, against 25 and 0 at 60.
const LIMITS = { turnDegS: 60, rollDegS: 270, speedChangeG: 2, snapsPerMin: 5, rocksPerMin: 24 };
const game = await openGame({ transform: stepper, viewport: { width: 1280, height: 720 } });
const p = game.page;
await p.waitForFunction(() => window.__g, null, { timeout: 90000 });
await p.evaluate(() => { window.__g.snd.init = () => {}; window.__g.start(); });
await p.evaluate(installPerson, PERSON);
const r = await p.evaluate(([minutes, fps, low]) => {
  const G = window.__g, T = G.THREE, P = window.__person, dt = 1 / fps, deg = 180 / Math.PI;
  const prev = new Map(), f = new T.Vector3(), dq = new T.Quaternion();
  const turn = [], roll = [], speed = [], byState = {}; let lifted = 0, frames = 0, lives = 1, jump = 0, reversals = 0, snaps = 0, rocks = 0, reversalsGround = 0, groundFrames = 0, t = 0;
  for (let i = 0; i < minutes * 60 * fps; i++) {
    P.step(dt); G.frame(dt, false); t += dt;
    if (low) { const j = G.jet.position, g = G.ground(j.x, j.z) + 400; if (j.y > g) { j.y = g; if (G.player.velocity.y > 0) G.player.velocity.y = 0; } }
    if (G.gameOver && G.deathCamTimer <= 0) { G.restart(); P.reset(); prev.clear(); lives++; }
    for (const e of G.enemies) {
      if (!e.alive) continue;
      const q = e.mesh.quaternion, pos = e.mesh.position, o = prev.get(e);
      f.set(0, 0, -1).applyQuaternion(q);
      if (o) {
        const t = Math.acos(Math.min(1, f.dot(o.f))) / dt * deg;
        dq.copy(o.q).invert().multiply(q);                       // last frame's attitude to this one's
        const rl = Math.abs(2 * Math.atan2(dq.z, dq.w));
        turn.push(t); roll.push(Math.min(rl, 2 * Math.PI - rl) / dt * deg);
        speed.push(Math.abs(e.currentSpeed - o.speed) / dt / 9.81); jump = Math.max(jump, Math.abs(e.currentSpeed - o.speed));
        (byState[e.state] ||= []).push(t);
        if (((pos.y - o.y) - f.y * e.currentSpeed * dt) / dt > 60) lifted++;
        if (e.ground > 0) groundFrames++;
        // A roll reversal: the roll rate's sign flips while it is above 0.5 rad/s either side.
        const rr = e.rollRate ?? 0;
        if (Math.abs(rr) > 0.5) {
          if (o.rollSign && Math.sign(rr) !== o.rollSign) { reversals++; if (e.ground > 0) reversalsGround++;
            if (Math.abs(o.rr) > 0.5) snaps++;
            if (t - o.lastRev < 0.5) rocks++;
            o.lastRev = t; }
          o.rollSign = Math.sign(rr); }
        o.rr = rr;
        frames++;
        o.f.copy(f); o.q.copy(q); o.y = pos.y; o.speed = e.currentSpeed;
      } else prev.set(e, { f: f.clone(), q: q.clone(), y: pos.y, speed: e.currentSpeed, rollSign: 0, rr: 0, lastRev: -Infinity });
    }
    for (const e of prev.keys()) if (!e.alive) prev.delete(e);
  }
  const sum = a => { a.sort((x, y) => x - y); const at = q => +a[Math.min(a.length - 1, Math.floor(a.length * q))].toFixed(1);
    return a.length ? { n: a.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: +a[a.length - 1].toFixed(1) } : null; };
  const enemyMin = frames * dt / 60;
  return { frames, lives, kills: G.kills, turnDegS: sum(turn), rollDegS: sum(roll), speedChangeG: sum(speed), speedJump: Math.round(jump), lifted,
    reversalsPerMin: +(reversals / enemyMin).toFixed(1), snapsPerMin: +(snaps / enemyMin).toFixed(2), rocksPerMin: +(rocks / enemyMin).toFixed(2), reversalsGroundPerMin: +(reversalsGround / enemyMin).toFixed(1), groundShare: +(groundFrames / frames).toFixed(4),
    turnByState: Object.fromEntries(Object.entries(byState).map(([k, a]) => [k, sum(a)])) };
}, [MINUTES, FPS, LOW]);
await game.close();

if (!r.frames) { console.error('FAIL: no enemy was ever alive'); process.exit(1); }
const row = (name, s, unit) => console.log(`  ${name.padEnd(24)} ${String(s.p50).padStart(8)} ${String(s.p95).padStart(8)} ${String(s.p99).padStart(8)} ${String(s.max).padStart(9)}  ${unit}`);
console.log(`${MINUTES} game-minutes at ${FPS} fps${LOW ? ', the player held within 400 m of the ground' : ''}, person-like pilot (${r.lives} lives): ${r.frames} enemy-frames`);
console.log(`  ${''.padEnd(24)} ${'median'.padStart(8)} ${'95th'.padStart(8)} ${'99th'.padStart(8)} ${'peak'.padStart(9)}`);
row('turn rate of the nose', r.turnDegS, 'deg/s'); row('roll rate', r.rollDegS, 'deg/s'); row('change of speed', r.speedChangeG, 'g');
console.log(`  largest change of speed in one frame: ${r.speedJump} m/s`);
console.log(`  lifted by the ground rules: ${r.lifted} enemy-frames (${(100 * r.lifted / r.frames).toFixed(2)}%)`);
console.log(`  roll reversals: ${r.reversalsPerMin} per enemy-minute (snaps ${r.snapsPerMin}, rocks ${r.rocksPerMin}), ${r.reversalsGroundPerMin} of them avoiding terrain`);
console.log(`  avoiding terrain: ${(100 * r.groundShare).toFixed(2)}% of enemy-frames`);
console.log('  turn rate by state:');
for (const [k, s] of Object.entries(r.turnByState)) row(`    ${k} (${(100 * s.n / r.frames).toFixed(0)}% of frames)`, s, 'deg/s');

const errors = [...game.errors];
let failed = 0;
if (CHECK) {
  const check = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'pass' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`); };
  console.log('');
  check(`nose turn rate never above ${LIMITS.turnDegS} deg/s`, r.turnDegS.max <= LIMITS.turnDegS, r.turnDegS.max);
  check(`roll rate never above ${LIMITS.rollDegS} deg/s`, r.rollDegS.max <= LIMITS.rollDegS, r.rollDegS.max);
  check(`speed never changes faster than ${LIMITS.speedChangeG} g`, r.speedChangeG.max <= LIMITS.speedChangeG, r.speedChangeG.max);
  check('nothing lifted by the ground rules', r.lifted === 0, r.lifted);
  check(`roll snaps at most ${LIMITS.snapsPerMin} per enemy-minute`, r.snapsPerMin <= LIMITS.snapsPerMin, r.snapsPerMin);
  check(`roll rocks at most ${LIMITS.rocksPerMin} per enemy-minute`, r.rocksPerMin <= LIMITS.rocksPerMin, r.rocksPerMin);
}
for (const [k, n] of errors) console.error(`  ${k} x${n}`);
if (failed || errors.length) { console.error(`\nFAIL: ${failed} checks failed, ${errors.length} page errors`); process.exit(1); }
