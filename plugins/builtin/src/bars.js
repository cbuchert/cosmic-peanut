// @ts-check
/**
 * Bars — Canvas 2D spectrum bars with falling peak caps and a live waveform line.
 *
 * Reference plugin for the `2d` renderer: reads `audio.bands` and `audio.waveform`, reacts to all
 * four param types, and allocates nothing per frame (gradients and buffers are built in `create`,
 * `resize` and `params`).
 */
import { hexToRgb } from "./lib/color.js";
import { createFlashLimiter } from "./lib/flash.js";
import { groupBands, smoothLevels, updatePeaks } from "./lib/levels.js";

const MAX_BARS = 64;

/** @type {import('../tidalviz').CreateVisualizer} */
export default function create(ctx) {
  const g = /** @type {CanvasRenderingContext2D} */ (ctx.ctx2d);

  const target = new Float32Array(MAX_BARS);
  const levels = new Float32Array(MAX_BARS);
  const peaks = new Float32Array(MAX_BARS);
  const hold = new Float32Array(MAX_BARS);
  const vel = new Float32Array(MAX_BARS);
  const rgb = new Float32Array(3);
  const flash = createFlashLimiter();
  let glow = 0;

  let count = 64;
  /** @type {CanvasGradient | string} */
  let barFill = "#fff";
  /** @type {CanvasGradient | string} */
  let backdrop = "rgb(0 0 0 / 0)";
  let colorCss = "#fff";
  let waveCss = "rgba(255,255,255,0.8)";
  let capCss = "#fff";

  function rebuildStyles() {
    count = Number(ctx.params.count) || 64;
    hexToRgb(ctx.params.color, rgb);
    const [r, gg, b] = [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255].map(Math.round);
    const light = (/** @type {number} */ c, /** @type {number} */ k) => Math.round(c + (255 - c) * k);
    colorCss = `rgb(${r} ${gg} ${b})`;
    waveCss = `rgb(${light(r, 0.6)} ${light(gg, 0.6)} ${light(b, 0.6)} / 0.85)`;
    capCss = `rgb(${light(r, 0.8)} ${light(gg, 0.8)} ${light(b, 0.8)})`;

    const { width: w, height: h } = ctx.size;
    const mirror = Boolean(ctx.params.mirror);
    const base = mirror ? h / 2 : h;
    const top = mirror ? 0 : h * 0.08;
    const grad = g.createLinearGradient(0, base, 0, top);
    grad.addColorStop(0, `rgb(${r} ${gg} ${b} / 0.25)`);
    grad.addColorStop(0.55, colorCss);
    grad.addColorStop(1, `rgb(${light(r, 0.7)} ${light(gg, 0.7)} ${light(b, 0.7)})`);
    barFill = grad;

    const bg = g.createRadialGradient(w / 2, h, 0, w / 2, h, Math.hypot(w / 2, h));
    bg.addColorStop(0, `rgb(${r} ${gg} ${b} / 0.35)`);
    bg.addColorStop(1, "rgb(0 0 0 / 0)");
    backdrop = bg;
  }
  rebuildStyles();

  /**
   * @param {Float32Array} wave
   * @param {number} y0
   * @param {number} amp
   * @param {number} w
   */
  function tracePath(wave, y0, amp, w) {
    const n = wave.length;
    const step = w / (n - 1);
    g.beginPath();
    g.moveTo(0, y0 - wave[0] * amp);
    for (let i = 1; i < n; i++) g.lineTo(i * step, y0 - wave[i] * amp);
  }

  return {
    frame(audio, time) {
      const { width: w, height: h } = ctx.size;
      const dt = time.dt;
      const mirror = Boolean(ctx.params.mirror);
      const unit = h / 1440; // scale strokes and gaps with resolution

      groupBands(audio.bands, count, target);
      smoothLevels(levels, target, count, Number(ctx.params.smoothing), dt);
      updatePeaks(peaks, hold, vel, levels, count, dt);

      // Background: transparent (the shell supplies black or the desktop) plus a bass glow. The
      // glow is the only full-screen brightness change, so it goes through the flash limiter.
      const kick = audio.onset ? Math.min(1, 0.4 + audio.onsetStrength) : 0;
      glow = Math.max(kick, glow * Math.exp(-dt * 5));
      const bright = flash.step(Math.min(1, 0.25 + 0.35 * glow + 0.2 * audio.bassAtt), dt, ctx.reduceFlashing);
      g.clearRect(0, 0, w, h);
      g.globalAlpha = bright;
      g.fillStyle = backdrop;
      g.fillRect(0, 0, w, h);
      g.globalAlpha = 1;

      // Bars
      const margin = w * 0.04;
      const slot = (w - margin * 2) / count;
      const gap = Math.max(1, slot * 0.22);
      const barW = slot - gap;
      const base = mirror ? h / 2 : h * 0.9;
      const maxH = mirror ? h * 0.42 : h * 0.78;
      const capH = Math.max(2, 5 * unit);
      g.fillStyle = barFill;
      for (let i = 0; i < count; i++) {
        const x = margin + i * slot + gap / 2;
        const bh = Math.max(capH, levels[i] * maxH);
        g.fillRect(x, base - bh, barW, bh);
        if (mirror) g.fillRect(x, base, barW, bh);
      }
      if (!mirror) {
        // Faint floor reflection, squashed into the space under the baseline.
        g.globalAlpha = 0.14;
        const room = h - base;
        for (let i = 0; i < count; i++) {
          const x = margin + i * slot + gap / 2;
          g.fillRect(x, base + capH, barW, Math.min(room, levels[i] * room * 1.2));
        }
        g.globalAlpha = 1;
      }
      g.fillStyle = capCss;
      for (let i = 0; i < count; i++) {
        const x = margin + i * slot + gap / 2;
        const y = peaks[i] * maxH + capH * 2;
        g.fillRect(x, base - y, barW, capH);
        if (mirror) g.fillRect(x, base + y - capH, barW, capH);
      }

      // Waveform: a wide faint stroke under a thin bright one reads as a glow without shadowBlur.
      if (ctx.params.waveform) {
        const y0 = mirror ? h / 2 : h * 0.45;
        const amp = h * 0.18;
        g.lineJoin = "round";
        tracePath(audio.waveform, y0, amp, w);
        g.strokeStyle = colorCss;
        g.globalAlpha = 0.25;
        g.lineWidth = 7 * unit;
        g.stroke();
        g.globalAlpha = 1;
        g.strokeStyle = waveCss;
        g.lineWidth = 2 * unit;
        g.stroke();
      }
    },

    resize() {
      rebuildStyles();
    },

    params(changed) {
      if ("count" in changed) {
        levels.fill(0);
        peaks.fill(0);
      }
      rebuildStyles();
    },
  };
}
