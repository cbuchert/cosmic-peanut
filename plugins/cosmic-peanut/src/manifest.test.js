// @ts-check
/** The pack's manifest, as the entry modules read it. */
import { describe, expect, it } from "vitest";
import { lookMode } from "./lib/look.js";

/** @type {(specifier: string) => Promise<any>} */
const load = (specifier) => import(specifier);
const { readFile } = await load("node:fs/promises");
const manifest = JSON.parse(await readFile(new URL("../tidalviz.json", import.meta.url), "utf8"));

/** @type {[string, any][]} */
const rows = manifest.visualizers.map((/** @type {any} */ v) => [v.id, v]);
describe.each(rows)("%s", (_id, v) => {
  it("has a Look select, classic or cinematic, right after Antialias soft lines", () => {
    const ids = v.params.map((/** @type {any} */ p) => p.id);
    expect(ids[ids.indexOf("antialias") + 1]).toBe("look");
    const look = v.params.find((/** @type {any} */ p) => p.id === "look");
    expect(look.type).toBe("select");
    expect(look.label).toBe("Look");
    expect(look.options).toEqual(["classic", "cinematic"]);
    expect(lookMode(look.default)).toBe(look.default);
  });
});

it("gives all three visualizers the same Look default", () => {
  const defaults = manifest.visualizers.map((/** @type {any} */ v) => v.params.find((/** @type {any} */ p) => p.id === "look")?.default);
  expect(new Set(defaults).size).toBe(1);
  expect(defaults[0]).toBeDefined();
});
