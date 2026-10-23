// @ts-check
import { describe, expect, it } from "vitest";
import {
  ATLAS_ERODE,
  createAtlasUniforms,
  createCreatures,
  creatureList,
  DATA_W,
  dwellSteps,
  packLibrary,
  packShape,
  TYPE_CHANGE_EVERY,
} from "./atlas.js";
import { blendShapes, createShape, parseSpecies, plainOf, TYPES } from "./bestiary.js";

/** @param {keyof typeof TYPES} type @param {number} bump @param {string} name */
function species(type, bump, name, group = "fish") {
  /** @type {Record<string, any>} */
  const edges = {};
  for (const e of TYPES[type].free) edges[`e${e}`] = { smooth: [[0.3, bump], [0.7, -bump]] };
  return parseSpecies(
    {
      format: 1,
      name,
      group,
      type,
      edges,
      art: [
        { part: "eye", circle: [0.5, 0.5, 0.05] },
        { part: "fin", stroke: { polyline: [[0.3, 0.3], [0.4, 0.4], [0.5, 0.3]] }, width: [0.02, 0.01] },
        { part: "patch", fill: { polyline: [[0.6, 0.6], [0.7, 0.6], [0.65, 0.7]] } },
      ],
      colours: { eye: "paper", fin: "cut", patch: "accent" },
      height: { dome: 0.5, parts: { fin: 0.3 } },
    },
    `${group}/${name}.json`,
  );
}

const texel = (/** @type {Float32Array} */ d, /** @type {number} */ t) => Array.from(d.subarray(t * 4, t * 4 + 4));

describe("packLibrary", () => {
  it("packs each species' art once: headers then points, row 0 left for the outline", () => {
    const a = species("C4", 0.05, "a");
    const b = species("TGTG", 0.05, "b");
    const lib = packLibrary([a, b]);
    expect(lib.data.length % (DATA_W * 4)).toBe(0);
    const sa = /** @type {{ start: number, count: number }} */ (lib.sets.get("fish/a"));
    const sb = /** @type {{ start: number, count: number }} */ (lib.sets.get("fish/b"));
    expect(sa.count).toBe(3);
    expect(sa.start).toBeGreaterThanOrEqual(DATA_W); // row 0 is the outline's
    expect(sb.start).toBeGreaterThanOrEqual(sa.start + 3 * 3);
    // Circle: kind 2, role paper (2), box = the circle's square.
    expect(texel(lib.data, sa.start).slice(0, 2)).toEqual([2, 2]);
    expect(texel(lib.data, sa.start + 2).map((v) => +v.toFixed(5))).toEqual([0.45, 0.45, 0.55, 0.55]);
    // Stroke: kind 1, role cut (3), its points where the header says, widths and height.
    const [kind, role, p0, n] = texel(lib.data, sa.start + 3);
    expect([kind, role, n]).toEqual([1, 3, 3]);
    expect(texel(lib.data, p0 + 1).slice(0, 2).map((v) => +v.toFixed(5))).toEqual([0.4, 0.4]);
    expect(texel(lib.data, sa.start + 4).slice(0, 3).map((v) => +v.toFixed(5))).toEqual([0.02, 0.01, 0.3]);
    // A plain tile (no art) gets an empty set.
    expect(packLibrary([plainOf(a)]).sets.get("fish/a~plain")).toEqual({ start: DATA_W, count: 0 });
  });
});

