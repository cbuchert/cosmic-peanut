# Notes: decisions and measurements

Newest first within each milestone. Numbers are from the dev machine unless stated
(Apple M4 Pro, macOS 26.6) — the PRD's reference machine is an M1 MacBook Air.

## Lattice shading: the cinematic look (2026-10-23)

Lattice and Tentacle Lattice gain **Look**: `classic` (the default) or `cinematic`.
`shaders/lattice/README.md` → "Shading" is the model; papers are cited there and in the shaders.

- **Classic is byte-identical** to e3dcaca. Its shader text is unchanged: no define, and the
  cinematic code sits under `#ifdef CINEMATIC`. 13 stills match the old build byte for byte at
  the default Look and at an explicit `classic`, with an exact RGBA byte compare: Lattice
  default, brass, ink and none over light, high + thick + fog 0.8, low; Tentacle Lattice default,
  each material, ink over light, brass + high + long + fog 0.9.
- **Cinematic:**
  - One BRDF for every surface: GGX + height-correlated Smith + Burley, with Kulla–Conty
    compensation via the analytic DFG fit.
  - Palette materials: steel, brass, ink. Tentacle Lattice's four materials blend their
    parameters through the same BRDF. Iridescent is a Belcour–Barla thin film.
  - A split-sum procedural environment, a key light with a cone-traced soft shadow, and Evans AO
    with specular occlusion.
  - Beat pulses become packed tube lights (Karis representative point).
  - Homogeneous fog with Sun et al.'s analytic in-scatter for the headlight and the pulses.
  - Over-relaxed sphere tracing; a Jimenez bloom chain; Narkowicz's ACES fit.
- **Default stays classic.** The stills don't clearly win. Cinematic is better on the steel and
  brass lattices: real metal, depth, glow. But Tentacle Lattice's iridescent reads weaker than
  classic's vivid (unphysical) hue cycle, because a physical film only colours the specular
  reflection. Ink turns sepia: the paper fog is mixed in linear light and tone-mapped per channel.
  Stills: `scratchpad/shots/lat-shading-*-{classic,cinematic,compare}.png`.
- **Frame time** (WebKit harness, 2560 × 1440, `sync=1`, `rep=4`, Medium, interleaved in one
  session, 3 rounds; the GPU was shared with other agents, and noisy runs were discarded):

  | | Classic p50 / p99 | Cinematic p50 / p99 |
  | --- | --- | --- |
  | Lattice | 3.0 / 4.0–4.25 ms | 3.25 / 5.0–5.5 ms |
  | Tentacle Lattice | 5.0 / 5.75 ms | 7.75 / 9.75 ms |

  At Low, Tentacle Lattice is 3.25 → 4.25 ms; at High, 8.25 → 12.5 ms (p99 15.5). Lattice stays
  near its 3 ms floor at every Quality. Shadows were the costliest addition (about +30 % of classic
  on Tentacle Lattice), so Medium uses 12 shadow taps and 4 AO taps.
- **Over-relaxation:** against a fine-step reference (0.6 × the step, 1500 steps), relaxed
  stills differ in fewer pixels than plain ones at the same budget. Tentacle Lattice default:
  177 k vs 283 k pixels off by more than 8/255. It recovers far detail, never skips a surface,
  and its time difference was within the noise.
- **Beat taste.** Exposure and the bloom mix are fixed: nothing global moves on the beat.
  - Pulse light reaches only 1.8 cells around each front.
  - The beat's mean-luminance swing (median over 0.25 s windows, Speed 0, Reduce flashing off)
    is 0.14 in cinematic vs 0.07 in classic for Lattice, and 0.14 vs 0.05 for Tentacle Lattice.
    The pulse is brighter and lights its neighbours, but it is still local to the pulse.
  - Under Reduce flashing the pulse lights are × 0.2 more. The flash check under the 10 Hz
    strobe gives 2 rises/s at 5 %, the same as classic, and 3–5 at 2 % (classic 3–4).
- **The TPMS agent's note** (pale pulse bands on pale walls): pulse emission is HDR before the tone
  curve, pulses light and glow, and the optional `STRUCT_WALL_TONE` define lets a wall-filling
  structure darken its lit walls. `pulseLights` (JS, optional) defaults to a point light at the
  source.
- **Harness determinism fix.** Before, `still` mode's clock started at `performance.now()`, so
  frame steps rounded differently per run. Lattice's beat decisions, and so its camera path,
  flipped between two outcomes. The first page in a fresh WebKit also renders differently.
  `still` now starts at 0, and identity runs discard a warm-up page.
- **Tests:**
  - `lattice-look.test.js`: Look mapping, tone-curve monotonicity and exact inverse, the alpha
    rule, sample counts, palette materials.
  - `lattice-lights.test.js`: the pack keeps the nearest lights with a fading window and no pop;
    strut fronts match a brute-force walk; the point fallback; the gain.
  - `lattice-bloom.test.js`: level sizing; levels allocated once per size change; no allocation
    in `render`.
  - `pulseLightsOf` and the manifests.
- **Not test-first:** the GLSL (no JS copy of it) and the GL wiring in `lattice.js`. The harness
  covers them: flipping every param, flipping the Look both ways at runtime, resize, dispose,
  with no errors.

## Lattice fractals: Sponge and Kaleidoscope (2026-10-23)

Two new options of Lattice's **Structure** param, each a structure file, a JS module and a table
entry (plugins/builtin/shaders/lattice/README.md → "Fractal structures").

- **Sponge: an exact self-similar zoom, not a fake one.** The cubes nest about a zoom centre F
  (the fixed point of S(p) = F + (p − F)/3, M an edge-middle sub-cube of its parent at every
  level), folded across the faces through F. The world is invariant under S, so a rebase (×3
  about F, when the camera enters the next dive) needs no crossfade. A periodic sponge was
  considered and rejected: at each rebase the coarsest carved level drops, and the tunnel the
  camera just left is 1–3 cells away.
- **The shader works in the camera's local cells** (`(frame − F) / scale`; the runtime
  re-uploads `u_cam` and `u_pulse`). Fog, headlight, AO, normals, pulse width and the hit test
  are absolute lengths in shade.glsl and march.glsl; in frame cells they would all jump ×3 at
  each rebase. Measured: mean |Δ| between frames across a rebase 15.3/255 vs 15.0–15.7 for the
  frames around it (silent flight, rebase at frame 356).
- **Fine levels by pixel footprint**: a level's holes grow in from nothing over 1–2 px half-width
  (no pops), and both that test and the far-from-cells early-out are scale-invariant.
- **Camera**: B-spline dives of five points (SWERVE straight on, or on a beat TURN a quarter turn
  — the next dive reflected across x − 9 = z − 9, a symmetry of the world), ≥ 0.437 cell clear
  in the frame's own units (3 seeds × 60 s), positions within 12 cells of F over 10 min (depth >
  40). One dive ≈ 6.9 s at Speed 1.
