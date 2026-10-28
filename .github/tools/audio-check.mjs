/**
 * Audio check: renders the game's own SoundEngine offline and measures it. Ears and
 * headphones differ; these numbers do not.
 *
 *   node .github/tools/audio-check.mjs [--render] [--page file.html]
 *
 * Each scenario runs the real SoundEngine against an OfflineAudioContext, driving
 * snd.update() and snd.updateListener() every 16 ms of audio time exactly as the game
 * does, with every bus but the one under test silenced. It prints a level table
 * (A-weighted, relative to the engine at 70% throttle, which is the mix's reference) and
 * then asserts:
 *
 *  - the mix: each sound sits in a band relative to the engine, so one cannot drown the
 *    others again (the engine once did);
 *  - positional audio: left/right placement, arrival delay d/343, distance falloff,
 *    Doppler against the formula;
 *  - the limiter catches stacked peaks and is transparent below threshold; volume and mute;
 *  - regressions this code has actually had: the cannon fusing into a 100 Hz tone (energy
 *    piled below 250 Hz, waveform periodic at the round spacing), the seeker as a pure
 *    tone, the baked filter helper giving low-pass coefficients for a high-pass, and a
 *    missile hit before its sound arrived silencing the launch.
 *
 * The bands are deliberately loose: they catch a broken mix, not a retune. If you retune
 * on purpose and a band no longer fits, move the band and say why in the commit.
 *
 * --render writes gun.wav and lock.wav to .github/tools/out/ for listening: a 1.5 s burst
 * with spin-up and release, and the seeker going from seek tone through growl to lock.
 * Exits 1 if any assertion fails or the page reports an error.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openGame, exposeSound, stopLoop, flag, outDir } from './lib.mjs';

const RENDER = flag('render');
const game = await openGame({ transform: h => exposeSound(stopLoop(h)), viewport: { width: 200, height: 120 } });
const p = game.page;
await p.waitForFunction(() => window.__snd, null, { timeout: 90000 });

const m = await p.evaluate(async (render) => {
  const THREE = window.__THREE, S = window.__snd.constructor, SR = 48000, Q = 768, FR = Q / SR, C = 343;
  try { localStorage.removeItem('skystrike.audio'); } catch {}

  // ---- analysis ----
  const fft = (re, im) => { const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len;
      for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const c = Math.cos(a * k), s = Math.sin(a * k), h = len / 2;
        const vr = re[i + k + h] * c - im[i + k + h] * s, vi = re[i + k + h] * s + im[i + k + h] * c;
        re[i + k + h] = re[i + k] - vr; im[i + k + h] = im[i + k] - vi; re[i + k] += vr; im[i + k] += vi; } } };
  // A-weighting magnitude, IEC 61672.
  const aw = f => { const f2 = f * f; return 1.2589 * (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2)); };
  const N = 4096, W = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)), wn = W.reduce((a, w) => a + w * w, 0);
  const AW = Float32Array.from({ length: N / 2 }, (_, k) => aw(Math.max(k, 1) * SR / N) ** 2);
  const BANDS = [[20, 250], [250, 1000], [1000, 4000], [4000, 16000]];
  const db = x => +(10 * Math.log10(x + 1e-20)).toFixed(1);
  // Level (A-weighted and unweighted), peak, and share of energy per band over [t0, t1).
  function measure(buf, t0, t1) {
    let pa = 0, pz = 0, blocks = 0, pk = 0; const band = [0, 0, 0, 0];
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c);
      for (let i = Math.floor(t0 * SR); i < t1 * SR; i++) pk = Math.max(pk, Math.abs(d[i]));
      for (let s = Math.floor(t0 * SR); s + N <= t1 * SR; s += N / 2, blocks++) {
        const re = new Float32Array(N), im = new Float32Array(N); for (let i = 0; i < N; i++) re[i] = d[s + i] * W[i]; fft(re, im);
        for (let k = 1; k < N / 2; k++) { const pw = 2 * (re[k] ** 2 + im[k] ** 2) / (wn * N), f = k * SR / N; pz += pw; pa += pw * AW[k];
          for (let b = 0; b < 4; b++) if (f >= BANDS[b][0] && f < BANDS[b][1]) band[b] += pw; } } }
    const tot = band.reduce((a, v) => a + v, 0) || 1;
    return { dBA: db(pa / blocks), dBZ: db(pz / blocks), peak: +(20 * Math.log10(pk + 1e-12)).toFixed(1), bands: band.map(v => +(100 * v / tot).toFixed(1)) };
  }
  // Spectral flatness over 200 Hz-6 kHz: 0 is a pure tone, 1 white noise.
  function flatness(buf, t0) { const d = buf.getChannelData(0), a = Math.floor(t0 * SR), n = 8192, re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = d[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)); fft(re, im);
    let lg = 0, ar = 0, c = 0; for (let k = Math.floor(200 * n / SR); k < 6000 * n / SR; k++) { const pw = re[k] ** 2 + im[k] ** 2 + 1e-20; lg += Math.log(pw); ar += pw; c++; }
    return +(Math.exp(lg / c) / (ar / c)).toFixed(3); }
  const autocorr = (x, ms) => { const L = Math.round(ms * SR / 1000); let c = 0, z = 0; for (let i = 0; i + L < x.length; i++) { c += x[i] * x[i + L]; z += x[i] * x[i]; } return +(c / z).toFixed(2); };
  const onset = buf => { const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 1e-4) return i / SR; return -1; };
  const energy = (buf, ch) => buf.getChannelData(ch).reduce((a, v) => a + v * v, 0);

  // ---- scenario runner ----
  // Render `secs` with only `bus` audible, calling drive(s, t) every 16 ms of audio time.
  // Math.random is seeded for the whole render, so every scenario is deterministic: the
  // engine's noise, an explosion's debris and the gun's per-round variation come out the
  // same on every run, and two renders differ only in what a check changes between them.
  const seeded = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const realRandom = Math.random;
  async function run(bus, secs, drive, opts = {}) {
    Math.random = seeded(1);
    try { return await render(bus, secs, drive, opts); } finally { Math.random = realRandom; }
  }
  async function render(bus, secs, drive, { setup, cam } = {}) {
    const saved = window.AudioContext;
    window.AudioContext = function () { return new OfflineAudioContext(2, SR * secs, SR); };
    const s = new S(); if (setup) setup(s); s.init(); window.AudioContext = saved;
    for (const k in s.buses) if (bus && k !== bus) s.buses[k].gain.value = 0;
    cam ||= { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    let f = 0, err = null;
    const step = () => { try { drive(s, f++ * FR); s.updateListener(cam, FR); } catch (e) { err ||= e.stack; } };
    for (let t = Q; t < SR * secs - Q; t += Q) s.ctx.suspend(t / SR).then(() => { step(); s.ctx.resume(); });
    s.updateListener(cam, FR); step();
    const buf = await s.ctx.startRendering();
    if (err) throw new Error(err);
    return { s, buf };
  }
  const idle = (s) => s.update(0.7, 300, false, 0, false, FR, -1, 0);
  const fake = (x, y, z, vx = 0, vy = 0, vz = 0) => ({ position: new THREE.Vector3(x, y, z), userData: { active: true, vel: new THREE.Vector3(vx, vy, vz) } });
  const r = { levels: {} }, L = r.levels;

  // ---- levels ----
  for (const thr of [0.3, 0.7, 1]) L[`engine ${thr * 100}%`] = measure((await run('engines', 4, s => s.update(thr, 150 + thr * 300, false, 0, false, FR))).buf, 1, 4);
  for (const [name, lock, sig] of [['seek tone', 0.2, 0], ['growl, weak', 0.3, 0.3], ['growl, strong', 0.8, 0.8], ['lock tone', 1, 0.8]]) {
    const { buf } = await run('cockpit', 3, s => s.update(0.7, 300, false, lock, false, FR, sig, 0));
    L[name] = measure(buf, 1, 3);
    if (name === 'seek tone' || name === 'growl, strong') r[`flatness ${name}`] = flatness(buf, 1.5);
  }
  { // Cannon: trigger held 0.25-2.25 s, barrels spun as the game spins them.
    let spin = 0;
    const { buf } = await run('weapons', 3.5, (s, t) => { const on = t >= 0.25 && t < 2.25;
      spin = on ? Math.min(spin + FR / 0.3, 1) : Math.max(spin - FR / 0.5, 0); s.update(0.7, 300, on, 0, false, FR, -1, spin); });
    L['gun burst'] = measure(buf, 0.6, 2.2);
    const d = buf.getChannelData(0), a = SR, n = SR;
    r.gunWaveformPeriodicity = autocorr(d.subarray(a, a + n), 10);
    const e = new Float32Array(n); let y = 0; for (let i = 0; i < n; i++) { y += (Math.abs(d[a + i]) - y) * 0.02; e[i] = y; }
    const mean = e.reduce((s, v) => s + v, 0) / n; for (let i = 0; i < n; i++) e[i] -= mean;
    r.gunEnvelope = { at5: autocorr(e, 5), at10: autocorr(e, 10), at15: autocorr(e, 15) };
  }
  { // Missile launched from under the player, 46 m ahead of the chase camera, pulling away.
    const mi = fake(0, -8, -46, 0, 0, -100);
    const { buf } = await run('weapons', 6, (s, t) => { idle(s); if (Math.abs(t - 0.1) < FR / 2) s.missileLaunch(mi);
      if (t > 0.1) { mi.userData.vel.set(0, 0, -(100 + Math.min((t - 0.1) / 0.45, 1) * 310)); mi.position.addScaledVector(mi.userData.vel, FR); } });
    L['missile launch'] = measure(buf, 0.2, 0.7); L['missile at 3-5 s'] = measure(buf, 3.2, 5.2);
  }
  for (const [name, d, sc] of [['explosion, 300 m', 300, 1], ['explosion, 1500 m', 1500, 1], ['own crash, 80 m', 80, 2]]) {
    const { buf } = await run('world', 6, (s, t) => { idle(s); if (Math.abs(t - FR) < FR / 2) s.explosion(new THREE.Vector3(0, 0, -d), sc); });
    L[name] = measure(buf, d / C, d / C + 0.5);
  }
  L['ground impact, 60 m'] = measure((await run('world', 2, (s, t) => { idle(s); if (Math.abs(t - FR) < FR / 2) s.impact(new THREE.Vector3(0, 0, -60)); })).buf, 0.1, 0.8);

  // ---- positional ----
  const launchAt = async (pos, yaw = 0) => { const cam = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw) };
    const mi = fake(...pos); const { buf } = await run('weapons', 2, (s, t) => { idle(s); if (t === 0) s.missileLaunch(mi); }, { cam });
    return db(energy(buf, 0)) - db(energy(buf, 1)); };
  r.leftRight = { left: +(await launchAt([-300, 0, 0])).toFixed(1), right: +(await launchAt([300, 0, 0])).toFixed(1),
    yawedLeftSourceBehindLeft: +(await launchAt([0, 0, 300], Math.PI / 2)).toFixed(1), yawedLeftSourceAhead: +(await launchAt([-300, 0, 0], Math.PI / 2)).toFixed(1) };
  r.arrival = {};
  for (const d of [100, 500, 2000]) { const { buf } = await run('world', 7, (s, t) => { idle(s); if (t === 0) s.explosion(new THREE.Vector3(0, 0, -d)); });
    r.arrival[d] = { onset: +onset(buf).toFixed(3), expected: +(d / C).toFixed(3), dBA: measure(buf, d / C, d / C + 0.5).dBA }; }
  { const { s } = await run(null, 0.1, () => {});
    const mi = fake(0, 0, -500, 0, 0, 100); s.missileLaunch(mi); const v = s.voices[0], cents = () => +v.detune[0].value.toFixed(1);
    const at = (vs, vl) => { v.vel.set(0, 0, vs); s.listenerVel.set(0, 0, vl); s._place(v); return cents(); };
    r.doppler = { approach100: [at(100, 0), 1200 * Math.log2(C / (C - 100))], recede100: [at(-100, 0), 1200 * Math.log2(C / (C + 100))],
                  listenerToward100: [at(0, -100), 1200 * Math.log2((C + 100) / C)], approach200Clamped: [at(200, 0), 1200] }; }

  // ---- limiter, volume, mute ----
  { const { buf } = await run('world', 2, (s, t) => { idle(s); if (t === 0) for (let i = 0; i < 20; i++) s.explosion(new THREE.Vector3(0, 0, -1)); });
    r.twentyStackedPeak = measure(buf, 0, 2).peak; }
  { const one = async setup => (await run('world', 2, (s, t) => { idle(s); if (t === 0) s.explosion(new THREE.Vector3(0, 0, -100)); }, { setup })).buf;
    const bypass = s => { const init = s.init.bind(s); s.init = () => { init(); s.master.disconnect(); s.master.connect(s.output); }; };
    r.limiterTransparency = +(measure(await one(), 0, 2).dBA - measure(await one(bypass), 0, 2).dBA).toFixed(2);
    r.halfVolume = +(measure(await one(s => { s.volume = 0.5; }), 0, 2).dBA - measure(await one(), 0, 2).dBA).toFixed(2);
    r.mutedPeak = measure(await one(s => { s.muted = true; }), 0, 2).peak; }

  // ---- regressions ----
  { const resp = (type, fc, f) => { const h = S._biquad(type, fc, 0.7, SR); let pk = 0;
      for (let i = 0; i < SR; i++) { const y = h(Math.sin(2 * Math.PI * f * i / SR)); if (i > SR / 2) pk = Math.max(pk, Math.abs(y)); } return +(20 * Math.log10(pk)).toFixed(1); };
    r.biquad = { hp500at100: resp('highpass', 500, 100), hp500at5k: resp('highpass', 500, 5000), lp500at100: resp('lowpass', 500, 100),
                 lp500at5k: resp('lowpass', 500, 5000), bp2kAt2k: resp('bandpass', 2000, 2000) }; }
  { // An enemy missile 700 m away (2 s of sound travel) that hits at 1.07 s, before its launch is heard.
    const mi = fake(0, 0, -700, 0, 0, 400); let removedAt = null;
    const { buf } = await run('weapons', 4, (s, t) => { idle(s); if (t === 0) s.missileLaunch(mi);
      if (mi.userData.active) { mi.position.addScaledVector(mi.userData.vel, FR); if (t >= 1.07) mi.userData.active = false; }
      if (t > 0 && !s.voices.length && removedAt === null) removedAt = +t.toFixed(2); });
    r.earlyHitMissile = { ignition: measure(buf, 700 / C, 700 / C + 0.5).dBA, voiceRemovedAt: removedAt }; }

  // ---- renders for listening ----
  if (render) {
    const enc = buf => { const n = buf.length, ch = [buf.getChannelData(0), buf.getChannelData(1)]; let pk = 0; for (const c of ch) for (const v of c) pk = Math.max(pk, Math.abs(v));
      const g = 0.9 / (pk || 1), i16 = new Int16Array(n * 2); for (let i = 0; i < n; i++) { i16[2 * i] = ch[0][i] * g * 32767; i16[2 * i + 1] = ch[1][i] * g * 32767; }
      let s = ''; const u8 = new Uint8Array(i16.buffer); for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    let spin = 0;
    r.wav = { gun: enc((await run('weapons', 2.6, (s, t) => { const on = t >= 0.2 && t < 1.7; spin = on ? Math.min(spin + FR / 0.3, 1) : Math.max(spin - FR / 0.5, 0);
                s.update(0.7, 300, on, 0, false, FR, -1, spin); })).buf),
              lock: enc((await run('cockpit', 5, (s, t) => { let lp = 0, sig = -1;
                if (t < 1) sig = 0; else if (t < 4) { lp = Math.min((t - 1) / 1.5, 1); sig = 0.35 + 0.45 * lp; }
                s.update(0.7, 300, false, lp, false, FR, sig, 0); })).buf) };
  }
  return r;
}, RENDER);
await game.close();

// ---- report ----
const E = m.levels['engine 70%'].dBA, rel = name => +(m.levels[name].dBA - E).toFixed(1);
console.log('level (dBA)   vs engine 70%   band share % (<250 / 250-1k / 1-4k / >4k)   sound');
for (const [name, v] of Object.entries(m.levels))
  console.log(`${String(v.dBA).padStart(6)}       ${(rel(name) >= 0 ? '+' : '') + rel(name)}`.padEnd(30) + `${v.bands.join(' / ')}`.padEnd(42) + name);

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const within = (x, lo, hi) => x >= lo && x <= hi;
console.log('\nmix (dB relative to the engine at 70%)');
check('seek tone sits near the engine (-8..+4)', within(rel('seek tone'), -8, 4), rel('seek tone'));
check('growl rises with lock quality', rel('growl, strong') > rel('growl, weak'), [rel('growl, weak'), rel('growl, strong')]);
check('growl is above the engine', rel('growl, weak') > 0, rel('growl, weak'));
check('lock tone 6..16 dB above the engine', within(rel('lock tone'), 6, 16), rel('lock tone'));
check('gun burst 7..17 dB above the engine', within(rel('gun burst'), 7, 17), rel('gun burst'));
check('missile launch 6..16 dB above the engine', within(rel('missile launch'), 6, 16), rel('missile launch'));
check('a missile pulling away fades by more than 12 dB', rel('missile launch') - rel('missile at 3-5 s') > 12, [rel('missile launch'), rel('missile at 3-5 s')]);
check('the engine gets louder with throttle', m.levels['engine 30%'].dBA < E && E < m.levels['engine 100%'].dBA);
check('own crash is the loudest event', rel('own crash, 80 m') > Math.max(rel('explosion, 300 m'), rel('gun burst'), rel('lock tone')), rel('own crash, 80 m'));
console.log('\npositional');
check('a source to the left is louder on the left (>3 dB)', m.leftRight.left > 3, m.leftRight.left);
check('a source to the right is louder on the right (>3 dB)', m.leftRight.right < -3, m.leftRight.right);
check('placement follows the camera\'s orientation', m.leftRight.yawedLeftSourceBehindLeft > 3 && Math.abs(m.leftRight.yawedLeftSourceAhead) < 1.5, m.leftRight);
for (const [d, a] of Object.entries(m.arrival)) check(`a blast ${d} m away arrives after d/343 (within 30 ms)`, Math.abs(a.onset - a.expected) < 0.03, a);
// The terrain echo falls off at 3 dB a doubling against the direct sound's 6, so a distant
// blast is mostly echo; the direct sound alone is about 22 dB down at 2 km.
check('a blast at 2 km is >10 dB below one at 100 m', m.arrival[100].dBA - m.arrival[2000].dBA > 10, [m.arrival[100].dBA, m.arrival[2000].dBA]);
for (const [k, [got, want]] of Object.entries(m.doppler)) check(`Doppler ${k} matches the formula (within 2 cents)`, Math.abs(got - want) < 2, [got, +want.toFixed(1)]);
console.log('\nlimiter and volume');
// The limiter's 3 ms attack lets about 1.7 dB through on a transient; what matters is no clipping.
check('20 stacked point-blank blasts do not clip (peak under -0.5 dBFS)', m.twentyStackedPeak < -0.5, m.twentyStackedPeak);
check('the limiter is transparent below threshold (within 0.5 dB)', Math.abs(m.limiterTransparency) < 0.5, m.limiterTransparency);
check('half volume is about -12 dB (applied squared)', within(m.halfVolume, -13.5, -10.5), m.halfVolume);
check('mute is silent', m.mutedPeak < -100, m.mutedPeak);
console.log('\nregressions');
check('gun: under 15% of its energy below 250 Hz (was 80% when it sounded like a fart)', m.levels['gun burst'].bands[0] < 15, m.levels['gun burst'].bands);
check('gun: waveform not periodic at the round spacing (was 0.78)', Math.abs(m.gunWaveformPeriodicity) < 0.3, m.gunWaveformPeriodicity);
check('gun: envelope repeats every 10 ms, i.e. 100 rounds/s', m.gunEnvelope.at10 > 0.3 && m.gunEnvelope.at5 < 0 && m.gunEnvelope.at15 < 0, m.gunEnvelope);
check('seeker: growl is not a pure tone (flatness was 0)', m['flatness growl, strong'] > 0.005, m['flatness growl, strong']);
check('filter helper: high-pass passes highs and cuts lows', m.biquad.hp500at5k > -1 && m.biquad.hp500at100 < -20, m.biquad);
check('filter helper: low-pass and band-pass shapes', m.biquad.lp500at100 > -1 && m.biquad.lp500at5k < -30 && m.biquad.bp2kAt2k > -3.5);
check('a missile hit before its sound arrives still plays its ignition', m.earlyHitMissile.ignition > -60 && m.earlyHitMissile.voiceRemovedAt > 700 / 343, m.earlyHitMissile);

if (RENDER) {
  const out = await outDir();
  const wav = b64 => { const pcm = Buffer.from(b64, 'base64'), h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
    h.writeUInt32LE(48000, 24); h.writeUInt32LE(48000 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]); };
  for (const k of ['gun', 'lock']) await writeFile(join(out, `${k}.wav`), wav(m.wav[k]));
  console.log(`\nwrote ${join(out, 'gun.wav')} and ${join(out, 'lock.wav')} (each normalised to the same peak)`);
}
const failed = results.filter(ok => !ok).length, errors = [...game.errors.entries()];
for (const [k, n] of errors) console.error(`  ${k} x${n}`);
if (failed || errors.length) { console.error(`\nFAIL: ${failed} of ${results.length} checks failed, ${errors.length} page errors`); process.exit(1); }
console.log(`\nall ${results.length} checks passed`);