describe("packShape", () => {
  it.each(/** @type {(keyof typeof TYPES)[]} */ (Object.keys(TYPES)))(
    "%s: inverse copies, centres, lattice and search ranges match the shape",
    (type) => {
      const s = createShape();
      blendShapes(species(type, 0.1, "a"), species(type, 0.1, "a"), 0, s);
      const u = createAtlasUniforms();
      packShape(s, u);
      const f = s.frame;
      expect(u.nCopies).toBe(f.nCopies);
      expect(u.n).toBe(s.n);
      expect(u.scale).toBeCloseTo(TYPES[type].scale, 12);
      for (let k = 0; k < f.nCopies; k++) {
        // inverse ∘ copy = identity on a test point
        const m = f.copies.subarray(k * 6, k * 6 + 6);
        const [x, y] = [0.37, 0.21];
        const wx = m[0] * x + m[2] * y + m[4];
        const wy = m[1] * x + m[3] * y + m[5];
        const iv = u.inv.subarray(k * 4, k * 4 + 4);
        const of = u.off.subarray(k * 4, k * 4 + 4);
        expect(iv[0] * wx + iv[2] * wy + of[0]).toBeCloseTo(x, 5);
        expect(iv[1] * wx + iv[3] * wy + of[1]).toBeCloseTo(y, 5);
        expect(of[2]).toBe(f.copyCls[k]);
        expect(u.range[k * 4]).toBeLessThanOrEqual(u.range[k * 4 + 1]);
        for (const r of u.range.subarray(k * 4, k * 4 + 4)) expect(Math.abs(r)).toBeLessThanOrEqual(2);
      }
      // Linv · L = I
      const L = u.L;
      const Li = u.Linv;
      expect(Li[0] * L[0] + Li[2] * L[1]).toBeCloseTo(1, 5);
      expect(Li[1] * L[0] + Li[3] * L[1]).toBeCloseTo(0, 5);
      expect(Array.from(u.cls)).toEqual([f.ca, f.cb, f.nc]);
      // The outline is uploaded as RGBA texels (x, y, 0, 0).
      expect(u.outline[4]).toBe(s.outline[2]);
      expect(u.outline[5]).toBe(s.outline[3]);
    },
  );

  it("allocates nothing (the same arrays come back)", () => {
    const s = createShape();
    const a = species("C3", 0.1, "a");
    blendShapes(a, a, 0, s);
    const u = createAtlasUniforms();
    const keep = [u.inv, u.off, u.ctr, u.range, u.L, u.Linv, u.box, u.cls, u.outline];
    packShape(s, u);
    packShape(s, u);
    expect([u.inv, u.off, u.ctr, u.range, u.L, u.Linv, u.box, u.cls, u.outline]).toEqual(keep);
    keep.forEach((arr, i) => expect([u.inv, u.off, u.ctr, u.range, u.L, u.Linv, u.box, u.cls, u.outline][i]).toBe(arr));
  });
});

describe("creatureList", () => {
  it("abstract → none; a group → its species; all → every group; group/name → one", () => {
    const ids = ["birds/tern", "fish/halibut", "fish/koi", "reptiles/turtle"];
    expect(creatureList("abstract", ids)).toEqual([]);
    expect(creatureList("fish", ids)).toEqual(["fish/halibut", "fish/koi"]);
    expect(creatureList("all", ids)).toEqual(ids);
    expect(creatureList("fish/koi", ids)).toEqual(["fish/koi"]);
    expect(creatureList("fish/nope", ids)).toEqual([]);
    expect(creatureList("mammals", ids)).toEqual([]);
  });
});

