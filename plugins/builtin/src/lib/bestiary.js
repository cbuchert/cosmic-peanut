// @ts-check
/**
 * The bestiary: animal tiles as data (plugins/builtin/tiles/<group>/<animal>.json, see
 * tiles/README.md), for the tessellation engine's atlas motif.
 *
 * A tile is one of four isohedral (Heesch) types. The designer edits the free edges; the other
 * edges are derived from them by the type's isometries, so the edge relations hold by
 * construction and the tile tiles the plane whenever its outline is a simple polygon (which
 * `uv run python -m tools.tiles check` verifies, blends included):
 *
 *   TTTTTT  hexagon, translations only (p1): every tile faces the same way.
 *   TGTG    quadrilateral, one pair of edges by translation, one by a glide reflection (pg):
 *           alternate rows are mirrored.
 *   C4      quadrilateral, edges paired by quarter turns about two corners (p4).
 *   C3      hexagon, edges paired by third turns about alternate corners (p3).
 *
 * Frame: each type's tile lives in a "tile frame" (C4 the unit square, C3 and TTTTTT a regular
 * hexagon of side 1 by default) scaled into plane units by TYPES[type].scale. A free edge's points
 * are given in its chord frame: (u, v) = (along the edge from its start to its end vertex, to the
 * left of it), in chord lengths; corners and edges both blend linearly, and every blend keeps the
 * relations. The art is in tile-frame coordinates. tools/tiles/geometry.py mirrors this module
 * (tests/fixtures/tiles_golden.json pins both to the same outlines).
 */

const S3 = Math.sqrt(3);
const THIRD = (2 * Math.PI) / 3;

/** Samples per cubic Bézier segment when flattening (edges and art alike). */
export const FLAT = 8;
/** Most outline points a tile can have (the bake shader's loop bound and data row). */
export const MAX_OUTLINE = 512;
/** Format version of the species files. */
export const FORMAT = 1;
/** Animal groups: one folder (and one designer) each. */
export const GROUPS = ["fish", "birds", "reptiles", "mammals"];
/**
 * Colour roles of the interior art (index = role code in the atlas): the tile's own fill
 * (hatched like the body), key-block ink, paper, the engine's "cut" (paper on dark fills, ink on
 * light), an accent colour block (a palette colour no tile class is using), and the fill shaded
 * towards ink or lightened towards paper.
 */
export const ROLES = ["fill", "ink", "paper", "cut", "accent", "shade", "light"];

/**
 * @typedef {"TTTTTT" | "TGTG" | "C4" | "C3"} TileType
 * @typedef {object} TypeInfo
 * @property {number} edges edge count
 * @property {number[]} free the free edges (the rest are derived)
 * @property {number} copies tiles per period cell
 * @property {number} classes colour classes of the type's colouring
 * @property {number} scale plane units per tile-frame unit
 * @property {string[]} corners the editable corner keys (`corners` in the file)
 */

/** @type {Record<TileType, TypeInfo>} */
export const TYPES = {
  TTTTTT: { edges: 6, free: [0, 1, 2], copies: 1, classes: 3, scale: 1 / 3, corners: ["v1", "v2", "v3"] },
  TGTG: { edges: 4, free: [0, 1], copies: 2, classes: 2, scale: 1 / 2, corners: ["w", "h", "s"] },
  C4: { edges: 4, free: [0, 1], copies: 4, classes: 2, scale: 1 / 2, corners: [] },
  C3: { edges: 6, free: [0, 2, 4], copies: 3, classes: 3, scale: 1 / 3, corners: ["v1"] },
};

/**
 * Default corners, packed 6 floats per type: TTTTTT v1, v2, v3; TGTG w, h, s; C3 v1; C4 none.
 * @param {TileType} type @param {Float64Array} [out]
 */
