// @ts-check
import { describe, expect, it } from "vitest";
import { JAW_LIMIT, PULSE_LIMIT } from "./skull-motion.js";
import { CAM_DIST, glslDefines, hullSpheres, screenRadius, SKULL_RADIUS } from "./skull-bounds.js";

describe("skull bounding sphere", () => {
  it("contains every part of the skull at every jaw angle", () => {
    for (let i = 0; i <= 20; i++) {
      const jaw = (JAW_LIMIT * i) / 20;
      for (const [x, y, z, r] of hullSpheres(jaw)) {
        expect(Math.hypot(x, y, z) + r, `jaw ${jaw}`).toBeLessThanOrEqual(SKULL_RADIUS);
      }
    }
  });
});

describe("screenRadius", () => {
  it("is a tight circle around the bounding sphere's perspective silhouette", () => {
    for (const focal of [1.2, 3.3, 6]) {
      for (const scale of [0.5, 1, 1.5 * (1 + PULSE_LIMIT)]) {
        const R = SKULL_RADIUS * scale;
        const circle = screenRadius(scale, focal);
        let far = 0;
        for (let i = 0; i < 400; i++) {
          // Points on the sphere (Fibonacci lattice), projected by a camera at z = CAM_DIST.
          const y = 1 - (2 * (i + 0.5)) / 400;
          const ring = Math.sqrt(1 - y * y);
          const a = i * 2.399963;
          const [px, py, pz] = [R * ring * Math.cos(a), R * y, R * ring * Math.sin(a)];
          far = Math.max(far, (focal * Math.hypot(px, py)) / (CAM_DIST - pz));
        }
        expect(far, `${focal} ${scale}`).toBeLessThanOrEqual(circle);
        expect(far, `${focal} ${scale}`).toBeGreaterThan(0.97 * circle);
      }
    }
  });
});

describe("glslDefines", () => {
  it("writes every shape of the table as #defines for the shader", () => {
    const src = glslDefines();
    expect(src).toContain("#define CRANIUM_C vec3(0.0, 0.28, -0.12)");
    expect(src).toContain("#define CRANIUM_R vec3(0.9, 0.92, 1.02)");
    expect(src).toContain("#define ARCH_A vec3(0.58, -0.22, 0.38)");
    expect(src).toContain("#define ARCH_R 0.075");
    expect(src).toContain("#define TEETH_UP_C vec3(0.0, -0.6, 0.12)");
    expect(src).toContain("#define TEETH_UP_ARC 0.4");
    expect(src).toContain("#define JAW_HINGE vec3(0.0, -0.42, -0.1)");
    expect(src).toContain("#define SKULL_RADIUS 1.42");
    expect(src).toContain("#define TOOTH_SIDE 4.0");
  });
});
