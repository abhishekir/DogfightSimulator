/**
 * Gunsight check: does putting the gun cross on the lead marker hit, does the cue mean what
 * it says, and does the cross stay on the gun line through turns? Reads the sight the HUD
 * draws (gunSight() in the page), so it tests what the player sees, not a copy of the maths.
 *
 *   node .github/tools/gunsight.mjs [--dt 0.0167] [--page file.html]
 *
 * A target is one enemy flying a straight line at constant velocity, its AI skipped, with
 * endless hit points. "Holding" means that every frame the jet is pointed so that the gun
 * cross lands on the lead marker as the HUD shows it (the marker's screen point is
 * unprojected, and the nose aimed at the point on that ray at the sight's range), or a set
 * distance off it. Every round fired is followed: whether the cue was lit when it left, and
 * how close its straight path passes the target, worked out from the round's and the
 * target's own positions and velocities, not from the sight.
 *
 * 1. On the marker. Trigger held for 1.5 s at 200-1,000 m, the target flying away, across
 *    the nose at up to 120 m/s, or climbing and closing. Fails if any case lands no hits, or
 *    the cue is not lit.
 * 2. The cue's edge. The cue is lit when rounds from both muzzles, 2.5 m either side of the
 *    gun line, will pass inside the hit radius. With the cross held 0.7 hit radii off the
 *    marker, in four directions, every round must leave with the cue lit and pass inside
 *    the radius, and some must hit; held 1.4 radii off, every round must leave unlit and
 *    pass outside it, and none hit. Then the cross sweeps across the marker and the cue is
 *    compared with each round's own path: no round that left lit may pass outside the
 *    radius (give or take the target's crossing speed times one frame, which is how stale
 *    the cue is when the round leaves), and every round passing well inside it, by twice
 *    the muzzle offset and that frame, must have left lit.
 * 3. High closure. A target flying at the jet, 600 m/s faster than level with it, from
 *    1,400 m: every round's path must pass inside the hit radius with the cue lit. How many
 *    of them the game counts as hits is reported, not checked: rounds are tested against
 *    the target once a frame, and at this closure and 30 fps a round can cross the whole
 *    hit radius between two frames ("Rounds can pass through a target between frames" in
 *    TODO.md). Run with --dt 0.0333 to see it.
 * 4. The gun line through turns. The jet pulls and rolls at full rate with the trigger held
 *    and no target, so the chase camera lags; for every round fired, the gun cross's point
 *    (GUN_ORIGIN along the nose at the sight's range) must lie on the round's path, within
 *    the muzzles' 2.5 m offset either side, and the round must fly at the sight's speed.
 *    Reports how far the cross moved from the middle of the screen while it did.
 *
 * --dt runs the simulation at another frame time (1/30 for 30 fps). Exits 1 on a failed
 * check or a page error.
 */
import { openGame, stepper, splice, arg } from './lib.mjs';

const DT = Number(arg('dt', 1 / 60));
const transform = html => {
  html = stepper(html);
  // A target that flies a straight line: an enemy given `straight` skips its AI.
  html = splice(html, "for(let i=enemies.length-1;i>=0;i--){const e=enemies[i];if(!e.alive)continue;e.prevPosition.copy(e.mesh.position);",
    "for(let i=enemies.length-1;i>=0;i--){const e=enemies[i];if(!e.alive)continue;e.prevPosition.copy(e.mesh.position);if(e.straight){e.mesh.position.addScaledVector(e.straight,dt);continue}");
  html = splice(html, 'e.hp-=GUN_DAMAGE;e.wasHit=true;', 'e.hp-=GUN_DAMAGE;e.wasHit=true;window.__hits=(window.__hits||0)+1;');
  return splice(html, 'window.__g = {', 'window.__x = { gunSight, GUN_ORIGIN, commandedSpeed, GUN_MUZZLE_SPEED, GUN_HIT_RADIUS, GUN_MUZZLE_OFFSET };\nwindow.__g = {');
};
const game = await openGame({ transform, viewport: { width: 1280, height: 720 } });
const p = game.page;
await p.waitForFunction(() => window.__g, null, { timeout: 90000 });
await p.evaluate(() => { window.__g.snd.init = () => {}; window.__g.start(); });

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