export function defaultCorners(type, out = new Float64Array(6)) {
  out.fill(0);
  if (type === "TTTTTT") out.set([1, 0, 1.5, S3 / 2, 1, S3]);
  else if (type === "TGTG") out.set([1, 1, 0]);
  else if (type === "C3") out.set([1, 0]);
  return out;
}

/**
 * @typedef {object} Frame the tile's vertices, lattice and copies for some corners
 * @property {Float64Array} V vertices x, y (up to 6)
 * @property {Float64Array} L period lattice a.x, a.y, b.x, b.y (tile frame)
 * @property {Float64Array} copies per copy in the cell, the affine map base → copy:
 *   x' = m0 x + m2 y + m4, y' = m1 x + m3 y + m5 (6 floats each, up to 4 copies)
 * @property {Int32Array} copyCls colour class of each copy at the lattice origin
 * @property {number} nCopies
 * @property {number} ca @property {number} cb class step per lattice step along a and b
 * @property {number} nc classes
 */

/** @returns {Frame} */
const createFrame = () => ({
  V: new Float64Array(12),
  L: new Float64Array(4),
  copies: new Float64Array(24),
  copyCls: new Int32Array(4),
  nCopies: 1,
  ca: 0,
  cb: 0,
  nc: 2,
});

/** Rotate (x, y) about (cx, cy) by angle a into out[o], out[o + 1]. */
function rotInto(
  /** @type {number} */ x,
  /** @type {number} */ y,
  /** @type {number} */ cx,
  /** @type {number} */ cy,
  /** @type {number} */ a,
  /** @type {Float64Array | Float32Array} */ out,
  /** @type {number} */ o,
) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  out[o] = cx + c * (x - cx) - s * (y - cy);
  out[o + 1] = cy + s * (x - cx) + c * (y - cy);
}

/** Copy k of `copies` = rotation by angle a about the origin. */
function setRotation(/** @type {Float64Array} */ m, /** @type {number} */ k, /** @type {number} */ a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[k * 6] = c;
  m[k * 6 + 1] = s;
  m[k * 6 + 2] = -s;
  m[k * 6 + 3] = c;
  m[k * 6 + 4] = 0;
  m[k * 6 + 5] = 0;
}

/**
 * The vertices, lattice, copies and colouring for a type and its corners.
 * Colourings: TTTTTT (i + 2j) mod 3 over lattice steps (neighbours are ±a, ±b, ±(a − b));
 * TGTG (copy + i) mod 2 (columns alternate, the glide copy above differs); C4 the quarter turn's
 * parity; C3 the third turn. Every edge neighbour differs (tested). Allocates nothing.
 * @param {TileType} type @param {ArrayLike<number>} cn corners @param {Frame} [f]
 */
