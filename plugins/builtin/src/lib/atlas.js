// @ts-check
/**
 * The atlas motif's data side (no GL): packs the bestiary's art into the bake shader's data
 * texture, packs a tile shape into the bake and print uniforms, and sequences the species with
 * the music. lib/atlas-gl.js uploads these; shaders/tess/atlas-bake.frag and atlas.glsl read them.
 *
 * Data texture (RGBA32F, DATA_W wide): row 0 holds the current outline (one point per texel,
 * x, y, 0, 0); from row 1 the art library, packed once at load: per species its primitives'
 * headers, 3 texels each — (kind, role, first point texel, points), (width at start, width at
 * end, height, 0), (box min x, min y, max x, max y) — then their points (x, y, 0, 0).
 */
import { MAX_OUTLINE, plainOf, TYPES } from "./bestiary.js";

/** Data texture width (texels). */
export const DATA_W = 512;
/** Atlas size while settled, and while a morph re-bakes every frame. */
export const ATLAS_SIZE = 512;
export const ATLAS_MORPH_SIZE = 256;
/** Tile-frame units the art of the species being left erodes by over a morph (tools/tiles ERODE). */
export const ATLAS_ERODE = 0.12;
/** Lattice steps the bake searches each way for a tile copy holding a texel. */
export const MAX_REACH = 2;

/**
 * @typedef {import('./bestiary.js').Species} Species
 * @typedef {import('./bestiary.js').Shape} Shape
 * @typedef {{ start: number, count: number }} ArtSet first header texel and primitive count
 */

/**
 * Pack every species' art (and nothing for plain tiles) into one data texture, once.
 * @param {Species[]} species
 * @returns {{ data: Float32Array, rows: number, sets: Map<string, ArtSet> }}
 */
export function packLibrary(species) {
  let texels = DATA_W; // row 0: the outline
  for (const sp of species) texels += sp.art.prims.length * 3 + sp.art.points.length / 2;
  const rows = Math.ceil(texels / DATA_W);
  const data = new Float32Array(rows * DATA_W * 4);
  /** @type {Map<string, ArtSet>} */
  const sets = new Map();
  let t = DATA_W;
  for (const sp of species) {
    const prims = sp.art.prims;
    const start = t;
    let pt = t + prims.length * 3;
    sets.set(sp.id, { start, count: prims.length });
    for (const p of prims) {
      data.set([p.kind, p.role, pt, p.count], t * 4);
      data.set([p.w0, p.w1, p.height, 0], (t + 1) * 4);
      data.set(p.box, (t + 2) * 4);
      for (let i = 0; i < p.count; i++, pt++) {
        data[pt * 4] = sp.art.points[(p.start + i) * 2];
        data[pt * 4 + 1] = sp.art.points[(p.start + i) * 2 + 1];
      }
      t += 3;
    }
    t = pt;
  }
  return { data, rows, sets };
}

/**
 * Uniforms for one tile shape, shared by the bake and the print pass; `packShape` fills them in
 * place (nothing allocated per frame).
 */
export function createAtlasUniforms() {
  return {
    /** Per copy (4): the inverse linear map world → base tile frame, column-major (a, b, c, d). */
    inv: new Float32Array(16),
    /** Per copy: the inverse's offset (x, y), the copy's class at the lattice origin, 0. */
    off: new Float32Array(16),
    /** Per copy: its centroid (tile frame), x, y. */
    ctr: new Float32Array(8),
    /** Per copy: lattice steps to search, i from … to, j from … to. */
    range: new Int32Array(16),
    /** Lattice (columns a, b) and its inverse, tile frame, column-major. */
    L: new Float32Array(4),
    Linv: new Float32Array(4),
    /** Outline bounding box in the base frame. */
    box: new Float32Array(4),
    /** Class steps along a and b, classes. */
    cls: new Float32Array(3),
    /** The outline as RGBA texels for data row 0. */
    outline: new Float32Array(MAX_OUTLINE * 4),
    n: 0,
    nCopies: 1,
    /** Plane units per tile-frame unit. */
    scale: 1,
  };
}

/**
 * Fill the uniforms for a shape. Allocates nothing.
 * @param {Shape} s @param {ReturnType<typeof createAtlasUniforms>} u
 */
