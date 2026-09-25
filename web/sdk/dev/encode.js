// @ts-check
/**
 * Test/dev-only binary v1 frame encoder (docs/protocols.md §1). Not used by the SDK runtime.
 *
 * @param {{
 *   frameIndex?: number, sampleRate?: number, hostTime?: number,
 *   onset?: boolean, silent?: boolean, stereo?: boolean,
 *   bands?: number, spectrum?: number, waveform?: number, scalars?: number,
 *   fill?: (plane: string, i: number) => number,
 *   magic?: number, version?: number,
 * }} [o]
 * @returns {ArrayBuffer}
 */
export function encodeFrame(o = {}) {
  const B = o.bands ?? 64, S = o.spectrum ?? 1024, W = o.waveform ?? 512, C = o.scalars ?? 16;
  const stereo = o.stereo ?? false;
  const fill = o.fill ?? (() => 0);
  const buf = new ArrayBuffer(32 + 4 * (C + B + S + W * (stereo ? 3 : 1)));
  const dv = new DataView(buf);
  dv.setUint32(0, o.magic ?? 0x315a5654, true);
  dv.setUint16(4, o.version ?? 1, true);
  dv.setUint16(6, (o.onset ? 1 : 0) | (o.silent ? 2 : 0) | (stereo ? 4 : 0), true);
  dv.setUint32(8, o.frameIndex ?? 0, true);
  dv.setFloat32(12, o.sampleRate ?? 48000, true);
  dv.setFloat64(16, o.hostTime ?? 0, true);
  dv.setUint16(24, B, true);
  dv.setUint16(26, S, true);
  dv.setUint16(28, W, true);
  dv.setUint16(30, C, true);
  let off = 32;
  /** @param {string} plane @param {number} n */
  const put = (plane, n) => {
    for (let i = 0; i < n; i++, off += 4) dv.setFloat32(off, fill(plane, i), true);
  };
  put("scalars", C);
  put("bands", B);
  put("spectrum", S);
  put("waveform", W);
  if (stereo) {
    put("left", W);
    put("right", W);
  }
  return buf;
}