- **Kaleidoscope**: Knighty's Menger KIFS bent by a rotation, running derivative, mirror-repeated
  (period 6), centred on the cell edges so its own central tunnels are the naves; the naves are
  also carved (radius 1.3), where the cubic camera ×6 flies (≤ 1 cell off axis): clearance ≥ 0.3
  whatever the parameters. DE tests: 0.8 × DE balls stay empty and |∇| < 1.25 over all looks at
  ±BEND; a mutant without the running derivative fails both. A "far from the box" early-out was
  tried and dropped (rotation lets the next box poke out: the Lipschitz test caught a jump).
- **Looks**: four curated (nave, vault, gallery, arcade) from ~12 tried; two (cut-cylinder
  tunnels, dark foam) were rejected. 45 s holds, 12 s crossfades; mids bend the angles, treble
  the offsets, ±0.12, through two 1.2 s stages; beats bend the offsets ≤ 7 % only near a front.

**Frame time** (WebKit, 2560×1440, Medium, `sync=1`, 30 s of `audio=music`, ms p50/p99; the GPU
is shared with other agents, so p99 swings ±4 ms run to run): Sponge 8–9 / 10–14, Kaleidoscope
7–8 / 10–14, Cubic in the same runs 4–6 / 9–10. GPU-bound (`rep=8`): Sponge ≈ 4.5–5 ms,
Kaleidoscope ≈ 3.7 ms. Before render scales 0.9 / 0.8 and a 1 px fade footprint the Sponge's p99
was 16–17 ms.

**Identity**: the entry now creates a structure's own camera and pulse pool on a Structure
change and passes the camera in StructureFrame. Cubic (4 param sets) and Tentacle Lattice (2)
stills byte-identical to e3dcaca, 5 alternating samples each. The harness's still mode itself is
not quite deterministic (a still occasionally comes out in one of two versions, for the base tree
too), so compare several alternating samples, not one pair.

## Lattice strut structures: octet, diamond, bitruncated (2026-10-23)

Three new options of Lattice's Structure param (`shaders/lattice/README.md` → Strut lattices).
Cubic and Tentacle Lattice are unchanged: 7 stills (Lattice default, brass, ink over light,
high + thick + fog 0.8, explicit cubic at thin rods; Tentacle Lattice default and ink over light;
`still=372`) match the previous build byte for byte (exact RGBA compare).

- **Geometry was measured before it was designed.** A brute-force search for the widest straight
  free lines: octet ⟨110⟩ channels clear the strut axes by (√3 − 1)/2 = 0.366 and meet three at a
  time at junctions; diamond ⟨110⟩ channels 0.608 (the dual network's bond midpoints are
  junctions); bitruncated ⟨111⟩ 0.612 and ⟨100⟩ 0.354 through cell centres. Through a B-spline
  turn, octet drops to 0.211 at √2 spacing, so its walk uses half steps (0.311).
- **Exact distances everywhere** (all three checked against brute force), so full march steps.
  Octet's struts are whole lines (6 families, two roundings each); its node cube at the nearest
  node is exact too at these sizes. Octet uses the cubic rods and cubes × 0.75.
