# The Lattice family: structures, shading and the seam between them

Lattice (`lattice`) and Tentacle Lattice (`tentacle-lattice`) share one entry module,
`src/lattice.js`, and one raymarch. What the camera flies through is a **structure**. To add one,
write one GLSL file, one JS module and one table entry. Shading work only touches `shade.glsl`,
`brdf.glsl`, `post.frag` and `bloom.frag` (and their `lib/lattice-look.js`, `-lights.js` and
`-bloom.js`). You shouldn't need anything else from this repo's history.

## File map

| File | Owner | What it is |
| --- | --- | --- |
| `shaders/lattice/lattice.frag` | shared | `main()`: builds the ray, calls `march`, then `shade`. Holds the `// #include` lines. |
| `shaders/lattice/common.glsl` | shared | Uniforms every part may read, `FACE_ROWS` / `NODE_ROWS`, and `sdRoundBox`. |
| `shaders/lattice/structure-<name>.glsl` | structure | The structure-file interface below. |
| `shaders/lattice/march.glsl` | shared | `sceneSDF(p)` wrapper, `calcNormal`, `march` (the sphere tracer). |
| `shaders/lattice/shade.glsl` | shading | Light, `MATERIALS`, AO, history and running-light emission, pulse glow, ink, fog. Classic under `#else`, cinematic under `CINEMATIC`. |
| `shaders/lattice/brdf.glsl` | shading | Cinematic only (prepended to `shade.glsl`): BRDF, split sum, thin film, in-scatter, tone inverse. |
| `shaders/lattice/post.frag` | shading | Composite: upsample the scene pass to premultiplied sRGB, with dither (cinematic: bloom + tone curve). |
| `shaders/lattice/bloom.frag` | shading | Cinematic bloom chain: 13-tap / Karis downsample, tent upsample. |
| `src/lib/lattice-look.js` | shading | Look param, tone curve and inverse, alpha rule, sample counts, palette materials. |
| `src/lib/lattice-lights.js` | shading | Pulse tube lights: `strutFrontLights`, `pointPulseLight`, the per-frame pack. |
| `src/lib/lattice-bloom.js` | shading | Bloom level sizes and targets (allocated per resize), the chain's draws. |
| `src/lattice.js` | shared | Entry: params, music, history texture, pulses, camera, uniforms, the two passes. |
| `src/lib/structures.js` | shared | `STRUCTURES` table, `structureFor`, `assembleShader`, `NEAR_CLEARANCE`. |
| `src/lib/structure-<name>.js` | structure | `<name>Runtime(ctx)` and `<name>Clearance(pos)`. |
| `src/lib/lattice-camera.js` | shared | `createCamera(seed)`: the cubic channel path (the camera-provider interface). |
| `src/lib/lattice-pulses.js` | shared | `createPulses(snap)`: the beat-pulse pool. |
| `src/lib/lattice-beat.js`, `lattice-history.js`, `lattice.js` | shared | Beat envelope, history ring, params, palettes, axis light. |
| `src/lib/tentacle-lattice.js` | tentacle | Pure tested logic mirrored by `structure-tentacle.glsl`. |
| `src/lib/strut-camera.js` | strut lattices | `createChannelCamera(seed, walk)`: the cubic camera's motion over any channel walk. |
| `src/lib/structure-{octet,diamond,bitruncated}.js` | strut lattices | Runtime, clearance, walk, and tested JS mirrors of the shader's distance and pulse metric. |

The scene shader is assembled as `assembleShader(lattice.frag, { common, structure, march, shade },
entry.defines)`. Each `// #include <name>` line is replaced by that part. Each define becomes
`#define NAME` right after `#version`. The include order is common → structure → march → shade, so
a structure may use anything in `common`, and `march` / `shade` may use anything the structure
declares.

## The structure-file interface (`structure-<name>.glsl`)

Coordinates are cells, relative to the integer origin `u_origin`. `u_cam` is the camera in that
frame. Use `p + u_origin` (as integers) when you need a stable per-cell hash.

