// @ts-check
import { LIFT_VARY } from "./tess-music.js";
import { CARD_HALF, CARD_RISE, RELIEF_BLOCK } from "./tess.js";

/**
 * Tiled Torus relief: the tessellation engine's carved block (tess.glsl TESS_RELIEF) riding on
 * the torus's waveform waves. The tiles become raised, carved blocks; a beat's wave of lifting
 * tiles, the spectrum's heave, onset pops and the figure/ground cards travel round the ring from
 * the camera (TESS_RING). Pure functions, mirrored by shaders/tess/torus.frag; nothing here
 * allocates.
 *
 * The surface sits at tube distance k + disp(θ, φ) + side × rel, where disp is the waves
 * (lib/torus-wave.js, fixed to the geometry) and rel the block's height turned into world units
 * (reliefWorld), raised towards the viewer (outward outside, inward inside the tube). The height
 * comes from the engine's height pass, baked once a frame over the torus's own coordinates
 * (a, b) = (θ/2π + fu, t(φ) + fv), so it spins and flows with the tiles: the plane point is
 * p = (lx a, ly (b + tw a)) and the map repeats exactly in a and b (a lap round the ring is the
 * plane translation T1 = (lx, tw ly), one round the tube T2 = (0, ly)).
 */

/**
 * The engine hashes each tile's cell for its lift variation and its onset pops; a tile cut by
 * the torus's seams is seen through two plane copies with different cells. TESS_CELL_KEY maps a
 * cell to its copy in one fundamental domain of the torus lattice (T1, T2), so both copies hash
 * alike (mirrors torus.frag torusCellKey). Cells as tess.glsl's Tile.cell: p4 the half-unit
 * square (i, j), whose copies are (2 lx, 2 tw ly) and (0, 2 ly) apart; p3 3 × the lattice point
 * (a, b) + (class, 0), the point at (a + b/2, b √3/2), so T1 is (nu − j, 2j) with j = tw nv and T2
 * (−nv, 2nv) in (a, b). Integer arithmetic; the half offsets keep the floors exact on the GPU.
 * @param {string} g "p4" | "p3" @param {number} x @param {number} y the cell
 * @param {{ nu: number, nv: number, lx: number, ly: number }} c lib/torus.js latticeCounts
 * @param {number} tw lib/torus.js twistTurns @param {number[]} out receives the key
 */
export function cellKey(g, x, y, c, tw, out) {
  if (g !== "p3") {
    const l1x = 2 * c.lx;
    const l1y = Math.round(2 * tw * c.ly);
    const l2 = 2 * c.ly;
    const n1 = Math.floor((x + 0.5) / l1x);
    const yy = y - n1 * l1y;
    out[0] = x - n1 * l1x;
    out[1] = yy - Math.floor((yy + 0.5) / l2) * l2;
    return out;
  }
  const j = Math.round(tw * c.nv);
  let la = Math.floor((x + 0.5) / 3);
  const k = x - 3 * la;
  let lb = Math.round(y / 3);
  const n1 = Math.floor((2 * la + lb + 0.5) / (2 * c.nu));
  la -= n1 * (c.nu - j);
  lb -= n1 * 2 * j;
  const n2 = Math.floor((lb + 0.5) / (2 * c.nv));
  la += n2 * c.nv;
  lb -= n2 * 2 * c.nv;
  out[0] = 3 * la + k;
  out[1] = 3 * lb;
  return out;
}

/**
 * World height per plane unit of relief, as a fraction of the local plane scale (a plane unit is
 * 2π (1 + k cos φ) / lx long there; the map is conformal): 1 keeps the block's proportions, so a
 * tile stands as tall against its width as on Metamorphosis's block.
 */
export const RELIEF_SCALE = 2;
/** The relief never stands taller than this × the tube radius (a turning card at Relief 1 with
 * every wave stacked would; it flattens at the cap). With the waves' 0.45 k the inside camera,
 * on the tube's centre circle, stays ≥ 0.3 k from every wall. */
export const RELIEF_CAP = 0.25;

/** World units per plane unit of relief at φ. @param {number} phi @param {number} k @param {number} lx */
export const reliefScale = (phi, k, lx) => (RELIEF_SCALE * 2 * Math.PI * (1 + k * Math.cos(phi))) / lx;

/** The relief's displacement (world, towards the viewer) for a block height h (plane units) at φ. @param {number} h @param {number} phi @param {number} k @param {number} lx */
export const reliefWorld = (h, phi, k, lx) => Math.min(RELIEF_CAP * k, reliefScale(phi, k, lx) * h);

/**
 * The largest relief displacement for heights up to hMax (the engine's bound, state.reliefMax):
 * the outer equator's, capped. The march's shell and the inside clearance use it.
 * @param {number} hMax @param {number} k @param {number} lx
 */
