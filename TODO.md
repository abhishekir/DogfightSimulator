# TODO

Open work on Sky Strike, written for whoever picks this up — human or agent.
Read "Orientation" first; a couple of the conventions are easy to break by
accident.

The tasks are sorted by priority, highest first. Each says what is there now,
what is missing, and what done looks like. How finished systems work is under
"Reference" at the end, so a task can point there instead of repeating it.

| Priority | Meaning |
|---|---|
| **P1** | Something the player sees or hears is broken or degrading now. |
| **P2** | A gap in gameplay or readability, cheap relative to what it buys. |
| **P3** | A large feature. Worth doing; plan it first. |
| **P4** | Investigation, polish, or a decision to make. |

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
- **Smooth with `smoothT(k, dt)`, never `lerp(a, b, k * dt)`.** The latter is
  frame-rate dependent and diverges outright once `k * dt` exceeds 2, which one
  long frame is enough to trigger. Every instance in the code now uses `smoothT`.

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
  streaming stalls. With a bot flying it (lead pursuit, guns and missiles,
  forced crashes, random pauses) 40 game-minutes take under three minutes.
- For audio, render offline: an `OfflineAudioContext` driven frame by frame
  through `snd.update()`, each bus soloed, measured A-weighted. Ears and
  headphones differ; the numbers in "Reference: the sound engine" do not.

---

## Tasks

### 1. Particle pool runs dry in heavy fights — P1

**What happens.** `spawnP` takes from a fixed pool of `MAX_PARTICLES` (600) and
drops the request silently when it is empty, so in a busy fight explosions come
out thin and hit sparks go missing. A soak (a bot flying 15 game-minutes with
guns and missiles, auto-restarting) took `freeParticles` down to 7. The same bot
on the code before the rotary cannon reached 21, so the pressure predates the
cannon; the cannon's muzzle flash adds about a dozen live particles. At the low
point roughly 290 were missile smoke trails and 250 short-lived fire.

**Why the reserve does not help.** `PARTICLE_EFFECT_RESERVE` (160) holds
particles back for one-off effects, but it only applies to requests flagged
`isTrail`, and the only emitter flagged is the missile trail
(`emitMissileTrail`). Every other continuous emitter — both jets' exhaust,
player damage smoke, wing vapour, burning debris, muzzle flash — draws from the
reserve exactly as an explosion does.

**What to do.** Measure first: count dropped requests by emitter in `spawnP`
and run a soak. Then likely some of: flag the continuous emitters as trails (or
give them their own budget) so the reserve protects one-off effects; when the
pool is empty, evict the oldest trail particle rather than drop an effect;
raise `MAX_PARTICLES` if the GPU cost of the batches allows (it is unmeasured,
see task 2).

**Done when:** a 15-minute soak drops no explosion, impact or spark particles,
and the count of dropped requests is logged per emitter. Do this before task 5
or task 8; damage effects add emitters, and a damaged dogfight is exactly when
the pool is closest to empty.

### 2. GPU cost is unmeasured — P2 (needs real hardware)

Every performance figure in the commit history comes from a software
rasteriser, which does not predict GPU cost for an ALU-heavy raymarch. The
volumetric cloud pass measured around 6% of frame time under SwiftShader; what
it costs on real hardware is unknown. If it is heavy, `USE_VOLUMETRIC_CLOUDS =
false` is the fallback. This cannot be done in a headless container.

**Done when:** frame time, and the share of it per pass, is recorded on at least
one integrated and one discrete GPU, and a default for `USE_VOLUMETRIC_CLOUDS`
is chosen from it.

### 3. Enemy aircraft make no sound — P2

