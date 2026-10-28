# CLAUDE.md

Sky Strike — a browser flight-combat game. **`TODO.md` has the roadmap and the
detail behind everything below; read it before starting work.**

## Hard constraints

- **The whole game is `index.html`.** No build step, no package manager, no test
  suite, no assets. Open the file in a browser and it runs. Keep it that way: if
  you need a texture or a sound, generate it procedurally at load, as
  `createPanelMaps`, `createCloudNoise3D` and `class SoundEngine` already do.
- **Line endings are LF**, declared in `.gitattributes` (`* text=auto eol=lf`)
  so git enforces it rather than it depending on whichever tool last wrote the
  file. Do not convert anything by hand. The repo was briefly a mix of LF and
  CRLF, which turned one routine change into a whole-file diff and made it
  unreviewable; if you ever see `git diff --stat` report an insertion count
  equal to the file's line count, that is what has happened.

- **Three.js r163**, via import map from jsDelivr. WebGL2 only, so shaders are
  GLSL ES 3.00.

## Invariants that are easy to break

- **One atmosphere model, shared by everything.** `ShaderChunk` fog hooks are
  overridden globally and `THREE.Material.prototype.onBeforeCompile` injects the
  shared uniforms, so terrain, water, aircraft and clouds all use one aerial
  perspective. Do not add a second.
- **One cloud coverage field, shared by three systems.** `cloudCoverAt` (in
  `CLOUD_SHADOW_GLSL`) is read by the volumetric march, by the ground and sea
  shadow term, and by the water's analytic cloud reflection. Changing it changes
  all three together — that is what keeps a cloud, its shadow and its reflection
  describing the same cloud.
- **Transparent effects go on the effects layer.** The cloud march stops at the
  depth buffer, so anything drawn with `depthWrite: false` — smoke, fire,
  exhaust, trails, tree billboards — is invisible to it, and left on layer 0 it
  gets cloud composited over it however near it is. Put the object on
  `FX_LAYER` with `asEffect()` and dim its material by the cloud in front of it
  with `fxCloudFront()` (`fxCloudAware()` does that for built-in additive
  materials); `EffectsPass` then draws it after the clouds.
- **Use `smoothT(k, dt)` for smoothing, never `lerp(a, b, k * dt)`.** The latter
  is frame-rate dependent and diverges outright once `k * dt` exceeds 2, which a
  single long frame is enough to trigger.
- `USE_VOLUMETRIC_CLOUDS = false` swaps the raymarched cloud layer for the older
  billboard field, for machines where the march is too expensive.

## Verifying changes

There is one automated check. `node .github/smoke-test.mjs` loads the game in a
headless browser, starts it, and fails on an uncaught exception, a console
error (which is how a shader that will not compile shows up), a WebGL error
(which Chrome logs as a warning, and which is how a draw call the GPU refused
shows up — a feedback loop, say), a failed request (which is how a dead CDN URL
shows up), an overlay that never dismisses (meaning the module did not run to
the end), or a frame too flat or too dark to be the rendered world. It runs on
every push and pull request. Offline, set `SMOKE_VENDOR_DIR` to a local three.js
package directory and `SMOKE_PLAYWRIGHT` to a playwright install; in CI both are
left unset, because fetching the pinned CDN URLs for real is part of what is
being tested.

It is a smoke test, not a test suite. It proves the game still starts and draws.
Three more tools in `.github/tools/` go further. They run locally, not in CI,
take the same two environment variables, and exit non-zero on failure; each
takes `--page <file>` to test another copy of the game, which is how a
before/after comparison is done.

- `soak.mjs [--minutes 10] [--screens]` — a bot flies the game at a fixed
  timestep (lead pursuit, guns, missiles, forced crashes, random pauses) with a
  watchdog after every step: non-finite values, pool and voice leaks, audio out
  of step with the trigger, page errors. Ten game-minutes take about a minute.
  It also reports how close the particle pool came to empty.
- `ui-test.mjs` — plays through the real UI in real time: overlays, keys,
  pause, focus loss, crash, game over, restart, settings across a reload.
- `audio-check.mjs [--render]` — renders the SoundEngine offline and checks the
  mix against the engine, positional audio, Doppler, the limiter, volume, and
  regressions the audio has actually had. `--render` writes WAVs to listen to.

Everything below is still on you.

- Drive it headless: Chromium with `--use-angle=swiftshader`, a generated copy
  of `index.html` with the spawn point and camera overridden, screenshot after a
  fixed settle time. Slow but deterministic, and it surfaces shader compile
  errors.
- For any numeric knob — coverage, density, wave amplitude — port the function
  to a CPU script and measure before touching the shader. Guessing at these has
  cost more time than measuring ever has.
- Change one variable per render. An artefact that looks obvious usually is not;
  run the isolation test before the fix, not after the third one fails.
- For simulation changes run `soak.mjs`; for anything a player touches,
  `ui-test.mjs`; for any sound, `audio-check.mjs`, and listen to its renders.
  Set audio levels by measurement, not by ear on one pair of headphones.

## Notes

- Line numbers drift; search by symbol name.
- No performance figure anywhere in this repo's history comes from real GPU
  hardware. They are all software-rasteriser numbers and do not predict GPU cost.
