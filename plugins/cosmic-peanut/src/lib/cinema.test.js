// @ts-check
import { describe, expect, it } from "vitest";
import { RGBA8_SCALE, hdrFormat, includeQuad } from "./cinema.js";

/**
 * Just enough WebGL2 for the format probe: which extensions exist and whether a float
 * framebuffer comes out complete.
 * @param {string[]} exts @param {boolean} complete
 */
function probeGl(exts, complete) {
  const deleted = /** @type {string[]} */ ([]);
  const gl = new Proxy(
    {},
    {
      get(_t, prop) {
        const name = String(prop);
        if (name === "getExtension") return (/** @type {string} */ e) => (exts.includes(e) ? {} : null);
        if (name === "checkFramebufferStatus") return () => (complete ? "FRAMEBUFFER_COMPLETE" : "INCOMPLETE");
        if (name.startsWith("delete")) return () => deleted.push(name);
        if (/^[A-Z0-9_]+$/.test(name)) return name;
        return () => ({});
      },
    },
  );
  return { gl: /** @type {WebGL2RenderingContext} */ (/** @type {unknown} */ (gl)), deleted };
}

describe("hdrFormat", () => {
  it("uses RGBA16F (half float) when EXT_color_buffer_float makes it renderable, at full scale", () => {
    const { gl, deleted } = probeGl(["EXT_color_buffer_float"], true);
    const f = hdrFormat(gl);
    expect([f.internal, f.format, f.type, f.scale, f.float]).toEqual(["RGBA16F", "RGBA", "HALF_FLOAT", 1, true]);
    expect(deleted.sort()).toEqual(["deleteFramebuffer", "deleteTexture"]); // the probe cleans up
  });
  it("accepts EXT_color_buffer_half_float too", () => {
    const f = hdrFormat(probeGl(["EXT_color_buffer_half_float"], true).gl);
    expect([f.internal, f.float]).toEqual(["RGBA16F", true]);
  });
  it("falls back to RGBA8 with headroom (lines stored at RGBA8_SCALE) without the extension", () => {
    const f = hdrFormat(probeGl([], true).gl);
    expect([f.internal, f.format, f.type, f.float]).toEqual(["RGBA8", "RGBA", "UNSIGNED_BYTE", false]);
    expect(f.scale).toBe(RGBA8_SCALE);
    expect(RGBA8_SCALE).toBeLessThan(1);
  });
  it("falls back to RGBA8 when the float framebuffer isn't complete", () => {
    const f = hdrFormat(probeGl(["EXT_color_buffer_float"], false).gl);
    expect(f.internal).toBe("RGBA8");
  });
});

describe("includeQuad", () => {
  it("splices the shared line-quad code in at its marker, once", () => {
    expect(includeQuad("a\n//#include quad\nb", "Q")).toBe("a\nQ\nb");
    expect(() => includeQuad("no marker", "Q")).toThrow();
  });
});
