// @ts-check
import { describe, expect, it } from "vitest";
import { createAutoGain, resampleSeed } from "./fire.js";
import { createAttacks, createFeed, resolveFeed } from "./fuel.js";
import { RISE_MAX, RISE_MIN, logColumns } from "./spectro.js";

const DT = 1 / 60;

describe("createAttacks", () => {
  it("fires a jet on a rising step, only in that band, and never on a steady tone", () => {
    const a = createAttacks(64);
    const lv = new Float32Array(64).fill(0.5);
    const jets = new Float32Array(64);
    let steady = 0;
    for (let i = 0; i < 180; i++) {
      a.step(lv, DT, 1, false, jets);
      if (i >= 60) for (const j of jets) steady = Math.max(steady, j);
    }
    expect(steady).toBeLessThan(0.01);
    lv[3] = 1;
    let peak = 0;
    let others = 0;
    for (let i = 0; i < 3; i++) {
      a.step(lv, DT, 1, false, jets);
      peak = Math.max(peak, jets[3]);
      for (let b = 0; b < 64; b++) if (b !== 3) others = Math.max(others, jets[b]);
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(others).toBeLessThan(0.01);
  });

  it("decays over ~150–300 ms, is bounded, and scales with reactivity", () => {
    /** @param {number} r */
    const trace = (r) => {
      const a = createAttacks(1);
      const lv = new Float32Array([0.2]);
      const jets = new Float32Array(1);
      for (let i = 0; i < 60; i++) a.step(lv, DT, r, false, jets);
      lv[0] = 1; // a big hit, then held
      const out = [];
      for (let i = 0; i < 40; i++) {
        a.step(lv, DT, r, false, jets);
        out.push(jets[0]);
      }
      return out;
    };
    const one = trace(1);
    const peak = Math.max(...one);
    const at = one.indexOf(peak);
    expect(peak).toBeLessThanOrEqual(1);
    expect(one[at + 9]).toBeGreaterThan(0.15 * peak); // 150 ms on
    expect(one[at + 24]).toBeLessThan(0.05 * peak); // 400 ms on
    const two = trace(2);
    expect(Math.max(...two)).toBeCloseTo(2 * peak, 5);
    expect(Math.max(...trace(0))).toBe(0);
  });

  it("with reduceFlashing, a 10 Hz train of hits starts at most 3 jets a second per band", () => {
    for (const reduce of [false, true]) {
      const a = createAttacks(1);
      const lv = new Float32Array(1);
      const jets = new Float32Array(1);
      let starts = 0;
      let prev = 0;
      for (let i = 0; i < 120; i++) {
        lv[0] = i % 6 < 2 ? 1 : 0.1; // 10 Hz at 60 fps
        a.step(lv, DT, 1, reduce, jets);
        if (jets[0] > prev * 1.5 + 0.05) starts++;
        prev = jets[0];
      }
      if (reduce) expect(starts).toBeLessThanOrEqual(6 + 1); // 2 s
      else expect(starts).toBeGreaterThan(15);
    }
  });

  it("behaves the same at 60 and 120 Hz", () => {
    /** @param {number} hz */
    const sample = (hz) => {
      const a = createAttacks(1);
      const lv = new Float32Array(1);
      const jets = new Float32Array(1);
      const out = [];
      for (let i = 0; i < hz * 2; i++) {
        const t = i / hz;
        lv[0] = 0.15 + 0.8 * Math.exp(-((t * 2) % 1) * 7); // 120 BPM kick envelope
        a.step(lv, 1 / hz, 1, false, jets);
        if (i % (hz / 20) === 0) out.push(jets[0]);
      }
      return out;
    };
    const a = sample(60);
    const b = sample(120);
    expect(Math.max(...a)).toBeGreaterThan(0.5);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.15);
  });
});

/** A minimal audio frame for the feed. */
function frame(/** @type {Float32Array} */ spectrum, /** @type {Float32Array} */ waveform, silent = false) {
  return { spectrum, waveform, sampleRate: SR, silent };
}

