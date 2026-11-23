/**
 * Flares: how often a missile is pulled off by them, in the game loop at a fixed timestep.
 *
 *   node .github/tools/flares.mjs [--trials 60] [--fps 60] [--page file.html]
 *
 * Two duels, each run with flares and without, so the difference is what flares do:
 *  - An enemy missile at the player. It is launched 1,200 m out, from a random direction in
 *    the rear half, at a jet flying straight and level; with flares, the player taps C once
 *    when the missile is inside 700 m (as the person-like pilot does on seeing the warning).
 *    A hit is the 30 HP a missile does.
 *  - A player missile at an enemy launched from the jet 900 m out, within about 35 degrees
 *    of the nose. The enemy flies its own flight model and drops its own flares (or has
 *    none), but is held in its extend state, flying straight away within 45 degrees either
 *    side of the line from the jet, and never evades (its skill fixed at 0.65): with its evade at 250 m or its
 *    repositioning turns, the missile's lagging pursuit misses outright most of the time,
 *    which would leave nothing for flares to show. A hit is the 50 HP a missile does. What
 *    flares and the rest of its flying do together in a fight is for the soak with the
 *    person-like pilot to say.
 * It also checks that a salvo is all or nothing when the flare pool is nearly full.
 * Reports the hit rate of each with its binomial standard error, and checks that flares
 * cut each by at least half of what the game's decoy chance would make them (an enemy may
 * drop several salvos, the player one) and that, without flares, missiles mostly hit; the
 * second is what makes the first mean anything. Exits 1 on a failed check or a page error.
 */
import { openGame, stepper, arg } from './lib.mjs';

const TRIALS = Number(arg('trials', 60)), FPS = Number(arg('fps', 60));
const game = await openGame({ transform: stepper });
const p = game.page;
await p.waitForFunction(() => window.__g, null, { timeout: 90000 });
await p.evaluate(() => { window.__g.snd.init = () => {}; window.__g.start(); });
const r = await p.evaluate(([trials, fps]) => {
  const G = window.__g, T = G.THREE, dt = 1 / fps, pl = G.player, jet = G.jet;
  const level = () => { jet.position.set(0, 1500, 0); jet.quaternion.identity(); pl.velocity.set(0, 0, -327); pl.throttle = 0.7; };
  const missileLive = m => m && m.userData.active;
  // Wave 1, for an enemy to borrow; the rest of the wave is taken out of play.
  for (let i = 0; i < 600 && !G.enemies.length; i++) { level(); G.frame(dt, false); }
  if (!G.enemies.length) throw new Error('no enemy spawned');

  // The player's flares against an enemy missile.
  function atPlayer(flares) {
    let hits = 0;
    for (let k = 0; k < trials; k++) {
      level(); pl.hp = 1e9; pl.flares = flares ? 8 : 0; pl.flareCooldown = 0;
      for (const e of G.enemies) e.alive = false;
      const a = Math.PI / 2 + Math.random() * Math.PI, el = (Math.random() - 0.5) * 0.4;   // rear half
      const from = new T.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), -Math.cos(a) * Math.cos(el));
      const pos = jet.position.clone().addScaledVector(from, 1200), dir = from.clone().negate();
      const m = G.spawnMissile(pos, dir, dir.clone().multiplyScalar(250), { mesh: jet, alive: true }, true);
      let pressed = false;
      for (let i = 0; i < 8 * fps && missileLive(m); i++) {
        G.keys.KeyC = flares && !pressed && m.position.distanceTo(jet.position) < 700;
        if (G.keys.KeyC) pressed = true;
        G.frame(dt, false); G.keys.KeyC = false;
      }
      if (pl.hp <= 1e9 - 30) hits++;
      if (m) { m.userData.active = false; m.visible = false; }
    }
    pl.hp = 100;
    return hits;
  }

  // An enemy's flares against the player's missile.
  function atEnemy(flares) {
    let hits = 0, salvos = 0;
    // Skill sets an enemy's reaction time, and so how many salvos it gets off before the
    // missile arrives; fixed, so that runs repeat (wave 1 draws it at random).
    const e = G.enemies[0]; e.skill = 0.65;
    for (let k = 0; k < trials; k++) {
      level(); for (const x of G.enemies) x.alive = x === e;
      const a = (Math.random() - 0.5) * 1.2;   // within about 35 degrees of the nose
      const bearing = new T.Vector3(Math.sin(a), 0, -Math.cos(a));
      e.mesh.position.copy(jet.position).addScaledVector(bearing, 900);
      // Flying away from the jet, within 45 degrees either side: the shot a player usually takes.
      e.mesh.quaternion.setFromAxisAngle(new T.Vector3(0, 1, 0), -a + (Math.random() - 0.5) * Math.PI / 2);
      e.prevPosition.copy(e.mesh.position); e.velocity.set(0, 0, 0);
      // Evading kept out of it (its cooldown never runs out), so flares are its only defence.
      e.hp = 1e9; e.wasHit = false; e.evadeCooldown = Infinity;
      e.state = 'extend'; e.stateTimer = 0; e.stateDuration = 1e9; e.extendDir.set(0, 0, -1).applyQuaternion(e.mesh.quaternion);
      if ('speedCmd' in e) { e.currentSpeed = e.speedCmd = 200; e.rollRate = 0; }
      if ('flares' in e) { e.flares = flares ? 3 : 0; e.flareCooldown = 0; e.flareReact = 0; }
      const f0 = e.flares || 0;
      const m = G.spawnMissile(jet.position.clone().addScaledVector(bearing, 12), bearing, pl.velocity, e, false);
      for (let i = 0; i < 8 * fps && missileLive(m); i++) { level(); G.frame(dt, false); }
      if (e.hp <= 1e9 - 50) hits++;
      salvos += f0 - (e.flares || 0);
      if (m) { m.userData.active = false; m.visible = false; }
    }
    return { hits, salvos };
  }
  // A salvo is all or nothing: with the pool full, or one flare short of a salvo, C spends
  // nothing; with a salvo's worth free it spends one salvo and lights exactly that many.
  function salvoFromPool() {
    level(); pl.hp = 1e9; pl.flares = 8; pl.flareCooldown = 0;
    const active = () => G.flarePool.filter(f => f.userData.active).length, out = {};
    for (const f of G.flarePool) { const u = f.userData; u.active = true; u.decoy.alive = true; u.life = u.maxLife = 100; }
    const press = () => { pl.flareCooldown = 0; G.keys.KeyC = true; G.frame(dt, false); G.keys.KeyC = false; return { spent: 8 - pl.flares, active: active() }; };
    out.noneFree = press();
    G.flarePool[0].userData.active = false; out.oneFree = press();
    G.flarePool[1].userData.active = false; out.twoFree = press();
    for (const f of G.flarePool) { f.userData.active = false; f.userData.decoy.alive = false; f.visible = false; }
    pl.flares = 8; pl.hp = 100; return out;
  }
  const salvo = salvoFromPool();
  const playerWith = atPlayer(true), playerWithout = atPlayer(false);
  const enemyWith = atEnemy(true), enemyWithout = atEnemy(false);
  return { salvo, playerWith, playerWithout, enemyWith, enemyWithout,
    chance: typeof window.__g.flarePool === 'object' };
}, [TRIALS, FPS]);
await game.close();

