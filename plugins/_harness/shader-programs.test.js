// @ts-check
// @ts-expect-error -- a Node builtin (tests run in Node); the web tsconfig has no @types/node.
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error -- as above.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IN_HARNESS, NO_GL, shaderPrograms } from "./shader-programs.js";

const PLUGINS = new URL("..", import.meta.url).pathname;
const PACKS = ["builtin", "cosmic-peanut", "template"];

/** Every shader file a pack ships (.glsl / .frag / .vert), as "<pack>/<path>". */
function shaderFiles() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const e of readdirSync(join(PLUGINS, rel), { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(glsl|frag|vert)$/.test(e.name)) out.push(p);
    }
  };
  PACKS.forEach(walk);
  return out.sort();
}

const read = async (/** @type {string} */ p) => readFileSync(join(PLUGINS, p), "utf8");

describe("shaderPrograms (the list tests/test_shader_compile.py compiles in WebKit)", () => {
  it("covers every visualizer in the built-in packs: enumerated, run in the harness, or not GL", async () => {
    const programs = await shaderPrograms(read);
    const listed = new Set([...programs.map((p) => p.viz), ...Object.keys(IN_HARNESS), ...NO_GL]);
    for (const pack of PACKS) {
      const m = JSON.parse(readFileSync(join(PLUGINS, pack, "tidalviz.json"), "utf8"));
      for (const v of m.visualizers) {
        expect(listed.has(v.id), v.id).toBe(true);
        if (NO_GL.includes(v.id)) expect(v.renderer, v.id).toBe("2d");
      }
    }
  });

  it("reads every shader file the packs ship, so a new one can't go uncompiled", async () => {
    const used = new Set(Object.values(IN_HARNESS).flat());
    const programs = await shaderPrograms(async (p) => {
      used.add(p);
      return read(p);
    });
    expect(programs.length).toBeGreaterThan(0);
    expect(shaderFiles().filter((f) => !used.has(f))).toEqual([]);
  });

  it("labels each program with its visualizer, variant and files, and has no unspliced include", async () => {
    for (const p of await shaderPrograms(read)) {
      expect(p.viz && p.variant && p.files.length >= 2, JSON.stringify(p.files)).toBeTruthy();
      expect(p.vs.startsWith("#version 300 es") && p.fs.startsWith("#version 300 es"), `${p.viz} ${p.variant}`).toBe(true);
      expect(/^\s*\/\/ ?#include /m.test(p.vs + p.fs), `${p.viz} ${p.variant}`).toBe(false);
    }
  });

  it("compiles each of the tess relief, height and atlas variants of a relief surface", async () => {
    const meta = (await shaderPrograms(read)).filter((p) => p.viz === "metamorphosis").map((p) => p.variant);
    expect(meta).toEqual(
      expect.arrayContaining(["metamorphosis.frag", "metamorphosis.frag (relief)", "metamorphosis.frag (relief height)",
        "metamorphosis.frag (relief, atlas)", "metamorphosis.frag (relief, atlas height)", "atlas-bake.frag", "paper.frag"]),
    );
  });

  it("compiles the lattice scene for every structure × Look", async () => {
    const lat = (await shaderPrograms(read)).filter((p) => p.viz === "lattice" && p.variant.startsWith("lattice.frag"));
    expect(lat).toHaveLength(9 * 2);
  });
});
