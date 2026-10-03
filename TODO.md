# TODO

Next pieces of work on Sky Strike, written for whoever picks this up — human or
agent. Each item says what is there now, what is missing, and what done looks
like. Read "Orientation" first; a couple of the conventions are easy to break by
accident.

---

## Orientation

- **The whole game is `index.html`.** No build step, no package manager, no test
  suite. Open the file in a browser and it runs. Keep it that way: the
  single-file property is the reason this thing is easy to share and easy to
  bisect. If you need an asset, generate it procedurally at load (see
  `createPanelMaps`, `createCloudNoise3D`, `tileableFBM`) rather than adding
  binaries.
- **Three.js r163**, loaded from jsDelivr through an import map. WebGL2 only,
  so shaders are GLSL ES 3.00.
- **Line endings are LF**, declared in `.gitattributes`. Do not convert them by
  hand. If `git diff --stat` ever reports an insertion count equal to the
  file's line count, something has rewritten the file in the other convention
  and the diff is no longer reviewable.
- **Post chain** (`EffectComposer`): scene render, then the volumetric cloud
  pass, then `EffectsPass`, then bloom, output, FXAA, and a grade pass that does
  lens falloff, lateral chromatic aberration, an S-curve and grain. The cloud
  pass is inserted at index 1 so sunlit cloud edges bloom with everything else.
  `EffectsPass` draws the effects layer (everything transparent that writes no
  depth) over the cloud composite, because the march cannot see what is not in
  the depth buffer.
- **Atmosphere is shared by every material.** `ShaderChunk` fog hooks are
  overridden globally and `THREE.Material.prototype.onBeforeCompile` injects the
  shared uniforms, so terrain, water, aircraft and clouds all use one aerial
  perspective model. Do not add a second one.
- **One coverage field drives three things.** `cloudCoverAt` (in
  `CLOUD_SHADOW_GLSL`) is read by the volumetric march, by the ground and sea
  shadow term, and by the analytic cloud reflection in the water. Changing it
  changes all three together, which is deliberate: it is what keeps a cloud, its
  shadow and its reflection describing the same cloud.
- `USE_VOLUMETRIC_CLOUDS = false` swaps the raymarched layer back to the old
  billboard field. It exists for machines where the march is too expensive.

Line numbers drift; search by symbol name.

### Verifying a change

There is no test suite, and graphics work cannot be verified by reading the
diff. What worked during the rendering overhaul:

- Headless Chromium with SwiftShader (`--use-angle=swiftshader`), a generated
  copy of `index.html` with the spawn point and camera overridden, and a
  screenshot after a fixed settle time. Software rendering is slow (seconds per
  frame) but deterministic, and it does surface shader compile errors.
- For anything with a numeric knob — cloud coverage, density, wave amplitude —
  port the function to a small CPU script and measure the distribution before
  touching the shader. Several rounds were wasted guessing at values that a
  thirty-second measurement settled.
- Isolate one variable per render. Three "fixes" for an artefact turned out to
  address three real but unrelated bugs, because the isolation test that would
  have identified the actual cause was not run first.
- For simulation changes, a soak harness (fixed timestep, many substeps per
  rendered frame, auto-restart on death, per-frame non-finite watchdog) covers
  minutes of game time in minutes of wall clock and catches NaN, pool leaks and
  streaming stalls.

---

## 1. Audio

`class SoundEngine` is entirely procedural Web Audio — no sample files, which is
worth preserving. The player's engine is turbulent roar, rumble, a beating
turbine whine and reheat crackle, every layer modulated by `_wobble` (a looping
slow random curve fed into an AudioParam) so nothing sits still. There is wind,
a rotary cannon baked into buffers, an infrared-missile seeker (seek tone, growl,
track tone), a threat warning, `explosion(pos, scale)` with a shared terrain
echo, `impact(pos)` for the airframe striking the ground, `missileLaunch(missile)`
with a motor that follows the missile, and `hitMarker()`.

**Measure levels before changing them.** Every level in the class was set
against A-weighted loudness measured offline (an `OfflineAudioContext` driven
frame by frame, each bus soloed). At 70% throttle the engine bus is about
-38 dBA. The seek tone is 2 dB below it; the growl 5–10 dB above, rising with lock
quality; the track tone 11 dB above; a sustained gun burst 11–12 dB above; a
missile launch about 11 dB above. An enemy blowing up 300 m away is about 5 dB
above in its first half second, the player's crash 15 dB above, peaking into
the limiter. Judging by ear on one pair of headphones is how the
engine came to drown out everything else.

