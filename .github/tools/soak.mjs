/**
 * Soak playtest: a bot flies the real game at a fixed timestep, rendering only now and
 * then, auto-restarting on death, with a watchdog run after every step. It covers minutes
 * of game time in seconds of wall clock, and catches what a short session cannot: NaN,
 * pool leaks, voices that are never released, audio that falls out of step with the
 * game, and exceptions on rare paths (deaths, restarts, pauses mid-burst).
 *
 *   node .github/tools/soak.mjs [--minutes 10] [--screens] [--page file.html]
 *
 * The bot pursues the nearest enemy with lead, fires guns and missiles, sometimes flies
 * erratically, sometimes dives into the ground on purpose, and pauses and resumes at
 * random. --screens saves one frame per game-minute to .github/tools/out/.
 *
 * Exits 1 on any watchdog anomaly or page error. The particle-pool figures (lowest free
 * count and what was using the pool at that moment) are reported but not failed on;
 * see TODO.md task 1.
 */
import { join } from 'node:path';
import { openGame, stepper, arg, flag, outDir } from './lib.mjs';

const MINUTES = Number(arg('minutes', 10)), SCREENS = flag('screens');
const game = await openGame({ transform: stepper, args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
const p = game.page;
await p.waitForFunction(() => window.__g, null, { timeout: 90000 });
await p.mouse.click(5, 5);                     // a user gesture, so the AudioContext may start
await p.evaluate(() => window.__g.start());

// The bot and the watchdog live in the page.
await p.evaluate(() => {
  const G = window.__g, T = G.THREE, K = G.keys;
  const S = window.__soak = { t: 0, steps: 0, deaths: 0, crashesForced: 0, pauses: 0, maxWave: 1, totalKills: 0, lives: 1,
    maxBullets: 0, bulletsFull: 0, maxParticles: 0, minFree: Infinity, under20: 0, lowFree: null, maxVoices: 0, maxMissiles: 0,
    gunToggles: 0, launches: 0, impacts: 0, anomalies: {}, events: [], mode: 'hunt', modeT: 0, lifeT: 0 };
  const A = (k, detail) => { (S.anomalies[k] ||= { n: 0, firstAt: +S.t.toFixed(2), detail }).n++; };
  const fin = v => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  const _to = new T.Vector3(), _loc = new T.Vector3(), _q = new T.Quaternion();
  // Count calls through the sound API, to prove those paths ran.
  const snd = G.snd, count = (name, key) => { const f = snd[name].bind(snd); snd[name] = (...a) => { S[key]++; return f(...a); }; };
  count('missileLaunch', 'launches'); count('impact', 'impacts');

  function bot(dt) {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'KeyF']) K[k] = false;
    if (G.gameOver || !G.gameStarted || G.paused) return;
    const jet = G.jet, pl = G.player;
    if ((S.modeT -= dt) <= 0) {                // pick a behaviour for the next stretch
      const r = Math.random();
      S.mode = S.lifeT > 150 && r < 0.25 ? 'crash' : r < 0.12 ? 'wild' : 'hunt';
      S.modeT = S.mode === 'crash' ? 25 : 4 + Math.random() * 8;
      if (S.mode === 'crash') S.crashesForced++;
    }
    let target = null, best = Infinity;
    for (const e of G.enemies) { if (!e.alive) continue; const d = e.mesh.position.distanceTo(jet.position); if (d < best) { best = d; target = e; } }
    const agl = jet.position.y - G.ground(jet.position.x, jet.position.z);
    _q.copy(jet.quaternion).invert();
    if (S.mode === 'crash') _to.set(0, -1, 0).add(_loc.set(0, 0, -1).applyQuaternion(jet.quaternion).multiplyScalar(0.3));
    else if (agl < 350 || (pl.velocity.y < 0 && agl < -pl.velocity.y * 5)) _to.set(0, 0, -1).applyQuaternion(jet.quaternion).setY(0).normalize().setY(1.2);
    else if (S.mode === 'wild') _to.set(Math.sin(S.t * 0.7), Math.sin(S.t * 1.3) * 0.5, Math.cos(S.t * 0.7));
    else if (target) {                         // lead pursuit: aim where the target will be when the rounds arrive
      const tof = best / (pl.velocity.length() + 650);
      _to.subVectors(target.mesh.position, target.prevPosition).divideScalar(dt).multiplyScalar(tof).add(target.mesh.position).sub(jet.position);
    } else _to.set(0, 0, -1).applyQuaternion(jet.quaternion).setY(0.05);
    _loc.copy(_to).normalize().applyQuaternion(_q);   // desired direction in the jet's frame
    const bank = Math.atan2(_loc.x, Math.max(_loc.y, 0.05) + (_loc.z > 0 ? 0.5 : 0));
    if (bank > 0.15) K.ArrowRight = true; else if (bank < -0.15) K.ArrowLeft = true;
    if (_loc.y > 0.03 || _loc.z > 0) K.ArrowDown = true; else if (_loc.y < -0.08) K.ArrowUp = true;   // ArrowDown pulls the nose up
    if (_loc.x > 0.05) K.KeyD = true; else if (_loc.x < -0.05) K.KeyA = true;
    const wantThr = S.mode === 'wild' ? 1 : target && best > 1500 ? 0.95 : 0.7;
    if (pl.throttle < wantThr - 0.03) K.KeyW = true; else if (pl.throttle > wantThr + 0.03) K.KeyS = true;
    const aim = -_loc.z;
    if ((target && aim > 0.97 && best < 1200) || (S.mode === 'wild' && Math.random() < 0.02)) K.Space = true;
    if ((target && aim > 0.8 && best < 1600) || (S.mode === 'wild' && Math.sin(S.t * 0.4) > 0.6)) K.KeyF = true;
  }

  function watch() {
    const pl = G.player, jet = G.jet;
    if (!fin(jet.position) || !fin(pl.velocity) || !Number.isFinite(jet.quaternion.w)) A('player non-finite', jet.position.toArray());
    if (pl.hp > G.MAX_PLAYER_HP + 1e-6) A('player hp over max', pl.hp);
    if (pl.missileAmmo < 0 || pl.missileAmmo > G.MAX_MISSILE_AMMO) A('missile ammo out of range', pl.missileAmmo);
    if (!(pl.gunSpin >= 0 && pl.gunSpin <= 1)) A('gunSpin out of range', pl.gunSpin);
    if (!(G.lockProgress >= 0 && G.lockProgress <= 1)) A('lockProgress out of range', G.lockProgress);
    if (!fin(G.camera.position)) A('camera non-finite');
    for (const e of G.enemies) {
      if (!fin(e.mesh.position) || !Number.isFinite(e.mesh.quaternion.w)) A('enemy non-finite');
      if (e.alive && e.mesh.position.y < G.ground(e.mesh.position.x, e.mesh.position.z) - 1) A('enemy below ground', e.mesh.position.y);
    }
    let nb = 0; for (const b of G.bullets) if (b.userData.active) { nb++; if (!fin(b.position)) A('bullet non-finite'); }
    let nm = 0; for (const m of G.missiles) if (m.userData.active) { nm++; if (!fin(m.position) || !fin(m.userData.vel)) A('missile non-finite'); }
    for (const q of G.particles) if (!fin(q.position)) { A('particle non-finite'); break; }
    S.maxBullets = Math.max(S.maxBullets, nb); if (nb >= G.MAX_BULLETS) S.bulletsFull++;
    S.maxMissiles = Math.max(S.maxMissiles, nm);
    S.maxParticles = Math.max(S.maxParticles, G.particles.length);
    const free = G.freeParticles.length;
    // Running low is pressure, reported below; losing entries is a leak. Every entry is
    // either active or free, so the two always sum to the pool's capacity.
    if (G.particles.length + free !== G.MAX_PARTICLES)
      A('particle pool entries lost or duplicated', { active: G.particles.length, free, capacity: G.MAX_PARTICLES });
    if (free < 20) S.under20++;
    if (free < S.minFree) {
      S.minFree = free;
      const using = {};
      for (const q of G.particles) { const k = q.type + (q.isTrail ? '/trail' : ''); using[k] = (using[k] || 0) + 1; }
      S.lowFree = { t: +S.t.toFixed(1), free, firing: !!K.Space, missiles: nm, enemies: G.enemies.length, using };
    }
    const s = G.snd;
    if (!s.ctx) return;
    S.maxVoices = Math.max(S.maxVoices, s.voices.length);
    if (!fin(s.listenerVel) || !fin(s.listenerPos)) A('listener non-finite');
    for (const v of s.voices) { if (!fin(v.pos)) A('voice non-finite'); for (const d of v.detune) if (!Number.isFinite(d.value)) A('detune non-finite'); }
    const motors = s.voices.filter(v => v.follow && v.release).length;
    if (motors > nm) A('missile motor voice following no live missile', { motors, nm });
    for (const [k, g] of [['roar', s.roarGain], ['seek', s.seekGain], ['fireDuck', s.fireDuck], ['blastDuck', s.blastDuck], ['output', s.output]])
      if (!Number.isFinite(g.gain.value)) A(k + ' gain non-finite');
    if (!!s._gun !== !!K.Space) A('gun audio out of step with trigger', { gun: !!s._gun, trigger: !!K.Space });
  }

  let wasGun = false, wasOver = false;
  window.__run = (n, dt, renderLast) => {
    for (let i = 0; i < n; i++) {
      bot(dt);
      try { G.frame(dt, renderLast && i === n - 1); }
      catch (e) { A('exception in frame: ' + e.message, (e.stack || '').split('\n').slice(0, 3).join(' | ')); }
      S.t += dt; S.steps++; S.lifeT += dt;
      if (!G.gameOver && !G.paused) watch();
      const gun = !!G.snd._gun; if (gun !== wasGun) { S.gunToggles++; wasGun = gun; }
      S.maxWave = Math.max(S.maxWave, G.wave);
      if (G.gameOver && !wasOver) { S.deaths++; S.totalKills += G.kills; S.events.push(`t=${S.t.toFixed(0)}s died (${S.mode}) on wave ${G.wave} with ${G.kills} kills`); }
      wasOver = G.gameOver;
      if (G.gameOver && G.deathCamTimer <= 0) { G.restart(); S.lives++; S.lifeT = 0; S.mode = 'hunt'; S.modeT = 5; }
      // Pause and resume now and then, sometimes with the trigger held.
      if (!G.gameOver && Math.random() < dt / 40) { G.togglePause(); S.pauses++; for (let k = 0; k < 30; k++) G.frame(dt, false); G.togglePause(); }
    }
    return { t: Math.round(S.t), wave: G.wave, kills: G.kills, hp: Math.round(G.player.hp), enemies: G.enemies.length,
      bullets: G.bullets.filter(b => b.userData.active).length, particles: G.particles.length, voices: G.snd.voices.length, mode: S.mode };
  };
});