```glsl
// Constants
const int   STRUCT_MAX_STEPS;       // loop cap of the march (the JS budget u_steps is ≤ this)
const int   STRUCT_AO_SAMPLES;      // AO taps along the normal...
const float STRUCT_AO_SPACING;      // ...at 0.02 + spacing × i, i = 1..samples
const float STRUCT_HIST_GAIN;       // node-face history brightness
const float STRUCT_HIST_INK;        //   less this × u_ink on paper
const float STRUCT_HIST_FADE;       // histEdge where the history starts fading (it is 0 at 1)
const float STRUCT_RUN_GAIN;        // strut running-light brightness
const float STRUCT_PULSE_GAIN;      // pulse glow on struts
const float STRUCT_NODE_PULSE_GAIN; // pulse glow on node faces
// optional: #define STRUCT_FAR_FADE  — fade the surface into the fog over 0.7–1 × u_far
//           (use it when `far` in the table is short, so the march limit never shows as an edge)

// Geometry
float sceneSDF(vec3 p, out int id); // distance bound and material id at p
float structStep(float d);          // how far the march may advance from sceneSDF's d
float pulseMetric(vec3 a, vec3 b);  // how far a pulse front travels from b to reach a

// Surface parameterization (shade.glsl asks these inside its branches; see "rounding" below)
int  structKind(int id);            // 0: node face (shows the history), 1: strut (running light)
int  structAxis(int id);            // 0/1/2: which band lights and tints it (x bass, y mids, z treble)
void structNodeFace(vec3 p, vec3 n, int id, out vec2 histAt, out float histWave,
                    out float histEdge, out vec3 pulseAt);
     // histAt = (band 0–1, age in rows before the newest); histWave 0 spectrogram / 1 waveform;
     // histEdge 0 at the face centre → 1 at its edge; pulseAt = where pulse fronts are measured
void structStrut(vec3 p, vec3 n, int id, out float runPhase, out vec3 pulseAt);
     // runPhase: the running light's phase in cycles (the light moves toward increasing phase)
```

**The distance guarantee.** The march advances `structStep(sceneSDF(p))`. That advance must
never exceed the true distance from `p` to the surface. If `sceneSDF` is exact (Lipschitz 1),
`structStep(d) = d`, as in cubic. If it is only a bound with Lipschitz constant L, return `d / L`.
Tentacle returns 0.8 d when d < 0.2: its bent tubes are approximate (L ≈ 1.25), and its far field
is an exact proxy, so it takes full steps there.

Two techniques keep a costly SDF fast, both used in tentacle:
- **Exact proxy:** a cheap, exact lower bound (cylinders and spheres around all geometry). Return
  it whenever it exceeds a small margin.
- **Per-family early-outs:** skip a group of geometry whose bound is already farther than the best
  distance so far.

Hit test: `d < 0.0008 + 0.0015 t`. The camera's near plane is 0.02. `u_far` is the march limit.

**Material ids** are the structure's own. `shade.glsl` only sees them through `structKind`,
`structAxis` and `structNodeFace` / `structStrut`. Pass the same `id` back that `sceneSDF`
returned.

**Rounding: ask inside the branch.** `shade.glsl` calls `structNodeFace` inside its node branch
and `structStrut` inside its strut branch. Computing those values earlier and carrying them in a
struct gave the same images to within one 8-bit step at a few pixels. It wasn't wrong, but it
broke byte-identity. Keep it this way.

## The structure table (`src/lib/structures.js`)

```js
STRUCTURES[name] = {
  shader: "structure-<name>.glsl",
  defines: [],            // e.g. ["MATERIALS"] turns on shade.glsl's material crossfade
  camera: (seed) => CameraProvider,
  pulseSource: (point, out) => out, // pulse topology: where a pulse launched near `point` starts
  clearance: (pos) => number,       // free distance (cells) vs worst-case geometry, any params
  scale, steps, fog,      // × Quality's render scale, × its march budget, × fog density
  far,                    // march cap (cells)
  runtime: (ctx) => StructureRuntime,
  pulseLights,            // optional: the cinematic look's pulse-light topology (see "Shading")
};
```

`StructureRuntime` is `{ onBeat(source), step(audio, dt, f), upload(gl, u, f), params(changed) }`.
`f` is the `StructureFrame` `{ react, live, bpm, origin, pulses }`. The hooks run in this order:
1. `onBeat` right after a pulse launches;
2. `step` once a frame, after the pulses step;
3. `upload` with the scene program bound, after the shared uniforms.

None of them may allocate per frame. Upload only your structure's uniforms; the entry already
uploads everything in `common.glsl`.

Lattice's **Structure** param lists `STRUCTURE_OPTIONS`. Add your name there and to the manifest
(`plugins/builtin/tidalviz.json`, plus its test in `tests/test_builtin_manifests.py`). Changing
the param recompiles the scene program and swaps the runtime; the camera and pulses carry on.
Tentacle Lattice is a separate visualizer id, fixed to `"tentacle"` by `structureFor`.

