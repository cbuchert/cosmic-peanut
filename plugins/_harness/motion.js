// @ts-check
/**
 * Harness motion meter (dev only): mean absolute frame-to-frame RGB change (0–255) over named zones
 * of a small probe image of the canvas. A zone is a list of ordered rects in 0–1 frame coordinates
 * (y down), "+x0,y0,x1,y1" includes and "-x0,y0,x1,y1" excludes; a leading "-" starts from the full
 * frame. Query: meter=1&zone.<name>=<rects>[&zone.<other>=…] (default zone "all": the full frame).
 */

/**
 * @param {string} spec e.g. "-0.44,0.04,0.56,0.42;-0.25,0.49,0.75,0.8"
 * @param {number} w probe pixels
 * @param {number} h
 * @returns {Uint8Array} 1 where the pixel counts
 */
export function parseZone(spec, w, h) {
  const rects = spec.split(";").filter(Boolean);
  const mask = new Uint8Array(w * h).fill(rects[0]?.startsWith("-") ? 1 : 0);
  for (const r of rects) {
    const on = r[0] === "-" ? 0 : 1;
    const [x0, y0, x1, y1] = r.replace(/^[+-]/, "").split(",").map(Number);
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5) / h;
      if (v < y0 || v > y1) continue;
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        if (u >= x0 && u <= x1) mask[y * w + x] = on;
      }
    }
  }
  return mask;
}

/**
 * @param {Record<string, Uint8Array>} zones masks from parseZone
 * @param {number} w
 * @param {number} h
 */
export function createMotionMeter(zones, w, h) {
  const prev = new Uint8ClampedArray(w * h * 4);
  const names = Object.keys(zones);
  /** @type {Record<string, number>} */
  const out = {};
  let first = true;
  return {
    /** @param {Uint8ClampedArray} rgba w × h RGBA @returns {Record<string, number>} */
    step(rgba) {
      for (const n of names) {
        const m = zones[n];
        let s = 0;
        let c = 0;
        for (let i = 0; i < w * h; i++) {
          if (!m[i]) continue;
          const j = i * 4;
          s += Math.abs(rgba[j] - prev[j]) + Math.abs(rgba[j + 1] - prev[j + 1]) + Math.abs(rgba[j + 2] - prev[j + 2]);
          c++;
        }
        out[n] = first || c === 0 ? 0 : s / (3 * c);
      }
      prev.set(rgba);
      first = false;
      return out;
    },
  };
}
