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
- For simulation changes, `.github/tools/soak.mjs`: a bot flies the game at a
  fixed timestep (lead pursuit, guns and missiles, forced crashes, random
  pauses) with a watchdog after every step, and catches NaN, pool and voice
  leaks, audio out of step with the game, and exceptions on rare paths. Ten
  game-minutes take about a minute.
- For anything a player touches, `.github/tools/ui-test.mjs`, which plays
  through the real overlays and keys in real time.
- For audio, `.github/tools/audio-check.mjs`: it renders the SoundEngine
  offline, each bus soloed, measured A-weighted, and checks the mix and the
  regressions listed in it. Ears and headphones differ; its numbers do not.
  `--render` writes WAVs to listen to as well.

See CLAUDE.md for how to run them.

---

## Tasks

### 1. Missile count, resupply and dumb-fire are invisible — P1

The rack holds 12 (`MAX_MISSILE_AMMO`). The HUD shows them as `MSL:` followed
by one bar per missile, in 11 px type at the foot of the flight-data panel: no
number, no maximum, and nothing happens when it reaches zero. Holding F with an
empty rack does nothing at all, with no tone and no message.

Resupply exists, but nothing tells the player about it. Each kill adds 2, up
to 12 (`killEnemy`), and clearing a wave refills the rack along with 25 hull,
which only the wave-cleared banner mentions. The start and pause screens say
"F (hold) — Lock & Fire Missile" and nothing more.

Worse, holding F with no enemy in the seeker cone (within about 32° of the nose
and 1,500 m: `LOCK_CONE`, 0.85) fires an unguided missile every half second, and
nothing on the HUD says so. That is the "dumb-fire" branch of the lock-on code
in `updatePlayer`. Measured headless: holding F with nothing locked, 11 of the
12 missiles were gone in 6 seconds. A player holding F while manoeuvring for a
shot empties the rack, which is probably where a new player's missiles go.

What to do:

- Show the count as a number against the maximum (`MSL 7/12`), somewhere the
  eye goes in a fight (beside the reticle or the lock diamond), not only in
  the corner panel.
- Announce an empty rack with a HUD flag and a short tone, and do the same when
  F is pressed with none left.
- Add "+2 MSL" to each kill notification (`addKillNotification`).
- Put one line on the start and pause screens: 12 missiles, 2 more per kill,
  full reload when a wave is cleared.
- Stop a held key from dumb-firing. Either fire only on a lock, or make an
  unguided shot a deliberate fresh press with nothing locked. While F is held,
  show the seeker's state: searching, locking, locked, or target out of range.

**Done when:** a player who has not read the source can say how many missiles
they have, how many they started with and how to get more, and never fires one
they did not mean to.

### 2. The gunsight is off the gun line and shows no lead — P1

The reticle is a fixed circle at the centre of the screen, but the guns do not
point there. In steady flight the chase camera trails about 12 m above and 78 m
behind the jet, looking slightly down. Measured headless at 960×540 in level
flight, the gun line passes 22 px above the centre of the screen at 200 m, 30 px
at 500 m and 35 px at 1,200 m (3.3° to 5.3°). A round hits if it passes within
14 m of the enemy's centre, so an enemy held in the middle of the reticle is
missed beyond about 250 m; at 500 m the rounds pass 40 m above it. The offset
also changes with speed and turn rate, because the camera lags the jet.

The reticle turns red whenever the nearest enemy is within 18° of the nose
(`isEnemyInCrosshair`, a dot product above 0.95), at any range and however it
is moving, so red does not mean "shoot". Nothing shows lead either. Rounds
leave along the nose at the aircraft's speed plus 650 m/s and fly straight for
2.5 s, so a crossing target has to be led by its velocity times the time of
flight, and the player has to guess by how much. The enemies already compute a
lead when they shoot at the player (`updateEnemies`).

What to do:

- Draw the gun cross by projecting a point on the gun line through the camera,
  at the target's range (or a fixed range when there is no target), instead of
  drawing it at the centre of the screen.
