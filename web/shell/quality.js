// Quality mode → the rendering limits the SDK applies (PRD "Adaptive quality").

/** @typedef {import("./validate.js").QualityMode} QualityMode */
/** @typedef {{ maxDpr: number; fpsCap: number; renderScaleMax: number }} QualityProfile */

/**
 * `fpsCap: 0` means uncapped (match the display). In `auto` the SDK may lower render scale
 * below `renderScaleMax` when frames run over budget.
 * @param {QualityMode} mode
 * @param {number} nativeDpr
 * @returns {QualityProfile}
 */
export function qualityProfile(mode, nativeDpr) {
  const dpr = nativeDpr > 0 ? nativeDpr : 1;
  if (mode === "balanced") return { maxDpr: Math.min(dpr, 1.5), fpsCap: 0, renderScaleMax: 1 };
  if (mode === "battery") return { maxDpr: Math.min(dpr, 1), fpsCap: 30, renderScaleMax: 1 };
  return { maxDpr: dpr, fpsCap: 0, renderScaleMax: 1 };
}