export function frameOf(type, cn, f = createFrame()) {
  const V = f.V;
  V.fill(0);
  f.copies.fill(0);
  f.copyCls.fill(0);
  const L = f.L;
  if (type === "TTTTTT") {
    for (let i = 0; i < 6; i++) V[2 + i] = cn[i];
    V[8] = cn[4] - cn[0]; // V4 = V3 − V1
    V[9] = cn[5] - cn[1];
    V[10] = cn[4] - cn[2]; // V5 = V3 − V2
    V[11] = cn[5] - cn[3];
    L[0] = cn[4] - cn[0]; // a = V3 − V1 (E0 → E3)
    L[1] = cn[5] - cn[1];
    L[2] = V[8] - cn[2]; // b = V4 − V2 (E1 → E4)
    L[3] = V[9] - cn[3];
    f.nCopies = 1;
    setRotation(f.copies, 0, 0);
    f.ca = 1;
    f.cb = 2;
    f.nc = 3;
  } else if (type === "TGTG") {
    const w = cn[0];
    const h = cn[1];
    const s = cn[2];
    V[2] = w;
    V[4] = w + s;
    V[5] = h;
    V[6] = s;
    V[7] = h;
    L[0] = w;
    L[1] = 0;
    L[2] = 0;
    L[3] = 2 * h;
    f.nCopies = 2;
    setRotation(f.copies, 0, 0);
    // The glide: mirror in x = (w + s) / 2, then up h.
    f.copies[6] = -1;
    f.copies[9] = 1;
    f.copies[10] = w + s;
    f.copies[11] = h;
    f.copyCls[1] = 1;
    f.ca = 1;
    f.cb = 0;
    f.nc = 2;
  } else if (type === "C4") {
    V[2] = 1;
    V[4] = 1;
    V[5] = 1;
    V[7] = 1;
    L[0] = 2;
    L[1] = 0;
    L[2] = 0;
    L[3] = 2;
    f.nCopies = 4;
    for (let k = 0; k < 4; k++) {
      setRotation(f.copies, k, (k * Math.PI) / 2);
      f.copyCls[k] = k & 1;
    }
    // Exact zeros and ones (cos(π/2) is 6e-17).
    for (let i = 0; i < 24; i++) f.copies[i] = Math.round(f.copies[i]);
    f.ca = 0;
    f.cb = 0;
    f.nc = 2;
  } else {
    // C3: V0, V2, V4 are the three kinds of 3-fold centre; V1 is free, V5 and V3 follow.
    V[2] = cn[0];
    V[3] = cn[1];
    V[4] = 1.5;
    V[5] = S3 / 2;
    V[9] = S3;
    rotInto(cn[0], cn[1], 0, 0, THIRD, V, 10); // V5 = R(V0)·V1
    rotInto(V[10], V[11], 0, S3, THIRD, V, 6); // V3 = R(V4)·V5
    L[0] = 3;
    L[1] = 0;
    L[2] = 1.5;
    L[3] = (3 * S3) / 2;
    f.nCopies = 3;
    for (let k = 0; k < 3; k++) {
      setRotation(f.copies, k, k * THIRD);
      f.copyCls[k] = k;
    }
    f.ca = 0;
    f.cb = 0;
    f.nc = 3;
  }
  return f;
}

/**
 * @typedef {object} ArtPrim one piece of interior art, flattened
 * @property {number} kind 0 = filled path, 1 = stroke, 2 = filled circle
 * @property {number} role ROLES index
 * @property {string} part
 * @property {number} start first point (index into the species' art points)
 * @property {number} count points
 * @property {number} w0 @property {number} w1 stroke width at the start and the end
 * @property {number} height relief hint (−1 carved … 1 raised)
 * @property {number[]} box minx, miny, maxx, maxy (strokes: widened by half the width; circles:
 *   the circle's square)
 */

/**
 * @typedef {object} Species a parsed species file
 * @property {string} id "<group>/<file name>"
 * @property {string} name @property {string} group @property {TileType} type
 * @property {string} sig edge structure: species with equal sigs blend
 * @property {Float64Array} corners 6 floats (defaultCorners layout)
 * @property {Float64Array[]} edges per edge (free edges only; others empty): flattened chord-frame
 *   points u, v after the start vertex, the last being (1, 0)
 * @property {{ prims: ArtPrim[], points: Float64Array }} art
 * @property {number} dome relief hint: how domed the body is (0–1)
 */

/** A point [x, y] of finite numbers. */
function point(/** @type {any} */ p, /** @type {string} */ where) {
  if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new Error(`${where}: points are [x, y] number pairs (got ${JSON.stringify(p)})`);
  }
  return /** @type {number[]} */ (p);
}

/**
 * Cubic Bézier chain a0 c c a1 c c a2 … → the points after a0 (FLAT per cubic, ending at the last
 * anchor).
 * @param {number[][]} c
 */
export function flattenBezier(c) {
  /** @type {number[][]} */
  const out = [];
  for (let s = 0; s + 3 < c.length; s += 3) {
    const [p0, p1, p2, p3] = [c[s], c[s + 1], c[s + 2], c[s + 3]];
    for (let i = 1; i <= FLAT; i++) {
      const t = i / FLAT;
      const m = 1 - t;
      const a = m * m * m;
      const b = 3 * m * m * t;
      const d = 3 * m * t * t;
      const e = t * t * t;
      out.push([a * p0[0] + b * p1[0] + d * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + d * p2[1] + e * p3[1]]);
    }
  }
  return out;
}

