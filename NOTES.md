# Notes: decisions and measurements

Newest first within each milestone. Numbers are from the dev machine unless stated
(Apple M4 Pro, macOS 26.6) — the PRD's reference machine is an M1 MacBook Air.

## Tessellations: the bestiary, animal tiles as data (2026-10-23)

**Creatures** (Metamorphosis param: `abstract` default, `all`, `fish`, `birds`, `reptiles`,
`mammals`; the harness also takes `p.creatures=<group>/<name>`) prints recognisable animal tiles
instead of the warp's abstract creatures, with the same print look, palettes, rings and music.
Species are data (`plugins/builtin/tiles/<group>/<name>.json`, authoring guide in its README),
checked and previewed by `uv run python -m tools.tiles`.

- **Tiles are Heesch types with the relations built in**: TTTTTT (p1), TGTG (pg), C4 (p4), C3
  (p3). Only the free edges are data, in each edge's chord frame (`smooth` Catmull–Rom, `bezier`
  or `polyline`); derived edges are isometric images, so any simple outline tiles. Editable corners:
  TTTTTT V1–V3, TGTG w/h/shear, C3 V1, C4 none. `lib/bestiary.js` derives, blends (corners and
  chord points linearly, no allocation) and locates; `tools/tiles/geometry.py` mirrors it, and
  `tests/fixtures/tiles_golden.json` (the seeds, plus the koi/halibut blend) pins both to the
  same points (vitest and pytest).
- **A blend of valid tiles is a tile of the type, but not necessarily a simple one** (the brief
  assumed it always was). So `check` also tests compatible pairs at 25/50/75 %, and each species
  against its plain tile (the type-change path); a deliberately crossing pair fails in pytest.
- **Colourings** (tested across every outline segment, wavy tiles included): TTTTTT (i + 2j) mod 3
  over lattice steps (neighbours ±a, ±b, ±(a − b)); TGTG (copy + i) mod 2; C4 the quarter turn's
  parity; C3 the third turn. The print state runs as p3 in atlas mode so all three class colours
  exist; `accent` art takes the first palette slot no class uses, cycling with the shift.
- **The atlas pass** (`shaders/tess/atlas-bake.frag`, `lib/atlas-gl.js`) bakes one period cell
  (lattice coordinates, REPEAT) into two RGBA16F textures: outline distance and inward normal,
  height hint; art edge distance and normal; packed copy, cell offset and role. A texel finds its
  tile by testing the copies over the lattice steps their boxes can reach (computed per shape).
  Its outline distance is to its own tile's outline only, since inside a tiling that is the
  nearest edge. The art composites in painter's order, keeping the distance to the nearest
  visible role edge. It bakes only when the tile changes: 256² while a morph re-bakes every frame,
  then 512² with mips once settled. Outline and art come from a data texture (the art library
  packed once at load, the outline in row 0, re-uploaded per change).
- **Print side** (`shaders/tess/atlas.glsl`): `textureGrad` with analytic lattice derivatives
  (seamless across the cell, mip-filtered when small). Outline and art edges are antialiased from
  distances in target px (`S`, `pxq`), so they stay crisp at any zoom; the art role across an
  edge is fetched one step past it. Then `tessPrint` as before: gouges follow each animal's
  contour, figure/ground classes, `TESS_RING`/`TESS_CLASS`. **Engine change (minimal):**
  `tess.glsl` has three `#ifdef TESS_ATLAS` hooks (a declaration, the art call in `tessPrint`, the
  `u_tMotif` branch in `tessShade`). `tess-gl.js` splices `atlas.glsl` only for surfaces that
  define TESS_ATLAS, and points its samplers at units 1–2: left on unit 0 they alias the print
  target and WebGL refuses every draw (a black print). With `abstract`, all six visualizers'
  `--shots` stills (still=150, black and light) are byte-identical to b1700b2. Other surfaces opt
  in with the define plus `createAtlas` (see Metamorphosis).
- **Morphing** (`lib/atlas.js` createCreatures): on tess-music's morph steps, held for
  1 + ⌊(1 − Morph)·4⌋ steps (Morph 0 holds). Compatible species blend over 1.2 s (×4 Reduce
  motion). The leaving species' art erodes (signed distance + w·0.12) while the arriving one's
  grows in. About every third change switches tile type: species → plain tile → swap → plain tile
  → species over 2.4 s, the print dipping to its mean at the swap (the lattices differ). The view
  offset wraps every 6 cells of the atlas lattice (where all colourings repeat). Atlas zoom is
  1.8 against 2.3, so the animals read larger.
- **Registration is a directory scan**: one generated `index.json` per group (`tools.tiles
  index`, checked current), with the group folders as the manifest's fixed options, so the four
  group designers never edit a shared file.
- **Seeds** (original outlines): koi and halibut (TGTG, a morph pair), Arctic tern (TTTTTT: a
  translation tiling forces a notched tail, so a tern rather than a gull), sea turtle (C4) and a
  mirror-symmetric bat (C3). The bat is the weakest silhouette: a C3 tile has 120° corners at
  its 3-fold points, so the wingtips there can't be sharp. A slim dolphin and a hedgehog were
  tried first and read as blobs in the regular hexagon frame.
