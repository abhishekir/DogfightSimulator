/**
 * Gunsight check: does putting the gun cross on the lead marker hit, and does the cross stay
 * on the gun line through turns? Reads the sight the HUD draws (gunSight() in the page), so
 * it tests what the player sees, not a copy of the maths.
 *
 *   node .github/tools/gunsight.mjs [--dt 0.0167] [--page file.html]
 *
 * 1. Holding the cross on the marker. One enemy flies a straight line at constant velocity,
 *    its AI replaced by that line, with endless hit points. Every frame the jet is pointed so
 *    that the gun cross lands on the lead marker as the HUD shows it (the marker's screen
 *    point is unprojected, and the nose aimed at the point on that ray at the sight's range),
 *    and the trigger is held for 1.5 s. Cases cover 200-1,000 m, a target flying away or
 *    across the nose at up to 120 m/s, and climbing. Fails if any case lands no hits.
 * 2. The gun line through turns. The jet pulls and rolls at full rate with the trigger held
 *    and no target, so the chase camera lags; for every round fired, the gun cross's point
 *    (GUN_ORIGIN along the nose at the sight's range) must lie on the round's path, within
 *    the muzzles' 2.5 m offset either side, and the round must fly at the sight's speed.
 *    Reports how far the cross moved from the middle of the screen while it did.
 *
 * 3. Round assist, when the page has one (GUN_ASSIST): the cross held off the marker by 0.8x
 *    the assist's angle at 1,000 m, where that is wider than the hit radius, still hits; held
 *    1.3x off, nothing does; and a wave-1 enemy dies while the cross wanders round its marker
 *    inside the assist's cone.
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
  return splice(html, 'window.__g = {', `window.__x = { gunSight, GUN_ORIGIN, commandedSpeed, GUN_MUZZLE_SPEED, GUN_HIT_RADIUS,
  assist: typeof GUN_ASSIST === 'number' ? GUN_ASSIST : 0 };\nwindow.__g = {`);
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
    // Aim the nose so that the gun cross falls on the HUD's lead marker, or `off` radians from
    // it in the direction `dir` (radians round the nose, 0 = above).
    hold(off = 0, dir = 0) {
      const s = X.gunSight(); if (!s.lead) return false;
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
  };
});

// [start range m, target velocity relative to the jet's line of flight: right, up, forward m/s]
const CASES = [];
for (const r of [200, 400, 600, 800, 1000]) for (const v of [[0, 0, 0], [60, 0, 0], [120, 0, 0], [80, 40, -60]]) CASES.push([r, v]);
const rows = await p.evaluate(([cases, dt]) => {
  const G = window.__g, X = window.__x, out = [], holdCrossOnMarker = () => window.__t.hold();
  for (const [range, [vr, vu, vf]] of cases) {
    const e = window.__t.target(range, [vr, vu, vf]);
    G.frame(dt, false);                     // one frame for the game to see its velocity
    window.__hits = 0; const r0 = G.player.gunRound; let held = 0, cue = 0, n = 0, r1 = 0;
    for (let i = 0; i < Math.round(1.5 / dt); i++) {
      if (holdCrossOnMarker()) held++;
      const s = X.gunSight(); if (s.cue) cue++; n++;
      G.keys.Space = true; G.frame(dt, false);
    }
    G.keys.Space = false;
    const rounds = G.player.gunRound - r0;
    for (let i = 0; i < Math.round(2.6 / dt); i++) { holdCrossOnMarker(); G.frame(dt, false); }   // rounds in flight land
    r1 = Math.round(e.mesh.position.distanceTo(G.jet.position));
    out.push({ range, vel: [vr, vu, vf], rounds, hits: window.__hits, cueLit: +(cue / n).toFixed(2), held: +(held / n).toFixed(2), endRange: r1 });
  }
  return out;
}, [CASES, DT]);
console.log(`holding the gun cross on the lead marker for 1.5 s at ${(1 / DT).toFixed(0)} fps (target velocity relative to the jet's: right, up, away m/s)`);
for (const r of rows) console.log(`  ${String(r.range).padStart(5)} m  [${r.vel.map(v => String(v).padStart(4)).join(',')}]  ${String(r.hits).padStart(4)} hits of ${String(r.rounds).padStart(3)} rounds  ${String(Math.round(100 * r.hits / Math.max(r.rounds, 1))).padStart(3)}%   cue lit ${String(Math.round(100 * r.cueLit)).padStart(3)}%`);
for (const r of [200, 400, 600, 800, 1000]) { const at = rows.filter(x => x.range === r);
  check(`hits at ${r} m in every case`, at.every(x => x.hits > 0), at.map(x => `${x.hits}/${x.rounds}`)); }
check('the cue is lit while the cross is held on the marker (over 90% of the time)', rows.every(x => x.cueLit > 0.9), rows.map(x => x.cueLit));

// 3. Round assist, when the page has one: rounds fired with the cross held off the marker
// by less than the assist's angle are aimed at the lead point, so they hit at 1,000 m, where
// that offset is wider than the hit radius; held further off than the assist reaches, none
// do. And a wave-1 enemy (40 HP) at 900 m dies while the cross wanders round its marker
// inside the assist's cone: "a player who keeps the gun cross roughly on the lead marker".
const ASSIST = await p.evaluate(() => window.__x.assist);
if (ASSIST > 0) {
  const off = await p.evaluate(([dt, a]) => {
    const G = window.__g, t = window.__t, res = {};
    for (const [name, k] of [['inside', 0.8], ['outside', 1.3]]) {
      t.target(1000, [60, 0, 0]); G.frame(dt, false); window.__hits = 0; const r0 = G.player.gunRound;
      for (let i = 0; i < Math.round(1.5 / dt); i++) { t.hold(k * a, Math.PI / 2); G.keys.Space = true; G.frame(dt, false); }
      G.keys.Space = false; const rounds = G.player.gunRound - r0;
      for (let i = 0; i < Math.round(2.6 / dt); i++) { t.hold(k * a, Math.PI / 2); G.frame(dt, false); }
      res[name] = { offDeg: +(k * a * 180 / Math.PI).toFixed(2), rounds, hits: window.__hits };
    }
    const e = t.target(900, [80, 0, 0], 40); G.frame(dt, false); let killedAt = null;
    for (let i = 0; i < Math.round(4 / dt) && killedAt === null; i++) {
      t.hold(0.8 * a * (0.5 + 0.5 * Math.abs(Math.sin(i * dt * 2.3))), i * dt * 3.1); G.keys.Space = true; G.frame(dt, false);
      if (!e.alive) killedAt = +(i * dt).toFixed(2);
    }
    G.keys.Space = false; res.wave1KilledAfterS = killedAt; return res;
  }, [DT, ASSIST]);
  console.log(`\nround assist ${(ASSIST * 180 / Math.PI).toFixed(2)} deg, at 1,000 m against a target crossing at 60 m/s:`);
  check('rounds fired with the cross held inside the assist (0.8x) hit', off.inside.hits > off.inside.rounds / 2, off.inside);
  check('rounds fired with the cross held outside it (1.3x) do not', off.outside.hits === 0, off.outside);
  check('a wave-1 enemy dies while the cross wanders round its marker inside the assist', off.wave1KilledAfterS !== null, off.wave1KilledAfterS);
} else console.log('\nno round assist in this page (GUN_ASSIST): its checks skipped');

// 2. The gun line through turns.
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