/**
 * A smooth curve through points (uniform Catmull–Rom) as a cubic Bézier chain: handles at
 * P_i ± (P_i+1 − P_i−1) / 6. Open curves repeat their end points; closed ones wrap round and
 * end back at the first point.
 * @param {number[][]} p @param {boolean} closed
 */
export function smoothToBezier(p, closed) {
  const n = p.length;
  const at = (/** @type {number} */ i) => (closed ? p[((i % n) + n) % n] : p[Math.max(0, Math.min(n - 1, i))]);
  const out = [p[0]];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    out.push([b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6], [c[0] - (d[0] - b[0]) / 6, c[1] - (d[1] - b[1]) / 6], c);
  }
  return out;
}

/** Flatten a chord-frame edge: interior points → u, v after the start, ending at (1, 0). */
function flattenEdge(/** @type {any} */ e, /** @type {string} */ where) {
  if (!e || typeof e !== "object") throw new Error(`${where}: missing (needs "bezier", "smooth" or "polyline")`);
  if (Array.isArray(e.polyline)) {
    const pts = e.polyline.map((/** @type {any} */ p) => point(p, where));
    pts.push([1, 0]);
    return { kind: "p", n: e.polyline.length, flat: Float64Array.from(pts.flat()) };
  }
  if (Array.isArray(e.bezier)) {
    const m = e.bezier.length;
    if ((m + 1) % 3 !== 0 || m < 2) throw new Error(`${where}: a bezier edge has 3n − 1 interior points (got ${m})`);
    const ctrl = [[0, 0], ...e.bezier.map((/** @type {any} */ p) => point(p, where)), [1, 0]];
    return { kind: "b", n: m, flat: Float64Array.from(flattenBezier(ctrl).flat()) };
  }
  if (Array.isArray(e.smooth)) {
    const pts = [[0, 0], ...e.smooth.map((/** @type {any} */ p) => point(p, where)), [1, 0]];
    return { kind: "s", n: e.smooth.length, flat: Float64Array.from(flattenBezier(smoothToBezier(pts, false)).flat()) };
  }
  throw new Error(`${where}: needs "bezier", "smooth" or "polyline"`);
}

/**
 * An art path → absolute tile-frame points (bezier chains include their first anchor; a smooth
 * fill is closed round, ending back at its first point).
 */
function flattenPath(/** @type {any} */ p, /** @type {string} */ where, /** @type {boolean} */ closed) {
  if (p && Array.isArray(p.polyline)) {
    if (p.polyline.length < 2) throw new Error(`${where}: a polyline needs at least 2 points`);
    return p.polyline.map((/** @type {any} */ q) => point(q, where));
  }
  if (p && Array.isArray(p.bezier)) {
    const m = p.bezier.length;
    if ((m - 1) % 3 !== 0 || m < 4) throw new Error(`${where}: a bezier path has 3n + 1 points (got ${m})`);
    const c = p.bezier.map((/** @type {any} */ q) => point(q, where));
    return [c[0], ...flattenBezier(c)];
  }
  if (p && Array.isArray(p.smooth)) {
    if (p.smooth.length < (closed ? 3 : 2)) throw new Error(`${where}: a smooth path needs at least ${closed ? 3 : 2} points`);
    const c = smoothToBezier(p.smooth.map((/** @type {any} */ q) => point(q, where)), closed);
    return [c[0], ...flattenBezier(c)];
  }
  throw new Error(`${where}: needs "bezier", "smooth" or "polyline"`);
}

/**
 * Parse and check a species file (the tool checks much more: geometry, art inside the outline,
 * blends). `path` ends in <group>/<name>.json.
 * @param {any} json @param {string} path
 * @returns {Species}
 */
