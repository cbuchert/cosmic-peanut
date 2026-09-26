// @ts-check
/**
 * Synthetic audio frames for the harness: 120 BPM kick on every beat, hats on the offbeats, two
 * drifting spectral bumps, a slow "song" envelope. Everything is preallocated. The waveform is the
 * newest 2,048 samples (overlapping between frames), as in the frame contract.
 * With `strobe`, onsets and bass hits land at 10 Hz — a worst case for the flash limiter.
 */
const SR = 48000;

/** @param {{ strobe?: boolean, silent?: boolean }} [opts] */
export function createSynth(opts = {}) {
  const bands = new Float32Array(64);
  const spectrum = new Float32Array(1024);
  const WAVE = 2048;
  const waveform = new Float32Array(WAVE);
  const left = new Float32Array(WAVE);
  const right = new Float32Array(WAVE);
  const specBand = new Float32Array(1024);
  for (let k = 0; k < 1024; k++) {
    const hz = Math.max(1, (k * SR) / 2048);
    specBand[k] = Math.min(63, Math.max(0, (Math.log(hz / 30) / Math.log(16000 / 30)) * 63));
  }
  let bassAtt = 1;
  let midAtt = 1;
  let trebAtt = 1;
  let lastPulse = -1;
  let onsetStrength = 0;
  let sampleClock = 0;
  let frameIndex = 0;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  /** @type {any} */
  const frame = {
    bands, spectrum, waveform, left, right,
    rms: 0, peak: 0, bass: 1, mid: 1, treb: 1, bassAtt: 1, midAtt: 1, trebAtt: 1,
    onsetStrength: 0, onset: false, bpm: 120, beatPhase: 0, centroid: 0.3, flux: 0,
    silent: false, frameIndex: 0, sampleRate: SR,
  };

  /** @param {number} t seconds @param {number} dt seconds */
  function update(t, dt) {
    const beat = t * 2;
    const phase = beat % 1;
    const pulseRate = opts.strobe ? 10 : 2;
    const pulse = Math.floor(t * pulseRate);
    const pulsePhase = (t * pulseRate) % 1;
    const onset = pulse !== lastPulse;
    lastPulse = pulse;
    const kick = Math.exp(-pulsePhase * (opts.strobe ? 3 : 7));
    const hat = opts.strobe ? 0 : Math.exp(-((beat + 0.5) % 1) * 18);
    const song = 0.75 + 0.25 * Math.sin(t * 0.21);

    const bass = 0.5 + 1.5 * kick;
    const mid = 1 + 0.35 * Math.sin(t * 1.3) + 0.25 * Math.sin(t * 3.7);
    const treb = 0.7 + 0.9 * hat + 0.2 * Math.sin(t * 5.3);
    const a = 1 - Math.exp(-dt * 5);
    bassAtt += (bass - bassAtt) * a;
    midAtt += (mid - midAtt) * a;
    trebAtt += (treb - trebAtt) * a;
    onsetStrength = onset ? 0.9 : onsetStrength * Math.exp(-dt * 12);

    const c1 = 0.32 + 0.18 * Math.sin(t * 0.7);
    const c2 = 0.66 + 0.14 * Math.sin(t * 1.1 + 1);
    for (let i = 0; i < 64; i++) {
      const x = i / 63;
      let v = 0.55 - 0.3 * x;
      v += 0.35 * Math.exp(-(((x - c1) / 0.07) ** 2)) * (0.7 + 0.3 * Math.sin(t * 2.3));
      v += 0.3 * Math.exp(-(((x - c2) / 0.05) ** 2)) * midAtt * 0.8;
      if (x < 0.16) v += kick * 0.75 * (1 - x / 0.16);
      if (x > 0.68) v += hat * 0.55 * (x - 0.68) * 3;
      v = v * song + (rnd() - 0.5) * 0.08;
      bands[i] = opts.silent ? 0 : Math.min(1, Math.max(0, v));
    }
    for (let k = 0; k < 1024; k++) {
      const f = specBand[k];
      const i0 = Math.floor(f);
      const i1 = Math.min(63, i0 + 1);
      spectrum[k] = bands[i0] + (bands[i1] - bands[i0]) * (f - i0);
    }
    let sum = 0;
    let peak = 0;
    sampleClock += Math.round(dt * SR);
    for (let n = 0; n < WAVE; n++) {
      const s = (sampleClock - WAVE + n) / SR;
      const kickEnv = Math.exp(-(((s * pulseRate) % 1) * 7));
      let v = 0.55 * kickEnv * Math.sin(2 * Math.PI * (48 + 60 * kickEnv) * s);
      v += 0.12 * mid * (Math.sin(2 * Math.PI * 220 * s) + Math.sin(2 * Math.PI * 277.2 * s) + Math.sin(2 * Math.PI * 329.6 * s));
      v += 0.15 * hat * (rnd() * 2 - 1);
      v = opts.silent ? 0 : Math.max(-1, Math.min(1, v * song));
      waveform[n] = v;
      left[n] = v * 0.9 + 0.1 * Math.sin(2 * Math.PI * 440 * s);
      right[n] = v * 0.9 - 0.1 * Math.sin(2 * Math.PI * 440 * s);
      if (n < WAVE - 512) continue; // level stats over the newest 512-sample hop
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }

    frame.rms = Math.sqrt(sum / 512);
    frame.peak = peak;
    frame.bass = bass;
    frame.mid = mid;
    frame.treb = treb;
    frame.bassAtt = bassAtt;
    frame.midAtt = midAtt;
    frame.trebAtt = trebAtt;
    frame.onset = onset && !opts.silent;
    frame.onsetStrength = onsetStrength;
    frame.beatPhase = phase;
    frame.centroid = 0.3 + 0.2 * hat;
    frame.flux = kick * 0.5;
    frame.silent = Boolean(opts.silent);
    frame.frameIndex = frameIndex++;
    return /** @type {import('../../web/sdk/tidalviz').AudioFrame} */ (frame);
  }

  return { update };
}

