/**
 * A pilot that flies like a person, for the soak (`soak.mjs --pilot person`). The soak's
 * own bot plays far better than anyone can: it leads with the target's exact velocity,
 * aims along the true gun line and reacts within a frame. This one is there to measure how
 * hard the game is for a person, so every playability change can be judged against it.
 *
 * What makes it person-like, and nothing else differs from the bot's control law:
 *
 * - It steers by what the HUD draws, read off the screen: it puts the mark it is steering
 *   for (the target box, or the lead marker once the HUD has one) on the aim point (the
 *   reticle, or the gun cross), and turns the screen-space error into a direction through
 *   the camera. It never sees the gun line or the target's velocity. When the page defines
 *   gunSight() (the game's gunsight: see "The game loop" in TODO.md) it reads the sight
 *   from there; otherwise, on a copy of the game from before the gunsight, it reads the HUD
 *   as it was drawn then: a fixed 35 px reticle at the centre of the screen, red when the
 *   nearest enemy within 1,500 m is within 18 degrees of the nose, and a box round that
 *   enemy.
 * - It sees with a reaction delay drawn per life from 150-250 ms, and aims with noise: a
 *   correlated random offset on where it steers the mark to, 1.5 degrees per axis (about 2
 *   all told) with a 0.4 s time constant. The noise is in its aim, not its eyes: whether
 *   the mark is inside the ring, or a box near the aim point, it judges from the symbols
 *   as drawn (late, like everything else). An enemy off the screen it knows only roughly
 *   (8 degrees), as from the radar and a glance over the shoulder.
 * - It presses keys like a person: no key changes state less than 80 ms after it last
 *   changed, and a burst of fire lasts at least 150 ms. It steers by tapping: on each
 *   axis it wants a turn rate proportional to the error it sees, plus 0.3 s of the error's
 *   rate (the lead a person adds so as not to overshoot) and, near the mark, the error's
 *   integral (how a person comes to match a target drifting steadily across the screen),
 *   and it taps the key for that fraction of the time. It learns how fast the jet turns on
 *   each axis by watching it turn while a key is held (at a rate per second, so the
 *   frame time does not change what it learns). Pitch and yaw take the error above
 *   and beside the nose; more than 10 degrees off, it also rolls to put the mark above the
 *   canopy, so that pulling brings the nose round to it.
 * - It fires the gun while the HUD's shoot cue is lit and the mark is inside the ring,
 *   at under 1,000 m on the range readout.
 * - It uses missiles the way a player does: it holds F when the target box is near the aim
 *   point and the range readout is under 1,500 m, keeps holding while it sees the lock
 *   diamond, lets go when it sees none (or sees the launch), and watches a missile it has
 *   fired for 2.5 s before trying again. The box, not the mark: once the HUD has a lead
 *   marker the gun goes by the marker and the missile by the aircraft itself, on any HUD.
 *
 * track.mjs measures how well it tracks, against one target flying a straight line 500-800 m
 * ahead with its AI skipped, level or crossing at up to 100 m/s: it holds the target box a
 * median 2.3-2.9 degrees from the reticle, and 1.0-1.3 degrees with the aim noise off.
 *
 * installPerson runs in the page (it is passed to page.evaluate) and defines
 * window.__person.step(dt), called once per step before the frame, and .reset(), called
 * at the start of every life.
 */
export const PERSON = {
  delay: [0.15, 0.25], noiseDeg: 1.5, noiseTau: 0.4, coarseNoiseDeg: 8,
  minHold: 0.08, minBurst: 0.15, fireRange: 1000, missileRange: 1500,
  fineDeg: 10, gain: 2, rollGain: 3, lead: 0.3, integral: 1, rateWindow: 0.15, tapBand: 0.04,
  rates: { pitch: 1, yaw: 0.6, roll: 1.4 },   // rad/s with a key held, to start with; learnt as it flies
  learn: 1.2,                  // per second: how fast a learnt rate follows what it sees
  missileWindow: 0.2,          // of the screen height: how near the aim point a box has to be to try for a lock
  watchMissile: 2.5, retryLock: 0.5,
};