export const reliefShell = (hMax, k, lx) => reliefWorld(Math.max(0, hMax), 0, k, lx);

/**
 * The block's cut sides as the march sees them: the engine's tiles are cliffs (a lifted tile
 * stands straight up from its neighbours, a card's edge from its bed), and a sphere tracer can't
 * bound a cliff. The height pass leans every cut side by capping each tile's height at
 * SLOPE_CAP × its distance to its own outline, so every tile meets the groove floor at its
 * outline and the field is continuous; where a block's own slope is steeper (a turning card, a
 * sharp bevel) the cap takes over too. The distance is the tile's own (in the warped tile plane)
 * over the warp's largest stretch ‖J‖ there (jacobianNorm): a lower bound of the plane distance,
 * continuous inside the tile. Only the cut sides change: tops, bevels and domes keep their
 * shape, and the shading still uses the engine's own block.
 */
export const SLOPE_CAP = 2;
/**
 * ‖J‖ changes across a tile, so the cap's own slope is SLOPE_CAP (1 + δ |∇ log ‖J‖|) with δ the
 * capped distance (≤ h / SLOPE_CAP where the cap binds): at most SLOPE_CAP + h |∇ log ‖J‖|.
 * Locally |∇ log ‖J‖| reaches about 17 on the engine's warps, but not where tall blocks are
 * capped: measured end to end on the baked field (p4 and p3 morphs of every family, Relief 0.6
 * and 1 with stacked lifts and pops, 0.004 apart) the excess over SLOPE_CAP is ≤ 10.7 × the
 * tallest block. This is that coefficient with a 1.3 margin (the test keeps 1.25 under it).
 * An empirical bound, like the warp's own Lipschitz fit, not a proof.
 */
export const WARP_LOG_SLOPE = 14;

/**
 * Lipschitz bound of the baked height in the plane, for heights up to hMax (plane units): the
 * march's relief step (reliefSlope) rests on it. @param {number} hMax
 */
export const planeSlope = (hMax) => SLOPE_CAP + Math.max(0, hMax) * WARP_LOG_SLOPE;

/**
 * The baked height (plane units): the engine's block height h at a point dist from its tile's
 * (or card's) outline in the tile's own units, jNorm = ‖d(tile point)/dp‖; 0 on a card's bare
 * bed (mirrors torus.frag's height pass).
 * @param {number} h @param {number} dist @param {number} jNorm @param {boolean} pit
 */
export const bakeHeight = (h, dist, jNorm, pit) => (pit ? 0 : Math.min(h, (SLOPE_CAP * dist) / Math.max(jNorm, 1e-6)));

/**
 * The largest singular value of the 2×2 matrix with columns (a, b) and (c, d) (GLSL order):
 * √ of the larger eigenvalue of JᵀJ. @param {number} a @param {number} b @param {number} c @param {number} d
 */
export function jacobianNorm(a, b, c, d) {
  const t = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  return Math.sqrt(0.5 * (t + Math.sqrt(Math.max(0, t * t - 4 * det * det))));
}

/**
 * A bound on the relief displacement's world gradient over the march's shell (tube distance
 * k ± D, D the waves' and the relief's displacement together), for a baked map whose plane
 * slope is within planeSlope(hMax). rel = min(cap, c(φ) H(a, b)), c = RELIEF_SCALE 2π ρk / lx,
 * ρk = 1 + k cos φ, a = θ/2π + fu, b = t(φ) + fv. A texel step in a moves the plane point by
 * (lx, tw ly) / W and one in b by (0, ly) / H, so the bilinear map has |∂H/∂a| ≤ S √(lx² + tw² ly²)
 * and |∂H/∂b| ≤ S ly (S the plane slope); |∇a| = 1 / (2π ρ), ρ = 1 + q cos φ the point's axis
 * distance, and |∇b| = √(1 − k²) / (2π ρk q), orthogonal. So c |∇H| ≤ RELIEF_SCALE S
 * √((√(lx² + tw² ly²) / lx · ρk/ρ)² + (ly √(1 − k²) / (lx q))²), with ρk/ρ ≤ (1 − k) / (1 − k − D)
 * and q ≥ k − D; plus H |∇c| ≤ RELIEF_SCALE 2π k hMax / (lx q). The cap only flattens.
 * @param {number} hMax the engine's height bound (state.reliefMax, plane units) @param {number} k
 * @param {{ lx: number, ly: number }} c lib/torus.js latticeCounts @param {number} tw twistTurns
 * @param {number} D the shell's half-thickness (waves + relief, world)
 */
