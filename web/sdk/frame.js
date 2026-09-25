// @ts-check
/**
 * Binary frame v1 decoder (docs/protocols.md §1).
 *
 * Decision: arrays are zero-copy Float32Array VIEWS over the received (transferred) ArrayBuffer.
 * One AudioFrame object is reused for every frame; per decode the only allocations are the
 * DataView and the 3–5 view wrappers (a few dozen bytes each, ~60/s since the SDK decodes only
 * the frame it renders). Copying into preallocated arrays would need a Uint8Array wrapper per
 * frame anyway plus a 6.5–10.6 KB memcpy, and would break the documented "zero-copy view"
 * contract. Scalars are copied into a preallocated array so the named getters never allocate.
 */

export const MAGIC = 0x315a5654; // "TVZ1" read as little-endian u32
export const VERSION = 1;
export const HEADER_BYTES = 32;
export const FLAG_ONSET = 1;
export const FLAG_SILENT = 2;
export const FLAG_STEREO = 4;

/** Scalar order of the v1 frame. New scalars are appended. */
export const SCALAR_NAMES = /** @type {const} */ ([
  "rms", "peak", "bass", "mid", "treb", "bassAtt", "midAtt", "trebAtt",
  "onsetStrength", "bpm", "beatPhase", "centroid", "flux",
]);

export class FrameError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "FrameError";
  }
}

/**
 * Validate a frame header; throws FrameError on a malformed frame.
 * @param {ArrayBuffer} buf
 * @param {DataView} dv
 */
function check(buf, dv) {
  if (buf.byteLength < HEADER_BYTES) throw new FrameError(`frame too short: ${buf.byteLength} B`);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC) throw new FrameError(`bad magic 0x${magic.toString(16)}`);
  const version = dv.getUint16(4, true);
  if (version !== VERSION) throw new FrameError(`unsupported frame version ${version}`);
  const flags = dv.getUint16(6, true);
  const b = dv.getUint16(24, true), s = dv.getUint16(26, true);
  const w = dv.getUint16(28, true), c = dv.getUint16(30, true);
  const need = HEADER_BYTES + 4 * (c + b + s + w * (flags & FLAG_STEREO ? 3 : 1));
  if (buf.byteLength < need) throw new FrameError(`frame truncated: ${buf.byteLength} B < ${need} B`);
  return flags;
}

/**
 * Validate a frame and return its flags (used on arrival to latch onsets).
 * @param {ArrayBuffer} buf
 * @returns {number}
 */
export function peekFlags(buf) {
  return check(buf, new DataView(buf));
}

/** The reusable AudioFrame. Named scalar getters read a preallocated array. */
export class DecodedFrame {
  constructor() {
    /** Scalars, at least 16 long (zeros for ones the frame doesn't carry). */
    this.scalars = new Float32Array(16);
    this.bands = new Float32Array(64);
    this.spectrum = new Float32Array(1024);
    this.waveform = new Float32Array(512);
    /** @type {Float32Array | null} */
    this.left = null;
    /** @type {Float32Array | null} */
    this.right = null;
    this.onset = false;
    this.silent = true;
    this.stereo = false;
    this.frameIndex = 0;
    this.sampleRate = 48000;
    /** Host monotonic time (s) of the newest sample. */
    this.hostTime = 0;
  }
  get rms() { return this.scalars[0]; }
  get peak() { return this.scalars[1]; }
  get bass() { return this.scalars[2]; }
  get mid() { return this.scalars[3]; }
  get treb() { return this.scalars[4]; }
  get bassAtt() { return this.scalars[5]; }
  get midAtt() { return this.scalars[6]; }
  get trebAtt() { return this.scalars[7]; }
  get onsetStrength() { return this.scalars[8]; }
  get bpm() { return this.scalars[9]; }
  get beatPhase() { return this.scalars[10]; }
  get centroid() { return this.scalars[11]; }
  get flux() { return this.scalars[12]; }
}

/** A silent all-zero frame (what plugins see before the first real frame arrives). */
export function createAudioFrame() {
  return new DecodedFrame();
}

/**
 * Decode `buf` into `frame` (reused). Arrays become views over `buf`. Throws FrameError.
 * @param {DecodedFrame} frame
 * @param {ArrayBuffer} buf
 * @returns {DecodedFrame}
 */
export function decodeInto(frame, buf) {
  const dv = new DataView(buf);
  const flags = check(buf, dv);
  const b = dv.getUint16(24, true), s = dv.getUint16(26, true);
  const w = dv.getUint16(28, true), c = dv.getUint16(30, true);

  if (frame.scalars.length < c) frame.scalars = new Float32Array(c);
  const sc = frame.scalars;
  for (let i = 0; i < sc.length; i++) sc[i] = i < c ? dv.getFloat32(HEADER_BYTES + 4 * i, true) : 0;

  let off = HEADER_BYTES + 4 * c;
  frame.bands = new Float32Array(buf, off, b); off += 4 * b;
  frame.spectrum = new Float32Array(buf, off, s); off += 4 * s;
  frame.waveform = new Float32Array(buf, off, w); off += 4 * w;
  const stereo = (flags & FLAG_STEREO) !== 0;
  if (stereo) {
    frame.left = new Float32Array(buf, off, w); off += 4 * w;
    frame.right = new Float32Array(buf, off, w);
  } else {
    frame.left = null;
    frame.right = null;
  }
  frame.stereo = stereo;
  frame.onset = (flags & FLAG_ONSET) !== 0;
  frame.silent = (flags & FLAG_SILENT) !== 0;
  frame.frameIndex = dv.getUint32(8, true);
  frame.sampleRate = dv.getFloat32(12, true);
  frame.hostTime = dv.getFloat64(16, true);
  return frame;
}