const SR = 48000;
/** Bin of a frequency in a 1,024-bin spectrum. @param {number} hz */
const bin = (hz) => Math.round((hz * 2048) / SR);
/** Texels whose column covers `hz` for a layout (via the same edges the feed uses). */
function texelsOf(/** @type {number} */ hz, layout = "mirrored") {
  const lo = new Float32Array(256);
  const hi = new Float32Array(256);
  logColumns(layout, 30, 16000, lo, hi);
  const f = bin(hz) * (SR / 2048);
  const out = [];
  for (let i = 0; i < 256; i++) if (lo[i] <= f && f < hi[i]) out.push(i);
  return out;
}
/** Run a feed on a fixed spectrum. */
function run(/** @type {ReturnType<typeof createFeed>} */ f, /** @type {Float32Array} */ spec, /** @type {number} */ frames, layout = "mirrored", wave = new Float32Array(2048)) {
  for (let k = 0; k < frames; k++) f.step(frame(spec, wave), DT, "spectrogram", layout, 1, false);
}

describe("resolveFeed", () => {
  it("keeps the two feeds and migrates anything else (the old 64-band 'spectrum', junk) to the spectrogram", () => {
    expect(resolveFeed("spectrogram")).toBe("spectrogram");
    expect(resolveFeed("waveform")).toBe("waveform");
    for (const v of ["spectrum", "bands", "", undefined, null, 3]) expect(resolveFeed(v)).toBe("spectrogram");
  });
});

