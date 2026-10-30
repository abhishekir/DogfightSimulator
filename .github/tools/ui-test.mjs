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
  'window.__pj=playerJet;window.__pl=player;window.__st=()=>({gameOver,paused,gameStarted,score});function checkGameOver(){') });
const p = game.page, out = await outDir();
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const ev = fn => p.evaluate(fn);
const shown = id => p.evaluate(i => getComputedStyle(document.getElementById(i)).display !== 'none', id);
const until = async (fn, ms) => { for (const t = Date.now(); Date.now() - t < ms; await p.waitForTimeout(250)) if (await ev(fn)) return true; return false; };
const clickCentre = () => p.mouse.click(320, 180);

await p.waitForFunction(() => window.__snd, null, { timeout: 90000 });
await p.waitForTimeout(3000);

// Volume keys on the title screen, before the audio context exists.
for (let i = 0; i < 3; i++) await p.keyboard.press('Minus');
check('volume keys work before start', await ev(() => window.__snd.volume) === 0.7, await ev(() => window.__snd.volume));
await clickCentre();
await until(() => window.__st().gameStarted && window.__snd.ctx, 10000);
check('click starts the game', !(await shown('blocker')) && await ev(() => window.__st().gameStarted));
check('audio running at start', await until(() => window.__snd.ctx.state === 'running', 5000));
check('output level is volume squared', await until(() => Math.abs(window.__snd.output.gain.value - 0.49) < 0.01, 5000),
      await ev(() => window.__snd.output.gain.value));

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

// Crash into the ground while firing.
await p.keyboard.down('Space');
await ev(() => { window.__pj.position.y = -50; });
check('ground crash ends the game', await until(() => window.__st().gameOver, 30000));
await p.screenshot({ path: join(out, 'ui-crash.png') });
check('gun audio stopped at game over', await until(() => !window.__snd._gun, 5000));
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