// Page helpers: a target on a straight line, and holding the gun cross on (or off) its marker.
await p.evaluate(() => {
  const G = window.__g, T = G.THREE, X = window.__x, SPEED = 327;
  const m = new T.Matrix4(), up = new T.Vector3(0, 1, 0), M = new T.Vector3(), P = new T.Vector3(), ray = new T.Vector3(), d = new T.Vector3(), q = new T.Quaternion();
  window.__t = {
    SPEED,
    // An enemy flying a straight line `range` ahead, at the jet's speed plus [right, up, away].
    target(range, [vr, vu, vf], hp = Infinity) {
      G.restart();
      for (let i = 0; i < 420; i++) { G.jet.position.set(0, 1500, 0); G.jet.quaternion.identity(); G.player.velocity.set(0, 0, -SPEED); G.player.throttle = 0.7; G.frame(1 / 60, false); }
      if (G.gameOver || !G.enemies.length) throw new Error('no wave to borrow a target from');
      const e = G.enemies[0]; for (const x of G.enemies.slice(1)) x.alive = false;
      e.hp = hp; e.straight = new T.Vector3(vr, vu, -SPEED - vf);
      e.mesh.position.set(0, 1500, -range); e.prevPosition.copy(e.mesh.position);
      e.mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 0, -1), e.straight.clone().normalize());
      return e;
    },
    // Aim the nose so that the gun cross falls on the HUD's lead marker, or off it in the
    // direction `dir` (radians round the nose, 0 = above) by `off` radians, or by `metres` at
    // the sight's range.
    hold(off = 0, dir = 0, metres = 0) {
      const s = X.gunSight(); if (!s.lead) return false;
      if (metres) off = Math.atan(metres / s.range);
      const cam = G.camera, C = cam.position;
      ray.set(s.lead.x / innerWidth * 2 - 1, 1 - s.lead.y / innerHeight * 2, 0.5).unproject(cam).sub(C).normalize();
      for (let k = 0; k < 3; k++) {        // the muzzle point moves with the nose, so settle it
        M.copy(X.GUN_ORIGIN).applyQuaternion(G.jet.quaternion).add(G.jet.position);
        const oc = C.clone().sub(M), b = oc.dot(ray), c = oc.lengthSq() - s.range * s.range;
        P.copy(C).addScaledVector(ray, -b + Math.sqrt(b * b - c));
        if (off) { d.subVectors(P, M); const side = new T.Vector3().crossVectors(d, up).normalize(), lift = new T.Vector3().crossVectors(side, d).normalize();
          d.applyQuaternion(q.setFromAxisAngle(side.multiplyScalar(Math.cos(dir)).addScaledVector(lift, -Math.sin(dir)).normalize(), off)); P.copy(M).add(d); }
        G.jet.quaternion.setFromRotationMatrix(m.lookAt(M, P, up));
      }
      G.player.pitchRate = G.player.yawRate = G.player.rollRate = 0;
      return true;
    },
    // Hold the trigger for `secs`, calling aim(time) before every frame, then let the rounds
    // in flight land. For every round: whether the cue was lit as it left, and how close its
    // own straight path passes the target `e`, from the two positions and velocities.
    shoot(e, secs, dt, aim = () => window.__t.hold()) {
      const live = new Set(G.bullets.filter(b => b.userData.active)), rounds = [], D = new T.Vector3(), rel = new T.Vector3();
      window.__hits = 0; let lit = 0, n = 0;
      for (let i = 0; i < Math.round(secs / dt); i++) {
        aim(i * dt); const cue = X.gunSight().cue; if (cue) lit++; n++;
        G.keys.Space = true; G.frame(dt, false);
        for (const b of G.bullets) { if (!b.userData.active || b.userData.isEnemy || live.has(b)) continue; live.add(b);
          D.subVectors(e.mesh.position, b.position); rel.copy(b.userData.vel).sub(e.straight);
          const tca = D.dot(rel) / rel.lengthSq();
          rounds.push({ cue, miss: tca > 0 ? D.addScaledVector(rel, -tca).length() : D.length() }); }
        for (const b of [...live]) if (!b.userData.active) live.delete(b);
      }
      G.keys.Space = false;
      for (let i = 0; i < Math.round(2.6 / dt); i++) { aim(secs); G.frame(dt, false); }
      return { rounds, hits: window.__hits, cueLit: +(lit / n).toFixed(2), endRange: Math.round(e.mesh.position.distanceTo(G.jet.position)) };
    },
  };
});

