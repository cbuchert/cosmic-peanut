// @ts-check
import { describe, expect, it } from "vitest";
import {
  ATLAS_ERODE,
  ATLAS_HINT,
  atlasBlock,
  atlasBlockMax,
  createAtlasUniforms,
  createCreatures,
  creatureList,
  DATA_W,
  dwellSteps,
  hintAt,
  hintMax,
  packLibrary,
  packShape,
  TYPE_CHANGE_EVERY,
} from "./atlas.js";
import { blendShapes, createShape, inside, parseSpecies, plainOf, TYPES } from "./bestiary.js";
import { RELIEF_BLOCK, reliefBound, reliefProfile } from "./tess.js";

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

describe("relief hint (the bake's height channel)", () => {
  // A raised boss (0.6) and a carved pit (−0.4) on a domed body; a second species, compatible,
  // with a raised ridge where the first has its pit.
  /** @param {string} name @param {any[]} art @param {Record<string, number>} parts @param {number} dome */
  const carved = (name, art, parts, dome, type = /** @type {keyof typeof TYPES} */ ("TGTG")) => {
    /** @type {Record<string, any>} */
    const edges = {};
    for (const e of TYPES[type].free) edges[`e${e}`] = { smooth: [[0.3, 0.04], [0.7, -0.04]] };
    /** @type {Record<string, string>} */
    const colours = {};
    for (const a of art) colours[a.part] = "cut";
    return parseSpecies({ format: 1, name, group: "fish", type, edges, art, colours, height: { dome, parts } }, `fish/${name}.json`);
  };
  const A = carved(
    "a",
    [
      { part: "boss", circle: [0.5, 0.5, 0.1] },
      { part: "pit", fill: { polyline: [[0.2, 0.2], [0.32, 0.2], [0.32, 0.32], [0.2, 0.32]] } },
    ],
    { boss: 0.6, pit: -0.4 },
    0.7,
  );
  const B = carved("b", [{ part: "ridge", stroke: { polyline: [[0.15, 0.26], [0.4, 0.26]] }, width: 0.05 }], { ridge: 0.5 }, 0.3);
  const C = carved("c", [{ part: "shell", circle: [0.5, 0.5, 0.2] }], { shell: 0.9 }, 1, "C4");
  const lib = packLibrary([A, B, C, plainOf(A), plainOf(C)]);
  const set = (/** @type {string} */ id) => /** @type {{ start: number, count: number }} */ (lib.sets.get(id));
  const none = { start: 0, count: 0 };
  const dome = (/** @type {number} */ k, /** @type {number} */ d) => k * (1 - (1 - Math.min(d / 0.35, 1)) ** 2);

  it("is the body's dome plus the height of the part on top, deep inside each part", () => {
    const h = (/** @type {number} */ x, /** @type {number} */ y) => hintAt(lib.data, set("fish/a"), none, 0, 0, 0.7, 0.3, x, y);
    expect(h(0.5, 0.5)).toBeCloseTo(dome(0.7, 0.3) + 0.6, 6);
    expect(h(0.26, 0.26)).toBeCloseTo(dome(0.7, 0.3) - 0.4, 6);
    expect(h(0.8, 0.2)).toBeCloseTo(dome(0.7, 0.3), 6);
    // The dome is 0 at the outline (the bevel starts at the groove) and tops out DOME_REACH in.
    expect(hintAt(lib.data, none, none, 0, 0, 0.7, 0, 0.8, 0.2)).toBe(0);
    expect(hintAt(lib.data, none, none, 0, 0, 0.7, 1, 0.8, 0.2)).toBeCloseTo(0.7, 9);
  });

  it("has no step at a part's edge (a march and its normals need a continuous height)", () => {
    let worst = 0;
    const dx = 0.0005;
    let prev = hintAt(lib.data, set("fish/a"), none, 0, 0, 0, 0.3, 0.3, 0.5);
    for (let x = 0.3 + dx; x < 0.7; x += dx) {
      const h = hintAt(lib.data, set("fish/a"), none, 0, 0, 0, 0.3, x, 0.5);
      worst = Math.max(worst, Math.abs(h - prev));
      prev = h;
    }
    // A raised part rises over at least ~6 base texels of a 512² bake (no cliff).
    expect(worst).toBeLessThan(0.6 * (dx / 0.012));
    expect(worst).toBeGreaterThan(0); // it does rise
  });

  /**
   * Run createCreatures through a change at 60 fps and return the largest per-frame change of the
   * block height (atlasBlock, × RELIEF_BLOCK at Relief 1) over a grid of base-frame points.
   * @param {import('./bestiary.js').Species[]} list
   */
  const worstFrame = (list) => {
    const c = createCreatures();
    c.setSpecies(list);
    const s = createShape();
    const o = { stepped: false, morph: 1, reduceMotion: false };
    /** @type {number[] | null} */
    let prev = null;
    let worst = 0;
    let moved = false;
    for (let f = 0; f < 60 * 4; f++) {
      o.stepped = f === 1;
      c.step(1 / 60, o);
      moved ||= c.moving;
      blendShapes(c.a, c.b, c.w, s);
      const sa = set(c.a.id);
      const sb = c.a === c.b ? none : set(c.b.id);
      const dm = c.a.dome + (c.b.dome - c.a.dome) * c.w;
      /** @type {number[]} */
      const now = [];
      for (let i = 1; i < 12; i++) {
        for (let j = 1; j < 12; j++) {
          const x = s.box[0] + ((s.box[2] - s.box[0]) * i) / 12;
          const y = s.box[1] + ((s.box[3] - s.box[1]) * j) / 12;
          let blk = 0;
          if (inside(s, x, y)) {
            const d = outlineDist(s, x, y);
            blk = RELIEF_BLOCK * atlasBlock(reliefProfile(d * TYPES[s.type].scale, 0.35), hintAt(lib.data, sa, sb, c.erodeA, c.erodeB, dm, d, x, y), c.dip);
          }
          now.push(blk);
        }
      }
      if (prev) for (let k = 0; k < now.length; k++) worst = Math.max(worst, Math.abs(now[k] - prev[k]));
      prev = now;
    }
    expect(moved).toBe(true);
    return worst;
  };

  it("blends smoothly while species morph and the atlas re-bakes: no part pops in or out", () => {
    // A part 0.6 tall is ATLAS_HINT · 0.6 · RELIEF_BLOCK of block; no frame moves it a quarter of that.
    expect(worstFrame([A, B])).toBeLessThan(0.25 * ATLAS_HINT * 0.6 * RELIEF_BLOCK);
  });

  it("flattens through a change of tile type, so the swap of outlines doesn't jump", () => {
    // The tallest block here is atlasBlockMax(1.9) RELIEF_BLOCKs; it lays down and rises again
    // eased (the print's dip), no frame moving it an eighth of the way.
    expect(worstFrame([A, C])).toBeLessThan(0.125 * atlasBlockMax(hintMax(C)) * RELIEF_BLOCK);
  });

  it("bounds every hint and block (the march starts at the bound)", () => {
    expect(hintMax(A)).toBeCloseTo(0.7 + 0.6, 9);
    expect(hintMax(B)).toBeCloseTo(0.3 + 0.5, 9);
    expect(hintMax(plainOf(A))).toBe(0);
    // An all-carved species: the dome alone.
    const D = carved("d", [{ part: "pit", circle: [0.5, 0.5, 0.1] }], { pit: -0.5 }, 0.4);
    expect(hintMax(D)).toBeCloseTo(0.4, 9);
    for (const sp of [A, B, C, D]) {
      const top = hintMax(sp);
      const own = packLibrary([sp]);
      const ss = /** @type {{ start: number, count: number }} */ (own.sets.get(sp.id));
      for (let i = 0; i < 200; i++) {
        const x = (i % 20) / 20;
        const y = Math.floor(i / 20) / 10;
        expect(hintAt(own.data, ss, none, 0, 0, sp.dome, 1, x, y)).toBeLessThanOrEqual(top + 1e-6);
      }
      for (const prof of [0, 0.5, 1]) {
        expect(atlasBlock(prof, top, 0)).toBeLessThanOrEqual(atlasBlockMax(top) + 1e-9);
      }
    }
    expect(atlasBlockMax(0)).toBe(1);
    expect(atlasBlockMax(1.3)).toBeCloseTo(1 + ATLAS_HINT * 1.3, 9);
    // The groove stays at the floor, and the dip lays the whole block down.
    expect(atlasBlock(0, 1.3, 0)).toBe(0);
    expect(atlasBlock(1, 1.3, 1)).toBe(0);
    // reliefBound takes the block's bound.
    expect(reliefBound(1, 0, 0, false, 0, atlasBlockMax(1.3))).toBeCloseTo(RELIEF_BLOCK * (1 + ATLAS_HINT * 1.3), 9);
    expect(reliefBound(0.6, 0.1, 0.02, true, 0.08)).toBe(reliefBound(0.6, 0.1, 0.02, true, 0.08, 1));
  });
});

/** Distance from (x, y) to a shape's outline (tile frame). @param {ReturnType<typeof createShape>} s @param {number} x @param {number} y */
function outlineDist(s, x, y) {
  let best = Infinity;
  for (let i = 0, j = s.n - 1; i < s.n; j = i++) {
    const ax = s.outline[j * 2];
    const ay = s.outline[j * 2 + 1];
    const bx = s.outline[i * 2] - ax;
    const by = s.outline[i * 2 + 1] - ay;
    const h = Math.min(1, Math.max(0, ((x - ax) * bx + (y - ay) * by) / Math.max(bx * bx + by * by, 1e-12)));
    best = Math.min(best, Math.hypot(x - ax - bx * h, y - ay - by * h));
  }
  return best;
}
