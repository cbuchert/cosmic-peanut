// @ts-check
import { describe, expect, it } from "vitest";
import {
  blendShapes,
  classOf,
  createShape,
  defaultCorners,
  FLAT,
  frameOf,
  loadBestiary,
  locate,
  parseSpecies,
  plainOf,
  shapeOf,
  TYPES,
} from "./bestiary.js";

/** Small seeded PRNG for repeatable random shapes. @param {number} seed */
function rng(seed) {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPE_NAMES = /** @type {(keyof typeof TYPES)[]} */ (Object.keys(TYPES));

/**
 * A species file with gently wavy free edges (small enough to stay simple), random per seed.
 * @param {keyof typeof TYPES} type @param {number} seed @param {number} [amp]
 * @returns {any}
 */
function wavy(type, seed, amp = 0.12) {
  const r = rng(seed);
  /** @type {Record<string, any>} */
  const edges = {};
  for (const e of TYPES[type].free) {
    // One cubic with two handles, or a polyline of three points: both kinds are exercised.
    edges[`e${e}`] =
      e % 2 === 0
        ? { bezier: [[0.3, amp * (r() * 2 - 1)], [0.7, amp * (r() * 2 - 1)]] }
        : { polyline: [[0.25, amp * (r() - 0.5)], [0.5, amp * (r() * 2 - 1)], [0.75, amp * (r() - 0.5)]] };
  }
  return {
    format: 1,
    name: `Test ${type}`,
    group: "fish",
    type,
    edges,
    art: [{ part: "eye", circle: [0.5, 0.5, 0.05] }],
    colours: { eye: "ink" },
  };
}

/** Signed area of a closed polygon (flat x, y). @param {ArrayLike<number>} p @param {number} n */
function area(p, n) {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}

/** Rotation by a about (cx, cy). @param {number} cx @param {number} cy @param {number} a */
const rotAbout = (cx, cy, a) => (/** @type {number} */ x, /** @type {number} */ y) => [
  cx + Math.cos(a) * (x - cx) - Math.sin(a) * (y - cy),
  cy + Math.sin(a) * (x - cx) + Math.cos(a) * (y - cy),
];
/** Translation. @param {number} tx @param {number} ty */
const shift = (tx, ty) => (/** @type {number} */ x, /** @type {number} */ y) => [x + tx, y + ty];

/**
 * Heesch's edge relations, written out independently of the module: [derived edge, its free
 * partner, the isometry taking the partner onto it, whether the direction reverses].
 * @param {string} type @param {ArrayLike<number>} V vertices
 * @returns {[number, number, (x: number, y: number) => number[], boolean][]}
 */
function relations(type, V) {
  const v = (/** @type {number} */ i) => [V[i * 2], V[i * 2 + 1]];
  const sub = (/** @type {number} */ i, /** @type {number} */ j) => [v(i)[0] - v(j)[0], v(i)[1] - v(j)[1]];
  const third = (2 * Math.PI) / 3;
  switch (type) {
    case "TTTTTT":
      return [
        [3, 0, shift(sub(3, 1)[0], sub(3, 1)[1]), true],
        [4, 1, shift(sub(4, 2)[0], sub(4, 2)[1]), true],
        [5, 2, shift(sub(5, 3)[0], sub(5, 3)[1]), true],
      ];
    case "TGTG": {
      const c = (V[2] + V[6]) / 2; // glide axis x = (w + s) / 2
      const h = V[5];
      return [
        [2, 0, (x, y) => [2 * c - x, y + h], false],
        [3, 1, shift(-V[2], 0), true],
      ];
    }
    case "C4":
      return [
        [2, 1, rotAbout(V[4], V[5], -Math.PI / 2), true],
        [3, 0, rotAbout(V[0], V[1], Math.PI / 2), true],
      ];
    default:
      return [
        [1, 2, rotAbout(V[4], V[5], third), true],
        [3, 4, rotAbout(V[8], V[9], third), true],
        [5, 0, rotAbout(V[0], V[1], third), true],
      ];
  }
}

describe("tile types", () => {
  it.each(TYPE_NAMES)("%s: the default base polygon has 1/copies of the period cell's area", (type) => {
    const s = createShape();
    shapeOf(plainOf(parseSpecies(wavy(type, 1), "fish/test.json")), s);
    const L = s.frame.L;
    const cell = Math.abs(L[0] * L[3] - L[1] * L[2]);
    expect(area(s.outline, s.n)).toBeCloseTo(cell / TYPES[type].copies, 5);
  });

  it("default corners are the regular polygons (C4 square, C3 and TTTTTT regular hexagons)", () => {
    const f = frameOf("C4", defaultCorners("C4"));
    expect(Array.from(f.V.slice(0, 8))).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    for (const type of /** @type {const} */ (["C3", "TTTTTT"])) {
      const g = frameOf(type, defaultCorners(type));
      for (let i = 0; i < 6; i++) {
        const j = (i + 1) % 6;
        expect(Math.hypot(g.V[j * 2] - g.V[i * 2], g.V[j * 2 + 1] - g.V[i * 2 + 1])).toBeCloseTo(1, 5);
      }
    }
  });
});

describe("edge derivation", () => {
  it.each(TYPE_NAMES)("%s: every derived edge is its partner's image under the type's isometry", (type) => {
    for (let seed = 1; seed <= 5; seed++) {
      const s = createShape();
      shapeOf(parseSpecies(wavy(type, seed), "fish/test.json"), s);
      // Each edge's points (start vertex first) from the outline.
      const V = s.frame.V;
      const ne = TYPES[type].edges;
      /** @type {number[][][]} */
      const edges = [];
      let k = 0;
      for (let e = 0; e < ne; e++) {
        const pts = [[V[e * 2], V[e * 2 + 1]]];
        for (let i = 0; i < s.edgeN[e]; i++, k++) pts.push([s.outline[k * 2], s.outline[k * 2 + 1]]);
        edges.push(pts);
      }
      expect(k).toBe(s.n);
      for (const [d, from, map, reversed] of relations(type, V)) {
        const src = edges[from].map(([x, y]) => map(x, y));
        if (reversed) src.reverse();
        expect(src.length).toBe(edges[d].length);
        src.forEach(([x, y], i) => {
          expect(edges[d][i][0]).toBeCloseTo(x, 5);
          expect(edges[d][i][1]).toBeCloseTo(y, 5);
        });
      }
    }
  });

  it("corners move the vertices and the edges follow (TGTG shear, TTTTTT and C3 corners)", () => {
    const a = createShape();
    const spec = wavy("TGTG", 3);
    shapeOf(parseSpecies({ ...spec, corners: { w: 1.2, h: 0.8, s: 0.3 } }, "fish/t.json"), a);
    expect(Array.from(a.frame.V.slice(0, 8)).map((v) => +v.toFixed(9))).toEqual([0, 0, 1.2, 0, 1.5, 0.8, 0.3, 0.8]);
    expect(Array.from(a.frame.L)).toEqual([1.2, 0, 0, 1.6]);
    const c3 = createShape();
    shapeOf(parseSpecies({ ...wavy("C3", 2), corners: { v1: [1.1, 0.1] } }, "fish/t.json"), c3);
    expect(c3.frame.V[2]).toBeCloseTo(1.1, 5);
    const t6 = createShape();
    shapeOf(parseSpecies({ ...wavy("TTTTTT", 2), corners: { v1: [1.2, 0], v2: [1.6, 0.9], v3: [1, 1.7] } }, "fish/t.json"), t6);
    const L = t6.frame.L;
    expect(area(t6.outline, t6.n)).toBeCloseTo(Math.abs(L[0] * L[3] - L[1] * L[2]), 5);
  });
});

describe("the tiling", () => {
  it.each(TYPE_NAMES)("%s: every point of the plane is in exactly one tile", (type) => {
    const s = createShape();
    shapeOf(parseSpecies(wavy(type, 7), "fish/test.json"), s);
    const r = rng(11);
    const hit = { k: 0, i: 0, j: 0, lx: 0, ly: 0, count: 0 };
    for (let n = 0; n < 400; n++) {
      locate(s, r() * 8 - 4, r() * 8 - 4, hit);
      expect(hit.count).toBe(1);
    }
  });

  it.each(TYPE_NAMES)("%s: the colour classes are a proper colouring (edge neighbours differ)", (type) => {
    const s = createShape();
    shapeOf(parseSpecies(wavy(type, 5), "fish/test.json"), s);
    const a = { k: 0, i: 0, j: 0, lx: 0, ly: 0, count: 0 };
    const b = { k: 0, i: 0, j: 0, lx: 0, ly: 0, count: 0 };
    const seen = new Set();
    // Across the middle of every outline segment of the base tile and of a translate of it.
    for (const [ox, oy] of [
      [0, 0],
      [s.frame.L[0] + s.frame.L[2], s.frame.L[1] + s.frame.L[3]],
    ]) {
      for (let i = 0; i < s.n; i++) {
        const j = (i + 1) % s.n;
        const x0 = s.outline[i * 2];
        const y0 = s.outline[i * 2 + 1];
        const dx = s.outline[j * 2] - x0;
        const dy = s.outline[j * 2 + 1] - y0;
        const l = Math.hypot(dx, dy);
        const mx = ox + x0 + dx / 2;
        const my = oy + y0 + dy / 2;
        const e = 1e-4;
        locate(s, mx - (dy / l) * e, my + (dx / l) * e, a); // left: inside (CCW)
        locate(s, mx + (dy / l) * e, my - (dx / l) * e, b);
        const ca = classOf(s, a);
        const cb = classOf(s, b);
        expect(ca).not.toBe(cb);
        seen.add(ca).add(cb);
      }
    }
    expect(seen.size).toBe(TYPES[type].classes);
  });
});

describe("blending", () => {
  it.each(TYPE_NAMES)("%s: blends of compatible species stay tiles of the type", (type) => {
    const a = parseSpecies(wavy(type, 1), "fish/a.json");
    const b = parseSpecies(wavy(type, 2), "fish/b.json");
    expect(a.sig).toBe(b.sig);
    const s = createShape();
    const sa = createShape();
    const sb = createShape();
    shapeOf(a, sa);
    shapeOf(b, sb);
    blendShapes(a, b, 0, s);
    expect(Array.from(s.outline.slice(0, s.n * 2))).toEqual(Array.from(sa.outline.slice(0, sa.n * 2)));
    blendShapes(a, b, 1, s);
    expect(Array.from(s.outline.slice(0, s.n * 2))).toEqual(Array.from(sb.outline.slice(0, sb.n * 2)));
    blendShapes(a, b, 0.4, s);
    const L = s.frame.L;
    expect(area(s.outline, s.n)).toBeCloseTo(Math.abs(L[0] * L[3] - L[1] * L[2]) / TYPES[type].copies, 5);
    const hit = { k: 0, i: 0, j: 0, lx: 0, ly: 0, count: 0 };
    const r = rng(3);
    for (let n = 0; n < 200; n++) {
      locate(s, r() * 6 - 3, r() * 6 - 3, hit);
      expect(hit.count).toBe(1);
    }
  });

  it("different edge structures are incompatible; blending them throws", () => {
    const a = parseSpecies(wavy("C4", 1), "fish/a.json");
    const spec = wavy("C4", 2);
    spec.edges.e0 = { bezier: [[0.2, 0.1], [0.4, 0.1], [0.5, 0], [0.6, -0.1], [0.8, -0.1]] };
    const b = parseSpecies(spec, "fish/b.json");
    expect(a.sig).not.toBe(b.sig);
    expect(() => blendShapes(a, b, 0.5, createShape())).toThrow(/compatible/);
    const c = parseSpecies(wavy("C3", 1), "fish/c.json");
    expect(c.sig).not.toBe(a.sig);
  });

  it("the plain tile has the species' structure and straight edges", () => {
    const a = parseSpecies(wavy("TTTTTT", 4), "fish/a.json");
    const p = plainOf(a);
    expect(p.sig).toBe(a.sig);
    expect(p.art.prims.length).toBe(0);
    const s = createShape();
    shapeOf(p, s);
    const L = s.frame.L;
    expect(area(s.outline, s.n)).toBeCloseTo(Math.abs(L[0] * L[3] - L[1] * L[2]), 5);
    expect(Math.abs(area(s.outline, s.n))).toBeCloseTo((3 * Math.sqrt(3)) / 2, 5);
  });

  it("allocates nothing per blend (the same arrays come back)", () => {
    const a = parseSpecies(wavy("TGTG", 1), "fish/a.json");
    const b = parseSpecies(wavy("TGTG", 2), "fish/b.json");
    const s = createShape();
    const { outline, frame } = s;
    const L = frame.L;
    blendShapes(a, b, 0.3, s);
    blendShapes(a, b, 0.6, s);
    expect(s.outline).toBe(outline);
    expect(s.frame).toBe(frame);
    expect(s.frame.L).toBe(L);
  });
});

describe("smooth curves", () => {
  it("a smooth edge passes through its points, and keeps its own structure", () => {
    const spec = wavy("C4", 1);
    spec.edges.e0 = { smooth: [[0.25, 0.1], [0.5, -0.05], [0.75, 0.1]] };
    const sp = parseSpecies(spec, "fish/s.json");
    expect(sp.sig).toContain("e0=s3");
    const e = sp.edges[0];
    // FLAT points per span, 4 spans: the span ends are the given points, then (1, 0).
    expect(e.length / 2).toBe(4 * FLAT);
    for (const [k, [u, v]] of [[0.25, 0.1], [0.5, -0.05], [0.75, 0.1], [1, 0]].entries()) {
      expect(e[((k + 1) * FLAT - 1) * 2]).toBeCloseTo(u, 12);
      expect(e[((k + 1) * FLAT - 1) * 2 + 1]).toBeCloseTo(v, 12);
    }
  });

  it("a smooth closed fill wraps round; a smooth stroke runs end to end", () => {
    const spec = wavy("C4", 1);
    spec.art = [
      { part: "eye", fill: { smooth: [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]] } },
      { part: "fin", stroke: { smooth: [[0.2, 0.2], [0.3, 0.3], [0.4, 0.2]] }, width: 0.02 },
    ];
    spec.colours = { eye: "ink", fin: "cut" };
    const sp = parseSpecies(spec, "fish/s.json");
    const [fill, stroke] = sp.art.prims;
    expect(fill.count).toBe(1 + 4 * FLAT); // first point, then 4 spans back round to it
    const p = sp.art.points;
    const last = fill.start + fill.count - 1;
    expect([p[last * 2], p[last * 2 + 1]]).toEqual([0.4, 0.4]);
    expect(stroke.count).toBe(1 + 2 * FLAT);
    const end = stroke.start + stroke.count - 1;
    expect(p[end * 2]).toBeCloseTo(0.4, 12);
    expect(p[end * 2 + 1]).toBeCloseTo(0.2, 12);
  });
});

