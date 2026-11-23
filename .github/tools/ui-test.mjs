/**
 * Real-time playtest through the real UI: overlays, keys, pause, focus loss, crash, game
 * over, restart, and settings that persist across a reload. Where the soak drives the game
 * through its internals at a fixed timestep, this drives it the way a player does, in real
 * time, so it is what catches a broken overlay, key binding or audio state transition.
 *
 *   node .github/tools/ui-test.mjs [--page file.html]
 *
 * Software rendering runs at a frame or so a second, so game time is far slower than wall
 * time here: anything that depends on the simulation advancing is polled with a deadline
 * rather than awaited for a fixed time. Screenshots of the crash and game-over screen go to
 * .github/tools/out/. Exits 1 if any check fails or the page reports an error.
 */
import { join } from 'node:path';
import { openGame, exposeSound, splice, outDir } from './lib.mjs';

const game = await openGame({ transform: h => splice(exposeSound(h), 'function checkGameOver(){',
  'window.__pj=playerJet;window.__pl=player;window.__st=()=>({gameOver,paused,gameStarted,score});' +
  'window.__mt=()=>missileThreat;window.__gt=()=>gameTime;window.__mp=missilePool;window.__aimMissile=d=>{const f=new THREE.Vector3(0,0,-1).applyQuaternion(playerJet.quaternion),' +
  'p=playerJet.position.clone().addScaledVector(f,d);return !!spawnMissile(p,f.clone().negate(),new THREE.Vector3(),{mesh:playerJet,alive:true},true)};' +
  'function checkGameOver(){') });
const p = game.page, out = await outDir();
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const ev = fn => p.evaluate(fn);
const shown = id => p.evaluate(i => getComputedStyle(document.getElementById(i)).display !== 'none', id);
const until = async (fn, ms) => { for (const t = Date.now(); Date.now() - t < ms; await p.waitForTimeout(250)) if (await ev(fn)) return true; return false; };
const clickCentre = () => p.mouse.click(320, 180);

await p.waitForFunction(() => window.__snd, null, { timeout: 90000 });
await p.waitForTimeout(3000);

// Both screens describe the pitch keys as they work: ↑ nose down, ↓ nose up.
const screens = await ev(() => ['blocker', 'pause'].map(id => document.getElementById(id).textContent));
check('start and pause screens say ↑ / ↓ is nose down / up', screens.every(t => /↑ \/ ↓\s*— Nose down \/ up/.test(t)), screens.map(t => (t.match(/↑[^\n]*/) || [''])[0]));

// The title screen says how the missile rack works.
const title = await ev(() => document.getElementById('blocker').innerText);
check('start screen explains the missile rack', /12 in the rack/.test(title) && /\+2 per kill/.test(title) && /wave is cleared/.test(title));

// Both screens list the flares key.
check('start and pause screens list C for flares', screens.every(t => /C\s*— Flares/.test(t)));

// Volume keys on the title screen, before the audio context exists.
for (let i = 0; i < 3; i++) await p.keyboard.press('Minus');
check('volume keys work before start', await ev(() => window.__snd.volume) === 0.7, await ev(() => window.__snd.volume));
await clickCentre();
await until(() => window.__st().gameStarted && window.__snd.ctx, 10000);
check('click starts the game', !(await shown('blocker')) && await ev(() => window.__st().gameStarted));
check('audio running at start', await until(() => window.__snd.ctx.state === 'running', 5000));
check('output level is volume squared', await until(() => Math.abs(window.__snd.output.gain.value - 0.49) < 0.01, 5000),
      await ev(() => window.__snd.output.gain.value));

// With no input the jet flies into a ridge near the spawn about 3 s of game time in (on main
// too; see "Small things to keep in mind" in TODO.md), and how much game time the checks
// below take depends on the machine. Put it at 1,500 m, level, so they test the game rather
// than the crash, and again before anything that needs a live player.
const clearOfGround = () => ev(() => { const j = window.__pj, pl = window.__pl; j.position.y = 1500; j.quaternion.identity();
  pl.velocity.set(0, 0, -327); pl.pitchRate = pl.yawRate = pl.rollRate = 0; });
await clearOfGround();

