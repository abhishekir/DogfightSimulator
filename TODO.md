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
  pass, then bloom, output, FXAA, and a grade pass that does lens falloff,
  lateral chromatic aberration, an S-curve and grain. The cloud pass is inserted
  at index 1 so sunlit cloud edges bloom with everything else.
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

**The weakest system in the game, and the one with the most headroom.** The
synthesis is decent; the architecture is the problem.

`class SoundEngine` is entirely procedural Web Audio — no sample files, which is
worth preserving. It has a four-layer player engine (noise rumble, turbine sine,
compressor harmonic, afterburner noise), wind, a cannon hiss, a lock tone, a
threat warning, plus one-shot `explosion(dist)`, `missileLaunch()` and
`hitMarker()`.

What is actually wrong:

### 1a. There is no positional audio at all

Every node connects straight to `this.master`. There is no `AudioListener`, no
`PannerNode`, no stereo placement, no distance attenuation and no Doppler.
`explosion(dist)` is the sole exception and it hand-rolls both — it delays by
`dist / 343` and attenuates by distance, which is exactly the right instinct and
should be generalised rather than repeated.

This is the foundation: fix it first and every other item below gets most of the
way there for free.

- Set up `ctx.listener` from the camera each frame (position and orientation).
- Give every world-space sound a `PannerNode` (`panningModel: 'HRTF'`,
  `distanceModel: 'inverse'`, a `refDistance` tuned to the scale of the world —
  the player's airframe is about 48 m nose to tail, so world units are metres).
- Keep cockpit sounds (lock tone, threat warning, the player's own engine) on
  the dry master. They are heard through the airframe, not across the sky.
- Doppler: Web Audio removed the built-in implementation, so drive
  `detune`/`playbackRate` from closing speed yourself. A jet passing at 450 kts
  is a dramatic shift and it is most of what sells a merge.

**Done when:** a missile launched to your left is heard on your left, an
explosion two kilometres away is late and quiet, and an enemy crossing in front
of you sweeps across the stereo field.

### 1b. The cannon is a hiss gate, not a gun

`update()` sets `cannonGain.gain.value = firing ? 0.12 : <decay>` on a
continuously running noise source. That is the sound of a valve opening, not of
a rotary cannon. There is no per-round transient, so the rate of fire is
inaudible and it does not match the tracers.

Fire a short enveloped burst per round from `spawnBullet` (or from the same
place that decides a round is fired) — a few milliseconds of attack, a filtered
noise body, a fast decay, with small random pitch and level variation per shot
so it does not machine-gun identically. Keep a quieter continuous layer
underneath for the mechanical whir. Muzzle blast should also duck the engine
slightly.

**Done when:** you can hear the rate of fire, and a two-round tap sounds
different from a two-second burst.

### 1c. Bullet impacts

`hitMarker()` is a 1200 Hz sine for 60 ms. That is a UI confirmation tone and it
should stay as one — but there is currently no *physical* impact sound at all.
Rounds striking an airframe should sound like metal being hit: a bright
transient, a short metallic ring, positioned at the impact point and attenuated
by distance.

Hits on terrain and water want their own variants — dirt thud, water slap. Note
that a round striking the ground currently produces *nothing at all*, visual or
audio: `updateBullets` just deactivates it below `getGroundHeight`. Land versus
water is one comparison against `WATER_LEVEL` away, and a splash or a puff of
dirt is worth adding at the same time as the sound.

**Done when:** hitting an enemy at 800 m sounds different from hitting one at
100 m, and different again from hosing the sea.

### 1d. Missiles are silent in flight

`missileLaunch()` is a one-shot whoosh of about 1.5 s. After that the missile
crosses several kilometres in total silence, which is the single most noticeable
gap in the mix.

Attach a looping motor to each active missile in the pool: rocket noise plus a
low sustain, panned and attenuated from its position, pitch-shifted by closing
speed, cutting to a tail when the motor burns out. Tie the node's lifetime to
the existing pool entry so it is released with the missile. A missile passing
close should be loud and brief.

**Done when:** you can hear a missile go past you, and hear one chasing you from
behind.

### 1e. Enemy aircraft make no sound

Only the player's engine is audible. Enemies are silent, so a merge has no
audio. Give each entry in `enemies` a cheap engine voice — far fewer layers than
the player's, since it will usually be distant and heavily attenuated — with
distance culling so eight of them do not cost eight full engine stacks. The
pass-by Doppler from 1a is what makes this worth doing.

**Done when:** you hear an enemy before the radar warning, and a head-on pass
sounds like one.

### 1f. Mix and headroom

Master gain is a flat 0.45 with no limiting. Once 1a–1e are in, several dozen
voices can be live at once and it will clip. Add a `DynamicsCompressorNode` on
the master as a safety limiter, put the sound groups on submix buses (engines,
weapons, world, cockpit) so they can be balanced independently, and duck the
world bus briefly under explosions and gunfire.

Worth adding at the same time: a volume control and a mute key. There is
currently no way to turn the game down.

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
  `k * dt` exceeds 2, which one long frame is enough to trigger. Two instances
  were fixed with the `smoothT` helper; two more (in `smoothLookAt` and
  `updateMissiles`) are clamped with `Math.min(..., 1)`, which is safe from
  divergence but still frame-rate dependent. Use `smoothT` for anything new.
- There is no volume control, no mute, and no settings of any kind.
- **The HUD labels airspeed in knots but prints metres per second.** `drawHUD`
  uses `player.velocity.length()` directly for the `IAS` readout while deriving
  `MACH` from the same figure as `spd / 343` — which is correct for m/s, so the
  Mach number is right and the knots label is not. At full throttle it reads
  450 kt where it means roughly 875. Converting (`* 1.94384`) is the realistic
  fix and keeps Mach consistent, but it changes a number the player reads, so
  it is a deliberate call rather than a silent correction.