export function installPerson(C) {
  const G = window.__g, T = G.THREE, K = G.keys, rad = Math.PI / 180;
  const fwd = new T.Vector3(), v = new T.Vector3(), a = new T.Vector3(), m = new T.Vector3(), q = new T.Quaternion(), qi = new T.Quaternion();
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const P = window.__person = { t: 0, hist: [], delay: 0, nx: 0, ny: 0, cx: 0, cy: 0, ix: 0, iy: 0, axes: {}, taps: {},
    rates: { ...C.rates }, launches: 0, seen: 0, noMissileUntil: 0 };
  const clamp = (x, a = 1) => Math.max(-a, Math.min(a, x)), wrap = x => Math.atan2(Math.sin(x), Math.cos(x));
  const KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'KeyF'];
  P.reset = () => {
    P.hist.length = 0; P.axes = {}; P.taps = {}; P.ix = P.iy = 0; P.nx = P.ny = P.cx = P.cy = 0; P.noMissileUntil = 0; P.seen = P.launches;
    P.delay = C.delay[0] + Math.random() * (C.delay[1] - C.delay[0]);
    for (const k of KEYS) K[k] = false;
  };
  P.reset();

  // A ray through the camera for a point on the HUD canvas, which is the size of the window.
  const ray = (out, x, y) => out.set(x / innerWidth * 2 - 1, 1 - y / innerHeight * 2, 0.5).unproject(G.camera).sub(G.camera.position).normalize();
  const project = (pos) => { const p = v.copy(pos).project(G.camera);
    return p.z < 1 ? { x: (p.x * .5 + .5) * innerWidth, y: (-p.y * .5 + .5) * innerHeight } : null; };
  const onScreen = p => p && p.x >= 0 && p.x <= innerWidth && p.y >= 0 && p.y <= innerHeight;

  // One look at the screen: what the person would act on `delay` seconds from now.
  function look(dt) {
    const jet = G.jet, pl = G.player, cam = G.camera, w = innerWidth, h = innerHeight;
    cam.updateMatrixWorld();
    fwd.set(0, 0, -1).applyQuaternion(jet.quaternion);
    qi.copy(jet.quaternion).invert();
    const k = Math.sqrt(2 * dt / C.noiseTau), fine = C.noiseDeg * rad, coarse = C.coarseNoiseDeg * rad;
    P.nx += -P.nx * dt / C.noiseTau + fine * k * gauss(); P.ny += -P.ny * dt / C.noiseTau + fine * k * gauss();
    P.cx += -P.cx * dt / C.noiseTau + coarse * k * gauss(); P.cy += -P.cy * dt / C.noiseTau + coarse * k * gauss();
    const s = { t: P.t, fHeld: !!K.KeyF, launches: P.launches, ammo: pl.missileAmmo, throttle: pl.throttle,
      agl: jet.position.y - G.ground(jet.position.x, jet.position.z), vy: pl.velocity.y,
      safe: v.copy(fwd).setY(0).normalize().setY(1.2).normalize().applyQuaternion(qi).clone(),
      level: v.copy(fwd).setY(0.05).normalize().applyQuaternion(qi).clone() };
    // What the sight shows.
    let aim, ring, target = null, mark = null, cue = false;
    const sight = G.sight ? G.sight() : null;
    if (sight) { aim = sight.cross; ring = sight.ring; target = sight.target; mark = sight.lead || sight.box; cue = !!sight.cue; }
    else {
      aim = { x: w / 2, y: h / 2 }; ring = 35;
      target = G.nearest();
      if (target) { cue = G.inCrosshair(target); mark = project(target.mesh.position); }
    }
    s.range = target ? Math.round(target.mesh.position.distanceTo(jet.position)) : Infinity;
    s.cue = cue; s.ring = ring; s.onScreen = onScreen(mark);
    // The target box, apart from the mark: it is what a missile lock is judged by, and with a
    // lead marker on the HUD the two are different points.
    const box = sight ? sight.box : mark;
    s.boxSeen = onScreen(box) ? Math.hypot(box.x - aim.x, box.y - aim.y) : Infinity;
    if (s.onScreen) {
      const f = (h / 2) / Math.tan(cam.fov * rad / 2);      // pixels per radian near the centre
      const px = mark.x + P.nx * f, py = mark.y + P.ny * f;
      q.setFromUnitVectors(ray(a, aim.x, aim.y), ray(m, px, py));
      s.local = v.copy(fwd).applyQuaternion(q).applyQuaternion(qi).clone();
      s.err = Math.hypot(px - aim.x, py - aim.y);
      s.seen = Math.hypot(mark.x - aim.x, mark.y - aim.y);   // what it sees: the symbols themselves
    } else {
      // Off the screen: the HUD's target if it has one, else the nearest blip, known roughly.
      let tgt = target && target.alive ? target : null;
      if (!tgt) { let best = Infinity; for (const e of G.enemies) { if (!e.alive) continue;
        const d = e.mesh.position.distanceTo(jet.position); if (d < best) { best = d; tgt = e; } } }
      if (tgt) { s.local = v.subVectors(tgt.mesh.position, jet.position).normalize().applyQuaternion(qi);
        s.local.x += P.cx; s.local.y += P.cy; s.local = s.local.normalize().clone();
        if (s.range === Infinity) s.range = Math.round(tgt.mesh.position.distanceTo(jet.position)); }
      else { s.local = s.level; s.range = Infinity; }
      s.err = s.seen = Infinity;
    }
    const lt = G.lockTarget;
    s.diamond = !!(lt && lt.alive && onScreen(project(lt.mesh.position)));
    return s;
  }

  // Where a direction in the jet's frame lies from the nose: above it and beside it, how far
  // off it is, and the bank that would put it straight above the canopy.
  const errors = d => ({ x: Math.atan2(d.x, -d.z), y: Math.atan2(d.y, -d.z), off: Math.acos(clamp(-d.z)),
    bank: Math.atan2(d.x, Math.max(d.y, 0.05) + (d.z > 0 ? 0.5 : 0)) });

  // A key or key pair that cannot change state again within `hold` seconds of its last change.
  function axis(name, neg, pos, want, hold = C.minHold) {
    const ax = P.axes[name] ||= { v: 0, since: -Infinity };
    if (want !== ax.v && P.t - ax.since >= (ax.v ? hold : C.minHold)) { ax.v = want; ax.since = P.t; }
    if (neg) K[neg] = ax.v < 0;
    if (pos) K[pos] = ax.v > 0;
  }

  // Tapping a key pair to get a fraction `u` (-1..1) of its full rate: a sigma-delta that
  // presses whichever key keeps the time-averaged input on `u`, within the minimum hold.
  function tap(name, neg, pos, u, dt) {
    const ax = P.axes[name] ||= { v: 0, since: -Infinity };
    const acc = P.taps[name] = (P.taps[name] || 0) + (u - ax.v) * dt;
    axis(name, neg, pos, acc > C.tapBand ? 1 : acc < -C.tapBand ? -1 : Math.abs(u) < 0.05 || Math.abs(acc) < C.tapBand / 2 ? 0 : ax.v);
  }

  P.step = dt => {
    if (G.gameOver || !G.gameStarted || G.paused) { for (const k of KEYS) K[k] = false; P.axes = {}; P.taps = {}; return; }
    P.t += dt;
    P.hist.push(look(dt));
    while (P.hist.length > 1 && P.hist[1].t <= P.t - P.delay - C.rateWindow) P.hist.shift();
    // The newest look at least `delay` old, and one `rateWindow` before it for the mark's motion.
    let i = P.hist.length - 1; while (i > 0 && P.hist[i].t > P.t - P.delay) i--;
    const s = P.hist[i], s0 = P.hist[0], span = s.t - s0.t;

    // Missiles. A launch it has seen ends the attempt and starts a watch.
    if (s.launches > P.seen) { P.seen = s.launches; P.noMissileUntil = P.t + C.watchMissile; }
    let wantF;
    if (K.KeyF) {
      wantF = P.t < P.noMissileUntil ? false : s.fHeld ? s.diamond : true;   // no diamond seen while holding: give up
      if (!wantF && P.t >= P.noMissileUntil) P.noMissileUntil = P.t + C.retryLock;
    } else wantF = P.t >= P.noMissileUntil && s.ammo > 0 && s.range < C.missileRange && s.boxSeen < innerHeight * C.missileWindow;
    axis('missile', null, 'KeyF', wantF ? 1 : 0);

    // The gun.
    axis('gun', null, 'Space', s.onScreen && s.cue && s.seen < s.ring && s.range < C.fireRange ? 1 : 0, C.minBurst);

    // Steering, toward the mark, or nose up and wings level when the ground is close.
    const ground = s.agl < 350 || (s.vy < 0 && s.agl < -s.vy * 5), L = ground ? s.safe : s.local;
    const e = errors(L), e0 = ground || s0.onScreen !== s.onScreen ? null : errors(s0.local);
    const rate = k => e0 && span > 0.05 ? wrap(e[k] - e0[k]) / span : 0;
    const fine = !ground && s.onScreen && e.off < C.fineDeg * rad;
    if (fine) { P.ix = clamp(P.ix + e.x * dt, 0.3); P.iy = clamp(P.iy + e.y * dt, 0.3); } else P.ix = P.iy = 0;
    const want = (k, i) => C.gain * (e[k] + C.lead * rate(k)) + C.integral * i;
    tap('pitch', 'ArrowUp', 'ArrowDown', L.z > 0 ? 1 : clamp(want('y', P.iy) / P.rates.pitch), dt);   // ArrowDown pulls the nose up
    tap('yaw', 'KeyA', 'KeyD', clamp(want('x', P.ix) / P.rates.yaw), dt);
    if (fine) { axis('roll', 'ArrowLeft', 'ArrowRight', 0); P.taps.roll = 0; }
    else tap('roll', 'ArrowLeft', 'ArrowRight', clamp(C.rollGain * (e.bank + C.lead * rate('bank')) / P.rates.roll), dt);
    // What it learns of the jet: the turn rate on an axis whose key has been held a while.
    for (const [k, r] of [['pitch', G.player.pitchRate], ['yaw', G.player.yawRate], ['roll', G.player.rollRate]]) {
      const ax = P.axes[k]; if (ax && ax.v && P.t - ax.since > 0.4) P.rates[k] += (Math.abs(r) - P.rates[k]) * (1 - Math.exp(-C.learn * dt)); }
    const wantThr = s.range > 1500 && s.range < Infinity ? 0.95 : 0.7;
    axis('throttle', 'KeyS', 'KeyW', s.throttle < wantThr - 0.03 ? 1 : s.throttle > wantThr + 0.03 ? -1 : 0);
  };
}