// The pitch keys do what the screens say.
const noseY = () => ev(() => new window.__THREE.Vector3(0, 0, -1).applyQuaternion(window.__pj.quaternion).y);
const pitchKey = async key => { const y0 = await noseY(); await p.keyboard.down(key);
  const sign = key === 'ArrowUp' ? -1 : 1, moved = await until(`(${sign}) * (new window.__THREE.Vector3(0, 0, -1).applyQuaternion(window.__pj.quaternion).y - (${y0})) > 0.05`, 15000);
  await p.keyboard.up(key); return moved; };
check('↑ pushes the nose down', await pitchKey('ArrowUp'));
check('↓ pulls the nose up', await pitchKey('ArrowDown'));

// The cannon.
await p.keyboard.down('Space');
check('gun audio on while trigger held', await until(() => !!window.__snd._gun && window.__pl.gunSpin > 0, 10000),
      await ev(() => ({ gun: !!window.__snd._gun, spin: window.__pl.gunSpin })));
await p.keyboard.up('Space');
check('gun audio off after release', await until(() => !window.__snd._gun, 10000));

// Focus loss mid-burst: the key-up never arrives, so blur has to release the key.
await p.keyboard.down('Space');
await until(() => !!window.__snd._gun, 10000);
await ev(() => window.dispatchEvent(new Event('blur')));
check('blur releases held keys', await until(() => !window.__snd._gun, 10000));
await ev(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
check('hidden tab pauses the game and audio', await until(() => window.__st().paused && window.__snd.ctx.state === 'suspended', 5000));
await ev(() => { delete document.hidden; delete document.visibilityState; });
await p.keyboard.up('Space');
if (await ev(() => window.__st().paused)) { await clickCentre(); await until(() => !window.__st().paused, 5000); }

// Pause with the trigger held, release it while paused, resume by clicking the overlay.
await p.keyboard.down('Space');
await until(() => !!window.__snd._gun, 10000);
await p.keyboard.press('Escape');
check('Esc shows the pause overlay', await until(() => window.__st().paused, 5000) && await shown('pause'));
check('audio suspended while paused', await until(() => window.__snd.ctx.state === 'suspended', 5000));
await p.keyboard.up('Space');
await p.keyboard.press('KeyM');
check('M mutes while paused', await ev(() => window.__snd.muted));
await p.keyboard.press('KeyM');
await clickCentre();
check('clicking the overlay resumes', await until(() => !window.__st().paused, 5000) && !(await shown('pause')));
check('audio running after resume', await until(() => window.__snd.ctx.state === 'running', 5000));
check('gun stopped after trigger released during pause', await until(() => !window.__snd._gun, 10000));

// The seeker.
await p.keyboard.down('KeyF');
check('seeker audible while F held', await until(() => window.__snd.seekGain.gain.value > 0.02, 15000),
      await ev(() => window.__snd.seekGain.gain.value));
await p.keyboard.up('KeyF');
check('seeker fades out after F released', await until(() => window.__snd.seekGain.gain.value < 0.01, 20000),
      await ev(() => window.__snd.seekGain.gain.value));

// F with an empty rack sounds the empty cue and fires nothing.
await ev(() => { window.__pl.missileAmmo = 0; });
const before = await ev(() => window.__snd._lastRackEmpty);
await p.keyboard.down('KeyF');
check('F with an empty rack sounds the empty cue', await until(() => window.__snd._lastRackEmpty > 0, 10000), await ev(() => window.__snd._lastRackEmpty));
await p.keyboard.up('KeyF');
check('an empty rack stays empty', await ev(() => window.__pl.missileAmmo) === 0 && before < 0);
await ev(() => { window.__pl.missileAmmo = 12; });

await clearOfGround();
check('the player is alive and clear of the ground for the flares and missile checks',
      await ev(() => !window.__st().gameOver && window.__pl.hp > 0 && window.__pj.position.y > 1000));

// Flares: one press of C drops one salvo, with its sound. Hold it until the salvo has gone,
// let go, and wait past the 0.6 s cooldown in game time: exactly one salvo spent.
const flares0 = await ev(() => { window.__gt0 = window.__gt(); return window.__pl.flares; });
await p.keyboard.down('KeyC');
await until(() => window.__pl.flares < 8, 10000);
await p.keyboard.up('KeyC');
await until(() => window.__gt() > window.__gt0 + 1.5, 30000);
check('one press of C drops one salvo', flares0 === 8 && await ev(() => window.__pl.flares) === 7, [flares0, await ev(() => window.__pl.flares)]);
check('the flares sound', await ev(() => window.__snd._lastFlares > 0), await ev(() => window.__snd._lastFlares));

// A missile tracking the player raises the warning, and its tone beeps: sampled once a game
// frame over a game-second (about five beeps; software rendering runs the game far slower
// than the wall clock), it must be seen both on and off. When the missile is gone (here
// taken out of play, as one that hits, expires or is decoyed is), the warning and tone stop.
check('still alive before the missile checks (a dead player raises no warning and would pass them trivially)',
      await ev(() => !window.__st().gameOver), await ev(() => ({ hp: window.__pl.hp, y: Math.round(window.__pj.position.y) })));
await ev(() => window.__aimMissile(1500));
check('a missile tracking the player raises the warning', await until(() => window.__mt() > 0, 15000), await ev(() => window.__mt()));
const tone = { on: 0, off: 0 };
for (const [t0, wall] = [await ev(() => window.__gt()), Date.now()]; Date.now() - wall < 90000;) {
  const s = await ev(() => ({ t: window.__gt(), on: window.__snd.mslGain.gain.value > 0 }));
  if (s.t !== tone.last) { tone.last = s.t; s.on ? tone.on++ : tone.off++; }
  if (s.t > t0 + 1) break; await p.waitForTimeout(50);
}
delete tone.last;
check('the missile warning tone beeps (heard on and off)', tone.on > 0 && tone.off > 0, tone);
await ev(() => { for (const m of window.__mp) if (m.userData.active && m.userData.isEnemy) { m.userData.active = false; m.visible = false; } });
check('the warning clears when the missile is gone', await until(() => window.__mt() === 0, 15000), await ev(() => window.__mt()));
check('and its tone stops', await until(() => window.__snd.mslGain.gain.value === 0, 15000), await ev(() => window.__snd.mslGain.gain.value));

// Crash into the ground while firing, with a missile warning sounding: at game over the
// warning tone must stop with everything else.
await ev(() => window.__aimMissile(2500));
await until(() => window.__mt() > 0, 15000);
await p.keyboard.down('Space');
// One frame of ground contact costs 12.5 HP and puts the jet back on the surface, so hold it
// under the ground until the game ends. (This passed with a single push only while the jet
// was already dying on the ridge by the spawn; see clearOfGround.)
check('ground crash ends the game', await until(() => { if (!window.__st().gameOver) window.__pj.position.y = -50; return window.__st().gameOver; }, 120000));
await p.screenshot({ path: join(out, 'ui-crash.png') });
check('gun audio stopped at game over', await until(() => !window.__snd._gun, 5000));
check('missile warning tone stopped at game over', await until(() => window.__snd.mslGain.gain.value === 0, 5000), await ev(() => window.__snd.mslGain.gain.value));
await p.keyboard.up('Space');
check('game-over screen appears', await until(() => getComputedStyle(document.getElementById('game-over')).display !== 'none', 120000));
await p.screenshot({ path: join(out, 'ui-gameover.png') });
await clickCentre();
await until(() => !window.__st().gameOver, 10000);
const st = await ev(() => ({ ...window.__st(), hp: window.__pl.hp, ctx: window.__snd.ctx.state, motors: window.__snd.voices.filter(v => v.follow && v.release).length }));
check('restart from the game-over screen', !st.gameOver && st.hp === 100 && st.score === 0 && !(await shown('game-over')), st);
check('audio running after restart', st.ctx === 'running');
await p.keyboard.down('Space');
check('gun works after restart', await until(() => !!window.__snd._gun, 10000));
await p.keyboard.up('Space');

// Reload: volume persists.
await p.reload();
await p.waitForFunction(() => window.__snd, null, { timeout: 90000 });
check('volume persists across reload', await ev(() => window.__snd.volume) === 0.7, await ev(() => window.__snd.volume));
for (let i = 0; i < 3; i++) await p.keyboard.press('Equal');
check('+ raises the volume', await ev(() => window.__snd.volume) === 1);

await game.close();
const failed = results.filter(ok => !ok).length, errors = [...game.errors.entries()];
for (const [k, n] of errors) console.error(`  ${k} x${n}`);
if (failed || errors.length) { console.error(`\nFAIL: ${failed} of ${results.length} checks failed, ${errors.length} page errors`); process.exit(1); }
console.log(`\nall ${results.length} checks passed`);