`src/lib/structures.test.js` runs against every table entry. It checks the shape of each entry,
and it flies each entry's own `camera` for 60 s × 3 seeds requiring `clearance > NEAR_CLEARANCE`
(0.15) all along. It also requires `clearance` to be negative inside the geometry. So a new entry
is tested as soon as it's in the table.

## The camera-provider interface

`camera(seed)` returns an object with:
- `pos`: Float64Array(3), world cells.
- `view`: `{ fwd, up, right }`, unit and orthogonal, with the bank and the drag look-around
  applied. These are what the shader gets.
- `fwd`, `up`, `right`: the camera's own basis, unbanked.
- `update(dt, speed)`: fly on for `dt` seconds toward the target `speed` (cells/s). It must be
  smooth on its own: the beat surge arrives as an 80 ms step in the target, and frames can hitch
  to 50 ms. Integrate in substeps and filter the speed and the view (see below).
- `beat()`: called on every beat. Use it to decide the next turn, placed beyond the view.
- `ahead(dist, out)`: the path point `dist` cells ahead (beat pulses launch 1.6 cells ahead).
- `pointer(e)`: drag to look around; it eases back on release.

`createCamera` (cubic channels) walks cell centre to cell centre through the free channels between
the struts, smoothed by a C2 cubic B-spline. Its smoothness design, which any new provider should
copy:
- **Turns are decided on the beat.** A turn is placed at the next control point appended, about
  four cells ahead. A B-spline segment depends only on its four points, so nothing the camera is on
  or looking at moves.
- **Speed** goes through two critically damped stages (rate 5/s), so the beat surge is a push, not
  a lurch.
- **The view** turns toward the point 1.2 cells ahead through a critically damped angular spring
  (6/s), banks up to 0.18 rad, and carries `up` by parallel transport.
- **Substeps:** everything runs in steps of 1/240 s or less.

`src/lib/lattice-camera.test.js` has the smoothness tests to reuse: a 60 s, 120 BPM run bounding
acceleration along the path (< 1 cell/s²), jerk (< 25), angular velocity (< 1.6 rad/s) and angular
acceleration (< 4 rad/s²); frame-rate independence; and beat-decided turns.

Any structure with a different free space needs its own provider, e.g. the tunnel centre line of a
minimal surface, or a zoom path for a fractal. It must keep `clearance` positive.

## Pulse topology

A beat launches a pulse at `pulseSource(cam.ahead(1.6))`. `createPulses(snap)` keeps up to 8
pulses: a source point, and a front that travels 3 cells (× 0.3 under Reduce motion) over 0.9 beat
with an eased amplitude. The shader lights a surface point by how close
`pulseMetric(pulseAt, source)` is to the front distance. `u_pulse` / `u_pamp` hold all slots;
`u_live` / `u_liveAmp` / `u_np` hold the live ones packed first, for loops inside the SDF.

- **Strut lattices:** `pulseSource` is the nearest node. `pulseMetric` is the shortest path on the
  strut graph: L1 for the cubic grid. For other trusses, use the graph distance (or a tight
  approximation of it).
- **Structures without struts:** choose a curve or surface that the light runs along.
  - For a tunnel or minimal surface: snap the source to the tunnel's centre-line point and make
    `pulseMetric` the distance along the wall (geodesic, or Euclidean if close enough). Return
    `pulseAt` from the surface point.
  - For a fractal: snap the source to the current zoom centre and measure Euclidean distance.

  Fronts are then rings spreading over the walls instead of lights running along struts.

## Strut lattices: octet, diamond, bitruncated

Three more options of Lattice's Structure param, all period 2 (the shader adds `mod(u_origin, 2)`
back so the integer origin can move freely), exact SDFs (`structStep(d) = d`), and no beat
reaction besides the pulses.

| | Octet truss | Diamond | Bitruncated cubic honeycomb |
| --- | --- | --- | --- |
| Nodes | FCC (even coordinate sum), rounded cubes | A = FCC, B = A + ½: atoms (spheres) | truncated-octahedron vertices: small balls |
| Struts | 12 per node, face diagonals, length √2 | 4 per atom, ⟨111⟩, length √3/2 | 4 per vertex, the cells' edges, length √2/2 |
| Distance | 6 line families, 2 roundings each | nearest A and B atoms, their 8 bonds | fold into a chamber: 2 edges, 1 vertex |
| Axis bands | by the coordinate plane a strut lies in | 3 bond directions → x/y/z; ⟨111⟩ bonds by layer | by the plane of the edge's face |
| Pulse metric | exact (FCC hops, nearer strut end) | exact (Σ\|d·vⱼ + σ/4\|) | estimated at vertices (sodalite net) |
| Camera channels | ⟨110⟩, 0.37 from strut axes | ⟨110⟩, 0.61 | ⟨100⟩ 0.35, ⟨111⟩ 0.61, via cell centres |
| Worst clearance flown | 0.19 | 0.49 | 0.28 |

