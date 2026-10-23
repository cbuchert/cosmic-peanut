// @ts-check
import { describe, expect, it } from "vitest";
import { NEAR_CLEARANCE, STRUCTURES, STRUCTURE_OPTIONS, assembleShader, structureFor } from "./structures.js";

describe("structureFor", () => {
  it("fixes Tentacle Lattice to its structure; Lattice takes the Structure param (unknown → cubic)", () => {
    expect(structureFor("tentacle-lattice", "cubic")).toBe("tentacle");
    expect(structureFor("lattice", "cubic")).toBe("cubic");
    expect(structureFor("lattice", "no-such")).toBe("cubic");
    expect(structureFor("lattice", undefined)).toBe("cubic");
    expect(STRUCTURE_OPTIONS).toEqual(["cubic", "octet", "diamond", "bitruncated"]);
    expect(structureFor("lattice", "octet")).toBe("octet");
    for (const name of STRUCTURE_OPTIONS) expect(STRUCTURES[name]).toBeDefined();
  });
});

describe("STRUCTURES", () => {
  it("every entry provides a shader, a camera, a pulse topology, a clearance and a runtime", () => {
    for (const [name, s] of Object.entries(STRUCTURES)) {
      expect(s.shader, name).toMatch(/^structure-[a-z0-9-]+\.glsl$/);
      expect(Array.isArray(s.defines), name).toBe(true);
      for (const k of /** @type {const} */ (["scale", "steps", "fog", "far"])) {
        expect(s[k], `${name}.${k}`).toBeGreaterThan(0);
      }
      const cam = s.camera(1);
      cam.update(1 / 60, 1);
      const out = new Float64Array(3);
      cam.ahead(1, out);
      expect(cam.pos.length).toBe(3);
      expect(cam.view.fwd.length).toBe(3);
      expect(typeof cam.pointer).toBe("function");
      s.pulseSource(out, out);
      expect(Number.isFinite(s.clearance(cam.pos))).toBe(true);
      expect(typeof s.runtime).toBe("function");
    }
  });

  it("each structure's camera keeps its own clearance along the whole flight", () => {
    for (const [name, s] of Object.entries(STRUCTURES)) {
      for (const seed of [1, 7, 42]) {
        const cam = s.camera(seed);
        let clear = Infinity;
        for (let f = 0; f < 240 * 60; f++) {
          cam.update(1 / 240, 2);
          clear = Math.min(clear, s.clearance(cam.pos));
        }
        expect(clear, `${name} seed ${seed}`).toBeGreaterThan(NEAR_CLEARANCE);
      }
    }
  });

  it("the cubic structures launch pulses from the nearest node", () => {
    const out = new Float64Array(3);
    for (const name of ["cubic", "tentacle"]) {
      STRUCTURES[name].pulseSource(new Float64Array([2.4, -1.6, 7.5]), out);
      expect(Array.from(out)).toEqual([2, -2, 8]);
    }
  });

  /** A node and a point on a strut, per structure (default: the cubic lattices'). */
  const INSIDE = {
    octet: [[0, 0, 0], [0.5, 0.51, 0.02]],
    diamond: [[0, 0, 0], [0.26, 0.25, 0.24]],
    bitruncated: [[1, 0.5, 0], [1, 0.26, 0.25]],
  };

  it("clearance is the worst case: it goes negative inside the geometry", () => {
    for (const [name, s] of Object.entries(STRUCTURES)) {
      for (const p of INSIDE[/** @type {keyof typeof INSIDE} */ (name)] ?? [[0, 0, 0], [0.5, 0.01, 0.02]]) {
        expect(s.clearance(new Float64Array(p)), `${name} ${p}`).toBeLessThan(0);
      }
    }
  });
});

describe("assembleShader", () => {
  it("replaces `// #include name` lines with the parts and adds defines after #version", () => {
    const main = "#version 300 es\nprecision highp float;\n// #include common\nvoid main() {}\n// #include structure\n";
    const out = assembleShader(main, { common: "float a;", structure: "float b;" }, ["MATERIALS"]);
    expect(out).toBe("#version 300 es\n#define MATERIALS\nprecision highp float;\nfloat a;\nvoid main() {}\nfloat b;\n");
    expect(assembleShader(main, { common: "", structure: "" }, [])).toBe(
      "#version 300 es\nprecision highp float;\n\nvoid main() {}\n\n",
    );
  });

  it("refuses a missing part", () => {
    expect(() => assembleShader("// #include nope\n", {}, [])).toThrow(/nope/);
  });
});
