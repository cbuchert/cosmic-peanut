// @ts-check
import { describe, expect, it } from "vitest";
import { HEIGHT_SCALE, includesOf, spliceIncludes, withDefines } from "./tess-gl.js";

describe("relief program variants", () => {
  it("puts the defines right after #version (GLSL ES needs #version first) and changes nothing else", () => {
    const src = "#version 300 es\n// a surface\nprecision highp float;\n";
    expect(withDefines(src, ["TESS_RELIEF", "TESS_HEIGHT_PASS"])).toBe(
      "#version 300 es\n#define TESS_RELIEF\n#define TESS_HEIGHT_PASS\n// a surface\nprecision highp float;\n",
    );
    expect(withDefines(src, [])).toBe(src);
  });

  it("renders the height pass smaller than the print (heights are smooth)", () => {
    expect(HEIGHT_SCALE).toBeGreaterThan(0.25);
    expect(HEIGHT_SCALE).toBeLessThanOrEqual(0.5);
  });
});

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