describe("createFeed", () => {
  it("waveform feed is the old behaviour: resampled |w| × the loudness auto-gain, no jets, no level-driven rise", () => {
    const f = createFeed(256);
    const ref = createAutoGain();
    const mag = new Float32Array(256);
    const signed = new Float32Array(256);
    const spec = new Float32Array(1024).fill(0.5);
    const wave = new Float32Array(2048);
    for (let k = 0; k < 30; k++) {
      for (let i = 0; i < 2048; i++) wave[i] = 0.4 * Math.sin((i + k * 800) * 0.05);
      f.step(frame(spec, wave), DT, "waveform", "mirrored", 1, false);
      resampleSeed(wave, mag, signed);
      const g = ref.step(Math.max(...mag), DT);
      for (let i = 0; i < 256; i += 17) expect(f.fuel[i]).toBeCloseTo(mag[i] * g, 5);
      for (const j of f.jet) expect(j).toBe(0);
      for (const r of f.rise) expect(r).toBe(0);
    }
  });

  it("spectrogram: each tone burns at its own column, and the louder one rises faster", () => {
    const f = createFeed(256);
    const spec = new Float32Array(1024).fill(1e-5); // −100 dB: under the gate
    spec[bin(220)] = 0.2; // loud
    spec[bin(2500)] = 0.01; // 26 dB quieter (≈ 16 dB after the pink tilt)
    run(f, spec, 180);
    const loud = texelsOf(220);
    const quiet = texelsOf(2500);
    expect(loud.length).toBeGreaterThanOrEqual(2); // both halves
    for (const i of loud) {
      expect(f.fuel[i]).toBeGreaterThan(0.9);
      expect(f.rise[i]).toBeCloseTo(RISE_MAX, 3);
      expect(f.fuel[255 - i]).toBeCloseTo(f.fuel[i], 6); // mirrored
    }
    for (const i of quiet) {
      expect(f.fuel[i]).toBeGreaterThan(0.1);
      expect(f.rise[i]).toBeLessThan(0.5 * RISE_MAX);
      expect(f.rise[i]).toBeGreaterThan(2 * RISE_MIN);
    }
    // Far from both tones: nothing burns and the gas barely moves.
    for (const i of [...texelsOf(60), ...texelsOf(10000)]) {
      expect(f.fuel[i]).toBe(0);
      expect(f.rise[i]).toBeCloseTo(RISE_MIN, 6);
    }
    for (const j of f.jet) expect(j).toBeLessThan(0.01); // steady tones never jet
  });

  it("layout 'linear' runs low → high left → right (unknown layouts are mirrored)", () => {
    const spec = new Float32Array(1024);
    spec[bin(100)] = 0.2;
    const lin = createFeed(256);
    run(lin, spec, 60, "linear");
    const [i] = texelsOf(100, "linear");
    expect(i).toBeLessThan(80);
    expect(lin.fuel[i]).toBeGreaterThan(0.9);
    expect(lin.fuel[255 - i]).toBe(0);
    const odd = createFeed(256);
    run(odd, spec, 60, "diagonal");
    for (const k of texelsOf(100)) expect(odd.fuel[k]).toBeGreaterThan(0.9);
  });

  it("a kick jets the centre and a hat jets the edges (mirrored)", () => {
    const f = createFeed(256);
    const spec = new Float32Array(1024).fill(0.003);
    run(f, spec, 120);
    for (let k = 1; k < 6; k++) spec[k] = 0.3; // kick, < 120 Hz
    run(f, spec, 2);
    expect(f.jet[127]).toBeGreaterThan(0.5);
    expect(f.jet[128]).toBeCloseTo(f.jet[127], 6);
    expect(f.jet[0]).toBeLessThan(0.01);
    run(f, spec, 60);
    for (let k = 400; k < 600; k++) spec[k] = 0.1; // hat, ~9–14 kHz
    run(f, spec, 2);
    expect(f.jet[2]).toBeGreaterThan(0.5);
    expect(f.jet[253]).toBeGreaterThan(0.5);
    expect(f.jet[127]).toBeLessThan(0.01);
  });

  it("flame roots rise at once and fall smoothly (~150 ms), not frame to frame", () => {
    const f = createFeed(256);
    const spec = new Float32Array(1024).fill(0.003);
    run(f, spec, 60);
    const [i] = texelsOf(440);
    spec[bin(440)] = 0.3;
    run(f, spec, 1);
    const hit = f.fuel[i];
    expect(hit).toBeGreaterThan(0.9);
    spec[bin(440)] = 0.003; // drops at once
    run(f, spec, 6);
    expect(f.fuel[i]).toBeGreaterThan(0.35 * hit); // 100 ms on
    run(f, spec, 30);
    expect(f.fuel[i]).toBeLessThan(0.1 * hit); // 600 ms on
  });

  it("silence: no fuel, no jets, everything at the smoulder speed", () => {
    const f = createFeed(256);
    const spec = new Float32Array(1024).fill(0.2);
    run(f, spec, 30);
    const quiet = new Float32Array(1024);
    for (let k = 0; k < 90; k++) f.step(frame(quiet, new Float32Array(2048), true), DT, "spectrogram", "mirrored", 1, false);
    for (let i = 0; i < 256; i++) {
      expect(f.fuel[i]).toBeLessThan(1e-3);
      expect(f.jet[i]).toBeLessThan(0.01);
      expect(f.rise[i]).toBeLessThan(RISE_MIN + 0.01);
    }
  });

  it("behaves the same at 60 and 120 Hz", () => {
    /** @param {number} dt */
    const sim = (dt) => {
      const f = createFeed(256);
      const spec = new Float32Array(1024);
      const wave = new Float32Array(2048);
      for (let t = 0; t < 2.5 - 1e-9; t += dt) {
        spec.fill(0.003);
        if (t < 1.5) spec[bin(330)] = 0.3; // a tone for 1.5 s, then 3 kick-like bursts
        else if ((t * 4) % 1 < 0.3) for (let k = 1; k < 6; k++) spec[k] = 0.3;
        f.step(frame(spec, wave), dt, "spectrogram", "mirrored", 1, false);
      }
      return [Float32Array.from(f.fuel), Float32Array.from(f.rise), Float32Array.from(f.jet)];
    };
    const a = sim(1 / 60);
    const b = sim(1 / 120);
    for (let k = 0; k < 3; k++) for (let i = 0; i < 256; i += 5) expect(b[k][i]).toBeCloseTo(a[k][i], 1);
  });
});