- **Pulse metric:** octet and diamond are exact graph distances (BFS-checked). The sodalite net
  (the honeycomb's edges) has no closed form; vertices are estimated as max(r, √2 r − 0.29) cells,
  within 1.6 hops by 4 hops out.
- **Camera** (60 s, 120 BPM, Speed 1): acceleration along the path 0.32 for all; across 2.8 octet
  and diamond, 4.2 bitruncated (cubic 4.2); jerk 9.5 / 9.5 / 17.8 (cubic 17.8); angular velocity
  0.97 / 0.97 / 1.43 rad/s (cubic 1.45).
- **Frame time** (1440p, medium, `sync=1`, 4 frames per rAF, WebKit; GPU shared with other
  agents, so ±1 ms): p50 / p99 octet 4.75 / 6.25 ms, diamond 8 / 9.5, bitruncated 4.5 / 6.25,
  cubic 1.5 / 2. A single-frame run read diamond's CPU p50 as 12 ms once: noise.

## Lattice: triply periodic minimal surfaces (2026-10-23)

Lattice's Structure param gains `gyroid`, `schwarz-p` and `schwarz-d`: thickened sheets
|f − c| ≤ t whose saddle walls split space into two labyrinths; the camera flies one.
`shaders/lattice/README.md` has the design (one GLSL file with a define per surface, `lib/tpms.js`,
`lib/net-camera.js`, `lib/structure-tpms.js`).

- **Bounds, measured:** max |∇f| = √3 for all three (sampled 1.73205; lip 1.75), Hessian spectral
  norm 2 (gyroid, D) and 1 (P). The march step is (|f − c| − t) / (k lip): 0.89 of the near-wall
  distance for G and D, 0.77 for P. Clearance takes the better of the first-order bound and a
  second-order one; with only the first, P's necks (∇f = 0, f = 1) failed the 0.15-cell floor.
- **Camera:** a net walk (srs / cubic / diamond, nodes at f's maxima) through `createCamera`'s
  B-spline and springs. 60 s × 3 seeds at 2 cells/s with beats: least worst-case clearance gyroid
  0.60, P 0.30, D 0.38 cells; view rate ≤ 1.1 / 1.9 / 1.5 rad/s at 2 cells/s, and the README's
  beat-run limits (along < 1, jerk < 25, ω < 1.6, ω̇ < 4) hold for all three at Speed 1.
- **Pulses:** first try snapped the source by steepest descent of f; on P's axis lines the gradient
  points along the axis, so it stalled in the neck (f = 1). Now: the nearest of 26 cast rays, then
  Newton. Euclidean fronts; the ring reads as a pale band (the steel and brass glow is near the
  walls' own tone; a per-structure wall tone would need a `shade.glsl` hook).
- **Look:** history age 12 rows/cell aliased into a moiré on far walls; 6 rows/cell doesn't. Steps
  × 1.4 removed most 1-pixel dark silhouette rims (rays grazing the saddles ran out of steps). Fog
  × 2.2 for depth.
- **Frame time** (harness, WebKit, 2560 × 1440, `sync=1`, `rep=4`, two runs each, GPU shared with
  other agents' runs so noisy): Medium — cubic p50 2–2.25 / p99 3.75–4.25 ms (reference); gyroid
  2.75 / 3.25–3.75; Schwarz P 2.5–3.25 / 3.75–4.75; Schwarz D 3.25–4 / 4.75–8.5 ms. All 58.8 fps
  but one D run (55.6 at rep 4). High, gyroid: p50 8.25 / p99 11.75–12.5 ms.
- **Cubic and Tentacle Lattice byte-identical:** 8 stills (cubic default at 150 and 372, thick +
  brass, ink + high + fog 0.2, none + low + speed 2, music + reactivity 2; tentacle default and
  chrome) match the pre-change build byte for byte (the comparer says DIFFER on two different stills).
- **Not test-first:** the GLSL (mirrored by `lib/tpms.js`, whose bounds are tested), the entry's
  camera swap on a Structure change (driven by flipping the param in WebKit: no errors) and the
  look (tuned by stills).

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
- **Fish** (9 more): salmon, shark, swordfish, sturgeon and moray share the koi's TGTG counts
  (e0 s9, e1 s4), so seven fish morph; gulper (TGTG, e1 s5: its slit mouth crosses snouts when
  blended), anglerfish and manta (TTTTTT), stingray (C3). In TGTG the back is the belly's glide
  image, so thickness at x and at W − x sum to 2h (deep head ⇔ thin tail) and a dorsal fin is a
  belly slot. Dropped: angelfish (both swept fins become dents that eat the body) and a C4 skate
  (C4 can't be mirror-symmetric; the pinwheel read as a blob).
- **Birds** (nine new, ten with the tern): mallard, puffin, kingfisher and cormorant are TGTG with the
  koi/halibut edge structure (e0 smooth 9, e1 smooth 4), so they morph into the fish; gull and swallow
  share the tern's (TTTTTT); chickadee, nuthatch and woodpecker are perching TGTG birds (e0 smooth 7,
  e1 smooth 5) that morph into each other. Symmetric TTTTTT wings: V2 halfway up and e2 = e1 with v negated.
- **Reptiles** (7 new, none in C3): crocodile, gharial and monitor (TGTG, one morph set: V0 is
  the tail tip, so each snout rests on the tail ahead), tortoise and softshell (C4 on the sea
  turtle's edges, morphing with it), horned lizard (C4, polyline for its spikes) and chameleon
  (TTTTTT in profile; legs on the side edges so the back stays an arched hump). In TGTG and
  TTTTTT, legs on the belly dent the back, so the walking gait and the corners place them. An
  iguana (TTTTTT, chameleon's edges) read as a bat: its long tail notched the shoulder. Dropped.
- **Mammals**: the bat is redesigned with its wingtips at V1/V5 (free corners, so they're sharp,
  poking into a neighbour's ear notch at V3) and its wrists on the 3-fold centres. Added: elephant
  face (C3, trunk tip at V3), lion face in its mane (C4), harbour seal from above (TTTTTT, with e2
  = e1 mirrored and v negated so the body comes out symmetric), and dolphin, orca and humpback
  (TGTG s9/s4 like koi/halibut, so all five morph). A running fox, leaping hare, flying squirrel
  and hedgehog were dropped: legs became notches in the back, and C4 squares read as frogs.
- **Cost** (WebKit harness, 2560×1440, Quality high, `sync=1`; GPU shared with other agents):
  one species static p50 2–3 ms; `all` with morphs (bakes on the music) p50 9 ms, p99 13–14 ms,
  58.8 fps. Three renders per vsync still hold 58.8 fps: 2–5 ms per frame, bakes included.
  Abstract in the same session: p50 7–13 ms. Untested on the M1.
- **With relief (integration, 2026-10-23):** the atlas hook (`tessArt`) sits in `tessPrintFill`,
  the print tail `tessPrint` and `tessShadeRelief` share. Relief carves the abstract creatures
  only: while the bestiary shows, Metamorphosis passes relief 0 (flat print, as before relief).
  Texture units: print target 0, atlas field 1 and art 2 (set on every program, relief ones
  included), relief height 3 (`HEIGHT_UNIT`, was 1, which aliased the atlas field).

## Lattice camera: smooth, with turns on the beat (2026-10-22)

The user, watching Tentacle Lattice: "It's jumpy." Diagnosis came first: 60 s at 120 BPM through
the real chain (beat envelope → `flySpeed` → `update`), at 60 Hz and with 33–50 ms hitches.

| | Before | After |
| --- | --- | --- |
| Acceleration along the path (cells/s²) | 10.4 (12.3 with hitches), 50 ms after each beat | 0.32 |
| Jerk (cells/s³) | 327 (655 with hitches), 83 ms after each beat | 17.8 |
| View angular velocity (rad/s) | 1.97 | 1.45 |
| View angular acceleration (rad/s²) | 13.0 | 3.1 |

- **Root cause: the beat speed surge.** Each beat added +50 % speed through the beat envelope's
  80 ms smoothstep, so acceleration reached about 10 cells/s². A smoothstep's second derivative
  jumps, so jerk spiked at both ends of the rise. That is a lurch at 2 Hz. The view was locked to
  the path's look-ahead chord, so its turn rate scaled with speed and every surge on a curve
  whipped it. The path itself was smooth (jerk 9 at constant speed). Hitches doubled the spikes
  because each frame took the surge's step whole. The B-spline's local support already kept new
  control points from moving the curve near the camera; turns were seeded, not on the beat.
- **Fix (`lib/lattice-camera.js`):**
  - The speed goes through two critically damped stages.
  - The view turns through a critically damped angular spring toward the look-ahead point, and
    banks up to 0.18 rad.
  - Everything runs in substeps of 1/240 s or less.
  - `beat()` decides the next turn, placed at the next control point appended, about four cells
    ahead, so it never touches the visible path. In silence it turns every 8 cells.
  - The remaining sideways acceleration (≤ 4.2) is the channel corners' centripetal floor.
- **Tests** (`lattice-camera.test.js`): the 60 s beat run's bounds; frame-rate independence
  (hitched versus 60 Hz: exact for steady input, ≤ 0.02 cell and 0.03 rad with beats, which the
  hitch can delay by two frames); beat-decided turns, with idle turns only in silence. Channel
  clearance (rods, and Tentacle Lattice's worst-case tentacle envelope) still holds per structure.
  Stills of both visualizers change, as expected.

## Lattice structure seam (2026-10-22)

The Lattice family is split so structures and shading can change independently:
`shaders/lattice/README.md` is the contract (file map, structure-file and camera-provider
interfaces, pulse topology, the identity-still procedure, known quirks). One GLSL file, one JS
module and one `STRUCTURES` entry add a structure; Lattice's new **Structure** param picks it
(today: `cubic`; Tentacle Lattice is fixed to `tentacle`).

- **Byte-identical:** 11 stills (Lattice default, brass, ink over light, high + thick + fog 0.8;
  Tentacle Lattice default, each material, ink over light, high + extreme params; all at
  `still=372`) match the pre-refactor build byte for byte.
- **Two traps found on the way.** First, Pillow's `getbbox()` on an RGBA difference only looks at
  alpha, so the comparison script used before called *any* two opaque stills identical. The earlier
  Lattice/Tentacle identity sets were re-checked with an exact byte compare and do hold. Second,
  computing the node face's values up front and carrying them in a struct changed the GPU's rounding
  (1–17 pixels off by one 8-bit step). Bisected to the face mask; `shade.glsl` now asks the structure
  inside each branch (`structNodeFace` / `structStrut`), which is exact.

## Tentacle Lattice (2026-10-22)

A second builtin on Lattice's entry module and shader: `ctx.id` "tentacle-lattice" prepends
`#define TENTACLE`, and every node becomes a Tentacube-style creature (rounded cube, six tapered
tentacles reaching 30–48 % toward the neighbours). Lattice is untouched: its code path is the same
text with the define absent, and before/after stills (default, each palette, background none,
high quality + thick rods + fog 0.8, all on a beat frame) are byte-identical.

- **Tentacles are procedural** (infinitely many; no verlet): a travelling sine sway perpendicular
  to the strut, `amp × s^1.5` (0 at the root), phase and direction hashed per tentacle from its
  absolute node (uint hash, so the origin rebasing never pops them), faster and wider with the
  mids/highs (`createSway`). Taper: linear, ×1.35 flare as `(1 − s)^12` ≈ Tentacube's `e^(−12 s)`
  (cheaper than `pow`/`exp`). Worst-case envelope 0.16 cell: the camera keeps ≥ 0.15 clear of it
  and of a fully swollen cube (tested over 3 seeds × 60 s).
- **The SDF:** per axis, the nearest node's tentacle on the point's side, the neighbour's reaching
  back, and a lower bound for the node's other one; other lines of struts are bounded by
  `1 − max|w| − envelopeMax`. Wrapped in an exact proxy (rods of radius `envelopeMax` + a bounding
  sphere per cube): the bent tubes are evaluated only within 0.03 of it. An earlier along-axis bound
  (`min(u, 1 − u)`) went to 0 on the node planes and drew thin fake discs on the cubes. Step × 0.8
  near surfaces. Against a 0.5-step, 3× budget reference, 0.045 % of pixels differ (silhouette
  specks), no holes.
- **Beat (local):** the pulse's front makes each strut it reaches hand-shake — both tentacles reach
  until their tips touch and straighten (`handshake`: smoothstep in over 0.45 cell of the front's
  travel, ~70 ms at 120 BPM, hold, ease out over 0.85 cell), times the pulse's own eased amplitude.
  The pulse's node twists a quarter turn (`createTwists`: target eased over 80 ms, Tentacube's
  1.5 Hz spring, ζ 0.32 at Twitch 1); only the cube body turns. A settled quarter turn is
  invisible because the faces' spectrogram is drawn as rings, the same on all six faces and
  quarter-turn symmetric, so the slot is freed without a pop (the cube faces keep the history for
  that reason). The bass swell goes only to the nodes nearest the camera (`swellWeight`).
- **Materials:** Tentacube's `createMorph` at its "slow" pace (16 bars or a sustained energy shift,
  1.5 s smoothstep crossfade): chrome reflects a procedural sky/panel environment, iridescent is a
  thin-film cosine by view angle, emissive glows the axis colours, obsidian is near-black with sharp
  highlights. The axis band light runs root → tip as an accent.
- **Reduce motion:** sway ×0.3 (and its pace), Twitch 1 → 0.3 (Tentacube's effectiveMotion), the
  twist turns slowly and critically damped, handshakes ×0.3, swell ×0.3, plus Lattice's.
- **Cost:** 74–91 ms/frame at medium at first (handshake loops over all 8 pulse slots per strut, and
  the exact field everywhere). Fixed by packing the live pulses (`live` / `liveCount`), the
  proxy, the tight `envelopeMax` (0.24 → 0.16), one handshake per axis, and for this variant only:
  render scale × 0.85, steps × 1.1, fog × 1.5 with the march stopping at 16 cells (fading out before
  it), 3 AO samples. Harness (WebKit, 2560 × 1440, `sync=1`, `rep=4`; noisy, another app was using
  the GPU at times): low p50 6.5–7.75 / p99 10 ms; **medium (default) p50 6–11 / p99 7–12.75 ms**;
  high p50 16.5–17 / p99 20–23.5 ms (high misses 60 fps). Lattice in the same runs: 1.5–3 ms.
- The dark cross on the screen's centre lines is real: the mid-planes between node layers are
  empty (no tentacle reaches them), so rays in the planes through the camera see the fog.

## Lattice (2026-10-22)

A new builtin `webgl2` visualizer: an endless cubic lattice (a rounded cube at every node, rods
along the three axes) that the camera flies through. Params: Speed, Reactivity, Rod thickness,
Fog, Palette (steel, brass, ink), Background (fog, none), Quality (low, medium, high).

- **Render:** one full-screen raymarch by domain repetition (`p - round(p)`: exact distances, so
  rays run quickly down the empty channels) at Quality's render scale (0.5 / 0.67 / 0.85, 56 / 80 /
  110 steps), then a full-resolution composite. Headlight + key light, 5-sample AO. The fog mixes
  in display space: mixed in linear light, the cream ink fog washed the lattice out within a cell
  (and every fog looked thinner than its density on dark backgrounds).
- **Motion** (`lib/lattice-camera.js`): a seeded walk cell centre → adjacent cell centre (runs of
  2–5 cells, then a perpendicular turn), smoothed by a uniform cubic B-spline (C2) and flown by
  arc length. The spline stays ≥ 0.47 cell from every rod axis and ≥ 0.6 from every node (tested
  over 2 minutes × 3 seeds), so the cube size is capped to fit (`geometry`). The view looks 1.2
  cells ahead along the path (turns start early and turn about half as fast); `up` is parallel
  transported. Drag look-around eases back with Möbius Field's critically damped spring.
- **Music:** the beat envelope (`lib/lattice-beat.js`, tempo-locked / strong onsets, 80 ms
  smoothstep rise, back to 0 by 0.9 beat) drives only the fly-speed surge (+50 % × Reactivity) and
  the pulses. Each beat launches one pulse from the node nearest the path 1.6 cells ahead; its front
  runs 3 cells out along the rods (on the rod graph that's L1 distance, so the shader needs no
  graph walk), easing in over 80 ms and out by 0.9 beat. Nothing pumps the whole scene. Rods take
  their axis's band energy (x bass, y mids, z treble) against a 4 s auto-gain, eased and
  flash-limited; cube faces scroll a 64 × 256 RGBA8 history (spectrogram, waveform on y faces), one
  row per frame, older on cubes farther from the camera. Reduce flashing: pulses × 0.3 and ≥ 1/3 s
  apart, axis light × 0.35. Reduce motion: Speed 1 → 0.25, no surge, running light and pulse
  travel × 0.3.
- **Frame time** (harness, WebKit, 2560 × 1440, `sync=1`, `rep=4`; WebKit clamps the clock to
  1 ms, so these are coarse): low p50 2 / p99 3 ms; medium p50 1.5–2.5 / p99 2–2.75 ms; high p50
  2.5–4.5 / p99 5.75–6.25 ms; 58.8 fps throughout. Flash check under the 10 Hz strobe: ≤ 3 rises/s
  at 2 % with Reduce flashing on (lum range 0.34–0.46).
- **Not test-first:** the GLSL (no JS copy of it, by design), the entry module's GL wiring (driven by
  the harness: resize, every param flipped, dispose, no errors) and the look (tuned by stills).

## Cosmic Peanut pack: a cinematic Look (2026-10-22)

A Look param (classic | cinematic) on the sphere, Möbius and Möbius Field. Details and sources are
in `plugins/cosmic-peanut/README.md` → Look.

- **Classic is untouched, and that is checked twice.** A GL-call snapshot was recorded from the
  code before the change: every call, handles by id, arrays by hash, over 7 visualizer and param
  paths. Deterministic WebKit stills before and after are byte-identical (all six, over black
  and over the light backdrop). Cinematic objects are created only when Look turns cinematic.
- **Default stays classic.** Cinematic is better on the sphere and Möbius: smooth lines at any
  DPR, highlights that roll off instead of clipping, a soft halo. On the Field it trades classic's
  sparkle (GL lines dropping sub-pixel segments) for depth of field and softness. That is a
  different character, not clearly better, and the user had called the Field perfect.
- **Implemented from the papers:**
  - Chan & Durand 2005: prefiltered line quads; Gaussian filter, closed-form erf coverage instead
    of their cone-filter table.
  - Jimenez 2014: the 13-tap downsample, Karis average and tent upsample, energy-conserving lerp.
  - Narkowicz 2016: the ACES fit.
  - Thin-lens CoC (Potmesil & Chakravarty 1981): the blur disk's variance c²/16 is added to the
    line's Gaussian, so a line's integral is unchanged as it defocuses.
  - Jarzynski & Olano 2020 (PCG3D): grain.
- **What the stills changed:**
  - Gain moved back into display space, before the decode, as classic has it. Applied in linear
    light, lines came out ~1.4× too bright.
  - The display transfer is a 2.2 power, not sRGB. The sRGB linear toe and the ACES toe together
    left the Field's faint lines at a quarter of their brightness (mean frame 0.9 vs 5.3).
  - The Field blooms at 4%, not 12%: with the power curve, its veiling glare showed as a haze
    (median background 0 → 2/255).
  - Field DoF A = 6, not 12: at 12 nearly every band was soft.
- **WebKit** (Playwright 2359) exposes `EXT_color_buffer_float`, `EXT_color_buffer_half_float`,
  `EXT_float_blend` and `OES_texture_float_linear`. RGBA16F is complete as a render target.
  `ALIASED_LINE_WIDTH_RANGE` is [1, 1], which is why wide lines have to be quads.
- **Field budget.**
  - Quads at device resolution with DoF cost 2.7× classic; DoF fill was about a third of that.
  - A CSS-pixel scene brought it to 1.6×.
  - Distance LOD (stride 2/4/8 at 4 and 8 units) brought it to ≈ 1×: 16.5–20.5 vs 16–23 ms p50
    under heavy GPU contention, where classic's uncontended time is 5 ms.
  - The Field kept quads: they are what makes its depth of field possible.
- Möbius cinematic is ~2× classic (6.5–7.5 vs 2.5–4.5 ms p50), still 58.8 fps. Turning its DoF
  off changed nothing measurable. Flash counts under the 10 Hz strobe are unchanged (1/s, both
  looks, Reduce flashing on and off).

## Tentacube: hyperbolic drift precision (2026-10-22)

`createDrift` (lib/hyperbolic.js) kept the view as a free 2×2 complex matrix, rescaled only to
|det| = 1. Rounding error off the disk-isometry form λ·[a b; b̄ ā] grows about tenfold per 1,000
frames, because each rebase multiplies by a large tiling element. At Tentacube's speeds T(0)
left the disk after 10,662–24,899 steps (about 3 min at 60 or 144 Hz; sooner when faster).
From then on the background is NaN, and in WebKit the frame turns solid white. The rebase
could also pick a mirroring element (5,500–27,000 mirrored frames per 30,000). That's invisible
for a symmetric {p,q}, but wrong.
**Fix:** an odd fold is closed with the mirror z ↦ z̄, so the rebase is always a rotation of
the tiling. After each rebase, T is re-projected onto translate(T(0)) ∘ rotate(arg T′(0)), as
tess-disk's view does. A 30,000-step test at 30/60/144 Hz and with jittered dt, across three
tilings, holds the form error below 1e-9 and |T(0)| below 0.4, with no mirroring. The early
picture is unchanged: early harness stills (150 frames) are pixel-identical. The fold output
matches the old code to 1e-10 over the first minute, with the same tile generations.

## Tessellations: relief, the carved block, and music that moves it (2026-10-22)

The engine can now carve the tiling into the block a woodcut is printed from, and the music drives
that block in 3D. Metamorphosis is the showcase (Relief, Light params); the other surfaces adopt
it later. Relief off is byte-identical: `run.py --shots` stills of Metamorphosis (Relief 0), Tile
Horizon, Endless Zoom and Tiled Sphere match the pre-relief build (`cmp`).

- **Block** (`tess.glsl` under `#ifdef TESS_RELIEF`, mirrored and tested in `lib/tess.js`): tiles
  are raised blocks over a groove floor at 0, height RELIEF_BLOCK (0.07) × Relief × a profile of
  the tile's interior distance, bevel (tops out 0.05 in) to dome (crown at the centre),
  `u_tRelief.y` (0.35); slope ≤ 2 / 0.05, so a height-field march is safe. Gouges are cut 0.012
  and features (eye, spine, fins, star) raised 0.014 as fine detail for the normals only.
- **Music** (`lib/tess-music.js`, allocation-free, tested): every beat (tempo-locked when
  confident, strong onsets otherwise) sends a front from ring 0 to 1 over 1.5 beats (≥ 0.6 s);
  each ring's tiles lift with an 80 ms smoothstep, then settle as a spring released from rest
  (2.2 Hz, ζ 0.6: a ~10 % dip, at rest by 0.9 s, no slope jump). A bar's first beat lifts 0.18
  plane units at Reactivity 1 and Relief 1 (others 0.7 of it), so at the defaults a beat lifts a
  tile by a fifth of its width. Up to 8 waves in flight; a beat with no free slot is dropped,
  never cut short. Spectrum heave: 64 bands → 32 ring bins (bass inner, treble outer), each over
  its own decaying peak (τ 6 s), eased (up τ 0.1 s, down 0.3 s) and blurred over neighbours,
  0.07 peak. Onsets pop single tiles near the newest front (hashed choice, 0.06, 80 ms up,
  0.25 s down, 3 slots). Each tile varies ± 30 %. Reduce motion: lifts × 0.4, spreading half as
  fast. Reduce flashing: lifts and pops × 0.4 (their shadows pump the mean light less).
- **Cards**: in relief the figure/ground cross-fade becomes each tile turning over (θ = π ×
  the old fade, same flash limit, Reduce flashing still 19.2 s and narrower, hop 0.08 → 0.02).
  The card is squeezed by |cos θ| across its axis (radial from the ring origin) in the warped
  plane q, not p: the true p-space centre would need the warp's inverse per tile. It is drawn
  unmirrored on its back, so at θ = π it is the tile itself in its new colour and the shift
  lands without a jump. Its height is shallowed (CARD_RISE 0.3): at full height edge-on cards
  stood as tall walls the march smeared. Outside the squeezed tile the bare bed shows.
- **Metamorphosis**: a height pass (the surface compiled with `TESS_HEIGHT_PASS`) writes the
  block's height at 0.35 × the print resolution over the view × 1.12. Then each pixel marches its
  perspective ray (camera 2.2 half-short-sides above the centre, resting tops where the flat
  print has them) down from the current bound `u_tRelief.z` (`lib/tess.js reliefBound`: lower
  when nothing lifts), stepping every 3 height texels of lean (1–16 steps, jittered), with 5
  bisections. Shading uses the analytic block gradient plus the fine carving's screen
  derivatives, cut sides of taller neighbours, a soft shadow marched towards the light (≤ 8
  steps), darker grooves and a faint sheen. A flat top in full light prints at its colour. Light
  is 0–360° round the view at 32° elevation (default 135°, upper left).
- **Motion** (`motion_hook.py`, synth music, Reduce flashing off, relief default vs Relief 0,
  which is the old build): loud 0.0131 → 0.0275, loud/silence 0.90 → 1.56. With the drift
  stopped (Speed 0), only the music moves it: loud 0.00118 → 0.0222 (19×). The beat ratio
  (150 ms after / before a strong onset) is 1.01 → 1.04 because waves now overlap continuously.
- **Cost**: WebKit harness, 2560×1440, Quality high, `sync=1`, measured alternately with the
  flat print on a GPU shared with other agents. Relief p50 11–16 ms, p99 25–27 ms, 55.6–58.8 fps;
  flat 7–14 / 8–29 ms in the same runs (one earlier relief run 20 / 28 ms at 45 fps under load).
  Roughly 1.3–1.6× the flat print. Flash check (10 Hz strobe): Reduce flashing on 0 /s at 5 %;
  off 1 /s at 5 % (2 at 2 %), from the lifted tiles' shadows, under the 3 /s limit.
- **Known**: a turning card's cut sides show a fine fringe where the coarse height texture
  steps. Detail normals use `dFdx`, so they're coarse at silhouettes.

**The relief seam** (`#define TESS_RELIEF` before `// #include tess`; `createTessPipeline(ctx,
surface, { relief: true })` also builds the `TESS_HEIGHT_PASS` variant and binds its target as
`u_tHeight` / `u_tHeightTexel` while `state.relief > 0`):

```glsl
vec3 tessRelief(vec2 p, mat2 S);   // height (plane units, 0 … u_tRelief.z) and dh/dp
vec4 tessShadeRelief(vec2 p, mat2 S, out TessPlate r, out float detail);
// r: tile, J, blend, h, grad (dh/dp), prof, face (0 front, 1 back), pit; detail = fine carving
// optional hook: #define TESS_FLIP_DIR(c) …  (unit direction across a card's axis; default radial)
```

A surface either **displaces geometry** with `tessRelief(p, S).x` along its normal (floor, torus,
sphere: raymarch with `u_tRelief.z` as the bound; Tiled Sphere does, see its section), or **shades it as relief** like Metamorphosis
(flat, zoom: height pass plus a per-pixel march). The state gains `relief`, `profile`, `lift`
(32 bins), `pops` (3 × vec4), `flipHop`, `flipping` and `reliefMax`, and takes `relief` (0–1)
in the options. Everything a flat surface reads is unchanged (tested frame by frame).

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

**The 3D scene (Scene = sphere, the default since 2026-10-23).** A lacquered coin carrying the
print floats in a large sphere tiled inside (Tiled Sphere's cube-sphere), turning the other way.
Flat is the print alone and still renders byte-identically to b1700b2 (`run.py --shots --prefix
_base/` against a `git archive` of b1700b2: default and {5,4}/watercolour/drums, black and light).
- *Pieces:* `lib/disk3d.js` (tested): waveform rim (trigger, seam), coin spin (mids) and
  spinning-plate tilt (bass, beat surge), counter-spin, beat kicks, `rippleLift`, `specLift`, the
  music drive and the camera director (orbit, swoop, skim, pull-back; clearance, phrase moves,
  drag, still). `tess-disk.js` view `nudge()` (exact kick) and `tracked` (impact point carried
  through rebases). `shaders/tess/disk3d.frag`: ray-marched coin (waveform rim, brushed metal),
  face = `diskShade` + lacquer (GGX, Fresnel, a cheap one-warp-step wall reflection), parallax
  ripple/heave and lift shading, treble glints on gouges, AO, the wall (fogged paper), an ink
  silhouette. Shared includes `disk.glsl`, `sphere.glsl`; `tess-gl.js` splices `// #include`.
- *The music drive* (`createDrive`) paces the camera's path, the coin's spin (and so the
  counter-spin) and the tiling's drift: 0.25 in silence (eased over 1.5 s), 0.6 with music at
  average bass, + 1.2 × the passage's bass (lag 0.8 s: energy, not the beat) + 3 × an eased beat
  surge (the beat envelope through two 35 ms lags). Times the Speed param for the drift and the
  camera. The camera director takes `intensity` (surge + the passage's bass) and widens each
  move's swing by it (lag 0.12 s): orbit and pull-back bob and lean in, the swoop rises higher and
  closer, the skim dips. Kicks 2.4 hyperbolic units/s at the envelope's peak (was 0.9); ripple
  0.1 world units high (was 0.05), reach 1.1 (was 0.7); heave 0.06 (0.035); bass tilt 0.35 rad
  per unit (0.22), beat tilt 0.14 (0.06), tilt spring 9/s (6); mids spin gain 2 (1.2).
- *Why the drive:* the old pace was the tess glide (1 at rest, ~1.3 loud), so silence moved
  nearly as much as music, and bass read through `bassAtt` arrives late (the att lag), so a
  bass-driven swing put motion just *before* the next beat. Ablations (motion profile folded on
  the beat) showed the camera's pace carries most of the beat shape at the probe's scale; the
  kicks and ripples are local and read in stills, not in the 96 × 54 probe.
- *Motion* (`motion_hook.py poincare-disk --query "p.scene=sphere&p.camera=…&reduce=0"`):
  auto camera loud/silence 0.98 → 5.52, beat ratio 1.06 → 1.22; still camera 1.20 → 5.37,
  1.11 → 1.18. loud/quiet stays ~1.0: the synth's quiet passage only scales levels, and every
  drive input is normalized (att, the beat).
- *AO* (a few samples): on the face, a horizon test against the carved outline as a tile-scaled
  V groove (half-width 0.045 tile units, depth 0.6 of that; faded out under ~12–40 px tiles) at
  0.5, 1 and 2 half-widths either side, and against the relief (ripple and heave) in four
  directions at 0.04 and 0.1 world units; on the rim, three samples of the coin's SDF along the
  normal. Replaces the old closeness-gated darkening (`u_near` is gone).
- *Bumps, cleanly:* the bigger ripple folded the parallax-mapped print on its far slope
  (dw′/dw = I + pc ∇hᵀ goes negative): the shift is scaled to keep pc·∇h ≥ −0.6 and the print's
  Jacobian includes it. The wall's reflection was minified to a speckle on the bump: it fades to
  0.9 × the wall's mean colour as the slope rises (0.02–0.12). Glints fade under ~4 px gouges.
- *Framing:* the skim comes in low over the rim (r 0.95, y 0.42) looking across the face to its
  far side, so the face fills the lower frame (it used to look along a tangent, mostly at the
  wall); the swoop's look-at stays within 0.2 of the centre. `director.force(move)` jumps
  straight to a move (tests; stills via a temporary `?move=` hook, not committed).
- *Cost:* WebKit harness, 2560×1440, Quality high (the default; flat needs it to stay
  byte-identical), `sync=1`, one render per vsync: 58.8 fps, p50 9–12 ms, p99 10–22 ms in most
  runs; one run under heavy contention 17 / 31 ms at 55.6 fps (Metamorphosis 12 ms in the same
  minute, against 6–8 in its notes). Two renders per vsync: ~7.5 ms each at high (55.6 fps),
  ~4.5 ms at medium (58.8 fps); Metamorphosis ~6–6.5 ms each. So high is about 1.2× Metamorphosis
  and holds 60 fps here; medium is the fallback for the M1 reference machine (not measured
  there). Flash check (`--flash`): 1 flash/s at 2 %, 0 at 5 % with reduce flashing off; 0 and 0
  with it on.
- *Invariants:* the view rebases by rotations only, re-projects T each frame, and records `e0`
  (colours stay put across rebases; the shader's fold starts at u_gE0). The 3D state runs
  symmetry p4 (the wall needs it) with u_tCls overridden by `threeClassColors`; flat runs p3.
  The face colour comes from `tessPrint` via `diskShade`; lighting and AO apply after it.
- *Gotchas:* take all dFdx before branches (face chart = analytic plane hit, wall direction
  computed for every pixel); a face-plane hit inside the printed disk skips the march (nothing
  rises above the face). `DISK_IMPACT` must be defined before `// #include disk`. The ripple's
  constants (speed 3, reach 1.1) are duplicated in disk3d.frag `rippleLift`.
- *Open:* the thumbnail is still the flat print; the wall's colouring is Tiled Sphere's (two
  classes plus seam tiles); not measured on the M1 reference machine.

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
  rad, fly 0.2 rad, tile flow 0.004 turns along the ring per unit of travel (the spin round the
  tube: see Spin and twist below).
  TESS_RING runs along the ring, 0 at the camera's azimuth to 1 half a turn away both ways, so
  figure/ground fronts and the spectrum rings travel around the torus from the viewer.
- **Cost** (WebKit harness, 2560×1440, Quality high, `sync=1`, GPU shared with other agents:
  Metamorphosis measured 8 / 13 ms p50 / p99 at the same time, against 6–8 / 7–11 above):
  outside p50 5 ms, p99 9–10 ms (p3 the same); inside p50 12 ms, p99 17 ms (full-screen tiles
  plus the march), 58.8 fps for both. Two renders per vsync inside still hold 58.8 fps (7.5 ms
  each); three drop to 18.5 fps. CPU < 0.1 ms. Flash check: 0 flashes/s at 2 % and 5 %, reduce
  flashing on and off. Untested on the M1 reference machine; Quality medium brings an
  inside render to about 5 ms (from 7.5).

**Waves (2026-10-23).** The waveform deforms the torus: each ring is born at the hole and rolls a
full lap round the tube (hole → top → outer equator → underneath → hole) at full height; just
past the hole the finishing waves cross-fade into the newborn ones over BIRTH (0.2 lap), so the
lap closes with no step and no dip. Rings close round θ by cross-fading the window's tail into
its start (no taper). The beat stamp (1 + envelope; 80 ms rise, gone by 0.9 beat) and the bass are
baked into the row being pushed: nothing on the surface changes size on a beat. Cost (WebKit,
2560×1440, `sync=1`, interleaved with Metamorphosis under the same shared-GPU load): outside
4 ms p50 / 5–6 ms p99, inside 6–7 / 7–8 ms, Metamorphosis 6–7 / 7–9; 58.8 fps everywhere.

**Spin and twist (2026-10-23).** The tiles roll round the tube: the spin shifts the conformal t
(not φ), so tiles stay square, growing over the outer equator and shrinking into the hole. Rate =
`SPIN` (1/60) × Spin param × glide travel: Spin is turns a minute at rest (travel 1/s at Speed 1),
signed, −2…2, default 1; bass and the eased beat surge speed it up (tested: never reverses, the
per-frame rate change stays < 15 % of the base under kicks). Reduce motion: × 0.4 on top of the
glide's × 0.25. Twist (0–2 half-turns a lap, default 0) adds tw · θ/2π to t, so the tiles stream
round the ring in a helix; `twistTurns` snaps tw so ly · tw is a whole number of BLEND_PERIOD y
periods (tested closed across θ = ±π for p4 and p3, with spin), and S gains its shear term. The
waves stay on the geometry: `disp()` and torus-disp.frag never see `u_flow` / `u_twist` (a source
test guards it), so the tiles slide over waves that keep rolling hole → top → outer equator.
Inside, the whole wall turns round the camera. Cost unchanged (WebKit, 2560×1440, `sync=1`,
interleaved, shared GPU): outside 4–5 / 5–6 ms p50 / p99, inside 6–6.5 / 7, Metamorphosis 6–6.5 / 7;
58.8 fps; Twist 2 the same. Stills: scratchpad `shots/torus-spin-*.png` (outside, inside, spin 0
vs 1 at the same frame, twist, p3 twist 2).

**Handoff for the next agent (Tiled Torus):**
- Wave history: `src/lib/torus-wave.js` `createWaveHistory` (trigger, auto-gain, `resampleLoop`
  seamless θ, `smoothRing`, `SHAPE_BLEND`, `ROW_SLEW`, stamp/bass in `rowGain`); one R16F row per
  push (COLS 128 × ROWS 72, LAP_ROWS 56 a lap). `dispAt` is the tested definition of the surface.
- Displacement: `shaders/tess/torus-disp.frag` bakes it each frame into a 512×256 R16F map over
  (θ/2π, age), REPEAT both ways; `torus.frag` `disp()` is one bilinear tap × `u_amp`. Needs
  `EXT_color_buffer_float`; without it `amp` = 0 (smooth torus).
- March: `torus.frag` main loop, exact shell skip (|sdTorus| − `u_dmax`) then over-relaxed
  (ω 1.5) steps of f × `u_stepK`; `stepFactor` (JS, per frame) bounds |∇disp| from the history and
  is tested against the real gradient; `liveDisp` sets the shell. Rays that run out of steps in the
  shell are projected onto the surface.
- Clearance: `maxDisp` ≤ 0.45 k (tested), so the inside camera (on the centre circle) is ≥ 0.55 k
  from any wall. Uniforms: `u_dispMap`, `u_amp`, `u_dmax`, `u_stepK`, `u_flow` (fu, fv), `u_twist`, `u_side`.
- Gotchas: the march cost is grazing walls inside the tube (hence `insideScale`, switched under
  the paper fade, and the fog-scaled tolerance); row-to-row cliffs (beat stamps) shrink the step
  factor 2–3×, hence the slew limit; zsh doesn't word-split `$var` in loops; the shared scratchpad
  gets overwritten by other agents, keep scripts in your own folder.
- Spin / twist: `SPIN`, `REDUCED_SPIN`, `twistTurns`, `planePoint(…, tw)` in `src/lib/torus.js`;
  camera `fv` is the spin; uniform `u_twist`. Tiles only: keep the displacement free of them.
- Left: adopting the relief engine once it's merged.

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

**Relief (2026-10-23).** Tiled Sphere adopts the engine's carved block (Relief 0–1, default 0.6;
Light 0–360°, default 135°): the tiles lift off the globe along its normal, outward from outside
and inward towards the camera from inside (the dome breathes round you), cast soft shadows and
catch a raking light. Relief 0 is the flat program, byte-identical (`run.py --shots`,
still=150 after the backdrop warm-up page, `cmp`: outside and inside, black and light), and so are
Metamorphosis (default, relief on) and Poincaré Disk (its wall includes `sphere.glsl`).

- **Height**: the sphere's `TESS_HEIGHT_PASS` writes the six face charts, each ATLAS_MARGIN (0.06
  plane units) wider than its face, into a 3 × 2 atlas of the height target (2560×1440 high: ~298 ×
  252 texels a face, ~40 a tile). `heightAt(dir)` picks the face as the colouring does. Heights
  are plane units; `planeToWorld(N)` = π/2N converts them (a face's axes are linear in angle).
- **March**: the ray's stretch through the shell (skin … radius 1 ± u_dispK × u_tRelief.z, the
  tested bound) in ceil(texels crossed / 4) steps (1–12, jittered), then 5 bisections. A ray that
  reaches the skin ends on solid ground (heights ≥ 0), so it always hits. Misses inside the shell
  antialias from their least clearance; the paper round the sphere skips the print.
- **Across the charts**: the height is continuous over cube edges and corners (tested from both
  charts along all 24 sides, with the warp, a wave part way out, cards turning and pops:
  `cube-sphere.js tileRelief`, the JS mirror of tessPlate with the sphere's hooks). Two things
  needed it: a tile split by an edge hashed its cell (lift ± 30 %, pops) in each chart's own
  coordinates, so its halves stood at different heights; and a card's turning axis must be one
  direction. `sphCell` keys a tile by its owner's cell (faces 64 apart) and `sphFlipDir` turns
  cards away from the pole (the fronts' direction, a terminator sweep via `TESS_RING`), taken in
  the owner's chart and turned back by the crossing's quarter turns.
- **Engine change (tiny, additive)**: an optional `TESS_CELL(cell, c)` hook in tess.glsl (default
  `cell`) for the id tessPlate hashes. Every other surface compiles as before.
- **Clearance**: `reliefScale(dist, reliefMax, N)` keeps the shell CLEARANCE (0.12) from the eye:
  full at D_OUT and D_IN (even at Relief 1 with loud music), flattening as the push nears the
  skin and 0 within CLEARANCE of it, so the tiles turn from outward to inward unseen. Tested over
  a whole push, frame to frame, and at the tallest possible block.
- **Light**: `viewLight` turns lightDir round the view (so it rakes alike whichever way the camera
  looks). Shading: a flat top where the light stands ≥ 30° high prints at its colour, darkening
  towards the terminator; cut sides, grooves (AO), shadows (≤ 8 steps), a faint sheen; the old
  limb shade on top.
- **Motion** (`motion_hook.py tiled-sphere --query "reduce=0&p.view=…"`, before → after): outside
  loud 0.0022 → 0.0091, loud/silence 0.90 → 3.05; inside loud 0.0182 → 0.0235, beat ratio 1.02 →
  1.31. With the turn stopped (Speed 0), only the music moves it: outside 0.00017 → 0.0085 (50×),
  inside 0.0014 → 0.0170 (12×). Outside the beat ratio is 1.26 → 0.76: the waves overlap
  continuously and a front reaches the visible side some way after the onset, as the pole turns
  with the sphere.
- **Cost** (WebKit, 2560×1440, Quality high, `sync=1`, interleaved with Metamorphosis on a GPU
  heavily shared with other agents: Metamorphosis 7–16 / 11–35 ms p50 / p99, against 6–8 in its
  notes): outside 4–9 / 11–17 ms, 58.8 fps; inside 11–18 / 13–33 ms, mostly 58.8 fps, dips to
  42–53 fps in the most contended runs (Metamorphosis 55.6–58.8 in the same minutes). Inside is
  roughly 1.3–1.5× Metamorphosis; not measured unloaded or on the M1 reference machine. Flash
  check (`--flash`): outside 1 /s at 2 %, 0 at 5 %; inside 2 and 0; Reduce flashing 0–1 and 0.
- **Known**: the jittered march leaves fine grain on cut sides at grazing angles near the limb;
  the thumbnail is still the flat print.

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
