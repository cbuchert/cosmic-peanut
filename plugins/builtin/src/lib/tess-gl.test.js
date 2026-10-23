// @ts-check
import { describe, expect, it } from "vitest";
import { includesOf, spliceIncludes } from "./tess-gl.js";

describe("shader includes", () => {
  const src = "a\n// #include tess\nb\n// #include disk\nc // #include nope-not-a-line\n";
  it("lists the include lines, in order, once each", () => {
    expect(includesOf(src)).toEqual(["tess", "disk"]);
    expect(includesOf("void main() {}")).toEqual([]);
  });
  it("splices each one in place", () => {
    expect(spliceIncludes(src, { tess: "T", disk: "D" })).toBe("a\nT\nb\nD\nc // #include nope-not-a-line\n");
  });
});