// [start range m, target velocity relative to the jet's line of flight: right, up, forward m/s]
const CASES = [];
for (const r of [200, 400, 600, 800, 1000]) for (const v of [[0, 0, 0], [60, 0, 0], [120, 0, 0], [80, 40, -60]]) CASES.push([r, v]);
const rows = await p.evaluate(([cases, dt]) => {
  const G = window.__g, t = window.__t, out = [];
  for (const [range, vel] of cases) {
    const e = t.target(range, vel);
    G.frame(dt, false);                     // one frame for the game to see its velocity
    const r = t.shoot(e, 1.5, dt);
    out.push({ range, vel, rounds: r.rounds.length, hits: r.hits, cueLit: r.cueLit });
  }
  return out;
}, [CASES, DT]);
console.log(`holding the gun cross on the lead marker for 1.5 s at ${(1 / DT).toFixed(0)} fps (target velocity relative to the jet's: right, up, away m/s)`);
const line = r => `  ${String(r.range).padStart(5)} m  [${r.vel.map(v => String(v).padStart(4)).join(',')}]  ${String(r.hits).padStart(4)} hits of ${String(r.rounds).padStart(3)} rounds  ${String(Math.round(100 * r.hits / Math.max(r.rounds, 1))).padStart(3)}%   cue lit ${String(Math.round(100 * r.cueLit)).padStart(3)}%`;
for (const r of rows) console.log(line(r));
for (const r of [200, 400, 600, 800, 1000]) { const at = rows.filter(x => x.range === r);
  check(`hits at ${r} m in every case`, at.every(x => x.hits > 0), at.map(x => `${x.hits}/${x.rounds}`)); }
check('the cue is lit while the cross is held on the marker (over 90% of the time)', rows.every(x => x.cueLit > 0.9), rows.map(x => x.cueLit));

// 2. The cue's edge: lit means the rounds pass inside the hit radius, unlit means they do not.
const edge = await p.evaluate(dt => {
  const G = window.__g, t = window.__t, R = window.__x.GUN_HIT_RADIUS, out = { inside: [], outside: [], R };
  for (const [name, k] of [['inside', 0.7], ['outside', 1.4]]) for (const dir of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    const e = t.target(800, [60, 0, 0]); G.frame(dt, false);
    const r = t.shoot(e, 1, dt, () => t.hold(0, dir, k * R));
    out[name].push({ dir: Math.round(dir * 180 / Math.PI), rounds: r.rounds.length, lit: r.rounds.filter(x => x.cue).length,
      within: r.rounds.filter(x => x.miss < R).length, hits: r.hits });
  }
  // A slow sweep of the cross through the marker, 2.2 radii either side.
  const e = t.target(800, [60, 0, 0]); G.frame(dt, false);
  const r = t.shoot(e, 4, dt, time => { const m = (time / 4 * 2 - 1) * 2.2 * R; t.hold(0, m < 0 ? 3 * Math.PI / 2 : Math.PI / 2, Math.abs(m) || 1e-6); });
  const stale = 60 * dt, lit = r.rounds.filter(x => x.cue), well = r.rounds.filter(x => x.miss < R - 2 * window.__x.GUN_MUZZLE_OFFSET - stale);
  out.sweep = { rounds: r.rounds.length, lit: lit.length, litPassingOutside: lit.filter(x => x.miss > R + stale).length,
    worstLitMiss: +Math.max(...lit.map(x => x.miss)).toFixed(1), wellInside: well.length, wellInsideLit: well.filter(x => x.cue).length, hits: r.hits };
  return out;
}, DT);
console.log(`\nthe cue's edge at 800 m, target crossing at 60 m/s (hit radius ${edge.R} m)`);
check('held 0.7 radii off the marker: every round leaves lit and passes inside the radius, and some hit',
  edge.inside.every(x => x.rounds > 50 && x.lit === x.rounds && x.within === x.rounds && x.hits > 0), edge.inside);
check('held 1.4 radii off the marker: every round leaves unlit and passes outside the radius, and none hit',
  edge.outside.every(x => x.rounds > 50 && x.lit === 0 && x.within === 0 && x.hits === 0), edge.outside);
check('sweeping the cross through the marker: no round that left lit passes outside the radius, and every round well inside left lit',
  edge.sweep.lit > 20 && edge.sweep.wellInside > 20 && edge.sweep.litPassingOutside === 0 && edge.sweep.wellInsideLit === edge.sweep.wellInside, edge.sweep);