export function parseSpecies(json, path) {
  const m = /([a-z0-9-]+)\/([a-z0-9-]+)\.json$/.exec(path);
  if (!m) throw new Error(`${path}: species files are tiles/<group>/<name>.json (lowercase, digits, -)`);
  const id = `${m[1]}/${m[2]}`;
  const where = (/** @type {string} */ s) => `${id}: ${s}`;
  if (json?.format !== FORMAT) throw new Error(where(`format must be ${FORMAT}`));
  if (typeof json.name !== "string" || !json.name) throw new Error(where("name (the common name) is required"));
  if (json.group !== m[1]) throw new Error(where(`group "${json.group}" must be the folder name "${m[1]}"`));
  /** @type {TileType} */
  const type = json.type;
  const info = TYPES[type];
  if (!info) throw new Error(where(`type "${type}" must be one of ${Object.keys(TYPES).join(", ")}`));

  const corners = defaultCorners(type);
  const cj = json.corners ?? {};
  for (const k of Object.keys(cj)) {
    if (!info.corners.includes(k)) throw new Error(where(`corners.${k}: ${type} corners are ${info.corners.join(", ") || "fixed"}`));
  }
  info.corners.forEach((k, i) => {
    if (!(k in cj)) return;
    if (type === "TGTG") {
      if (typeof cj[k] !== "number" || !Number.isFinite(cj[k])) throw new Error(where(`corners.${k} must be a number`));
      corners[i] = cj[k];
    } else {
      const [x, y] = point(cj[k], where(`corners.${k}`));
      corners[i * 2] = x;
      corners[i * 2 + 1] = y;
    }
  });

  /** @type {Float64Array[]} */
  const edges = [];
  /** @type {string[]} */
  const sig = [type];
  for (let e = 0; e < info.edges; e++) {
    if (!info.free.includes(e)) {
      edges.push(new Float64Array(0));
      continue;
    }
    const fe = flattenEdge(json.edges?.[`e${e}`], where(`edges.e${e}`));
    edges.push(fe.flat);
    sig.push(`e${e}=${fe.kind}${fe.n}`);
  }
  for (const k of Object.keys(json.edges ?? {})) {
    if (!/^e\d$/.test(k) || !info.free.includes(Number(k.slice(1)))) {
      throw new Error(where(`edges.${k}: ${type}'s free edges are ${info.free.map((e) => `e${e}`).join(", ")} (the others are derived)`));
    }
  }

  const colours = json.colours ?? {};
  /** @type {ArtPrim[]} */
  const prims = [];
  /** @type {number[]} */
  const pts = [];
  const parts = json.height?.parts ?? {};
  (json.art ?? []).forEach((/** @type {any} */ a, /** @type {number} */ i) => {
    const w = where(`art[${i}]`);
    if (typeof a?.part !== "string" || !a.part) throw new Error(`${w}: needs a "part" name`);
    if (!(a.part in colours)) throw new Error(`${w}: part "${a.part}" has no entry in "colours"`);
    const role = ROLES.indexOf(colours[a.part]);
    if (role < 0) throw new Error(`${w}: colour role "${colours[a.part]}" must be one of ${ROLES.join(", ")}`);
    const height = typeof parts[a.part] === "number" ? parts[a.part] : 0;
    const start = pts.length / 2;
    if (Array.isArray(a.circle)) {
      const [cx, cy, r] = a.circle;
      if (![cx, cy, r].every((v) => typeof v === "number") || !(r > 0)) throw new Error(`${w}: circle is [x, y, r > 0]`);
      prims.push({ kind: 2, role, part: a.part, start, count: 0, w0: 0, w1: 0, height, box: [cx - r, cy - r, cx + r, cy + r] });
      return;
    }
    const kind = a.fill ? 0 : a.stroke ? 1 : -1;
    if (kind < 0) throw new Error(`${w}: needs "circle", "fill" or "stroke"`);
    const path = flattenPath(kind === 0 ? a.fill : a.stroke, w, kind === 0);
    let w0 = 0;
    let w1 = 0;
    if (kind === 1) {
      const wd = Array.isArray(a.width) ? a.width : [a.width, a.width];
      if (!wd.every((/** @type {any} */ v) => typeof v === "number" && v > 0)) throw new Error(`${w}: a stroke needs "width" > 0 (or [start, end])`);
      [w0, w1] = wd;
    }
    const pad = Math.max(w0, w1) / 2;
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of path) {
      pts.push(x, y);
      box[0] = Math.min(box[0], x - pad);
      box[1] = Math.min(box[1], y - pad);
      box[2] = Math.max(box[2], x + pad);
      box[3] = Math.max(box[3], y + pad);
    }
    prims.push({ kind, role, part: a.part, start, count: path.length, w0, w1, height, box });
  });
  for (const part of Object.keys(colours)) {
    if (!prims.some((p) => p.part === part)) throw new Error(where(`colours.${part}: no art uses this part`));
  }
  const dome = typeof json.height?.dome === "number" ? json.height.dome : 0;
  return { id, name: json.name, group: m[1], type, sig: sig.join(" "), corners, edges, art: { prims, points: Float64Array.from(pts) }, dome };
}