- **Camera:** `lib/strut-camera.js` is `lattice-camera.js` with the walk handed in as a
  `ChannelWalk` (`start`, `next(turn, rand, out)` → 1 turned, 0 straight at a junction, −1 no
  junction here). Same B-spline, beat-decided turns, speed and view springs and substeps.
  `stepWalk(steps, start, dir, every)` covers walks whose junctions repeat every `every` points
  (octet, bitruncated); diamond walks the dual network's bond midpoints, where every point is a
  junction of three channels. Turns are at most 90° (60° for octet and diamond).
- **Tests:** `strut-structures.test.js` checks each JS mirror against brute force over explicit
  nodes and struts (distance exact, march-safe, nearest-node pulse source, graph distance by BFS),
  and flies each walk with a beat every half second at the worst-case geometry.
  `strut-camera.test.js` holds each camera to the cubic smoothness bounds.
- **Cost** (1440p, medium, GPU synced): p50 / p99 per frame octet 4.75 / 6.25 ms, diamond
  8 / 9.5, bitruncated 4.5 / 6.25 (cubic 1.5 / 2). Diamond is the dearest: 8 bonds a step.

## Identity stills (proving a refactor changes no pixels)

1. Serve the repo from `plugins/_harness`'s parent:
   `python3 -m http.server <port> --bind 127.0.0.1` (in tmux).
2. Before the change, take deterministic stills of every visualizer you touch, with several
   params:
   `index.html?repo=builtin&viz=<id>&still=372&<p.param=value…>` (`still=N` fixes the steps at
   60 Hz and seeds `Math.random`; frame 372 is just after a harness beat). Use a Playwright
   WebKit page at 1280 × 720, `device_scale_factor=2`. `run.py --shots DIR --tag before` does
   this at `still=150` for the default params.
3. After the change, take the same stills and compare **every byte**:
   `uv run --with pillow python -c "import sys;from PIL import Image as I;a,b=(I.open(p).convert('RGBA').tobytes() for p in sys.argv[1:]);print('IDENTICAL' if a==b else 'DIFFER')" before.png after.png`.
   Do **not** use `ImageChops.difference(...).getbbox()` on RGBA images: Pillow's `getbbox` looks
   at the alpha channel only, so any two opaque images look "identical". Check your comparer
   once against two different stills.
4. Shoot several stills in one browser page, and throw away the first: the first page a fresh
   WebKit renders can differ from later loads of the same URL. Before 2026-10-23 `still` mode's
   clock also started at `performance.now()`. Its frame steps then rounded differently from run
   to run, and Lattice's camera could fly two different paths. The clock now starts at 0.

The scratchpad is shared between agents. Keep your helper scripts in a folder of your own.

## Shading: the Look param

Both visualizers have **Look**: `classic` (the default) or `cinematic`. `lib/lattice-look.js`
`lookDefines` adds no define for classic, so its shader text is exactly the original (its stills
are byte-identical to the build before the cinematic look). Cinematic compiles the scene with
`brdf.glsl` prepended to `shade.glsl` and `#define CINEMATIC`, and runs the bloom chain and the
tone curve in the composite.

### The cinematic shading model

Everything is HDR linear radiance until the composite.

- **One BRDF for every surface.** GGX specular with Smith height-correlated visibility and
  Burley's diffuse (Burley, SIGGRAPH 2012 course; Karis, "Real Shading in Unreal Engine 4",
  SIGGRAPH 2013 course). Kulla–Conty multiple-scattering compensation (SIGGRAPH 2017 course) keeps
  rough metals from darkening. Its analytic form uses the directional albedo of the same DFG fit
  (Karis 2014).
- **Materials.** Palettes map to materials (`paletteMaterial`): steel (iron's measured f0, a
  little blued), brass, and ink, a matte black dielectric on paper. Tentacle Lattice's chrome,
  iridescent, emissive and obsidian blend their parameters under `u_mat` and go through the same
  BRDF. Iridescent is a Belcour–Barla thin film (SIGGRAPH 2017): a TiO₂-like film on a dark
  high-index base, its thickness varying smoothly in world space. The film's Airy series is
  integrated in closed form against Gaussian RGB sensitivities.