// 3. High closure: the solution holds; what the once-a-frame hit test makes of it is reported.
const fast = await p.evaluate(dt => {
  const G = window.__g, t = window.__t, R = window.__x.GUN_HIT_RADIUS, out = [];
  for (const vel of [[0, 0, -600], [80, 0, -600], [0, 60, -600]]) {
    const e = t.target(1400, vel); G.frame(dt, false);
    const r = t.shoot(e, 1.2, dt);
    out.push({ range: 1400, vel, rounds: r.rounds.length, within: r.rounds.filter(x => x.miss < R).length, lit: r.rounds.filter(x => x.cue).length,
      hits: r.hits, cueLit: r.cueLit, endRange: r.endRange });
  }
  return out;
}, DT);
console.log(`\nhigh closure: a target flying at the jet from 1,400 m, on the marker for 1.2 s at ${(1 / DT).toFixed(0)} fps`);
for (const r of fast) console.log(line(r) + `   paths inside the radius ${r.within}/${r.rounds}`);
check('at high closure every round leaves lit and its path passes inside the hit radius',
  fast.every(x => x.rounds > 50 && x.within === x.rounds && x.lit === x.rounds), fast.map(x => `${x.within}/${x.rounds}`));
const counted = fast.reduce((n, x) => n + x.hits, 0), fired = fast.reduce((n, x) => n + x.rounds, 0);
console.log(`      the game counted ${counted} of those ${fired} rounds as hits (${Math.round(100 * counted / fired)}%)` +
  (counted < fired ? ': the rest crossed the hit radius between two frames' : ''));

// 4. The gun line through turns.
const turn = await p.evaluate(dt => {
  const G = window.__g, T = G.THREE, X = window.__x;
  G.restart();
  for (let i = 0; i < 420; i++) { G.jet.position.set(0, 1500, 0); G.jet.quaternion.identity(); G.player.velocity.set(0, 0, -327); G.player.throttle = 0.7; G.frame(1 / 60, false); }
  for (const e of G.enemies) e.alive = false;
  const live = new Set(G.bullets.filter(b => b.userData.active)), M = new T.Vector3(), F = new T.Vector3();
  let worst = 0, speedErr = 0, checked = 0, maxOff = 0;
  G.keys.ArrowDown = G.keys.ArrowRight = G.keys.Space = true;
  for (let i = 0; i < Math.round(3 / dt); i++) {
    G.frame(dt, false);
    const s = X.gunSight();
    maxOff = Math.max(maxOff, Math.hypot(s.cross.x - innerWidth / 2, s.cross.y - innerHeight / 2));
    M.copy(X.GUN_ORIGIN).applyQuaternion(G.jet.quaternion).add(G.jet.position); F.set(0, 0, -1).applyQuaternion(G.jet.quaternion);
    const cross = M.clone().addScaledVector(F, s.range), speed = X.commandedSpeed() + X.GUN_MUZZLE_SPEED;
    for (const b of G.bullets) { if (!b.userData.active || b.userData.isEnemy || live.has(b)) continue; live.add(b);
      // This frame's round: how close its straight path passes the cross's point.
      const d = b.userData.vel.clone().normalize(), w = cross.clone().sub(b.position);
      worst = Math.max(worst, w.sub(d.multiplyScalar(w.dot(d))).length());
      speedErr = Math.max(speedErr, Math.abs(b.userData.vel.length() - speed)); checked++; }
    for (const b of [...live]) if (!b.userData.active) live.delete(b);
  }
  for (const k of ['ArrowDown', 'ArrowRight', 'Space']) G.keys[k] = false;
  return { checked, worstMiss: +worst.toFixed(2), speedErr: +speedErr.toFixed(3), crossFromCentrePx: Math.round(maxOff) };
}, DT);
console.log(`\nthrough a full-rate pull and roll: ${turn.checked} rounds; the cross moved up to ${turn.crossFromCentrePx} px from the middle of the screen`);
check('every round passes the gun cross\'s point within the muzzle offset (2.5 m)', turn.checked > 50 && turn.worstMiss <= 2.6, turn);
check('every round flies at the sight\'s round speed', turn.speedErr < 0.01, turn.speedErr);

await game.close();
const failed = results.filter(ok => !ok).length, errors = [...game.errors];
for (const [k, n] of errors) console.error(`  ${k} x${n}`);
if (failed || errors.length) { console.error(`\nFAIL: ${failed} of ${results.length} checks failed, ${errors.length} page errors`); process.exit(1); }
console.log(`\nall ${results.length} checks passed`);