export function packShape(s, u) {
  const f = s.frame;
  const L = f.L;
  u.L.set(L);
  const det = L[0] * L[3] - L[2] * L[1];
  u.Linv[0] = L[3] / det;
  u.Linv[1] = -L[1] / det;
  u.Linv[2] = -L[2] / det;
  u.Linv[3] = L[0] / det;
  u.box[0] = s.box[0];
  u.box[1] = s.box[1];
  u.box[2] = s.box[2];
  u.box[3] = s.box[3];
  u.cls[0] = f.ca;
  u.cls[1] = f.cb;
  u.cls[2] = f.nc;
  u.n = s.n;
  u.nCopies = f.nCopies;
  u.scale = TYPES[s.type].scale;
  for (let i = 0; i < s.n; i++) {
    u.outline[i * 4] = s.outline[i * 2];
    u.outline[i * 4 + 1] = s.outline[i * 2 + 1];
  }
  // The base tile's centroid (area-weighted).
  let ax = 0;
  let ay = 0;
  let a2 = 0;
  for (let i = 0, j = s.n - 1; i < s.n; j = i++) {
    const cr = s.outline[j * 2] * s.outline[i * 2 + 1] - s.outline[i * 2] * s.outline[j * 2 + 1];
    a2 += cr;
    ax += (s.outline[j * 2] + s.outline[i * 2]) * cr;
    ay += (s.outline[j * 2 + 1] + s.outline[i * 2 + 1]) * cr;
  }
  const cx = ax / (3 * a2);
  const cy = ay / (3 * a2);
  const m = f.copies;
  for (let k = 0; k < 4; k++) {
    const o = k * 6;
    if (k >= f.nCopies) {
      u.range[k * 4] = 1; // empty: from > to
      u.range[k * 4 + 1] = 0;
      continue;
    }
    const md = m[o] * m[o + 3] - m[o + 2] * m[o + 1];
    const ia = m[o + 3] / md;
    const ib = -m[o + 1] / md;
    const ic = -m[o + 2] / md;
    const id = m[o] / md;
    u.inv[k * 4] = ia;
    u.inv[k * 4 + 1] = ib;
    u.inv[k * 4 + 2] = ic;
    u.inv[k * 4 + 3] = id;
    u.off[k * 4] = -(ia * m[o + 4] + ic * m[o + 5]);
    u.off[k * 4 + 1] = -(ib * m[o + 4] + id * m[o + 5]);
    u.off[k * 4 + 2] = f.copyCls[k];
    u.ctr[k * 2] = m[o] * cx + m[o + 2] * cy + m[o + 4];
    u.ctr[k * 2 + 1] = m[o + 1] * cx + m[o + 3] * cy + m[o + 5];
    // The copy's box in lattice coordinates: a texel of the cell [0, 1)² can only be in the
    // copy translated by d with d ∈ [floor(−max), ceil(1 − min)].
    let lo0 = Infinity;
    let lo1 = Infinity;
    let hi0 = -Infinity;
    let hi1 = -Infinity;
    for (let c = 0; c < 4; c++) {
      const x = s.box[c & 1 ? 2 : 0];
      const y = s.box[c & 2 ? 3 : 1];
      const wx = m[o] * x + m[o + 2] * y + m[o + 4];
      const wy = m[o + 1] * x + m[o + 3] * y + m[o + 5];
      const l0 = u.Linv[0] * wx + u.Linv[2] * wy;
      const l1 = u.Linv[1] * wx + u.Linv[3] * wy;
      lo0 = Math.min(lo0, l0);
      lo1 = Math.min(lo1, l1);
      hi0 = Math.max(hi0, l0);
      hi1 = Math.max(hi1, l1);
    }
    u.range[k * 4] = Math.max(-MAX_REACH, Math.floor(-hi0));
    u.range[k * 4 + 1] = Math.min(MAX_REACH, Math.ceil(1 - lo0));
    u.range[k * 4 + 2] = Math.max(-MAX_REACH, Math.floor(-hi1));
    u.range[k * 4 + 3] = Math.min(MAX_REACH, Math.ceil(1 - lo1));
  }
  return u;
}

/**
 * The species a Creatures value selects, from the loaded ids (sorted): "abstract" none, "all"
 * every one, a group name its species, "<group>/<name>" that one (for previewing a design in the
 * harness: p.creatures=fish/koi).
 * @param {string} value @param {string[]} ids
 */
export function creatureList(value, ids) {
  if (value === "abstract") return [];
  if (value === "all") return ids.slice();
  if (value.includes("/")) return ids.includes(value) ? [value] : [];
  return ids.filter((id) => id.startsWith(`${value}/`));
}

/** Seconds a morph between compatible species takes (a type change takes twice this). */
export const MORPH_TIME = 1.2;
/** Reduce motion: morphs this many times as long. */
export const REDUCED_MORPH = 4;
/** Every this many species changes, change tile type if the list has another type. */
export const TYPE_CHANGE_EVERY = 3;
/** Fraction of a type change, either side of the swap, over which the print dips to its mean. */
const DIP = 0.15;