Only the player's engine is audible, so a merge has no audio. Give each entry in
`enemies` a cheap engine voice through `_voice(..., follow)` (see "Reference:
the sound engine") — far fewer layers than the player's, since it will usually
be distant and heavily attenuated — with distance culling so eight of them do
not cost eight full engine stacks. The panning and Doppler come free. Put them
on the `world` bus, and once they are there, duck the world bus briefly under
close blasts (today only the engine bus is ducked, because the world bus held
nothing but explosions).

**Done when:** you hear an enemy before the radar warning, a head-on pass sweeps
across the stereo field with a Doppler drop, and eight enemies cost less than
the player's engine.

### 4. Hits and enemy gunfire make no physical sound — P2

`hitMarker()` is a UI confirmation tone (limited to one per 80 ms) and should
stay one, but there is no *physical* impact sound. Rounds striking an airframe
should sound like metal being hit — a bright transient, a short metallic ring —
as a `_voice` at the impact point. Hits on terrain and water want their own
variants, dirt thud and water slap; a round striking the ground currently
produces nothing at all, visual or audio (`updateBullets` just deactivates it
below `getGroundHeight`), so add a dirt puff or splash at the same time. Land
versus water is one comparison against `WATER_LEVEL`. Enemy guns are silent
too; a positional burst per enemy volley would tell you you are being shot at.

At 100 rounds a second, hit sounds need the same treatment as the cannon:
bake or pool them, and rate-limit per target.

**Done when:** hitting an enemy at 800 m sounds different from hitting one at
100 m, and different again from hosing the sea; you hear an enemy firing at
you.

### 5. Enemy damage you can read at range — P2

An enemy carries no visible damage state: you cannot tell one that is about to
die from a fresh one. Smoke from a damaged enemy, thickening as HP falls, would
make a wounded bandit identifiable at range. The player's single 20 HP
threshold for tail flame should become graded at the same time. Depends on
task 1.

**Done when:** at 1 km you can tell a nearly dead enemy from a fresh one.

### 6. Enemies leave no contrails — P2

`updateContrails` draws one contrail, the player's, from the fuselage origin.
At altitude a contrail is how you spot a bandit before the radar does, so
giving enemies contrails is a gameplay benefit as much as a visual one. Vary
persistence with altitude rather than the hard 300 m cut while doing it.

**Done when:** an enemy above 3,000 m is visible by its contrail before it is
visible as an aircraft.

### 7. Cockpit view — P3

There is one chase camera (`camOff`, `camLookOff`) and nothing else. A cockpit
or virtual-cockpit view would change how the game reads more than any other
single addition, and the canopy, coaming and instrument shroud geometry are
already modelled. Before starting:

- The canopy is deliberately opaque (`canopyMat`) so the chase camera never
  sorts through it. A cockpit view needs it genuinely transparent, which means
  dealing with the sort order that decision was avoiding.
- The HUD is drawn to a 2D canvas overlay. A cockpit view wants it projected
  onto a combining glass in world space instead, or it will look pasted on.
- A view toggle needs the camera smoothing to stay frame-rate independent; use
  `smoothT`, never `lerp(a, b, k * dt)`.
- The listener follows the camera, so the player's own engine — dry, heard from
  the chase position — wants a muffled, interior variant in the cockpit.

**Done when:** a key toggles views, the canopy is transparent from inside
without sorting artefacts, and the HUD sits on the combiner.

### 8. Battle damage on the airframe — P3

Beyond task 5's smoke, both the player and enemies go from pristine to
exploding with nothing in between.

- **Surface damage.** Scorch and soot around hit locations. The airframe
  materials already carry procedurally generated panel normal and roughness maps
  and the lofts carry arc-length UVs, so a damage mask blended into those maps
  fits naturally and needs no new texture assets.
- **Structural loss.** Pieces departing on heavy hits — the debris pool already
  exists — and a flame from an engine that has been killed.

Reuse the particle pool rather than adding another, and do task 1 first.

### 9. Time of day — P3

The sun direction is a module-scope constant, and a good deal of tuning assumes
it: `uCloudShadowOffset` is computed once from it at load, the terrain's
sun-visibility is baked per vertex on the assumption the sun never moves, and
the water's specular normalisation and the sky's turbidity/Rayleigh curve were
both tuned at its current elevation of about 21 degrees. So the order matters:

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

### 10. Wingtip vortices and contrail polish — P3

**Wingtip vapour** exists in `updatePlayer` under `// Wing vapor`: above 3 G it
spawns pale smoke particles at both wingtips. It is a puff emitter, not a
vortex. Remaining (enemy contrails are task 6):

- Emit contrails from each wingtip rather than the centreline, so a roll
  visibly twists the pair.
- Make the vapour read as a vortex — a ribbon or tapered core with a lifetime —
  and scale it with G rather than switching on at 3.
- The wingtip positions are hardcoded as `±12 * 1.8` (semi-span times model
  scale). Derive them from the wing stations so they survive the next airframe
  change.

### 11. The flight model allows 30+ G — P4 (decision)

The HUD's G readout regularly shows 30–37 G in hard turns: steady pitch rate
reaches about 1.15 rad/s, which at 300 m/s is about 35 G. That is the arcade
handling working as built, not a bug, but it sits oddly next to realistic
airspeed, cannon and missile cues. Decide whether to cap turn rate by speed (a
real fighter manages about 9 G) or to leave it and stop showing the number.

### 12. Settings screen — P4

There is none. Volume and mute are keys only (`-`/`+`, `M`). Graphics options
(`USE_VOLUMETRIC_CLOUDS`, pixel ratio) are constants in the source.

### 13. Cloud and water quality — P4

- The cloud march is half resolution (`CLOUD_SCALE = 0.5`) and resolved with a
  four-tap rotated-grid blur. Temporal reprojection would do better if anyone
  wants to spend the complexity.
- Water reflections are a half-resolution planar pass and only cover what the
  mirrored camera can see; everything off-screen falls back to the analytic sky
  plus the analytic cloud tint. Look for the seam at grazing angles.

### 14. Small things to keep in mind — P4

- **Below 20 fps, game time runs slow but audio does not.** `dt` is clamped to
  0.05 s, so the simulation slows while the audio clock keeps real time; the
  cannon's sound reaches full rate in 0.3 s of real time while the barrels in
  the game take longer.
- **Terrain streaming** is budgeted at about 4 ms per frame. Under the soak
  harness the build queue reaches several hundred chunks because the aircraft
  outruns it; at normal frame rates it drains. If you make the aircraft faster,
  re-check that.
- **Missile motors never burn out** (`motor` ramps to 1 and stays), so the
  motor sound runs for the missile's whole life. If burnout is modelled, cut
  the roar to a tail there.

---

## Reference: the sound engine

`class SoundEngine` is entirely procedural Web Audio — no sample files, which is
worth preserving.

**Measure levels before changing them.** Every level in the class was set
against A-weighted loudness measured offline. At 70% throttle the engine bus is
about -38 dBA. The seek tone is 2 dB below it; the growl 5–10 dB above, rising
with lock quality; the track tone 11 dB above; a sustained gun burst about
12 dB above; a missile launch about 11 dB above. An enemy blowing up 300 m away
is about 5 dB above in its first half second, the player's crash 15 dB above,
peaking into the limiter. Judging by ear on one pair of headphones is how the
engine once came to drown out everything else.

**Mix.** Four buses (`this.buses.engines`, `.weapons`, `.world`, `.cockpit`)
into the 0.45 mix level, then a limiter (`DynamicsCompressorNode`, -3 dB, 20:1,
3 ms attack), then a trim, then the player's volume. The trim exists because
Chromium's compressor applies its own makeup gain — measured at +1.71 dB below
threshold at these settings — and the limiter should only turn peaks down. If
you change the threshold or ratio, re-measure it and update
`LIMITER_MAKEUP_TRIM`. The engine bus sits at 0.7, the others at 1.0. Nearby
blasts dip the engine bus on arrival (`blastDuck`) and held fire pulls it to
0.75 (`fireDuck`). Volume is `-`/`+` (tenths, applied squared), mute is `M`,
both persisted in `localStorage`. Hiding the tab pauses the game, which
suspends the audio clock.

**Positional audio.** `snd.updateListener(camera, dt)` runs once per frame after
the camera moves. A world-space sound is built in three steps:

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
   and disconnected once finished. A looping voice passes `Infinity` and sets
   `v.release`, which `updateListener` calls the first frame its `follow` pool
   entry is inactive (pool entries are reused, so it never follows past that).

`refDistance` is the distance inside which the sound plays at full level, so it
doubles as the source-loudness knob. The player's engine, wind, cannon and the
cockpit tones stay dry. Measured: a source 90° left is 4.9 dB louder in the
left channel (HRTF, not hard panning); onsets land within about 12 ms of
`d / 343`; a blast at 2 km is 21 dB below one at 100 m.

**Engine.** Turbulent pink-noise roar, brown-noise rumble, a turbine whine of
two partials beating a few cents apart, and reheat crackle, every layer
modulated by `_wobble` (a looping slow random curve fed into an AudioParam) so
nothing sits still. A steady filtered noise plus a clean sine is what a fan
sounds like.

**Cannon.** Modelled on the M61: `GUN_RATE` 100 rounds a second, `GUN_SPINUP`
0.3 s, `GUN_SPINDOWN` 0.5 s, fired from an accumulator so rate and spacing do
not depend on the frame rate. Every third round is a tracer; `GUN_DAMAGE` 2.5
keeps damage per second where the old 12-volley gun had it. The sound is baked
by `_bakeRounds` into a spin-up buffer and a seamless one-second loop, because a
node graph per round would be thousands of nodes a burst. Each round is noise —
crack, mid blast, feed tick, a short noise punch — never a tone: an earlier
version gave each round a pitched sine thump, and 100 identical thumps a second
fused into a 100 Hz tone with 80% of its energy under 250 Hz, which sounded like
a fart. Measured now: 4% under 250 Hz, no waveform periodicity at 10 ms, but
the envelope still repeats every 10 ms, so the rate is heard as rhythm.

**Seeker.** Infrared-missile cues: a quiet seek tone with nothing in the
seeker, a chopped growl rising with lock quality (the target's alignment and
range blended with lock progress), a steady high tone on track. It is a
band-limited sawtooth mixed with narrow-band noise at the same pitch, chopped,
then put through a headset chain (300–3400 Hz, soft saturation, faint line
hiss). A square wave with nothing else, which an earlier version used, measured
spectral flatness 0 and sounded like a toy.

**Missiles and explosions.** `missileLaunch(missile)` plays an ignition and a
looping motor that follows the missile, released with its pool entry; player
and enemy missiles both have one. `explosion(pos, scale)` layers a blast front,
a soft-clipped boom, a sub thud, a churning fireball, crackle and debris, with a
send into one shared terrain-echo convolver that falls off more slowly with
distance than the direct sound; level scales with `scale` (1 an enemy, 2 the
player's crash). `impact(pos)` is the airframe striking the ground.
