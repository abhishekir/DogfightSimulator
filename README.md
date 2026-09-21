# Sky Strike

A fighter jet dogfight simulator that runs in a browser tab. One HTML file, no
build, no install — open it and you are airborne over an archipelago with
hostiles inbound.

The goal is a game that looks like a modern flight sim and plays like an arcade
one: **convincing enough to be worth looking at, immediate enough to be worth
playing.** Those two things pull against each other, and most decisions in this
codebase are a judgement about where the line sits.

---

## Play

Open `index.html` in any WebGL2 browser. Click to start.

| Input | Action |
|---|---|
| `W` / `S` | Throttle up / down |
| `↑` / `↓` | Pitch |
| `←` / `→` | Roll |
| `A` / `D` | Yaw |
| `Space` | Cannon |
| `F` (hold) | Acquire lock, then launch missile |
| `Esc` | Pause |

Survive waves of hostiles. Each wave is larger and flown better than the last —
count rises to ten, and enemy aggression, skill, speed and durability all scale
with the wave number. Clearing one restores 25 hull and refills the missile
rails; each kill returns two missiles. Missile lock takes 1.5 s inside a
forward cone and the seeker tone tightens as it converges.

---

## What this project is trying to be

### 1. It should look like a real aircraft over real terrain

Not photoreal — that is not available in a single file with no assets — but
**physically motivated**, so the eye accepts it. In practice that means
preferring a model with a reason behind it over a value that happened to look
fine in one screenshot:

- Ocean waves are Gerstner/trochoidal with deep-water dispersion, and whitecaps
  are driven by the wave Jacobian — foam appears where the surface actually
  compresses, not where a noise threshold says so.
- The sun's specular is normalised for a finite solar disc rather than a point,
  which is what stops a calm sea turning into a white hole.
- Clouds are raymarched and lit by the sun, the sky dome *and* bounce off the
  sunlit sea, because a cloud lit only by the sun has a black underside — and
  the underside is the side you fly under all day.
- Aerial perspective is one shared model injected into every material, so sea,
  land, aircraft and cloud all recede into the same atmosphere.

The same standard applies to the aircraft. They are lofted surfaces — fuselage
cross-sections and aerofoil sections skinned into continuous skin — rather than
stacked primitives, and the parts are meant to read as **one object**: wing
roots pass through the fuselage, the canopy sits in a coaming with a spine
running aft, exhaust cans emerge from shrouds. A fighter that looks like a kit
of parts flying in formation is a bug here, not a style.

### 2. It should be satisfying to fly and to fight

The flight model is deliberately not a study sim. Throttle sets speed directly,
there is no fuel, no trim, no departure from controlled flight. What it *does*
owe the player:

- **Weight.** Control inputs build rates and decay; the aircraft does not snap
  to a new attitude. G is computed and shown, and a damaged aircraft responds
  more sluggishly.
- **Readability.** You should always know where the enemy is, whether you are
  being shot at, and how close the lock is. The radar, threat warning and lock
  tone exist for that.
- **Feedback.** Hits, kills, gunfire, damage and speed should be felt —
  screen shake, hit flash, FOV pulse with throttle, tracers that read at range.
- **Pace.** Waves ramp; the loop is engage, kill, breathe, repeat. Downtime is
  the enemy of the loop.

### 3. It should stay one file

No build step, no package manager, no binary assets. Every texture, noise field
and sound is generated procedurally at load. This is a hard constraint, not a
preference — it is why the whole thing can be opened, read, bisected and shared
as a single artefact.

---

## What is built

| System | State |
|---|---|
| Ocean | Gerstner waves, Jacobian whitecaps, sphere-light specular, planar reflections, shoreline surf |
| Atmosphere | Shared aerial perspective, altitude-varying sky, tuned sun glare |
| Terrain | Procedural archipelago, streamed in 1 km chunks, triplanar rock, baked sun visibility, canopy vegetation |
| Clouds | Raymarched cumulus deck at 1500–2500 m, shared coverage field driving ground shadows and sea reflections |
| Aircraft | Two lofted airframes — player twin-fin chined fighter, hostile tailless canard delta |
| Combat | Cannon, lock-on missiles, 8 concurrent hostiles, scaling waves, radar, threat warning |
| Audio | Procedural Web Audio — engine, wind, cannon, lock tone, explosions |

Audio is the weakest system by a distance and is the top item in `TODO.md`.

---

## Reviewing this project

If you are reviewing a change here — human or agent — this is what matters, in
roughly this order.

### Does it break the illusion?

Rendering bugs in this project have almost never been crashes. They have been
things that quietly say "computer graphics": aliasing that flickers as you
move, banding across a gradient, a seam where two surfaces meet, a shape that
is subtly axis-aligned, a sky that washes to flat grey at altitude, a cloud
that reads as a cotton ball or a flat-topped slab. **Look at the output, not
just the diff.** A change that compiles and reads correctly can still be wrong
in a way only a screenshot reveals.

### Is the value justified, or did someone guess?

Numeric constants in shaders are where this codebase has wasted the most time.
The standard is: if a knob controls something measurable — cloud coverage,
wave amplitude, density, a threshold — it should have been measured, not
eyeballed. Porting the function to a CPU script and sampling its distribution
takes a minute and settles arguments that screenshots cannot.

### Physically motivated, or a fudge that happens to look right?

A fudge is acceptable when it is labelled as one and the reason is given. What
is not acceptable is a magic multiplier with no comment, because the next
person cannot tell whether it is load-bearing.

### Correctness traps this codebase has actually hit

These are real defects that shipped here, and they are worth checking for
specifically:

- **Shared mutable state across entities.** A glow material written each frame
  from the player's throttle was also assigned to every enemy — so all of them
  pulsed in time with the player's engine. Materials, geometries and vectors
  that look like constants are often shared.
- **Frame-rate dependence.** `lerp(a, b, k * dt)` is not frame-rate
  independent, and diverges outright once `k * dt` exceeds 2 — which one slow
  frame is enough to trigger. Use `smoothT(k, dt)`.
- **Resolution and pixel ratio.** Post-process buffers, FXAA's resolution
  uniform and any screen-space LOD term all have to agree, at startup *and*
  after a resize, at every device pixel ratio. One of these was silently
  squared on HiDPI displays and self-corrected on the first resize.
- **Implicit derivatives inside a loop.** Sampling a texture with implicit LOD
  from a raymarch loop variable gives a meaningless mip level that jumps
  between quads. Use `textureLod`.
- **Geometry that is open where it should be closed.** Lofted surfaces are
  tubes; an uncapped end is a hole straight through the model under back-face
  culling.

### Performance claims

Be sceptical of any performance number in this repository. **None of them come
from real GPU hardware** — they are all software-rasteriser measurements, which
do not predict GPU cost for ALU-heavy work like the cloud raymarch. A change
justified on performance grounds should say how it was measured.

### Scope

Does the change respect the single-file constraint? Does it add a second
atmosphere model, a second cloud field, a second particle pool, where one
already exists? Duplicated systems drift apart and the scene stops agreeing
with itself.

---

## Where to go next

- **`CLAUDE.md`** — constraints, invariants that are easy to break by accident,
  and how to verify a change without a test suite.
- **`TODO.md`** — the roadmap: audio, wingtip vortices, battle damage, a
  cockpit view, time of day. Each entry says what already exists, what is
  actually missing, and what done looks like.

Built with [Three.js](https://threejs.org) r163.