/**
 * The plain tile of a species' structure: default corners, straight edges, no art. Every species
 * blends with its plain tile, so a change of tile type goes species → plain → plain → species.
 * @param {Species} sp @returns {Species}
 */
export function plainOf(sp) {
  const edges = sp.edges.map((e) => {
    const n = e.length / 2;
    const out = new Float64Array(e.length);
    for (let i = 0; i < n; i++) out[i * 2] = (i + 1) / n;
    return out;
  });
  return { ...sp, id: `${sp.id}~plain`, corners: defaultCorners(sp.type), edges, art: { prims: [], points: new Float64Array(0) }, dome: 0 };
}

/**
 * @typedef {object} Shape a tile's outline in the tile frame, ready for the atlas
 * @property {TileType} type
 * @property {Frame} frame
 * @property {Float32Array} outline closed polygon x, y (CCW), starting after V0
 * @property {number} n points
 * @property {Int32Array} edgeN points per edge
 * @property {Float64Array} corners
 * @property {Float64Array} box outline bounding box minx, miny, maxx, maxy
 */

/** @returns {Shape} */
export const createShape = () => ({
  type: "C4",
  frame: createFrame(),
  outline: new Float32Array(MAX_OUTLINE * 2),
  n: 0,
  edgeN: new Int32Array(6),
  corners: new Float64Array(6),
  box: new Float64Array(4),
});

const scratchEdges = [0, 1, 2, 3, 4, 5].map(() => new Float64Array(MAX_OUTLINE * 2));

/**
 * Derived edge d from free edge e: map e's points (start vertex included) by an isometry and
 * (kinds 0 and 1) reverse them. kind 0: translate (tx, ty); 1: rotate by a about (tx, ty);
 * 3: glide x ↦ tx − x, y ↦ y + ty.
 */
function deriveEdge(
  /** @type {Shape} */ s,
  /** @type {number} */ d,
  /** @type {number} */ e,
  /** @type {number} */ kind,
  /** @type {number} */ tx,
  /** @type {number} */ ty,
  /** @type {number} */ a,
) {
  const src = scratchEdges[e];
  const out = scratchEdges[d];
  const n = s.edgeN[e];
  const V = s.frame.V;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  for (let i = 0; i < n; i++) {
    // Source point: reversed edges take e's points n−2 … 0 then its start vertex; the glide
    // keeps the order (points 0 … n−1).
    const j = kind === 3 ? i : n - 2 - i;
    const x = j < 0 ? V[e * 2] : src[j * 2];
    const y = j < 0 ? V[e * 2 + 1] : src[j * 2 + 1];
    if (kind === 0) {
      out[i * 2] = x + tx;
      out[i * 2 + 1] = y + ty;
    } else if (kind === 1) {
      out[i * 2] = tx + c * (x - tx) - sn * (y - ty);
      out[i * 2 + 1] = ty + sn * (x - tx) + c * (y - ty);
    } else {
      out[i * 2] = tx - x;
      out[i * 2 + 1] = y + ty;
    }
  }
  s.edgeN[d] = n;
}