describe("parseSpecies", () => {
  it("names the species by group/file and keeps the metadata", () => {
    const sp = parseSpecies(wavy("C4", 1), "tiles/fish/test-c4.json");
    expect(sp.id).toBe("fish/test-c4");
    expect(sp.name).toBe("Test C4");
    expect(sp.type).toBe("C4");
    expect(sp.art.prims.length).toBe(1);
  });

  it.each([
    [{ type: "p6" }, /type/],
    [{ edges: {} }, /e0/],
    [{ edges: { e0: { bezier: [[0.5, 0.1]] }, e1: { polyline: [] } } }, /3n − 1/],
    [{ colours: {} }, /eye/],
    [{ colours: { eye: "glitter" } }, /role/],
    [{ format: 2 }, /format/],
    [{ group: "birds" }, /group/],
  ])("rejects %j", (patch, msg) => {
    expect(() => parseSpecies({ ...wavy("C4", 1), ...patch }, "tiles/fish/x.json")).toThrow(msg);
  });
});

// Node built-ins are loaded untyped so node's globals don't leak into the DOM-typed program.
/** @type {(specifier: string) => Promise<any>} */
const nodeImport = (specifier) => import(specifier);
const { readFileSync } = await nodeImport("node:fs");

describe("the seeds against the tool (tests/fixtures/tiles_golden.json)", () => {
  const root = new URL("../../../../", import.meta.url);
  const golden = JSON.parse(readFileSync(new URL("tests/fixtures/tiles_golden.json", root), "utf8"));
  const load = (/** @type {string} */ id) =>
    parseSpecies(JSON.parse(readFileSync(new URL(`plugins/builtin/tiles/${id}.json`, root), "utf8")), `${id}.json`);
  const near = (/** @type {ArrayLike<number>} */ a, /** @type {number[]} */ b) => {
    expect(a.length).toBe(b.length);
    for (let i = 0; i < b.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(2e-6);
  };

  it.each(Object.keys(golden.species))("%s: the JS derives the tool's outline", (id) => {
    const g = golden.species[id];
    const sp = load(id);
    expect(sp.sig).toBe(g.sig);
    const s = shapeOf(sp, createShape());
    near(s.outline.subarray(0, s.n * 2), g.outline);
    near(s.frame.L, g.L);
    near(s.frame.V.subarray(0, g.V.length), g.V);
  });

  it("blends the morph pairs as the tool does", () => {
    expect(golden.blends.length).toBeGreaterThan(0);
    for (const b of golden.blends) {
      const s = blendShapes(load(b.a), load(b.b), b.w, createShape());
      near(s.outline.subarray(0, s.n * 2), b.outline);
    }
  });
});

describe("loadBestiary", () => {
  it("reads every group's index, skips missing groups and bad files (logging them), sorted by id", async () => {
    /** @type {Record<string, any>} */
    const files = {
      "tiles/fish/index.json": { species: ["koi", "bad"] },
      "tiles/fish/koi.json": { ...wavy("TGTG", 1), name: "Koi" },
      "tiles/fish/bad.json": { ...wavy("TGTG", 1), type: "nope" },
      "tiles/birds/index.json": { species: ["tern"] },
      "tiles/birds/tern.json": { ...wavy("TTTTTT", 1), group: "birds" },
    };
    /** @type {string[]} */
    const logs = [];
    const assets = {
      json: async (/** @type {string} */ p) => {
        if (!(p in files)) throw new Error(`404 ${p}`);
        return files[p];
      },
    };
    const sp = await loadBestiary(assets, (/** @type {string} */ m) => logs.push(m));
    expect(sp.map((s) => s.id)).toEqual(["birds/tern", "fish/koi"]);
    expect(logs.some((m) => m.includes("fish/bad"))).toBe(true);
  });
});