- Add a lead pipper: solve the time of flight to the nearest or locked target
  at its current velocity, and project where it will be.
- Replace the 18° red cue with one that means the pipper is on the target, that
  is, within the hit radius at that range.

**Done when:** holding the pipper on a target flying straight at constant speed
hits it at every range from 200 to 1,000 m, checked by a script that does
exactly that, and the gun cross stays on the gun line through turns.

### 3. Roll response is sluggish — P1

Roll is a rate. A held key adds 6.5 rad/s² to it while it decays by 7% a frame
(`updatePlayer`). Porting that update to a script gives a steady roll rate of
82°/s, reaching 63% of it after 0.23 s, and 1.3 s from wings level to 90° of
bank. Pitch peaks at 60°/s and yaw at 33°/s the same way. Tracking a crossing
target with the guns means rolling to put it above the canopy and then pulling,
so a slow roll makes every gun solution late.

The update is also frame-rate dependent: the steady rate is 82°/s at 60 fps and
about 80°/s at 30 fps.

What to do: raise the roll rate and shorten its onset. Tune by measurement first
(port the update to a script, as above), then by play; 180–270°/s, reached
within about 0.2 s, is a reasonable place to start. Write the rate as an
approach to a target rate using `smoothT`, so it no longer depends on frame
rate. Consider scaling it with airspeed, so the jet rolls more slowly when slow.
Task 15, the 30+ G question, is the same knob on the pitch axis; decide the two
together.

**Done when:** a 90° bank takes about half a second from wings level at combat
speed, the response is the same at 30 and 60 fps, and a playtest no longer
finds the roll sluggish.

### 4. Aim assist for the gun — P2

Do this after task 2: the assist needs the same lead solution the pipper shows.
Even with a correct pipper, holding it on a manoeuvring target with keyboard
controls is hard. The options, in order of how much control they take from the
player:

- **Round assist.** Rounds fired with the pipper within a degree or two of the
  target bend toward the lead point. The controls are untouched, so it never
  fights the player.
- **Hit tolerance.** The 14 m hit radius grows with range, so the same angular
  error counts at 1,000 m as at 300 m.
- **Steering assist.** The nose is pulled gently toward the lead point while
  the trigger is held and the pipper is close. It is the strongest option and
  the one most likely to feel like losing control.

Start with round assist. Make its strength one constant (a setting later, task
16) and set it by measurement. Give the soak bot human-sized aim error, a couple
of degrees of noise and a reaction delay, and compare its time to a gun kill
with and without the assist.

**Done when:** a player who keeps the pipper roughly on a wave-1 enemy gets a
gun kill, and the bot with human-sized aim error kills measurably faster with
the assist than without it.

### 5. GPU cost is unmeasured — P2 (needs real hardware)

Every performance figure in the commit history comes from a software
rasteriser, which does not predict GPU cost for an ALU-heavy raymarch. The
volumetric cloud pass measured around 6% of frame time under SwiftShader; what
it costs on real hardware is unknown. If it is heavy, `USE_VOLUMETRIC_CLOUDS =
false` is the fallback. This cannot be done in a headless container.

**Done when:** frame time, and the share of it per pass, is recorded on at least
one integrated and one discrete GPU, and a default for `USE_VOLUMETRIC_CLOUDS`
is chosen from it.

### 6. Enemy aircraft make no sound — P2

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

### 7. Hits and enemy gunfire make no physical sound — P2

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

### 8. Enemy damage you can read at range — P2

An enemy carries no visible damage state: you cannot tell one that is about to
die from a fresh one. Smoke from a damaged enemy, thickening as HP falls, would
make a wounded bandit identifiable at range. The player's single 20 HP
threshold for tail flame should become graded at the same time. The smoke is a
continuous emitter: see "Reference: the particle pool" for how to tag it.

**Done when:** at 1 km you can tell a nearly dead enemy from a fresh one.

### 9. Enemies leave no contrails — P2

