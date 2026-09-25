import { describe, it, expect } from "vitest";
import { createAudioFrame, decodeInto, FrameError, peekFlags, SCALAR_NAMES } from "./frame.js";
import { encodeFrame } from "./dev/encode.js";

// Node built-ins are loaded untyped so node's globals don't leak into the DOM-typed SDK program.
/** @type {(specifier: string) => Promise<any>} */
const load = (specifier) => import(specifier);
const { readFileSync } = await load("node:fs");
const { fileURLToPath } = await load("node:url");

/** @param {string} name */
function fixture(name) {
  const dir = new URL("../../tests/fixtures/", import.meta.url);
  const bin = readFileSync(fileURLToPath(new URL(`${name}.bin`, dir)));
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const json = JSON.parse(readFileSync(fileURLToPath(new URL(`${name}.json`, dir)), "utf8"));
  return { buf, json };
}

/**
 * @param {any} audio
 * @param {any} json
 */
function assertMatchesGolden(audio, json) {
  expect(audio.frameIndex).toBe(json.frameIndex);
  expect(audio.sampleRate).toBe(json.sampleRate);
  expect(audio.hostTime).toBe(json.hostTime);
  expect(audio.onset).toBe(json.onset);
  expect(audio.silent).toBe(json.silent);
  expect(audio.stereo).toBe(json.stereo);
  expect(json.scalarNames.slice(0, SCALAR_NAMES.length)).toEqual(SCALAR_NAMES);
  SCALAR_NAMES.forEach((name, i) => expect(audio[name], name).toBe(json.scalars[i]));
  // Every named (non-reserved) scalar the host writes must be exposed on the frame.
  json.scalarNames.forEach((/** @type {string} */ name, /** @type {number} */ i) => {
    if (!name.startsWith("reserved")) expect(audio[name], name).toBe(json.scalars[i]);
  });
  expect(Array.from(audio.scalars)).toEqual(json.scalars);
  expect(Array.from(audio.bands)).toEqual(json.bands);
  expect(Array.from(audio.spectrum)).toEqual(json.spectrum);
  expect(Array.from(audio.waveform)).toEqual(json.waveform);
  if (json.left === null) {
    expect(audio.left).toBeNull();
    expect(audio.right).toBeNull();
  } else {
    expect(Array.from(audio.left)).toEqual(json.left);
    expect(Array.from(audio.right)).toEqual(json.right);
  }
}

describe("decodeInto (golden fixtures shared with pytest)", () => {
  it("decodes the mono fixture exactly", () => {
    const { buf, json } = fixture("frame_v1_mono");
    assertMatchesGolden(decodeInto(createAudioFrame(), buf), json);
  });

  it("decodes the stereo fixture exactly", () => {
    const { buf, json } = fixture("frame_v1_stereo");
    assertMatchesGolden(decodeInto(createAudioFrame(), buf), json);
  });
});

describe("decodeInto validation and layout", () => {
  it("rejects bad magic", () => {
    expect(() => decodeInto(createAudioFrame(), encodeFrame({ magic: 0x12345678 }))).toThrow(FrameError);
  });
  it("rejects an unknown version", () => {
    expect(() => decodeInto(createAudioFrame(), encodeFrame({ version: 2 }))).toThrow(/version 2/);
  });
  it("rejects a truncated frame and a too-short buffer", () => {
    const full = encodeFrame({ stereo: true });
    expect(() => decodeInto(createAudioFrame(), full.slice(0, full.byteLength - 4))).toThrow(/truncated/);
    expect(() => peekFlags(new ArrayBuffer(8))).toThrow(FrameError);
  });
  it("uses the header counts, not constants (extra scalars appended)", () => {
    const buf = encodeFrame({
      bands: 8, spectrum: 16, waveform: 4, scalars: 20, stereo: true,
      fill: (plane, i) => (/** @type {Record<string, number>} */ ({ scalars: 100, bands: 200, spectrum: 300, waveform: 400, left: 500, right: 600 }))[plane] + i,
    });
    const a = decodeInto(createAudioFrame(), buf);
    expect(a.scalars.length).toBe(20);
    expect(a.rms).toBe(100);
    expect(a.flux).toBe(112);
    expect(Array.from(a.bands)).toEqual([200, 201, 202, 203, 204, 205, 206, 207]);
    expect(a.spectrum.length).toBe(16);
    expect(a.spectrum[15]).toBe(315);
    expect(Array.from(a.waveform)).toEqual([400, 401, 402, 403]);
    expect(Array.from(/** @type {Float32Array} */ (a.left))).toEqual([500, 501, 502, 503]);
    expect(Array.from(/** @type {Float32Array} */ (a.right))).toEqual([600, 601, 602, 603]);
  });
  it("reads fewer scalars as zeros and clears stale scalars", () => {
    const f = createAudioFrame();
    decodeInto(f, encodeFrame({ fill: (p) => (p === "scalars" ? 1 : 0) }));
    decodeInto(f, encodeFrame({ scalars: 2, fill: (p) => (p === "scalars" ? 7 : 0) }));
    expect(f.rms).toBe(7);
    expect(f.bass).toBe(0);
  });
  it("reuses one frame object; arrays are zero-copy views of the buffer", () => {
    const f = createAudioFrame();
    const buf = encodeFrame({ onset: true, silent: true });
    expect(decodeInto(f, buf)).toBe(f);
    expect(f.bands.buffer).toBe(buf);
    expect(f.onset && f.silent).toBe(true);
    expect(peekFlags(buf)).toBe(3);
  });
  it("a fresh frame is silent and zeroed with default sizes", () => {
    const f = createAudioFrame();
    expect([f.bands.length, f.spectrum.length, f.waveform.length]).toEqual([64, 1024, 512]);
    expect(f.silent).toBe(true);
    expect(f.onset).toBe(false);
    expect(f.left).toBeNull();
    expect(f.bass).toBe(0);
  });
});