/**
 * The outline of the blend of two compatible species (w = 0: a, 1: b) into `s`. Corners and
 * chord-frame edge points blend linearly; the derived edges follow by the type's isometries, so
 * every blend is a tile of the type. Allocates nothing.
 * @param {Species} a @param {Species} b @param {number} w @param {Shape} s
 */
export function blendShapes(a, b, w, s) {
  if (a.sig !== b.sig) throw new Error(`${a.id} and ${b.id} are not blend-compatible (${a.sig} ≠ ${b.sig})`);
  const type = a.type;
  const info = TYPES[type];
  s.type = type;
  for (let i = 0; i < 6; i++) s.corners[i] = a.corners[i] + (b.corners[i] - a.corners[i]) * w;
  const V = frameOf(type, s.corners, s.frame).V;
  const ne = info.edges;
  // Free edges, absolute (chord frame → tile frame between their vertices).
  for (const e of info.free) {
    const ea = a.edges[e];
    const eb = b.edges[e];
    const out = scratchEdges[e];
    const ax = V[e * 2];
    const ay = V[e * 2 + 1];
    const e1 = (e + 1) % ne;
    const dx = V[e1 * 2] - ax;
    const dy = V[e1 * 2 + 1] - ay;
    const n = ea.length / 2;
    for (let i = 0; i < n; i++) {
      const u = ea[i * 2] + (eb[i * 2] - ea[i * 2]) * w;
      const v = ea[i * 2 + 1] + (eb[i * 2 + 1] - ea[i * 2 + 1]) * w;
      out[i * 2] = ax + u * dx - v * dy;
      out[i * 2 + 1] = ay + u * dy + v * dx;
    }
    s.edgeN[e] = n;
  }
  if (type === "TTTTTT") {
    deriveEdge(s, 3, 0, 0, V[6] - V[2], V[7] - V[3], 0);
    deriveEdge(s, 4, 1, 0, V[8] - V[4], V[9] - V[5], 0);
    deriveEdge(s, 5, 2, 0, V[10] - V[6], V[11] - V[7], 0);
  } else if (type === "TGTG") {
    deriveEdge(s, 2, 0, 3, V[4], V[5], 0); // glide: x ↦ (w + s) − x, y ↦ y + h (not reversed)
    deriveEdge(s, 3, 1, 0, -V[2], 0, 0);
  } else if (type === "C4") {
    deriveEdge(s, 2, 1, 1, V[4], V[5], -Math.PI / 2);
    deriveEdge(s, 3, 0, 1, V[0], V[1], Math.PI / 2);
  } else {
    deriveEdge(s, 1, 2, 1, V[4], V[5], THIRD);
    deriveEdge(s, 3, 4, 1, V[8], V[9], THIRD);
    deriveEdge(s, 5, 0, 1, V[0], V[1], THIRD);
  }
  // Concatenate E0 … E(n−1) into the closed outline.
  let k = 0;
  const box = s.box;
  box[0] = box[1] = Infinity;
  box[2] = box[3] = -Infinity;
  for (let e = 0; e < ne; e++) {
    const src = scratchEdges[e];
    for (let i = 0; i < s.edgeN[e]; i++, k++) {
      if (k >= MAX_OUTLINE) throw new Error(`${a.id}: more than ${MAX_OUTLINE} outline points`);
      const x = src[i * 2];
      const y = src[i * 2 + 1];
      s.outline[k * 2] = x;
      s.outline[k * 2 + 1] = y;
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    }
  }
  s.n = k;
  return s;
}