describe("createCreatures", () => {
  const koi = species("TGTG", 0.05, "koi");
  const hal = species("TGTG", -0.04, "halibut");
  const turtle = species("C4", 0.05, "turtle", "reptiles");
  const opts = { stepped: false, morph: 1, reduceMotion: false };
  /** @param {ReturnType<typeof createCreatures>} c @param {number} seconds */
  const run = (c, seconds, stepAt = -1) => {
    for (let t = 0; t < seconds * 60; t++) {
      opts.stepped = t === stepAt;
      c.step(1 / 60, opts);
    }
  };

  it("starts on the first species, unchanged until a step", () => {
    const c = createCreatures();
    c.setSpecies([koi, hal]);
    c.step(1 / 60, opts);
    expect(c.a).toBe(koi);
    expect(c.w).toBe(0);
    expect(c.changed).toBe(true); // first frame: bake
    c.step(1 / 60, opts);
    expect(c.changed).toBe(false);
  });

  it("morphs to a compatible species on a step, easing w 0 → 1, art eroding across", () => {
    const c = createCreatures();
    c.setSpecies([koi, hal]);
    run(c, 0.1, 1);
    expect(c.a).toBe(koi);
    expect(c.b).toBe(hal);
    expect(c.w).toBeGreaterThan(0);
    expect(c.w).toBeLessThan(1);
    expect(c.erodeA).toBeCloseTo(c.w * ATLAS_ERODE, 9);
    expect(c.erodeB).toBeCloseTo((1 - c.w) * ATLAS_ERODE, 9);
    expect(c.dip).toBe(0);
    expect(c.changed).toBe(true);
    run(c, 3);
    expect(c.a).toBe(hal);
    expect(c.w).toBe(0);
    expect(c.changed).toBe(false);
  });

  it("changes type through the plain tiles, dipping to the mean at the swap", () => {
    const c = createCreatures();
    c.setSpecies([koi, turtle]);
    run(c, 0.05, 1);
    expect(c.b.id).toBe("fish/koi~plain");
    let peak = 0;
    let swapped = false;
    for (let t = 0; t < 600; t++) {
      opts.stepped = false;
      c.step(1 / 60, opts);
      peak = Math.max(peak, c.dip);
      if (c.a.id === "reptiles/turtle~plain") swapped = true;
      if (c.a === turtle && c.w === 0) break;
    }
    expect(swapped).toBe(true);
    expect(peak).toBeCloseTo(1, 1);
    expect(c.a).toBe(turtle);
    expect(c.dip).toBe(0);
  });

  it("Morph sets how many steps a species stays; 0 holds it", () => {
    expect(dwellSteps(1)).toBe(1);
    expect(dwellSteps(0.7)).toBe(2);
    expect(dwellSteps(0.01)).toBe(4);
    expect(dwellSteps(0)).toBe(Infinity);
    const c = createCreatures();
    c.setSpecies([koi, hal]);
    const o = { stepped: false, morph: 0, reduceMotion: false };
    for (let i = 0; i < 20; i++) {
      o.stepped = i % 2 === 0;
      c.step(0.5, o);
    }
    expect(c.a).toBe(koi);
    expect(c.w).toBe(0);
  });

  it("prefers compatible species and changes type every few changes", () => {
    const koi2 = species("TGTG", 0.02, "koi2");
    const c = createCreatures();
    c.setSpecies([koi, turtle, hal, koi2]);
    /** @type {string[]} */
    const seen = [c.a?.id ?? ""];
    for (let n = 0; n < 12; n++) {
      run(c, 4, 1);
      if (c.a.id !== seen[seen.length - 1]) seen.push(c.a.id);
    }
    // Compatible hops among the TGTG fish, then a hop to the turtle on the TYPE_CHANGE_EVERY-th change.
    const firstTurtle = seen.indexOf("reptiles/turtle");
    expect(firstTurtle).toBe(TYPE_CHANGE_EVERY);
    expect(seen.slice(0, firstTurtle).every((id) => id.startsWith("fish/"))).toBe(true);
  });

  it("a single species never morphs; an empty list is inactive", () => {
    const c = createCreatures();
    c.setSpecies([koi]);
    run(c, 5, 1);
    expect(c.a).toBe(koi);
    expect(c.w).toBe(0);
    const e = createCreatures();
    e.setSpecies([]);
    e.step(1 / 60, opts);
    expect(e.active).toBe(false);
  });

  it("allocates nothing per step once the species are set", () => {
    const c = createCreatures();
    c.setSpecies([koi, hal, turtle]);
    const before = c.plain;
    run(c, 10, 1);
    expect(c.plain).toBe(before);
  });
});