/** Morph steps a species is held for at a Morph param value (0 holds it). @param {number} morph */
export const dwellSteps = (morph) => (morph <= 0 ? Infinity : 1 + Math.floor((1 - Math.min(1, morph)) * 4));

/** @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * The species sequence: one species held, then on the music's morph steps (tess-music's
 * `stepped`, once a bar) a morph to the next. Compatible species (same tile type and edge
 * structure) blend directly, outline and all, while the art of the one being left erodes away
 * and the other's grows in. Every TYPE_CHANGE_EVERY-th change (or when nothing compatible is
 * left) the tile type changes: species → its plain tile, swap to the next species' plain tile at
 * the midpoint while the print dips to its mean colour, → the next species. Fields `a`, `b`, `w`
 * (outline blend), `erodeA`, `erodeB` (art), `dip` and `changed` (re-bake) are read each frame.
 */
export function createCreatures() {
  /** @type {Species[]} */
  let list = [];
  /** @type {Map<string, Species>} */
  let plain = new Map();
  let cur = 0;
  let next = 0;
  let steps = 0;
  let changes = 0;
  let u = -1; // transition progress 0–1; −1 = settled
  let span = 1;
  let typeChange = false;
  let fresh = true;
  const c = {
    /** False with no species (abstract). */
    active: false,
    /** @type {Species} */
    a: /** @type {any} */ (null),
    /** @type {Species} */
    b: /** @type {any} */ (null),
    w: 0,
    erodeA: 0,
    erodeB: 0,
    dip: 0,
    /** True when the outline or art changed this frame: re-bake. */
    changed: false,
    /** True while a transition runs (bake small and fast). */
    moving: false,
    /** The plain tiles, by species id (made once in setSpecies). */
    plain,
    /** @param {Species[]} species */
    setSpecies(species) {
      list = species;
      plain = new Map(species.map((sp) => [sp.id, plainOf(sp)]));
      c.plain = plain;
      cur = 0;
      u = -1;
      steps = 0;
      changes = 0;
      fresh = true;
      c.active = species.length > 0;
      c.a = c.b = species[0];
      c.w = c.erodeA = c.erodeB = c.dip = 0;
      c.moving = false;
    },
    /** @param {number} dt @param {{ stepped: boolean, morph: number, reduceMotion: boolean }} o */
    step(dt, o) {
      c.changed = fresh;
      fresh = false;
      if (!c.active) return c;
      if (u < 0 && o.stepped && list.length > 1 && ++steps >= dwellSteps(o.morph)) {
        steps = 0;
        changes++;
        next = pickNext();
        typeChange = list[next].sig !== list[cur].sig;
        span = MORPH_TIME * (typeChange ? 2 : 1) * (o.reduceMotion ? REDUCED_MORPH : 1);
        u = 0;
      }
      if (u >= 0) {
        u = Math.min(1, u + dt / span);
        const from = list[cur];
        const to = list[next];
        if (!typeChange) {
          c.a = from;
          c.b = to;
          c.w = smooth(u);
          c.erodeA = c.w * ATLAS_ERODE;
          c.erodeB = (1 - c.w) * ATLAS_ERODE;
        } else if (u < 0.5) {
          c.a = from;
          c.b = /** @type {Species} */ (plain.get(from.id));
          c.w = smooth(u * 2);
          c.erodeA = c.w * ATLAS_ERODE;
          c.erodeB = 0;
        } else {
          c.a = /** @type {Species} */ (plain.get(to.id));
          c.b = to;
          c.w = smooth(u * 2 - 1);
          c.erodeA = 0;
          c.erodeB = (1 - c.w) * ATLAS_ERODE;
        }
        c.dip = typeChange ? smooth(1 - Math.abs(u - 0.5) / DIP) : 0;
        c.changed = true;
        if (u >= 1) {
          cur = next;
          u = -1;
          c.a = c.b = list[cur];
          c.w = c.erodeA = c.erodeB = c.dip = 0;
        }
      }
      c.moving = u >= 0;
      return c;
    },
  };

  /** The next species: a compatible one in list order, or every TYPE_CHANGE_EVERY-th change
   * (or when none is compatible) the next one of another type. */
  function pickNext() {
    const n = list.length;
    const sig = list[cur].sig;
    const wantOther = changes % TYPE_CHANGE_EVERY === 0;
    for (let pass = 0; pass < 2; pass++) {
      const other = pass === 0 ? wantOther : !wantOther;
      for (let i = 1; i < n; i++) {
        const j = (cur + i) % n;
        if ((list[j].sig !== sig) === other) return j;
      }
    }
    return (cur + 1) % n;
  }

  return c;
}