- **Lights.**
  - A key light with a cone-traced SDF soft shadow (Quilez 2010; Aaltonen, GDC 2018).
  - A headlight at the camera, with a windowed inverse-square falloff.
  - The beat pulses as tube lights (see below).
  - A procedural environment through the split sum (Karis 2013), with an analytic DFG fit and no
    LUT.
  - AO from the distance field (Evans, SIGGRAPH 2006 course): geometric taps, each normalized by
    its distance, plus specular occlusion (Lagarde & de Rousiers 2014).
  - Shadow and AO tap counts follow Quality (`shadingSamples`).
- **Pulses are lights.** `lib/lattice-lights.js` turns each live pulse's front into tube lights
  and packs the 12 nearest a point 1.5 cells ahead of the camera. Each tube fades to zero 3.5 cells
  from that point, so none pops out of the pack. The shader lights surfaces within 1.8 cells of
  each tube with Karis's representative-point tube light (diffuse from the line integral,
  specular from the point nearest the reflection ray). Under Reduce flashing the lights are
  dimmed by `REDUCED_LIGHT`.
- **Fog.** The fog is a homogeneous medium: transmittance e^(−βt), with β = Fog density × 0.85
  (× 0.5 on paper). It scatters light from:
  - the background, as HDR: the tone inverse of the palette's background, so the far fog lands
    exactly on it;
  - the key light, with a Henyey–Greenstein phase;
  - the headlight and each pulse tube, through Sun et al.'s analytic single-scattering integral
    (SIGGRAPH 2005). The paper's F(u, v) table is replaced by Gauss–Legendre quadrature.

  The pulses therefore carry soft halos, and rays that hit nothing see lit haze (`shadeMiss`,
  through an additive `CINEMATIC` branch in `lattice.frag`). The haze softens the dark cross on
  the screen's centre lines.
- **March.** `march.glsl` adds over-relaxed sphere tracing (Keinert et al., "Enhanced Sphere
  Tracing", 2014) under `CINEMATIC`: ω = 1.4 times `structStep(d)`. A relaxed step is kept only if
  the previous and current unbounding spheres overlap, so it still never passes a surface. On
  overshoot it falls back to the plain step. Against a fine-step reference it misses fewer
  far surfaces within the same step budget.
- **Composite.** `post.frag` mixes in the Jimenez bloom chain (SIGGRAPH 2014): 6 levels from half
  the scene size, 13-tap downsamples with the Karis average on the first, tent upsamples, and a
  fixed 6 % mix (1.5 % on paper). It then applies Narkowicz's ACES fit (`tone`, exposure 0.8) and
  encodes like classic. The canvas stays premultiplied:
  alpha = max(coverage, brightest channel) (`compositeAlpha`). Light drawn where nothing covers
  the pixel (haze, halos, bloom) adds over a light desktop, and surfaces keep classic's fog
  coverage. Nothing on the beat touches exposure or the bloom mix.

### What a new structure gets for free

A structure that implements the interface above is shaded by both looks with no shading code:

- Cinematic reads the hit only through `sceneSDF`, `structStep`, `structKind`, `structAxis`,
  `structNodeFace`, `structStrut`, `pulseMetric` and the AO constants.
- Shadows and AO march `sceneSDF` with the structure's own `structStep`.
- The relaxed march relies on `structStep` being a true bound, as the distance guarantee
  requires.

Two optional, additive hooks are available:

- **`pulseLights`** (JS, in the `STRUCTURES` entry): how a pulse's front becomes tube lights.
  Strut lattices with the L1 metric use `strutFrontLights`. Without it, each pulse is a point light
  at its source (`pointPulseLight`), which suits rings spreading over walls.
- **`STRUCT_WALL_TONE`** (GLSL `#define` in the structure file, default 1.0): scales the lit
  surface but not its emission. A structure whose walls fill the view (minimal surfaces,
  fractals) can set it below 1 so pulses read against pale walls. Pulse emission is HDR before the
  tone curve either way.

## Known quirks (not bugs)

- **A dark cross on the screen's centre lines.** The camera flies on cell centres. The mid-planes
  between node layers hold nothing (no strut or tentacle reaches them), so rays in the planes
  through the camera see straight into the fog. In the cinematic look those rays see lit haze.
- **A tentacle root peeks through a twisting cube** (Tentacle Lattice). Only the cube body turns
  a quarter turn, so mid-twist a tentacle's flared root shows through the rotated face. After the
  turn the cube is symmetric again, and the twist slot is released without a visible change.
- **Tentacle Lattice at High quality** takes ~17 ms a frame at 1440p (it misses 60 fps). Medium,
  the default, takes 6–11 ms.