### 1a. Positional audio — done; use it for everything below

`snd.updateListener(camera, dt)` runs once per frame after the camera moves and
places `ctx.listener` at it. A world-space sound is built in three steps:

1. `const v = this._voice(pos, bus, refDistance, follow)` — an HRTF
   `PannerNode` with the inverse distance model, behind a lowpass that stands in
   for air absorption (`22000 / (1 + d / 600)` Hz). `v.delay` is the travel
   time from `pos`; start the sources at `currentTime + v.delay` and connect
   them to `v.input`.
2. Push the sources' `detune` params (oscillator or `BiquadFilter`) onto
   `v.detune`. Doppler is computed from closing speed every frame and written to
   them in cents, capped at an octave either way, with both speeds held below
   0.6 c (the formula breaks at Mach 1, and at full throttle the player is
   doing about Mach 1.3).
3. `this._track(v, duration)` registers the voice; it is re-placed every frame
   and disconnected once it has finished.

`refDistance` is the distance inside which the sound plays at full level, so it
doubles as the source-loudness knob (explosions use 200 m, missile launches
60 m). `follow` is a pool entry — anything with `position`, `userData.vel` and
`userData.active` — to track; the voice stops following the first frame the
entry is inactive, because pool entries are reused.

The player's engine, the wind, the cannon and the cockpit tones stay dry. Every
explosion and every missile launch, the enemy's included, is positional; enemy
launches were silent before, and missile detonations that did not kill anything
(hits that did not kill, impacts on terrain, a missile hitting the player) were
silent too.