export function reliefSlope(hMax, k, c, tw, D) {
  if (hMax <= 0) return 0;
  const S = planeSlope(hMax);
  const q = Math.max(1e-3, k - D);
  const ratio = (1 - k) / Math.max(1e-3, 1 - k - D);
  const A = (Math.hypot(c.lx, tw * c.ly) / c.lx) * ratio;
  const B = (c.ly * Math.sqrt(1 - k * k)) / (c.lx * q);
  return RELIEF_SCALE * (S * Math.hypot(A, B) + (2 * Math.PI * k * hMax) / (c.lx * q));
}

/**
 * The march's step factor inside the relief's shell: the waves' and the relief's slopes add
 * (|∇(disp + rel)| ≤ G_wave + G_relief). @param {number} gWave waveSlope @param {number} gRelief reliefSlope
 */
export const reliefStep = (gWave, gRelief) => 1 / Math.sqrt(1 + (gWave + gRelief) * (gWave + gRelief));

// ---- The local ceiling: the march's fast descent through the relief's shell ------------------
// The global slope bound (reliefStep) is steep: the cut sides are. But the block's height near a
// point is known analytically from the music: a tile's height is at most Relief × (block + its
// ring's lift × (1 + LIFT_VARY) + the pops whose band reaches its ring) + a card's rise if the
// figure/ground front is turning its ring, and its ring is its centre's position round the ring.
// So within STEP_REACH of the march's point, every tile's ring lies in a window round the point's
// own (ringWindow), and the block there is under localCeiling of that window: above it the
// march steps by the waves' own bound (capped at STEP_REACH), and only below it by reliefStep.

/** tess.glsl's POP_BAND: a pop lifts tiles within this many rings of it. */
export const POP_BAND = 0.08;
/** A tile's centre (in the warped tile plane, which rings it) is within this many plane units of
 * the point round the ring: warp displacement plus the tile's own reach (measured ≤ 0.3 on the
 * engine's warps; the test keeps 1.2 under it). */
export const RING_REACH = 0.6;
/** The longest step the local ceiling allows (world): it bounds how far round the ring a step
 * can reach. */
export const STEP_REACH = 0.05;

/**
 * Half-width, in turns round the ring (a = θ/2π), of the window holding the rings of every tile
 * a STEP_REACH step can touch: the step's own reach at the shell's least axis distance
 * 1 − k − D, plus RING_REACH. @param {number} k @param {number} D the shell (world) @param {number} lx
 */
export const ringWindow = (k, D, lx) => STEP_REACH / (2 * Math.PI * Math.max(1e-3, 1 - k - D - STEP_REACH)) + RING_REACH / lx;

/**
 * The rings (0 at the camera's azimuth … 1 half a turn away, torus.frag torusRing) a window of
 * half-width w turns round a covers, into out = [lo, hi]. @param {number} a @param {number} ringO
 * @param {number} w @param {number[]} out
 */
export function ringRange(a, ringO, w, out) {
  const x = a - ringO + 0.5;
  const f = Math.abs(x - Math.floor(x) - 0.5);
  out[0] = 2 * Math.max(0, f - w);
  out[1] = Math.min(1, 2 * (f + w));
  return out;
}

/**
 * The tallest the block can be (plane units) on tiles whose rings lie in [lo, hi]: the engine's
 * lift bins over the range (linear between bins, so the bins themselves bound it), the pops whose
 * band reaches it, and a card's rise if the figure/ground front turns a ring there (mirrors
 * torus.frag reliefCeiling). State arrays as lib/tess-music.js's (`lift`, `pops`, `invert`).
 * @param {Float32Array} lift @param {Float32Array} pops @param {Float32Array} invert
 * @param {number} relief @param {number} hop @param {number} lo @param {number} hi
 */
export function localCeiling(lift, pops, invert, relief, hop, lo, hi) {
  const n = lift.length - 1;
  let top = -Infinity;
  for (let i = Math.max(0, Math.floor(lo * n)); i <= Math.min(n, Math.ceil(hi * n)); i++) top = Math.max(top, lift[i]);
  let pop = 0;
  for (let k = 0; k < pops.length / 4; k++) if (pops[k * 4] > 0 && lo < pops[k * 4 + 1] + POP_BAND && hi > pops[k * 4 + 1] - POP_BAND) pop += pops[k * 4];
  const lifted = top * (top > 0 ? 1 + LIFT_VARY : 1 - LIFT_VARY);
  const card = lo < invert[0] + invert[1] / 2 && hi > invert[0] - invert[1] / 2 ? CARD_RISE * (2 * CARD_HALF + hop) : 0;
  return Math.max(0, relief * (RELIEF_BLOCK + lifted + pop) + card);
}
