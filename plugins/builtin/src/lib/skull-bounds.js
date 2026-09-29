// @ts-check
/**
 * Skull Trip's skull: the table of shapes the signed-distance model is built from (injected into
 * shaders/skull/skull.frag as #defines, so the shader and these bounds can't drift apart), the
 * bounding sphere that contains it at every jaw angle, and that sphere's circle on screen (the
 * raymarch runs only inside it).
 *
 * Object space: y up, the face looks down +z, the cranium is about 1 unit in radius.
 */

/**
 * @typedef {{ kind: "ellipsoid", c: number[], r: number[], mirror?: boolean, jaw?: boolean }} Ellipsoid
 * @typedef {{ kind: "capsule", a: number[], b: number[], r: number, mirror?: boolean, jaw?: boolean }} Capsule
 * @typedef {{ kind: "teeth", c: number[], arc: number, jaw?: boolean }} Teeth
 * @typedef {Ellipsoid | Capsule | Teeth} Shape
 */

/** Half-size and rounding of one tooth (a rounded box). */
export const TOOTH = [0.048, 0.085, 0.045];
export const TOOTH_ROUND = 0.022;
/** Angular spacing of the teeth (radians) and how many either side of the middle. */
export const TOOTH_STEP = 0.2;
export const TOOTH_SIDE = 4;

/** The jaw swings about this hinge (the x axis through it); positive angles drop the chin. */
export const JAW_HINGE = [0, -0.42, -0.1];

/** @type {Record<string, Shape>} */
export const SHAPES = {
  CRANIUM: { kind: "ellipsoid", c: [0, 0.28, -0.12], r: [0.9, 0.92, 1.02] },
  BROWFACE: { kind: "ellipsoid", c: [0, 0.08, 0.34], r: [0.72, 0.6, 0.55] },
  MAXILLA: { kind: "ellipsoid", c: [0, -0.4, 0.4], r: [0.44, 0.3, 0.38] },
  CHEEK: { kind: "ellipsoid", c: [0.48, -0.2, 0.5], r: [0.22, 0.17, 0.22], mirror: true },
  ARCH: { kind: "capsule", a: [0.58, -0.22, 0.38], b: [0.78, -0.2, -0.12], r: 0.075, mirror: true },
  BROW: { kind: "capsule", a: [0.6, 0.14, 0.56], b: [0.08, 0.12, 0.8], r: 0.1, mirror: true },
  TEMPLE: { kind: "ellipsoid", c: [1.04, -0.05, 0.22], r: [0.3, 0.36, 0.42], mirror: true },
  SOCKET: { kind: "ellipsoid", c: [0.3, -0.02, 0.7], r: [0.22, 0.2, 0.5], mirror: true },
  NOSE_LOBE: { kind: "ellipsoid", c: [0.055, -0.37, 0.8], r: [0.075, 0.07, 0.32], mirror: true },
  NOSE_TIP: { kind: "ellipsoid", c: [0, -0.26, 0.8], r: [0.04, 0.1, 0.32] },
  TEETH_UP: { kind: "teeth", c: [0, -0.6, 0.12], arc: 0.4 },
  CHIN: { kind: "ellipsoid", c: [0, -0.96, 0.34], r: [0.3, 0.15, 0.2], jaw: true },
  JAW_BODY: { kind: "capsule", a: [0.18, -0.93, 0.36], b: [0.5, -0.82, -0.06], r: 0.11, mirror: true, jaw: true },
  RAMUS: { kind: "capsule", a: [0.5, -0.82, -0.06], b: [0.58, -0.42, -0.12], r: 0.09, mirror: true, jaw: true },
  TEETH_DOWN: { kind: "teeth", c: [0, -0.8, 0.1], arc: 0.38, jaw: true },
};

/**
 * Carve-outs (sockets, temples, nose) only remove material, so they're left out of the hull.
 * @param {string} name
 */
const isCarve = (name) => name === "TEMPLE" || name === "SOCKET" || name.startsWith("NOSE");