/**
 * The Cosmic Peanut prototype's "Demo signal" (docs/reference/cosmic-peanut-prototype.html): bass
 * chord, kick, hats, arpeggiated lead, 2,048 samples from the demo clock, and no host `bass`
 * level (so the plugin uses its waveform fallback, as the prototype does).
 */
export function createProtoDemo() {
  const WAVE_LEN = 2048;
  const waveBuf = new Float32Array(WAVE_LEN);
  const CHORDS = [55, 65.41, 49, 73.42];
  let demoT = 0;
  /** @type {any} */
  const frame = {
    bands: new Float32Array(64), spectrum: new Float32Array(1024), waveform: waveBuf,
    left: null, right: null, rms: 0, peak: 0, bass: undefined, mid: 1, treb: 1,
    bassAtt: 1, midAtt: 1, trebAtt: 1, onsetStrength: 0, onset: false, onsetAge: 10, bpm: 0,
    beatPhase: 0, centroid: 0, flux: 0, silent: false, frameIndex: 0, sampleRate: 48000, hostTime: 0,
  };
  /** @param {number} _t @param {number} dt */
  function update(_t, dt) {
    demoT += dt;
    const t = demoT;
    const sr = 48000, beat = 0.5;
    const root = CHORDS[Math.floor(t / 4) % CHORDS.length];
    for (let i = 0; i < WAVE_LEN; i++) {
      const s = t + i / sr, bt = s % beat, ht = (s + beat / 2) % beat;
      const kick = Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-bt * 30)) * bt) * Math.exp(-bt * 9);
      const bass = 0.45 * Math.sin(2 * Math.PI * root * s) + 0.2 * Math.sin(2 * Math.PI * root * 1.5 * s) +
                   0.12 * Math.sin(2 * Math.PI * root * 4 * s + Math.sin(s * 0.7) * 2);
      const hat = (Math.random() * 2 - 1) * 0.18 * Math.exp(-ht * 60);
      const note = root * 4 * [1, 1.5, 2, 1.25][Math.floor(s * 4) % 4];
      const saw = ((s * note) % 1) * 2 - 1, sq = ((s * note * 2.01) % 1) < 0.5 ? 1 : -1;
      const lead = (0.16 * saw + 0.06 * sq) * Math.exp(-((s * 4) % 1) * 3);
      waveBuf[i] = 0.9 * kick + bass * (0.6 + 0.4 * Math.sin(s * 0.9)) + hat + lead;
    }
    frame.frameIndex++;
    return /** @type {import('../../web/sdk/tidalviz').AudioFrame} */ (frame);
  }
  return { update };
}
