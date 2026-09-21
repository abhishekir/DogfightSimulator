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
- **Use `smoothT(k, dt)` for smoothing, never `lerp(a, b, k * dt)`.** The latter
  is frame-rate dependent and diverges outright once `k * dt` exceeds 2, which a
  single long frame is enough to trigger.
- `USE_VOLUMETRIC_CLOUDS = false` swaps the raymarched cloud layer for the older
  billboard field, for machines where the march is too expensive.

## Verifying changes

There is one automated check. `node .github/smoke-test.mjs` loads the game in a
headless browser, starts it, and fails on an uncaught exception, a console
error (which is how a shader that will not compile shows up), a failed request
(which is how a dead CDN URL shows up), an overlay that never dismisses
(meaning the module did not run to the end), or a frame with too little
variance to be a rendered scene. It runs on every push and pull request. Offline,
set `SMOKE_VENDOR_DIR` to a local three.js package directory and
`SMOKE_PLAYWRIGHT` to a playwright install; in CI both are left unset, because
fetching the pinned CDN URLs for real is part of what is being tested.

It is a smoke test, not a test suite. It proves the game still starts and draws.
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
- For simulation changes use a soak harness — fixed timestep, many substeps per
  rendered frame, auto-restart on death, per-frame non-finite watchdog. It
  covers minutes of game time in minutes of wall clock and catches NaN, pool
  leaks and streaming stalls.

## Notes

- Line numbers drift; search by symbol name.
- No performance figure anywhere in this repo's history comes from real GPU
  hardware. They are all software-rasteriser numbers and do not predict GPU cost.