Measured against `OfflineAudioContext` in Chromium: a source 90° left is 4.9 dB
louder in the left channel (HRTF, not hard panning, so expect a modest level
difference rather than silence on one side);
onsets land within about 12 ms of `d / 343` (the HRTF's own latency); a blast at
2 km is 21 dB below one at 100 m, which is the inverse law and air absorption
together.

Still open from the original "done when": *an enemy crossing in front of you
sweeps across the stereo field* needs enemies to make sound at all — that is
1e, and it gets the panning and Doppler for free.

### 1b. The cannon — done

The gun is modelled on the M61 rotary cannon: `GUN_RATE` 100 rounds a second,
reached over `GUN_SPINUP` 0.3 s and wound down over `GUN_SPINDOWN` 0.5 s. A
trigger pressed while the barrels are still winding down picks up from where
they are. Rounds come from an accumulator in `updatePlayer`, not once per frame,
and a round fired partway through a frame is advanced by the time it has
already flown, so the rate and the spacing of the stream do not depend on the
frame rate. Every third round is a tracer (`GUN_TRACER_EVERY`); the others are
invisible but hit. `GUN_DAMAGE` is 2.5 a round, which keeps damage per second
on target where the old 12-volley gun had it.

The sound is baked, not built from nodes, because a graph per round at 100 a
second is thousands of nodes a burst. `_bakeRounds` writes each round (a crack,
a body and a thump, varied per round) into a buffer at its firing time:
`gunStartBuf` holds the spin-up with the rate ramping by the same rule the game
uses, `gunLoopBuf` is one second at full rate with its tails wrapped so it
loops without a seam. `update()` starts and stops them on the trigger's edges;
release plays the report rolling away and the barrels whirring down. Measured,
the sustained burst has a 10.0 ms period, i.e. 100 rounds a second.

`hitMarker()` is limited to one tone per 80 ms, and hit sparks come only from
tracer rounds, or a burst on target would flood both.

Enemy guns are still silent.

### 1c. Bullet impacts

`hitMarker()` is a 1200 Hz sine for 60 ms. That is a UI confirmation tone and it
should stay as one — but there is currently no *physical* impact sound at all.
Rounds striking an airframe should sound like metal being hit: a bright
transient, a short metallic ring, as a `_voice` at the impact point.

Hits on terrain and water want their own variants — dirt thud, water slap. Note
that a round striking the ground currently produces *nothing at all*, visual or
audio: `updateBullets` just deactivates it below `getGroundHeight`. Land versus
water is one comparison against `WATER_LEVEL` away, and a splash or a puff of
dirt is worth adding at the same time as the sound.

**Done when:** hitting an enemy at 800 m sounds different from hitting one at
100 m, and different again from hosing the sea.

### 1d. Missile motors — done

`missileLaunch(missile)` plays an ignition thump and flame burst, then a looping
motor (pink-noise roar with a random sputter, plus hiss) on a `_voice` that
follows the missile. A voice can carry a `release()`; `updateListener` calls it
the first frame the followed pool entry is inactive, which fades the motor out
(40 ms time constant) and stops its sources. `silence()` releases every motor too, because the
pool stops updating when the game ends. Player and enemy missiles both have
motors, so one chasing you is audible.

Measured from the chase camera with the missile pulling away at 410 m/s: about
-28 dBA in the first half second, -35 by one second, -43 at two, -48 at four,
against the engine at about -38 dBA at 70% throttle.

There is no motor burnout in the simulation (`motor` ramps to 1 and stays), so
the sound runs for the missile's whole life; if burnout is ever modelled, cut
the roar to a tail there.

### 1e. Enemy aircraft make no sound

Only the player's engine is audible. Enemies are silent, so a merge has no
audio. Give each entry in `enemies` a cheap engine voice — far fewer layers than
the player's, since it will usually be distant and heavily attenuated — with
distance culling so eight of them do not cost eight full engine stacks. The
pass-by Doppler from 1a is what makes this worth doing.

**Done when:** you hear an enemy before the radar warning, and a head-on pass
sounds like one.

### 1f. Mix and headroom — done, apart from balancing

The graph is now four buses (`this.buses.engines`, `.weapons`, `.world`,
`.cockpit`) into the 0.45 mix level, then a limiter (`DynamicsCompressorNode`,
-3 dB, 20:1, 3 ms attack), then a trim, then the player's volume. The trim
exists because Chromium's compressor applies its own makeup gain — measured at
+1.71 dB below threshold at these settings — and the limiter should only ever
turn peaks down. Measured: twenty point-blank explosions at once peak at
-4.3 dBFS where they would be +10.6 unlimited, and a single explosion is within
0.15 dB of the unlimited graph. If you change the threshold or ratio, re-measure
the makeup gain and update `LIMITER_MAKEUP_TRIM`.

Ducking lands on the engine bus, not the world bus as first planned: the world
bus only carries explosions so far, so ducking it under explosions would duck
the explosions themselves. Nearby blasts dip the engines on arrival, scaled by
distance (`blastDuck`), and held fire pulls them to 0.75 (`fireDuck`). When
enemy engines (1e) land on the world bus, ducking it under close blasts becomes
worth doing.

Volume is `-`/`+` (tenths, applied squared), mute is `M`, both shown briefly on
the HUD and persisted in `localStorage`.

The engine bus sits at 0.7, the others at 1.0; see the measured levels at the
top of this section before moving them.

---

## 2. Wingtip vortices, and contrails that respond to flight

Check what is there before starting — more exists than you would guess from
playing it.

**Contrails:** `updateContrails` maintains a single polyline of up to 120 points
trailing the player, gated on altitude above 300 m, with an alpha ramp along its
length. One line, from the fuselage origin, player only.

**Wingtip vapour:** already implemented, in `updatePlayer` under the comment
`// Wing vapor`. Above 3 G it spawns pale blue-white smoke particles at both
wingtips. It works, but it is a puff emitter rather than a vortex.

What is missing:

- Emit contrails from each wingtip rather than the centreline, so a roll
  visibly twists the pair.
- Make the vapour read as a vortex rather than a cloud of dots: a ribbon or
  tapered core with a lifetime, instead of independent particles.
- Scale vapour with G rather than switching on at a hard threshold of 3, and
  vary contrail persistence with altitude rather than a hard 300 m cut.
- The wingtip positions are hardcoded as `±12 * 1.8` — the wing semi-span times
  the model scale. Derive them from the wing stations so they survive the next
  airframe change.
- Give enemies contrails and vapour. At altitude a contrail is how you spot a
  bandit before the radar does, so this is a gameplay benefit as much as a
  visual one.

## 3. Battle damage

Partly there. The player streams orange flame particles from the tail below 20
HP, and a round striking an enemy throws a burst of sparks at the impact point.
Beyond that both go from pristine to exploding with nothing in between, and an
enemy carries no visible damage state at all — you cannot tell one that is about
to die from a fresh one, which costs readability as well as looks.

- **Surface damage.** Scorch and soot around hit locations. The airframe
  materials already carry procedurally generated panel normal and roughness maps
  and the lofts carry arc-length UVs, so a damage mask blended into those maps
  fits naturally and needs no new texture assets.
- **Enemy damage states.** Smoke from a damaged enemy, thickening as HP falls,
  so a wounded bandit is identifiable at range. The player's single threshold at
  20 HP should become graded at the same time.
- **Structural loss.** Pieces departing on heavy hits — the debris pool already
  exists — and a flame from an engine that has been killed.

Reuse the particle pool rather than adding another, and respect the reserve and
budget constants it already carries (`MAX_PARTICLES`, `PARTICLE_EFFECT_RESERVE`);
a damaged dogfight is exactly when it is closest to exhaustion.

## 4. Cockpit view

There is one chase camera (`camOff`, `camLookOff`) and nothing else. A cockpit
or virtual-cockpit view would change how the game reads more than any other
single addition, and the canopy, coaming and instrument shroud geometry are
already modelled.

Note two things before starting:

- The canopy is deliberately opaque (`canopyMat`) so the chase camera never
  sorts through it. A cockpit view needs it genuinely transparent, which means
  dealing with the sort order that decision was avoiding.
- The HUD is drawn to a 2D canvas overlay. A cockpit view wants it projected
  onto a combining glass in world space instead, or it will look pasted on.

A view toggle also needs the camera smoothing to stay frame-rate independent —
see `smoothT`, and the note in item 5 of "Known gaps".

## 5. Time of day

The sun direction is a module-scope constant, and a good deal of tuning assumes
it: `uCloudShadowOffset` is computed once from it at load, the terrain's
sun-visibility is baked per vertex on the assumption the sun never moves, and
the water's specular normalisation and the sky's turbidity/Rayleigh curve were
both tuned at its current elevation of about 21 degrees.

So this is a bigger job than it looks, and the order matters:

1. Make the sun a variable and find everything that assumes otherwise (start by
   grepping `sunDirection`).
2. Decide what happens to the baked terrain shadowing — either re-bake on a
   coarse schedule when the sun has moved enough to matter, or replace it with
   something dynamic.
3. Re-tune the sky, water specular and cloud lighting across the range. Dawn and
   dusk are the interesting cases and also where a low sun through a cumulus
   field looks best — expect the forward-scatter cap in the cloud pass
   (`min(sun * phase * 12.0, 4.6)`) to need revisiting.

Even a fixed choice of three or four presets — dawn, noon, golden hour, dusk —
would be worth a lot and avoids most of the dynamic-shadowing problem.

---

## Known gaps

- **GPU performance is unmeasured.** Every performance figure quoted in the
  commit history comes from a software rasteriser, which does not predict GPU
  cost for an ALU-heavy raymarch. The volumetric cloud pass measured around 6%
  of frame time under SwiftShader; what it costs on real hardware is unknown. If
  it is heavy, `USE_VOLUMETRIC_CLOUDS = false` is the fallback.
- The cloud march is half resolution (`CLOUD_SCALE = 0.5`) and resolved with a
  four-tap rotated-grid blur. That is a quality/cost trade, not a finished
  answer — temporal reprojection would do better if anyone wants to spend the
  complexity.
- Water reflections are a half-resolution planar pass and only cover what the
  mirrored camera can see; everything off-screen falls back to the analytic sky
  plus the analytic cloud tint. Look for the seam at grazing angles.
- Terrain streaming is budgeted at about 4 ms per frame. Under the soak harness
  the build queue reaches several hundred chunks because the aircraft outruns
  it; at normal frame rates it drains. If you make the aircraft faster, re-check
  that.
- **`lerp(a, b, k * dt)` is frame-rate dependent** and diverges outright once
  `k * dt` exceeds 2, which one long frame is enough to trigger. Every instance
  now goes through `smoothT`; use it for anything new.
- There is no settings screen. Volume and mute are keys only (see 1f).
- **The particle pool runs close to empty in heavy fights.** A soak (a bot
  flying 15 game-minutes, auto-restarting) took `freeParticles` down to 7 of
  `MAX_PARTICLES` 600; the same bot on the code before the rotary cannon got to
  21, so the pressure predates it. At the low point about 290 were missile and
  exhaust smoke trails and about 250 short-lived fire. When the pool is empty
  `spawnP` drops the effect silently, so an explosion can come out thin.
- **On a machine too slow for 20 fps, game time runs slow but audio does not.**
  `dt` is clamped to 0.05 s, so below 20 fps the simulation slows down while the
  audio clock keeps real time: the cannon's sound reaches full rate in 0.3 s of
  real time while the barrels in the game take longer.