const DT = 1 / 60, CHUNK = 600;                // 10 s of game time per call
const out = SCREENS ? await outDir() : null, heap = [], t0 = Date.now();
for (let gameT = 0, shot = 0; gameT < MINUTES * 60; gameT += CHUNK * DT) {
  const render = SCREENS && Math.floor(gameT / 60) !== Math.floor((gameT + CHUNK * DT) / 60);
  const st = await p.evaluate(([n, dt, r]) => {
    const o = window.__run(n, dt, r);
    if (window.gc) { window.gc(); o.heapMB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1); }
    return o;
  }, [CHUNK, DT, render]);
  heap.push(st.heapMB);
  if (render) await p.screenshot({ path: join(out, `soak-${String(++shot).padStart(2, '0')}.png`) });
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${JSON.stringify(st)}`);
}
// Voices expire on the audio clock, which runs in real time while the soak runs much
// faster, so many are legitimately alive at the end. Let real time pass (up to 15 s) for
// them to finish, then judge each remaining voice against its own deadline: one whose
// deadline is still ahead is fine (a blast 10 km away is not heard for 29 s, and the
// frame that triggers the cleanup can start new sounds); one that can never end, whose
// deadline has passed, or whose deadline is implausibly far off is a leak. Live missile
// motors are the exception: they end when their missile does.
const wait = await p.evaluate(() => { const s = window.__g.snd, ends = s.voices.map(v => v.end).filter(Number.isFinite);
  return Math.min(15, Math.max(0, ...ends.map(e => e - s.ctx.currentTime))); });
await p.waitForTimeout(wait * 1000 + 500);
const leftover = await p.evaluate(() => { const G = window.__g; G.keys.Space = false; G.frame(1 / 60, false);
  const now = G.snd.ctx.currentTime;
  return G.snd.voices.filter(v => !(v.follow && v.release))
    .filter(v => !Number.isFinite(v.end) || v.end < now || v.end - now > 120)
    .map(v => Number.isFinite(v.end) ? +(v.end - now).toFixed(1) : 'never'); });
const S = await p.evaluate(() => ({ ...window.__soak, lastKills: window.__g.kills }));
if (leftover.length) S.anomalies['voices that will never be released'] = { n: leftover.length, firstAt: +S.t.toFixed(2), detail: { secondsUntilDeadline: leftover } };
await game.close();

const anomalies = Object.entries(S.anomalies), errors = [...game.errors.entries()];
console.log(`
${(S.t / 60).toFixed(1)} game-minutes, ${S.steps} steps, ${S.lives} lives (${S.crashesForced} forced crashes), ${S.pauses} pauses
waves reached ${S.maxWave}, kills ${S.totalKills + S.lastKills}, missile launches ${S.launches}, ground impacts ${S.impacts}, gun start/stops ${S.gunToggles}
peaks: bullets ${S.maxBullets} (pool full ${S.bulletsFull} steps), missiles ${S.maxMissiles}, voices ${S.maxVoices}, particles ${S.maxParticles}
particle pool: lowest free ${S.minFree}, steps under 20 free ${S.under20}${S.lowFree ? `, at the low point ${JSON.stringify(S.lowFree)}` : ''}
heap MB per game-minute: ${heap.filter((_, i) => i % 6 === 5).join(' ')}`);
for (const e of S.events.slice(-10)) console.log('  ' + e);
if (anomalies.length || errors.length) {
  console.error('\nFAIL');
  for (const [k, v] of anomalies) console.error(`  anomaly: ${k} x${v.n}, first at ${v.firstAt}s ${v.detail !== undefined ? JSON.stringify(v.detail) : ''}`);
  for (const [k, n] of errors) console.error(`  ${k} x${n}`);
  process.exit(1);
}
console.log('\nsoak passed');