- **Reptiles** (7 new, none in C3): crocodile, gharial and monitor (TGTG, one morph set: V0 is
  the tail tip, so each snout rests on the tail ahead), tortoise and softshell (C4 on the sea
  turtle's edges, morphing with it), horned lizard (C4, polyline for its spikes) and chameleon
  (TTTTTT in profile; legs on the side edges so the back stays an arched hump). In TGTG and
  TTTTTT, legs on the belly dent the back, so the walking gait and the corners place them. An
  iguana (TTTTTT, chameleon's edges) read as a bat: its long tail notched the shoulder. Dropped.
- **Cost** (WebKit harness, 2560×1440, Quality high, `sync=1`; GPU shared with other agents):
  one species static p50 2–3 ms; `all` with morphs (bakes on the music) p50 9 ms, p99 13–14 ms,
  58.8 fps. Three renders per vsync still hold 58.8 fps: 2–5 ms per frame, bakes included.
  Abstract in the same session: p50 7–13 ms. Untested on the M1.

## Tessellations: Poincaré Disk, the hyperbolic surface (2026-10-22)

**Poincaré Disk** (`poincare-disk`, webgl2) prints interlocking creatures tiling the hyperbolic
plane in the Poincaré disk. The tiles shrink towards the rim forever. It uses the engine's print look, palettes and music state
on a {7,3}, {5,4}, {4,5} or {6,4} tiling (`src/lib/tess-disk.js`, `shaders/tess/disk.frag`).

- **The tiles are kites, not p-gons.** A p-gon of {p,q} has p-fold symmetry, so it can only
  deform into a rosette. The kite O, M, V, M′ (the fundamental triangle and its mirror across
  O–V) is a fundamental domain of the rotation group, as the engine's p4 half-squares are for
  (2,4,4). So an asymmetric creature (eye, spine, fins) repeats in every kite, turning with it.
  uv: O, M, V, M′ → (0,0), (1,0), (1,1), (0,1), as the engine's p4 tile.
- **The warp, and why it still tiles:** every point of the fundamental triangle lies in the
  diamond round its edge midpoint M. That is four triangles, one corner of each of the four
  kites meeting there. In a square chart of the diamond (M to 0, Klein, scaled) the kite edges are the
  diagonals. The field `W Σ A sin(nπ(s+1)/2) sin(mπ(t+1)/2)` with n + m odd is odd under
  the half-turn about M, which is the diamond's only rotation. So the warp commutes with the
  whole rotation group, and every kite stays congruent. W = cos²cos² makes the field and its
  slope vanish on the diamond's rim (the O–V lines run through the middle of the kites), so it
  is smooth there. Each step is fitted under a Lipschitz bound of 0.85 (per-mode slope max π or
  2π, checked on a grid), and 4 steps are composed, as in the engine. The tests check
  congruence under random rotations of the tiling, with and without the warp.
- **Colouring:** the fold reads its word of mirrors back to front, so a colour can't be
  carried along. The shader tracks the word in a finite quotient of the triangle group:
  2×2 matrices mod r (PGL(2, r): {7,3} r = 7, {5,4} and {4,5} r = 5, {6,4} r = 7), one integer
  matrix product per fold step. It then reads one texel of an r² × r² table holding the classes
  of the four kites round M. The table comes from a DSATUR 3-colouring of the quotient's kite
  graph (168, 120, 120 and 336 kites), evened out. Edge neighbours differ by ρ±1 or τ±1, never
  trivial in the quotient, so the colouring is proper in the whole plane. Tested in the group
  and across bisected edges in the plane. 3 classes is what the engine's u_tCls holds;
  {7,3} needs at least 3 (a vertex has 3 kites round it), and its 3 are exactly balanced (56 each).
- **View:** drifts `DISK_DRIFT` 0.12 hyperbolic units per unit of glide travel (bass plus the
  eased beat surge), along a slowly wandering flow. A drag carries the plane with the pointer
  and eases the flow round to the drag's direction (τ 0.35 s). Rebased every frame, but **not
  with `createDrift`**: its rebase can apply a mirror (which would flip the creatures), and its
  matrix degrades until T(0) leaves the disk after about 6,000 frames at this speed. That is a
  latent bug for Tentacube too (not fixed here). The view rebases by rotations only, re-projects
  T to translate ∘ rotate each frame, and records the quotient element of each rebase (`e0`, the
  fold's starting matrix) so the colours on screen don't change.
- **Rings and rim:** a tile's ring is its hyperbolic distance from the screen centre (the
  centre's image is folded alongside), reaching 1 where kites are 3 px. Fronts and spectrum
  rings spread from the centre to the rim. A tile size from the disk metric at the pixel (smooth across a kite)
  drives the print's fades (`tessPrint` takes it): the true per-pixel size varies 0.45–3.6×
  across a kite. Kites under ~1 px print as ink (no fold there), then the edge is antialiased
  into paper.
- **Engine changes (backward-compatible):** `tessShade`'s body is now `tessPrint(t, tf, pxq,
  tileSize, dpx, m, q)`, and `tessShade` keeps its signature (Metamorphosis stills, p4 and
  p3/watercolour, byte-identical before and after). The tess state exposes `morphW` and `theta`.
- **Cost:** WebKit harness, 2560×1440, Quality high, `sync=1`: one frame per vsync 62.5 fps,
  p50 12–15 ms, p99 22–24 ms. 10 frames per vsync: 11.7 ms per frame (medium: 4.1 ms). CPU
  < 0.1 ms. The GPU was shared with other agents (Metamorphosis measured p50 9–22 ms in the same
  runs, against 6–8 ms in its own notes), so these numbers are noisy.

## Tiled Torus: the tiling on a torus, outside and inside (2026-10-22)

**Tiled Torus** (`tiled-torus`, webgl2) wraps the tessellation engine's tiling around a torus
(ring radius 1, tube radius = Thickness), seen tumbling over paper (`outside`), flown through
along the tube's centre circle (`inside`, fog down the tube), or both (`auto`). It is a surface
on the seam above (`shaders/tess/torus.frag`, `src/lib/torus.js`); the engine is unchanged.

- **Mapping:** conformal coordinates, x = lx (θ/2π + fu), y = ly (t(φ) + fv) with
  t(φ) = (1/π) atan(√((1−k)/(1+k)) tan(φ/2)) (atan2 form, continuous on (−π, π]). Tiles are
  squares everywhere (bigger on the outer equator, (1+k)/(1−k) times the inner ones), not just
  near-square. lx = nu, ly = nv (p4) or nv √3 (p3, the rectangular sublattice (1, 0), (0, √3)):
  nu, nv multiples of BLEND_PERIOD, chosen so ly / lx is within 15 % of the conformal ratio
  k / √(1 − k²) with nu near 30. The tests check the warp field and tile classes repeat after lx
  and ly for both groups, so both symmetries are supported.
- **S is analytic:** the ray differential on the hit's tangent plane times the analytic
  gradients of θ and t, so outlines don't break at θ = ±π, φ = ±π (WebKit seam close-up checked)
  or the silhouette; screen derivatives would need wrapping at both seams and fail at the edge.
- **Render:** sphere tracing the exact torus SDF (64/80/96 steps by Quality), from the bounding
  sphere outside; inside, a ray that grazes the curving wall and runs out of steps takes where
  it got to (falling back to the fog colour drew a bright crescent). Outside, the silhouette is
  inked from the closest miss in px.
- **Camera:** one azimuth shared by the orbit and the fly path, so a dive goes straight in where
  the camera is and comes out where it has flown to. The dive lerps the position over 6 s
  (smoothstep; reduce motion 12 s) and turns the heading down the tube only after 40 % of it, so
  the torus stays in view while the camera closes in; crossing the wall dissolves through paper
  (fade 1 on the wall, 0 at 0.6 tube radii). Auto dives on phrase changes (every 8 bar steps of
  tess-music, ≥ 20 s since the last change), or after 60 s without one. Drag orbits outside and
  turns the look inside; it eases back over 1.6 s (smoothstep) after release.
- **Music:** all motion is the state's glide travel (bass + the eased beat surge): orbit 0.04
  rad, fly 0.2 rad, tile flow 0.004 / 0.006 turns along / around the tube, per unit of travel.
  TESS_RING runs along the ring, 0 at the camera's azimuth to 1 half a turn away both ways, so
  figure/ground fronts and the spectrum rings travel around the torus from the viewer.
- **Cost** (WebKit harness, 2560×1440, Quality high, `sync=1`, GPU shared with other agents:
  Metamorphosis measured 8 / 13 ms p50 / p99 at the same time, against 6–8 / 7–11 above):
  outside p50 5 ms, p99 9–10 ms (p3 the same); inside p50 12 ms, p99 17 ms (full-screen tiles
  plus the march), 58.8 fps for both. Two renders per vsync inside still hold 58.8 fps (7.5 ms
  each); three drop to 18.5 fps. CPU < 0.1 ms. Flash check: 0 flashes/s at 2 % and 5 %, reduce
  flashing on and off. Untested on the M1 reference machine; Quality medium brings an
  inside render to about 5 ms (from 7.5).

## Tessellations: Tiled Sphere (2026-10-22)

**Tiled Sphere** (`tiled-sphere`, webgl2) wraps the woodcut tiling round a sphere, seen from
outside (it floats and turns on the paper, a soft limb shade and shadow) or from inside (a tiled
dome all round); in `auto` the camera pushes through the skin on a phrase change and back out on
a later one. Surface: `shaders/tess/sphere.frag`; JS: `lib/cube-sphere.js`, `lib/sphere-view.js`.

- **Cube-sphere, p4 only**: six equal-angle faces of 3 × 3 lattice cells (`faceCells`: a divisor
  or multiple of BLEND_PERIOD), 24 tiles round the equator. Across each edge the two face planes
  differ by a quarter turn plus whole-face translation (`transitions`, exact along the edge), a
  symmetry of the p4 warp, so the tiles carry on with no gap or kink. p3 would need an icosahedral
  net whose corners turn 60°, which p3 can't absorb, so there is no Symmetry param.
- **Colours across edges**: a quarter turn swaps the checkerboard's classes and every corner turns
  an odd number of quarters, so no 2-colouring closes up. Each tile takes the class of the face
  whose warped square holds its centre; per-face flips (searched, 64 cases) leave 4 seam edges,
  one per corner, where every other tile along the seam takes the palette's third colour. On the
  regular cells no two neighbours share a colour, corners included (tested); the warp still
  distorts the tiles right at the 8 corners. Engine change: an optional `TESS_CLASS(cls, c)` hook
  in tess.glsl (default `cls`), like TESS_RING.
- **The spatial blend is off on the sphere** (`u_tBlend.xy = 0`): the wave runs along one lattice
  direction, which a quarter-turn edge breaks, so the two motif sets blend in time only.
- **S** = the face chart's analytic Jacobian × screen derivatives of the hit point, which are
  smooth across faces (misses use the closest point, so the limb is continuous too); outlines keep
  their weight over the edges. `TESS_RING` = angle from a pole (upper left) / π, so fronts and
  spectrum rings sweep the sphere like a terminator.
- **Motion**: turn = 0.07 rad per unit of glide travel (bass and the eased beat surge), axis tilt
  swaying slowly. Push-through: smoothstep over 6 s (Reduce motion 12 s), on every 8th morph step
  (a phrase with a tempo) ≥ 12 s after the last, or after 60 s anyway; within 0.15 of the surface
  the print fades to paper, so crossing the skin is soft. Drag orbits outside, looks round
  inside, and eases back with a critically damped spring (no jolt, no overshoot; slower under
  Reduce motion).
- **Cost**: WebKit harness, 2560×1440, Quality high, `sync=1`: outside p50 4 ms / p99 9 ms, auto
  6 / 10, inside 14 / 25, 58.8 fps for each. Measured while other agents shared the GPU:
  Metamorphosis measured 15 / 20 in the same session (6–8 / 7–11 above), so the inside numbers
  are inflated by about the same factor.

## Tessellations: Endless Zoom (2026-10-22)

**Endless Zoom** (`endless-zoom`, webgl2) is a tessellation surface: Metamorphosis's
woodcut tiling seen through a log-polar map, p = α log z + O (z relative to the vanishing point,
in half-short-side units), so it spirals self-similarly into the centre and zooms without end.

- **Closure** (`src/lib/tess-zoom.js`, on `tess.js` `drosteAlpha`/`drosteAt`): one turn moves p by
  V = α·2πi = a e1 + b e2. The tiles close for any integer a, b, but the metamorphosis blend wave
  must also repeat over V or the shapes jump at the seam: both groups' waves have
  k·e1 = 1/BLEND_PERIOD, k·e2 = 0, so a = BLEND_PERIOD (6) and b is the twist. Spiral: none /
  gentle / medium / strong = b 0 / 1 / 3 / 6 (b = 3 still reads as a mild twist; 6 gives real
  arms). Tested across the seam for every option and group (field, tile class and uv agree).
  Colour classes survive any lattice translation (p4 parity, p3 sector).
- **S** is the analytic Jacobian, α / z / hs as a complex multiply; `dFdx` would see the atan
  wrap. The engine's ink-spread noise (`tessNoise(q · 9)`) is not lattice-periodic, so outline
  width can step by a few percent where an outline crosses the seam; not visible in stills.
- **Zoom**: O moves by −α · ZOOM_RATE (0.2 log-scale per unit of glide travel) × Zoom speed ×
  the eased direction, so bass and the eased beat surge set the pace through `s.travel`. O wraps
  by whole BLEND_PERIOD lattice steps (tiles and wave both repeat there): seamless, small floats.
  Direction changes ease the sign through 0 (τ 0.6 s), never a reverse jolt.
- **Rings** (`TESS_RING`) by log radius Re((c − O)/α), constant round a turn so it agrees across
  the seam: from the vanishing point's soft edge to the farthest corner. Fronts ripple outward
  zooming in, inward zooming out; the order only flips while no front is under way.
- **Centre**: the engine fades sub-10 px tiles to their mean; then a soft point (radius 0.015–0.11)
  of ink zooming in, paper zooming out (eased with the direction).
- **Drag** moves the vanishing point (≤ 0.75 units); on release it eases home over 1.4 s with a
  smoothstep (zero speed at both ends). The ring span follows it.
- **Cost**: WebKit harness, 2560×1440, Quality high, `sync=1`: p50 6 ms, p99 11 ms, 58.8 fps
  (Metamorphosis in the same run: 7 / 9 ms); 3 frames per vsync: 50 fps, so ~6.7 ms GPU (shared
  GPU with other agents' runs, so noisy). CPU (no sync) p50 < 0.1 ms. Flash check, 10 Hz strobe:
  0 flashes/s at a 5 % threshold, reduceFlashing on and off.

## Tessellations: Tile Horizon, the floor surface (2026-10-22)

**Tile Horizon** (`tile-horizon`, webgl2) casts the engine's woodcut tiling onto an endless floor
seen low in perspective, receding to a horizon that fades into the paper. Same motifs, palettes,
music and params as Metamorphosis, plus Height, Tilt and Fog. No engine change: it is one
surface shader (`shaders/tess/tile-horizon.frag`) plus a camera (`src/lib/tess-floor.js`).

- **Surface**: per-pixel ray–plane hit (focal 1.6 half-short-sides, ~32° half field of view),
  `S = mat2(dFdx(p), dFdy(p))`, computed for every pixel (sky too) so the derivatives stay
  defined across the horizon. The floor fades to paper by distance (`1 − exp(−3 (d/fog)²)`) and by
  footprint: a half-unit tile under 16 → 5 px along its most foreshortened axis. The engine's own
  small-tile fade uses √|det M|, the geometric mean, which stays moderate at grazing angles where
  the depth axis already aliases, so the surface needs the worst-axis test. Fully fogged pixels
  skip `tessShade`, so the sky costs nothing.
- **Rings**: `TESS_RING` is the distance from the camera's ground point over 0.6 × the fog
  distance, so figure/ground fronts and the spectrum rings sweep outwards across the floor.
- **Camera**: ground speed = travel × 0.6 × height (the floor's apparent speed doesn't depend on
  Height); the heading drifts as two slow sines (≤ 0.05 rad/s); the position wraps every
  `BLEND_PERIOD` lattice steps. Drag grabs the world (0.004 rad/px pan, ≤ 1.2 rad; 0.003 rad/px
  tilt, pitch kept within 0.03–1.3 rad); on release a critically damped spring (ω 2.2/s, solved
  exactly per step) eases it back from rest with no overshoot. Reduce motion: heading drift
  × 0.25, ease-back ω × 0.5 (the glide is already × 0.25 in the state). Height 0–1 → 0.25–1.5
  units, Tilt → 0.06–0.6 rad below the horizon, Fog → 40–8 camera heights.
- **Cost**: WebKit harness, 2560×1440, Quality high, `sync=1`: p50 7 ms, p99 10–11 ms, 58.8 fps
  (p4 default and p3 at Tilt 1), the same as Metamorphosis; CPU p50 < 0.1 ms. The GPU was shared
  with other agents' harnesses while measuring. Flash check: 0 flashes/s at 5 %, Reduce flashing
  on and off.

## Tessellations: the engine and Metamorphosis (2026-10-22)

**Metamorphosis** (`metamorphosis`, webgl2) is the first of a series of interlocking-tiling
visualizers: a p4 or p3 tiling whose tiles turn into hooked, lobed, finned and star-like
creatures, printed like a multi-block woodcut (bold key-block outlines, gouges echoing each
contour, colour blocks slightly out of register, paper fibre and tooth). Motifs, palettes and
names are original; the palettes only follow the ink colours of 1930s–60s woodcuts.

- **Tiling engine** (`src/lib/tess.js`, `shaders/tess/tess.glsl`): a displacement field
  `d(p) = Σ A cos(2π k·p + φ)` symmetrized over the group's rotations (k on the dual lattice, so
  it's lattice-periodic), applied as 4 composed steps `p + d(p)`. Each step's Lipschitz bound
  (Σ |A| 2π|k|, plus |∇m|·(D_A + D_B) for the spatial blend m between two coefficient sets) is
  fitted to 0.85, so every step, and so the warp, is a homeomorphism: the tiles always tile.
  One step alone only moves points ~0.03 units (the bound is conservative); four give real hooks.
  Tiles: p4 half-unit squares in a checkerboard (2 classes), p3 the three rhombi of each hexagon
  (3 classes; same-class tiles are translates ≥ 1 apart, edges are 1/√3, so never adjacent).
  Colour slot = (class + shift) mod n with n ≥ 3 distinct tile colours, so any figure/ground
  shift is still a valid colouring. Tile-local uv (0–1) turns with the tile for the features.
- **Music** (`src/lib/tess-music.js`): morph targets step once a bar (4 tempo beats; strong
  onsets ≥ 0.75, ≥ 2 s apart, without a tempo), easing over 1.5 beats (≥ 0.6 s); the smoothed
  centroid (0.05–0.3 of Nyquist) picks lobed → finned → star → hooked; Morph sets how far each
  step travels. Bass and an eased beat surge (80 ms smoothstep rise, gone by 0.9 beat, then a
  0.12 s lag) set the drift. Phrase changes (32 beats) or onsets ≥ 0.92 sweep a figure/ground
  front across the rings of tiles over 3.2 s, ≥ 8 s apart; Reduce flashing: 19.2 s, ≥ 24 s
  apart, a narrower front. Reduce motion: glide × 0.25, steps every 2 bars, eases × 4.
  Reactivity (0–2) scales every audio effect; 0 also stops inversions.
- **Cost**: WebKit harness, 2560×1440, Quality high, `sync=1` (GPU included): p50 6–8 ms,
  p99 7–11 ms, 58.8 fps; rendering 3 frames per vsync drops to 55.6 fps, so the GPU part is
  ~5.5 ms. CPU (no sync) p50 < 0.1 ms. Flash check under a 10 Hz strobe: 0 flashes/s at a 5 %
  threshold, reduceFlashing on and off. Untested on the M1 reference machine; Quality medium /
  low (0.75 / 0.5 render scale) are there for it.

**The seam for new surfaces** (floor, Droste, hyperbolic, sphere, torus …): a surface is a
fragment shader that maps its pixel to the tiling plane and calls the engine.

```glsl
#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
// optional: float myRing(vec2 c) { … }  #define TESS_RING(c) myRing(c)   (before the include)
// #include tess
uniform vec2 u_res;                 // set by the pipeline: print-target size
void main() {
  vec2 p = …;                       // plane point (lattice units) for this pixel
  mat2 S = …;                       // dp/dpixel (target px); e.g. mat2(dFdx(p), dFdy(p))
  o = tessShade(p, S);              // linear RGB, a = 1; or tessShade(p, float px) if isotropic
  // apply the surface's own fog/sky to o.rgb here
}
```

`S` keeps outlines, gouges and features a constant print weight in pixels however the map
stretches the plane (use an analytic S where p has a seam, e.g. log-polar's angle wrap).
`TESS_RING(c)` gives a tile (by its plane centre c) its ring, 0 near/centre … 1 far/edge, for the
figure/ground front and the spectrum rings; the default is `|c − u_tRing.xy| / u_tRing.z`.
`TESS_CLASS(cls, c)` (optional) recolours a tile from its regular class and centre (0–2, into
`u_tCls`; Tiled Sphere uses it where its face charts meet with a class-swapping turn).
On the JS side:

```js
import { createTessPipeline } from "./lib/tess-gl.js";
import { createTessState, renderScale } from "./lib/tess-music.js";
const tess = await createTessPipeline(ctx, "shaders/tess/<surface>.frag");
const state = createTessState();
tess.resize(renderScale(ctx.params.quality));          // and tess.resize() on ctx resize
// frame(audio, time):
const s = state.step(audio, time.dt, { symmetry, palette, reactivity, speed, morph, ink,
  hatching, height: ctx.size.height, reduceMotion: ctx.reduceMotion, reduceFlashing: ctx.reduceFlashing });
tess.render(s, (gl, u, w, h) => { /* the surface's uniforms, incl. u_tRing unless TESS_RING */ });
```

`s.speed` / `s.travel` (glide), `s.env` (beat envelope), `s.stepped`, `s.family`, `s.shift` are
there for the surface's own motion. Plane offsets can wrap every `BLEND_PERIOD` (6) lattice
steps (the tiling and the blend wave both repeat there). Shared GLSL is spliced in with
`// #include tess`, like Laminar's `// #include common`.

## Beat tracking: Ballroom harness and a new tracker (2026-10-22)

`uv run python -m tools.beat_eval` streams all 698 Ballroom clips hop by hop through the real
Analyzer (9 s on 10 cores) and scores the beats (each `beatPhase` wrap while `bpm > 0`) with
mir_eval against the Krebs annotations. `tests/test_beat_eval_ballroom.py` holds these as a floor
when the dataset is present (`--fetch`, 1.5 GB to `~/.cache/tidalviz/ballroom`).

| Tracker | F | CMLt | AMLt | Acc1 | Acc2 |
| --- | --- | --- | --- | --- | --- |
| Old (ACF tempo + onset PLL), all 698 | 0.524 | 0.378 | 0.592 | 0.646 | 0.913 |
| ChaChaCha (best) | 0.717 | 0.696 | 0.908 | 0.991 | 0.991 |
| Quickstep (~200 BPM) | 0.485 | 0.001 | 0.720 | 0.000 | 1.000 |
| Waltz (3/4) | 0.284 | 0.119 | 0.235 | 0.309 | 0.700 |
| **New (beat score + comb tempo), all 698** | **0.661** | **0.522** | **0.688** | **0.726** | **0.950** |
| ChaChaCha | 0.763 | 0.751 | 0.813 | 1.000 | 1.000 |
| Quickstep | 0.534 | 0.000 | 0.754 | 0.000 | 1.000 |
| Waltz | 0.460 | 0.255 | 0.446 | 0.400 | 0.782 |

- **What moved the numbers** (half-set sweeps, then the full set): the cumulative beat score
  for phase (α 0.9, tightness 5, the paper's values; F 0.52 → 0.59); holding the tempo through
  weak estimates instead of dropping after ~1 s (+0.04 F; lock coverage was 82 %, Waltz 43 %);
  a comb over the ACF at 1–4 × the period with equal weights plus a ±16-frame moving-mean
  threshold on the envelope (Davies & Plumbley 2007; Acc1 0.64 → 0.73, Waltz and Jive most).
  Prior (120 BPM, ±1 octave) and range (60–180) were already best; a 220 ceiling trades CMLt
  for F, and a higher confidence bar costs far more than it saves. Analysis p99 78 µs.
- **`bpm` is now held until 1 s of silence** (a weak estimate never drops it). The old tracker
  also locked onto a made-up tempo (148–175 BPM) from silence; it no longer estimates while silent.
- **The old tracker had tempo mostly right up to an octave (Acc2 0.91); phase and continuity
  were the weak part (CMLt 0.38).** Quickstep (~200 BPM) sits above the 60–180 search range, so
  it still always halves (CMLt 0, AMLt fine); Waltz is still the weakest genre.
- **Libraries ruled out:** madmom (last PyPI release 2018, breaks on Python ≥ 3.10, models
  CC BY-NC-SA), BeatNet (needs madmom + PyTorch), BTrack/aubio (GPL) and essentia (AGPL) under
  our MIT license, librosa (offline only); `analysis/rhythm.py` implements the published
  algorithms instead (cumulative score: Stark, Davies & Plumbley, DAFx 2009).
- **Tie-Dye moves on the beat:** with a confident tempo an onset's surge is scaled to 0.2 and the
  dye swell follows the beat; before, an off-beat onset pushed the flow further than a beat
  (0.161 vs 0.129 unit radii).

## More reactive backgrounds: Tie-Dye, Skull Trip, Dark Sun, Eclipse, Marbling (2026-10-21)

Background motion = mean frame-to-frame pixel change over the background (subject excluded),
5–10 s deterministic windows in the harness; beat response = motion 150 ms after a strong onset
÷ 150 ms before. Each agent used its own meter, so compare rows, not visualizers.

| Visualizer | Loud ÷ silence (main → now) | Beat response (main → now) | What changed |
| --- | --- | --- | --- |
| Tie-Dye | 2.6 → 7.6 | 1.29 → 1.57 | new bands born per beat, coloured by the spectrum; auto pattern morphs every 32 beats |
| Skull Trip | 3.4 → 8.9 | 2.57 → 2.85 | stripes are contours of a distance field: closed loops born at beat-seeded emitters grow off screen |
| Dark Sun | 4.2 → 64.5 | 2.49 → 3.90 | flowing washes, beat-locked range drop and horizon shock, ground ripples; sun 2.4 → 32 |
| Eclipse | 1.3 → 19.6 (30.8 with water) | 1.01 → 1.45 | orbiting, re-forming clouds; water reflection (off/low/mid) |
| Marbling | ~3–9 → ~260 | 1.7–3.1 → 4.2 | every beat pours (by spectrum), currents between drops, tempo-locked combing |

- **Skull Trip is budget-limited on purpose:** every stripe motion shares one per-pixel alternation
  budget (≤ 3 Hz with Reduce flashing). On main the skull's nod/chomp moved every contour and spent
  most of it; the field now uses the skull's rest outline and the budget goes to the background.
- **Silence:** several visualizers now move *less* in silence than before, by design.
- **Harness:** each agent wrote its own motion meter; kept one built-in meter (`meter=1`, named
  zones) plus `motion_hook.py`; `silent=1` now zeroes levels in every audio mode.

## Blaze: flame-test materials and sparks (2026-10-15)

Eleven new palettes after the original four: propane, copper, boron, sodium, lithium, strontium,
potassium, calcium, barium (flame-test colours) and iron, nickel (sparks).

- **Blackbody rendering:** a material is `soot` × the blackbody glow plus `line` × `strength` × t^1.2
  (its emission lines/bands, filling the body more evenly than the soot), tone-mapped together.
  Propane is nearly soot-free, hence blue. Display gamma flattens colour ratios hard, so strontium
  and calcium need almost no green in their lines to read as red and brick orange.
  **Simple rendering:** a keyed ramp through a hand-picked `swatch`.
- **Iron and nickel barely tint a flame** (they burn like "natural"); they throw sparks:
  `lib/sparks.js`, a 1,024-slot structure-of-arrays pool (swap-remove, no per-frame allocation)
  spawned from the fuel line by rejection sampling on fuel, so sparks fly from the loud columns,
  at a rate set by the bass stoke and onset flare. Gravity + drag arcs; colour is blackbody cooling
  over life. Iron sparks fork into 3–5 short, hotter children (steel's carbon burst); nickel's are
  mixed 70% toward white and never fork. Drawn as soft additive streaks (35 ms of motion) after the
  composite. Spark motion runs on sim time, so Speed and reduce-motion slow it.
- Known gap: the spark pass's GPU cost isn't measured (worst case 1,024 streaks, a 172 KB
  `bufferSubData` per frame).

## Blaze: blackbody rendering (2026-10-15)

A new *Rendering* param: **blackbody** (default) or **simple** (the original hand-keyed ramps,
byte-identical stills).

- **Blackbody is Tetraballs' fire model, not a new one.** Heat t → K = 800 + 2400 · t^1.4, Planck's
  law at 610/550/465 nm, emission ∝ t^2.2, ACES tone map + display gamma. A test reads
  `shaders/tetraballs/volume.glsl` so the two can't drift. (Tetraballs' SIGGRAPH citations are its
  thin-film and sheen materials; the fire is plain Planck.)
- **Still a 256-texel LUT built on the CPU**, rebuilt on palette/rendering change: the GPU path and
  its cost are unchanged. `gain` (2) stands in for the density Tetraballs' ray march accumulates.
- **Palettes are re-tints of the blackbody fire:** blue gas and green chemical swap channels; ember
  mono is a deep-red → orange curve on luminance (the brightest channel saturates early and looked flat).
- The low-heat tips are less red than the old ramp (r/g ≈ 3.8 at t = 0.2, against 14): that is a
  ~1050 K blackbody after display gamma, so the red-tips test now asks r > 3.5 g.

## Linux support (2026-10-02)

**Machine (not the M4 Pro above):** Linux 7.2 (CachyOS), i9-12900KF, RTX 4090 (driver 615.71),
PipeWire 1.6, WebKitGTK 2.52, Hyprland 0.56 on Wayland, 2560×1440 @ 60 Hz.

**Capture** (`capture/pipewire_source.py`): `pw-record --raw` on a pipe, 512-frame blocks.
`--latency 256` gives one block per 10.7 ms; 512 delivers two at once (a dropped hop). Per-app pids
come from `application.process.id`, else `pipewire.sec.pid`. A per-app target is pinned with
`node.dont-reconnect`: otherwise WirePlumber re-links `pw-record` to the microphone when the app's
stream ends. The watchdog marks the source `failed` when `pw-record` delivers no data for 1 s (4 s
before the first block, for a sink waking from suspend); silent audio still streams zero blocks.

| Measure (pink noise via `speaker-test`) | Result | Budget / macOS note |
| --- | --- | --- |
| Block interval, 5 s | p1/p50/p99 10.61 / 10.67 / 10.72 ms | 10.67 ms ideal |
| Headless host CPU, 60 s, `tools.cpu_budget` | **2.4%** (analysis 1.4, main 0.6, reader 0.2) | < 10% (macOS 6.6%) |
| Orbit bench, fullscreen 2560×1440 | 58.5–59.5 fps, p99 33 ms, 0.9–2.9% dropped | 60 fps, p99 20 ms |
| Audio-to-screen p95 (same runs) | 31.4–31.7 ms | 50 ms |
| App with window, Orbit, 1440p (% of one core) | `tidalviz` **30–33%**, WebProcess 10% | **over the budget** (macOS 13.8%) |

- **Windowed host CPU is 30–33%, over the 10% budget, and not fixed here.** The GTK main thread is
  25% of it. `py-spy record --native` shows no Tidalviz Python on the hot path, only GTK/GDK and
  NVIDIA's EGL-Wayland libraries; what wakes it ~92 times a second isn't established.
- **Crash on NVIDIA + native Wayland, and the fix.** The app died ~1 s after launch (`Gdk-Message:
  Error 71 (Protocol error)`). One variable at a time, 12 s launches (exit 124 = survived):

  | Variant | Exit | Error 71 |
  | --- | --- | --- |
  | baseline | 1, dead in ~1 s | yes |
  | `WEBKIT_DISABLE_DMABUF_RENDERER=1` | 124 | 0 |
  | `__NV_DISABLE_EXPLICIT_SYNC=1` | 124 | 0 |
  | `GDK_BACKEND=x11` | 124 | 0 |

  `window_gtk.configure_gl_environment()` sets `__NV_DISABLE_EXPLICIT_SYNC=1` before GTK starts when
  `/proc/driver/nvidia/version` exists; a value the user set wins (`=0` brings the crash back).
- **Known gap: WebKitWebProcess segfaults on exit with the NVIDIA driver** (a core dump each
  time): `libwebkit2gtk` destructors call into `libnvidia-eglcore` after the window has gone. The
  app itself exits normally. Not fixed here.
- Not measured: switching the default output mid-stream, Flatpak apps.
- **Tried and dropped:** `WEBKIT_DISABLE_DMABUF_RENDERER=1` copies every frame through shared
  memory (Orbit 51.6 fps, WebKitWebProcess at 94.5% CPU, against 59.5 fps and 10.3% CPU with DMA-BUF
  kept); a Qt backend (WebEngine is Chromium, 524 MB); PyGObject as a default dependency (a bare
  `uv sync` would fail without headers), hence the `gtk` extra.

## Background and visual opacity (2026-10-02)

Two persisted settings, `backgroundOpacity` (0–1, default 0) and `visualOpacity` (0.1–1, default
1), live only while *Transparent background* is on.

- **Two sliders, and the visual's goes on a `.viz-layer` wrapper.** *Transparent background* only
  removes the black backdrop, but most visualizers paint nearly every pixel, so the window stays
  opaque. The backdrop alpha sits on the stage background. The visual opacity sits on a new
  `.viz-layer` around the plugin iframes, not on `.stage` (that would fade the backdrop too) and not
  on each iframe (the plugin host animates their inline `opacity` for the crossfade).
- **Fade live on `input`, save on `change`.** Each `settings` message rewrites settings.json.
- Visual stops at 0.1 so the visual can fade but never vanish; Background has no floor.

Unit and e2e tests pass on macOS (2026-10-14). Known gap: the GPU cost of the extra compositing
layer below opacity 1 is unmeasured.

## Visualizer batch: Tentacube, Tie-Dye, Skull Trip, Dark Sun, Eclipse, Marbling, Laminar, Tetraballs (2026-09-28)

Built in parallel worktrees and merged one at a time. GPU times were measured on the M4 Pro at
2560×1440 while up to seven agents were rendering, so treat them as rough upper bounds (the
reference M1 Air is roughly 3–4× slower).

| Visualizer | Technique | GPU (M4 Pro, loaded) |
| --- | --- | --- |
| Tentacube | three.js; verlet tentacle chains (CPU, ~0.05 ms); material morph; Poincaré-disk tiling | ≤ 2.2 ms |
| Tie-Dye | half-res dye pass + full-res weave composite | 1.6–1.9 ms |
| Skull Trip | raymarched SDF skull (half res) over AA op-art stripes | 2.0–2.2 ms |
| Dark Sun | quarter-res watercolour washes + full-res sun/horizon; mirrored spectrum range | ~0.9 ms |
| Eclipse | procedural branching corona trees (noise gave worms/specks); third-res clouds | ~2.3 ms |
| Marbling | Jaffer drop/tine displacement, baked feedback with a 48-event queue | 1.4–2 ms |
| Laminar | stable-fluids sim (MacCormack, obstacle, confinement in the wake cone) | 3–3.6 ms |
| Tetraballs | raymarched metaballs; 9 materials (thin-film, Charlie sheen, dispersion…) | chrome ≤ 2.5; fire 3.5–10; smoke 4–9 |

- **Fire/smoke in Tetraballs likely miss 60 fps on an M1 Air at medium quality**; the low
  quality setting and auto render scale reduce them. To verify on the reference machine.
- **Photosensitivity:** every visualizer routes global brightness swings through the flash
  limiter. Skull Trip's check counts 4 changes/s at a 2% luminance threshold but 0 at 5%; WCAG's
  general-flash threshold is ~10% opposing changes, so it isn't a flash by that definition.
- **Harness:** the melody signal produced NaNs before t = 0 (negative modulo) and the drums kick
  peaked at ~30 Hz; both fixed. Headless WebKit paints a transparent page's unstyled iframe
  white, so backdrop colour in harness screenshots isn't reliable.
- Merging: parallel agents each appended a manifest entry and a test; a conflict can split a
  function in two, so the manifest test file is rebuilt from both sides rather than
  "keep both".

## Host CPU (2026-09-27)

Measured with `uv run python -m tools.cpu_budget` (headless host, WebSocket client in a separate
process so its CPU isn't counted) and an in-process sampler for the app with its window.

| Setup | Host process CPU |
| --- | --- |
| Headless, live TIDAL, before this work | ~7–8.6% (the earlier "~15%" probe counted its in-process client) |
| Headless, live TIDAL, after | **6.6%** — analysis 2.8, main/asyncio 1.5, catap drain 1.3, catap worker 0.8 |
| App with window, live TIDAL, after | 13.8% |
| App with window, live TIDAL, before (old code) | 23.3% |

- **Our code meets the < 10% budget.** The remaining ~7 points in the app are WKWebView's UI
  process, which lives in the host process and handles WebKit's per-frame layer commits and IPC
  at 60 fps. Getting the combined number under 10% would mean running the host in a separate
  process from the window — not done; it would meet the budget's letter, not its intent.
- **catap drain pacing** (`capture/catap_drain.py`): catap 0.6 polls its native ring every 1 ms
  (~1,000 wakeups/s for ~94 chunks). A wrapper around the private
  `AudioRecorder._drain_native_recorder` sleeps until just before the next chunk is due. It's
  guarded (no method ⇒ warning, catap untouched) and catap is pinned `~=0.6.0` so an upgrade is a
  deliberate step. This was most of the window-app improvement.
- Analysis: fewer, fused numpy calls per hop; planar mirrored ring with a zero-copy view of the
  newest frames; float32 spectrum after the float64 FFT. Golden-value tests pinned the outputs
  first. Analysis p50 ≈ 0.20–0.23 ms live.
- Tried and dropped: a lock-as-doorbell instead of the ring's Condition — no measurable gain.

## Integration — app, bench, e2e (2026-09-26)

- **Plugins were stuck at 20 fps in the app.** The shell's iframes ignore the pointer (so the
  shell sees the mouse), so the native click that lifts WebKit's cross-origin rAF throttle never
  reached the plugin. Now, while the active plugin reports < 40 fps, its iframe accepts the
  pointer; the shell then takes keyboard focus back. The fix is occasionally flaky in the real
  window (one bench run stayed at 22 fps); the host re-clicks every 2 s.
- **No 120 Hz WebKit preference.** Turning off `PreferPageRenderingUpdatesNear60FPSEnabled` made
  WKWebView pace frames irregularly: Orbit 48 fps / 26% dropped vs 59.9 fps / 0.56% at the default.
- **Bench, Orbit, live TIDAL audio, 2560×1440 canvas (M4 Pro, window alone):** 59.9 fps, 0.7%
  dropped, frame p99 37 ms (budget 20), audio-to-screen p95 ~33–57 ms (budget 50), analysis p50
  0.19 ms, capture→send p95 0.7 ms, **host CPU ~20% (budget 10%)**. Two app windows at once push
  latency to ~500 ms — measure alone.
- **Host CPU breakdown (headless probe):** analysis thread ~7% (Analyzer 0.46–0.54 ms thread CPU
  per hop live vs 44 µs in a hot loop: per-call numpy overhead on cold caches; `AnalysisContext.load`
  alone is 0.18 ms), catap capture workers ~6%, event loop ~2%. QoS user-interactive doesn't help.
  Reaching 10% needs far fewer numpy calls per hop (batching extractors) — open decision.
- **Frame contract:** waveform is now 2,048 samples per channel (Cosmic Peanut): mono 12,640 B,
  stereo 29,024 B.

## M1/M2 components — parallel lanes (2026-09-25)

Built in parallel worktrees (audio, host, plugins, sdk, shell, viz, spike) against the M0
contracts, then merged. The app entry point that wires them together is the next step.

**M1 spike: WKWebView (tools/spike/REPORT.md).** The architecture holds, with two changes:
- WebKit throttles rAF in a cross-origin iframe to **20 Hz until the user interacts with it**
  (no preference turns this off). One synthetic NSEvent click into the window after each plugin
  is ready lifts it. Host send → first iframe rAF: 47 ms p95 without, **17 ms p95 at 60 Hz and
  9 ms at 120 Hz** with it. Estimated audio-to-screen ≈ 33–49 ms, inside the 50 ms budget.
- The plugin iframe **shares the shell's WebContent process and main thread**: `while(true){}`
  freezes the shell. Heartbeat detection works; recovery needs
  `_killWebContentProcessAndResetState()` + `reload()` (plain reload does nothing).
- WebGL2 and WebGPU both work in the sandboxed iframe. rAF is 60 Hz on ProMotion unless
  `PreferPageRenderingUpdatesNear60FPSEnabled` is turned off. `performance.now()` has 1 ms
  resolution in WKWebView. On-top windows ignore the first fullscreen toggle.
- Site isolation (private `SiteIsolationEnabled` + plugin served from `localhost`) gives the
  plugin its own process so a hang doesn't freeze the shell — an M2 experiment, flag is unstable.

**Audio.** Analysis p50 44 µs / p99 124 µs in the benchmark; live on the real pipeline with TIDAL
p50 ≈ 0.5 ms, p99 0.77–0.91 ms (cores idle down between hops; the analysis thread uses Mach
real-time scheduling, without it p99 ≈ 1.8 ms). Capture → publish p95 0.9 ms. Zero per-frame
allocation (tracemalloc test). Onsets: every click detected once, 0.67 ms error. Tempo locks in
2.9 s at 120 ± 0.2 BPM. Reserved scalar 13 is now **`onsetAge`** (sub-hop onset timing).
Known gap: tempo can land an octave off on ambiguous material.

**Host.** Loopback p95 0.5 ms for 10.6 KB frames at 94 Hz, 100% delivered. The bootstrap page's
CSP carries a per-response nonce (the §3 CSP as first written blocked its own inline scripts —
the spike found the same). Paths reject hidden segments; dev harnesses and `*.test.js` are not
served.

**Plugins.** Dev-folder save → callback ≈ 30 ms. Real HTTPS fetch of a small GitHub repo ≈ 5.5 s.
Keys: built-ins use their folder name, dev folders `dev-<slug>-<hash8>`.

**SDK / shell.** SDK overhead is below WKWebView's 1 ms timer (µs-level in micro-benchmarks);
shell forwarding ≈ 3–20 µs per frame. Frames are forwarded by transfer.

**Viz.** At 2560×1440 in WebKit: Bars 0.1/0.2 ms, Undertow ≤0.05/0.1 ms (+~0.7 ms GPU), Orbit
0.1/0.5 ms (+~0.8 ms GPU), Template ≤0.05/0.1 ms CPU p50/p99. Vendored three 0.186.1 is 6.6 MB.

## M0 — contracts (2026-09-25)

- **Frame v1 channels are planar** (mono, left, right) instead of interleaved, so every waveform
  view is zero-copy. Mono 6,496 B, stereo 10,592 B. See docs/protocols.md §1.
- **Shell and SDK are plain ES modules with JSDoc types**, type-checked by `tsc --checkJs`. The PRD
  asks for TypeScript built at build time *and* a checkout that runs with only uv; shipping source
  that needs no build satisfies both, with no committed build output to drift. Node is dev-only.
- **aiohttp serves HTTP and the WebSocket** on one event loop (the PRD allowed aiohttp for HTTP and
  named `websockets` for WS); one dependency instead of two.
- **Manifest `fallback`** is the `id` of another entry in the same manifest.
- **catap live check:** system capture delivers 48 kHz stereo float32, 512-frame buffers
  (~94 callbacks/s) with real signal from TIDAL — the hop matches catap's buffer size.