`updateContrails` draws one contrail, the player's, from the fuselage origin.
At altitude a contrail is how you spot a bandit before the radar does, so
giving enemies contrails is a gameplay benefit as much as a visual one. Vary
persistence with altitude rather than the hard 300 m cut while doing it.

**Done when:** an enemy above 3,000 m is visible by its contrail before it is
visible as an aircraft.

### 10. Cockpit view — P3

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

### 11. Battle damage on the airframe — P3

Beyond task 8's smoke, both the player and enemies go from pristine to
exploding with nothing in between.

- **Surface damage.** Scorch and soot around hit locations. The airframe
  materials already carry procedurally generated panel normal and roughness maps
  and the lofts carry arc-length UVs, so a damage mask blended into those maps
  fits naturally and needs no new texture assets.
- **Structural loss.** Pieces departing on heavy hits — the debris pool already
  exists — and a flame from an engine that has been killed.

Reuse the particle pool rather than adding another (see "Reference: the
particle pool").

### 12. Time of day — P3

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

### 13. Wingtip vortices and contrail polish — P3

**Wingtip vapour** exists in `updatePlayer` under `// Wing vapor`: above 3 G it
spawns pale smoke particles at both wingtips. It is a puff emitter, not a
vortex. Remaining (enemy contrails are task 9):

- Emit contrails from each wingtip rather than the centreline, so a roll
  visibly twists the pair.
- Make the vapour read as a vortex — a ribbon or tapered core with a lifetime —
  and scale it with G rather than switching on at 3.
- The wingtip positions are hardcoded as `±12 * 1.8` (semi-span times model
  scale). Derive them from the wing stations so they survive the next airframe
  change.

### 14. More aircraft: sixth-generation designs — P3

Do this last of the large features, once the gameplay and graphics tasks above
are settled.

There are two airframes, both built in code by lofting cross-sections and wing
stations (`loftFuselage`, `createPlayerJet`, `createEnemyJet`): the player's
twin-engine, twin-fin jet, and the enemy's single-engine tailless delta with
canards, which is deliberately a different shape so the two read apart as
silhouettes. Nothing about an aircraft is a parameter. The handling constants
live in `updatePlayer` and the `player` object, and the airframe's geometry is
repeated as numbers through the code:

- exhaust points at `±.7*1.8, 13*1.8`
- wingtips at `±12*1.8`
- muzzles at `(±2.5, -.6, -14)`
- missile rails at `(±5, -1.7, -1)`
- two nozzles and two afterburner cones, reached through `userData`
- a camera offset (`camOff`) tuned for this airframe's 47 m length

So start with an aircraft definition holding the geometry builder, the hard
points (nozzles, muzzles, rails, wingtips), the handling and the engine count.
Move the current player jet onto it with no visible change, proved by a
pixel-identical render, before adding anything. Then add the new types, and an
aircraft choice on the start screen (with task 16).

The two designs wanted are sixth-generation, and both are largely unknown in
public, so treat the shapes as interpretations, not replicas:

- **Chengdu J-36** (an unofficial name). A large tailless aircraft with a
  diamond or double-delta planform and three engines: two in the fuselage and,
  by most accounts, a third fed by a dorsal intake. It first flew in public in
  December 2024
  ([MiGFlug](https://migflug.com/jetflights/chengdu-j-36-tailless-stealth-fighter-three-engines/)).
  Three nozzles means three exhaust emitters and three afterburner cones.
- **Boeing F-47.** The US Air Force's NGAD winner, announced in March 2025, with
  a first flight targeted for 2028
  ([Wikipedia](https://en.wikipedia.org/wiki/Boeing_F-47),
  [TWZ](https://www.twz.com/air/first-f-47-6th-generation-fighter-now-being-built)).
  Only official concept art has been shown. It has canards, and commentators
  doubt it shows the real aircraft
  ([TWZ](https://www.twz.com/air/what-the-f-47s-canards-say-about-the-rest-of-its-design)).

The enemy is already a tailless canard delta, close to the F-47 art, so keep
the player's and the enemies' silhouettes distinct whichever way the new types
are assigned.

**Done when:** the player can choose between at least three aircraft, each with
its own silhouette and handling, and the soak, the UI test and the smoke test
pass with each.

### 15. The flight model allows 30+ G — P4 (decision)

The HUD's G readout regularly shows 30–37 G in hard turns: steady pitch rate
reaches about 1.15 rad/s, which at 300 m/s is about 35 G. That is the arcade
handling working as built, not a bug, but it sits oddly next to realistic
airspeed, cannon and missile cues. Decide whether to cap turn rate by speed (a
real fighter manages about 9 G) or to leave it and stop showing the number.
Decide it together with task 3: it is the same knob, on the pitch axis.

### 16. Settings screen — P4

There is none. Volume and mute are keys only (`-`/`+`, `M`). Graphics options
(`USE_VOLUMETRIC_CLOUDS`, pixel ratio) are constants in the source.

### 17. Cloud and water quality — P4

- The cloud march is half resolution (`CLOUD_SCALE = 0.5`) and resolved with a
  four-tap rotated-grid blur. Temporal reprojection would do better if anyone
  wants to spend the complexity.
- Water reflections are a half-resolution planar pass and only cover what the
  mirrored camera can see; everything off-screen falls back to the analytic sky
  plus the analytic cloud tint. Look for the seam at grazing angles.

### 18. Small things to keep in mind — P4

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
cockpit tones stay dry. Measured: a source 90° left is about 4 dB louder in the
left channel (HRTF, not hard panning); onsets land within about 12 ms of
`d / 343`; a blast at 2 km is about 14 dB below one at 100 m over its first
half second. The direct sound alone is about 22 dB down; the terrain echo falls
off more slowly, so a distant blast is mostly echo.

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

---

## Reference: the particle pool

`spawnP(emitter, ...)` takes from a fixed pool of `MAX_PARTICLES` (600). Every
request names an entry in `emitters`, which counts what it requested, what was
dropped and how many of its particles were evicted. The soak prints that table
and fails if any emitter not flagged as a trail is refused a particle.

- **Trail emitters** (only `missileTrail`) are capped at `MAX_TRAIL_PARTICLES`
  (360) and may not take the last `PARTICLE_EFFECT_RESERVE` (160) free entries.
  Missile trails drop 6–9% of their requests in a 15-minute soak, by design.
- **Every other emitter** takes from the whole pool, and if it finds the pool
  empty it evicts the most faded trail particle (lowest `life / maxLife`)
  rather than being dropped. It can still be dropped if the pool is full and
  holds no trail particle, which no soak has produced.

Why it is built this way, measured with two 15-minute soaks per variant. Before
eviction the pool's lowest free count was 6 and 16, and one run lost 49
explosion particles over three kills, 14–20 of each kill's 84–108. At each loss
the pool held 243–298 missile-trail particles, 142–215 cannon hit sparks, 69–80
from the previous explosion, and 56–95 from the continuous emitters not flagged
as trails. The reserve could not help: hit sparks are one-off effects and use it
up legitimately. With eviction (four soaks) nothing outside the trails was
dropped, though the pool still ran as low as 2 free; the trails gave up 41–69
particles per 15 minutes to eviction.

Flagging exhaust, wing vapour, muzzle flash, damage smoke and debris smoke as
trails as well was measured too, and rejected. They share the trail cap with
the missile trails and run earlier in each frame, and missile-trail drops
doubled to 13–18%. They also began dropping 0.2–2.5% of their own requests.
That bought nothing, since eviction alone already stopped every one-off drop.
A new continuous emitter (enemy damage smoke, task 8) can hold dozens of
particles per aircraft, so tag it as a trail: untagged, it cannot be evicted
and can starve explosions. The soak's table will show which way it went.

`MAX_PARTICLES` is unchanged: eviction made raising it unnecessary, and what the
particle batches cost on a GPU is unmeasured (task 5).
