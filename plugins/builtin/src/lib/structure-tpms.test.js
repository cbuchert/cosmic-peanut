// @ts-check
import { describe, expect, it } from "vitest";
import { THICKNESS } from "./lattice.js";
import { tpmsStructure } from "./structure-tpms.js";
import { SWELL_MAX, TPMS, sheet } from "./tpms.js";

describe("tpmsStructure runtime", () => {
  it("uploads the sheet within the worst case the clearance assumes, and the origin's phase", () => {
    for (const name of /** @type {const} */ (["gyroid", "schwarz-p", "schwarz-d"])) {
      const s = TPMS[name];
      /** @type {Record<string, number[]>} */
      const got = {};
      const gl = /** @type {any} */ ({
        uniform4f: (/** @type {string} */ u, /** @type {number[]} */ ...v) => (got[u] = v),
        uniform3f: (/** @type {string} */ u, /** @type {number[]} */ ...v) => (got[u] = v),
      });
      const ctx = /** @type {any} */ ({ params: { thickness: THICKNESS.max }, reduceMotion: false });
      const rt = tpmsStructure(name).runtime(ctx);
      const origin = new Float64Array([-7, 13, 2 * s.period]);
      const f = /** @type {any} */ ({ react: 2, live: true, bpm: 120, origin, pulses: {} });
      const worst = sheet(s, THICKNESS.max, SWELL_MAX, 1, new Float64Array(4));
      for (let i = 0; i < 1200; i++) {
        rt.step(/** @type {any} */ ({ bassAtt: 3, midAtt: 3 }), 1 / 60, f);
        rt.upload(gl, /** @type {any} */ ({ u_tpms: "u_tpms", u_tphase: "u_tphase" }), f);
        expect(Math.abs(got.u_tpms[1])).toBeLessThanOrEqual(worst[1] + 1e-6);
        expect(got.u_tpms[2]).toBeLessThanOrEqual(worst[2] + 1e-6);
      }
      // Fully bent by now.
      expect(got.u_tpms[2]).toBeGreaterThan(worst[2] * 0.97);
      const k = (2 * Math.PI) / s.period;
      const ph = (/** @type {number} */ o) => (((o % s.period) + s.period) % s.period) * k;
      expect(got.u_tphase[0]).toBeCloseTo(ph(-7), 9);
      expect(got.u_tphase[1]).toBeCloseTo(ph(13), 9);
      expect(got.u_tphase[2]).toBeCloseTo(0, 9);
      for (const v of got.u_tphase) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