const rate = h => { const q = h / TRIALS; return { q, se: Math.sqrt(q * (1 - q) / TRIALS) }; };
const fmt = h => { const { q, se } = rate(h); return `${String(h).padStart(3)}/${TRIALS}  ${(100 * q).toFixed(0).padStart(3)}% ± ${(100 * se).toFixed(0)}`; };
console.log(`${TRIALS} trials each at ${FPS} fps: missiles that hit`);
console.log(`  enemy missile at the player, no flares     ${fmt(r.playerWithout)}`);
console.log(`  enemy missile at the player, one salvo     ${fmt(r.playerWith)}`);
console.log(`  player missile at an enemy, no flares      ${fmt(r.enemyWithout.hits)}`);
console.log(`  player missile at an enemy, its flares     ${fmt(r.enemyWith.hits)}   (${(r.enemyWith.salvos / TRIALS).toFixed(1)} salvos a missile)`);

const results = [], check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
console.log('');
check('without flares, an enemy missile mostly hits the player', rate(r.playerWithout).q >= 0.7, r.playerWithout);
check('without flares, a player missile mostly hits an enemy', rate(r.enemyWithout.hits).q >= 0.5, r.enemyWithout.hits);
check('the player\'s flares cut the enemy missile\'s hits', r.playerWith < r.playerWithout * 0.65, [r.playerWith, r.playerWithout]);
check('an enemy\'s flares cut the player missile\'s hits', r.enemyWith.hits < r.enemyWithout.hits * 0.8, [r.enemyWith.hits, r.enemyWithout.hits]);
check('an enemy drops flares at a missile tracking it', r.enemyWith.salvos > 0, r.enemyWith.salvos);
check('a salvo is all or nothing: none spent with 0 or 1 flare free, one with 2', r.salvo.noneFree.spent === 0 && r.salvo.oneFree.spent === 0
  && r.salvo.twoFree.spent === 1 && r.salvo.twoFree.active === r.salvo.oneFree.active + 1, r.salvo);   // one more freed, two lit
const errors = [...game.errors], failed = results.filter(ok => !ok).length;
for (const [k, n] of errors) console.error(`  ${k} x${n}`);
if (failed || errors.length) { console.error(`\nFAIL: ${failed} of ${results.length} checks failed, ${errors.length} page errors`); process.exit(1); }
console.log(`\nall ${results.length} checks passed`);