/** The outline of one species into `s`. @param {Species} sp @param {Shape} s */
export const shapeOf = (sp, s) => blendShapes(sp, sp, 0, s);

/**
 * @typedef {object} Hit which tile holds a point (mirrors the bake shader's search)
 * @property {number} k copy within the cell @property {number} i @property {number} j lattice
 *   translate @property {number} lx @property {number} ly the point in the base tile's frame
 * @property {number} count how many tiles hold it (1 for a tiling)
 */

/** Even-odd test of (x, y) against the outline. @param {Shape} s @param {number} x @param {number} y */
export function inside(s, x, y) {
  const p = s.outline;
  let c = false;
  for (let i = 0, j = s.n - 1; i < s.n; j = i++) {
    const yi = p[i * 2 + 1];
    const yj = p[j * 2 + 1];
    if (yi > y !== yj > y && x < ((p[j * 2] - p[i * 2]) * (y - yi)) / (yj - yi) + p[i * 2]) c = !c;
  }
  return c;
}

/**
 * The tile holding frame point (x, y): every copy and nearby lattice translate whose inverse
 * map takes the point into the base outline. For tests and tools (the bake shader does the same).
 * @param {Shape} s @param {number} x @param {number} y @param {Hit} out
 */
export function locate(s, x, y, out) {
  const f = s.frame;
  const L = f.L;
  const det = L[0] * L[3] - L[2] * L[1];
  const ci = Math.floor((x * L[3] - y * L[2]) / det);
  const cj = Math.floor((y * L[0] - x * L[1]) / det);
  out.count = 0;
  for (let k = 0; k < f.nCopies; k++) {
    const o = k * 6;
    const m = f.copies;
    const md = m[o] * m[o + 3] - m[o + 2] * m[o + 1];
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        const ti = ci + di;
        const tj = cj + dj;
        const px = x - ti * L[0] - tj * L[2] - m[o + 4];
        const py = y - ti * L[1] - tj * L[3] - m[o + 5];
        const lx = (m[o + 3] * px - m[o + 2] * py) / md;
        const ly = (-m[o + 1] * px + m[o] * py) / md;
        if (lx < s.box[0] || lx > s.box[2] || ly < s.box[1] || ly > s.box[3]) continue;
        if (!inside(s, lx, ly)) continue;
        if (out.count++ === 0) {
          out.k = k;
          out.i = ti;
          out.j = tj;
          out.lx = lx;
          out.ly = ly;
        }
      }
    }
  }
  return out;
}

/** Colour class of the tile a Hit names. @param {Shape} s @param {Hit} h */
export function classOf(s, h) {
  const f = s.frame;
  const c = f.copyCls[h.k] + h.i * f.ca + h.j * f.cb;
  return ((c % f.nc) + f.nc) % f.nc;
}

/**
 * Every species in the bestiary: each group's tiles/<group>/index.json (written by
 * `uv run python -m tools.tiles index`, one file per group so designers never share one), then
 * its species files. A missing group is empty; a file that fails to parse is logged and skipped.
 * @param {{ json: (path: string) => Promise<any> }} assets @param {(msg: string) => void} log
 * @returns {Promise<Species[]>}
 */
export async function loadBestiary(assets, log) {
  /** @type {Species[]} */
  const out = [];
  await Promise.all(
    GROUPS.map(async (g) => {
      /** @type {string[]} */
      let names = [];
      try {
        names = (await assets.json(`tiles/${g}/index.json`)).species ?? [];
      } catch {
        return;
      }
      await Promise.all(
        names.map(async (n) => {
          try {
            out.push(parseSpecies(await assets.json(`tiles/${g}/${n}.json`), `tiles/${g}/${n}.json`));
          } catch (e) {
            log(`bestiary: skipped ${g}/${n}: ${e instanceof Error ? e.message : e}`);
          }
        }),
      );
    }),
  );
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
