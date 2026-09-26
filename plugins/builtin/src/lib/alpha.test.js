// @ts-check
import { describe, expect, it } from "vitest";
import { alphaFromBrightness } from "./alpha.js";

describe("alphaFromBrightness", () => {
  it("sets alpha to the brightest channel as the shader's last statement", () => {
    const src = "void main() {\n  gl_FragColor = vec4(1.0);\n}\n";
    expect(alphaFromBrightness(src)).toBe(
      "void main() {\n  gl_FragColor = vec4(1.0);\n" +
        "  gl_FragColor.a = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));\n}\n",
    );
  });

  it("throws when the source doesn't end with main's closing brace", () => {
    expect(() => alphaFromBrightness("void main() { gl_FragColor = vec4(1.0); } // done")).toThrow(/closing brace/);
  });
});