/** Radius of the sphere (object units, about the origin) the skull fits in at any jaw angle. */
export const SKULL_RADIUS = 1.42;

/**
 * Rotate a jaw point about the hinge by `jaw` radians (chin down for positive angles).
 * @param {number[]} p
 * @param {number} jaw
 * @returns {number[]}
 */
export function jawToWorld(p, jaw) {
  const y = p[1] - JAW_HINGE[1];
  const z = p[2] - JAW_HINGE[2];
  const c = Math.cos(jaw);
  const s = Math.sin(jaw);
  return [p[0], JAW_HINGE[1] + y * c - z * s, JAW_HINGE[2] + y * s + z * c];
}

/**
 * Spheres (x, y, z, r) that together contain every solid part of the skull with the jaw open by
 * `jaw` radians. Allocates: for tests and setup only.
 * @param {number} jaw
 */
export function hullSpheres(jaw) {
  const toothR = Math.hypot(TOOTH[0], TOOTH[1], TOOTH[2]) + TOOTH_ROUND;
  /** @type {number[][]} */
  const out = [];
  for (const [name, s] of Object.entries(SHAPES)) {
    if (isCarve(name)) continue;
    /** @type {number[][]} */
    const balls =
      s.kind === "ellipsoid" ? [[...s.c, Math.max(...s.r)]]
      : s.kind === "capsule" ? [[...s.a, s.r], [...s.b, s.r]]
      : [[...s.c, s.arc + toothR]];
    for (const b of balls) {
      const mirrored = "mirror" in s && s.mirror ? [b, [-b[0], b[1], b[2], b[3]]] : [b];
      for (const m of mirrored) {
        const p = s.jaw ? jawToWorld(m, jaw) : m;
        out.push([p[0], p[1], p[2], m[3]]);
      }
    }
  }
  return out;
}

/** Camera distance from the skull's centre (object units at scale 1). */
export const CAM_DIST = 6;

/**
 * Radius, in screen units, of the circle the bounding sphere (SKULL_RADIUS × scale, centred at
 * the origin) covers when seen by a pinhole camera CAM_DIST away with focal length `focal`
 * (screen = focal × xy / depth). The silhouette of a sphere is a circle whose half-angle α has
 * sin α = R / D, so its screen radius is focal × tan α.
 * @param {number} scale
 * @param {number} focal
 */
export function screenRadius(scale, focal) {
  const R = Math.min(SKULL_RADIUS * scale, 0.95 * CAM_DIST);
  return (focal * R) / Math.sqrt(CAM_DIST * CAM_DIST - R * R);
}

/** @param {number} x */
const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
/** @param {number[]} v */
const vec3 = (v) => `vec3(${v.map(f).join(", ")})`;

/** The shape table as GLSL #defines (NAME_C/NAME_R, NAME_A/NAME_B/NAME_R, NAME_C/NAME_ARC). */
export function glslDefines() {
  const lines = [
    `#define SKULL_RADIUS ${f(SKULL_RADIUS)}`,
    `#define JAW_HINGE ${vec3(JAW_HINGE)}`,
    `#define TOOTH ${vec3(TOOTH)}`,
    `#define TOOTH_ROUND ${f(TOOTH_ROUND)}`,
    `#define TOOTH_STEP ${f(TOOTH_STEP)}`,
    `#define TOOTH_SIDE ${f(TOOTH_SIDE)}`,
  ];
  for (const [name, s] of Object.entries(SHAPES)) {
    if (s.kind === "ellipsoid") lines.push(`#define ${name}_C ${vec3(s.c)}`, `#define ${name}_R ${vec3(s.r)}`);
    else if (s.kind === "capsule")
      lines.push(`#define ${name}_A ${vec3(s.a)}`, `#define ${name}_B ${vec3(s.b)}`, `#define ${name}_R ${f(s.r)}`);
    else lines.push(`#define ${name}_C ${vec3(s.c)}`, `#define ${name}_ARC ${f(s.arc)}`);
  }
  return lines.join("\n") + "\n";
}
