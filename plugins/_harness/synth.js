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

/**
 * A separable drum pattern for checking frequency-localised response (`audio=drums`): 120 BPM,
 * kick on beats 1 and 3 (bands below ~120 Hz), snare on 2 and 4 (a broad mid bump, ~250 Hz–
 * 3 kHz), closed hats on every eighth (bands above ~8 kHz), over a quiet pad. A beat is 0.5 s, so
 * with `still` (fixed 60 Hz steps) kicks land on frames 0, 60, 120 … and snares on 30, 90, 150 ….
 * Bands, waveform and the bass/onset stats all follow the same events.
 */
export function createDrums() {
  const bands = new Float32Array(64);
  const spectrum = new Float32Array(1024);
  const WAVE = 2048;
  const waveform = new Float32Array(WAVE);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let lastEighth = -1;
  let bassAtt = 1;
  let onsetStrength = 0;
  let sampleClock = 0;
  let frameIndex = 0;
  /** @type {any} */
  const frame = {
    bands, spectrum, waveform, left: null, right: null,
    rms: 0, peak: 0, bass: 1, mid: 1, treb: 1, bassAtt: 1, midAtt: 1, trebAtt: 1,
    onsetStrength: 0, onset: false, onsetAge: 10, bpm: 120, beatPhase: 0, centroid: 0.3, flux: 0,
    silent: false, frameIndex: 0, sampleRate: SR,
  };
  /** Envelopes at time s: [kick, snare, hat]. @param {number} s */
  const env = (s) => {
    const beat = s * 2;
    const b = Math.floor(beat) % 4;
    const ph = beat % 1;
    const kick = b % 2 === 0 ? Math.exp(-ph * 6) : 0;
    const snare = b % 2 === 1 ? Math.exp(-ph * 9) : 0;
    const hat = Math.exp(-((beat * 2) % 1) * 20);
    return [kick, snare, hat];
  };
  /** @param {number} t @param {number} dt */
  function update(t, dt) {
    const [kick, snare, hat] = env(t);
    const eighth = Math.floor(t * 4);
    const onset = eighth !== lastEighth;
    lastEighth = eighth;
    for (let i = 0; i < 64; i++) {
      const x = i / 63;
      let v = 0.1 + 0.08 * Math.exp(-(((x - 0.45) / 0.15) ** 2)); // quiet pad
      if (x < 0.2) v += 0.85 * kick * (1 - x / 0.2);
      v += 0.75 * snare * Math.exp(-(((x - 0.5) / 0.12) ** 2));
      if (x > 0.8) v += 0.6 * hat * ((x - 0.8) / 0.2);
      bands[i] = Math.min(1, Math.max(0, v + (rnd() - 0.5) * 0.02));
    }
    for (let k = 0; k < 1024; k++) spectrum[k] = bands[Math.min(63, k >> 4)];
    sampleClock += Math.round(dt * SR);
    let sum = 0;
    let peak = 0;
    for (let n = 0; n < WAVE; n++) {
      const s = (sampleClock - WAVE + n) / SR;
      const [k, sn, h] = env(s);
      let v = 0.6 * k * Math.sin(2 * Math.PI * (50 + 70 * k) * s);
      v += 0.35 * sn * (rnd() * 2 - 1) + 0.2 * sn * Math.sin(2 * Math.PI * 190 * s);
      v += 0.12 * h * (rnd() * 2 - 1);
      v += 0.05 * Math.sin(2 * Math.PI * 220 * s);
      v = Math.max(-1, Math.min(1, v));
      waveform[n] = v;
      if (n >= WAVE - 512) {
        sum += v * v;
        peak = Math.max(peak, Math.abs(v));
      }
    }
    const bass = 0.5 + 1.5 * kick;
    bassAtt += (bass - bassAtt) * (1 - Math.exp(-dt * 5));
    onsetStrength = onset ? (eighth % 2 === 0 ? 0.9 : 0.4) : onsetStrength * Math.exp(-dt * 12);
    frame.rms = Math.sqrt(sum / 512);
    frame.peak = peak;
    frame.bass = bass;
    frame.mid = 0.7 + 1.3 * snare;
    frame.treb = 0.7 + 0.9 * hat;
    frame.bassAtt = bassAtt;
    frame.onset = onset;
    frame.onsetStrength = onsetStrength;
    frame.beatPhase = (t * 2) % 1;
    frame.frameIndex = frameIndex++;
    return /** @type {import('../../web/sdk/tidalviz').AudioFrame} */ (frame);
  }
  return { update };
}

/**
 * Music-like audio with a real-looking spectrum (`audio=music`), for checking spectrogram views: a
 * sustained drone (A1 + A2) and pad chord (changing every 2 bars) with harmonics, an eighth-note
 * pentatonic melody (440–1,320 Hz, decaying notes, harmonics), and 120 BPM drums — kick on 1 and 3
 * (40–150 Hz + a click), snare on 2 and 4 (broad 200 Hz–8 kHz), hats on every eighth (6–16 kHz).
 * The spectrum is built analytically (each partial as a Hann main lobe, linear magnitude with a
 * full-scale sine at 1.0), so it is deterministic and noise-free. Bands follow the spectrum.
 */
export function createMusic() {
  const N = 1024;
  const binHz = SR / 2048;
  const bands = new Float32Array(64);
  const spectrum = new Float32Array(N);
  const WAVE = 2048;
  const waveform = new Float32Array(WAVE);
  const DRONE = [55, 110];
  const CHORDS = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [164.8, 207.7, 246.9]];
  const MELODY = [440, 523.3, 587.3, 659.3, 784, 880, 1046.5, 1174.7, 1318.5, 1046.5, 880, 784, 659.3, 587.3, 523.3, 587.3];
  const bandOf = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const hz = Math.max(1, k * binHz);
    bandOf[k] = Math.min(63, Math.max(0, Math.round((Math.log(hz / 30) / Math.log(16000 / 30)) * 63)));
  }
  let lastEighth = -1;
  let onsetStrength = 0;
  let bassAtt = 1;
  let frameIndex = 0;
  let sampleClock = 0;
  /** @type {any} */
  const frame = {
    bands, spectrum, waveform, left: null, right: null,
    rms: 0, peak: 0, bass: 1, mid: 1, treb: 1, bassAtt: 1, midAtt: 1, trebAtt: 1,
    onsetStrength: 0, onset: false, onsetAge: 10, bpm: 120, beatPhase: 0, centroid: 0.3, flux: 0,
    silent: false, frameIndex: 0, sampleRate: SR,
  };
  /** Add a partial of frequency `hz`, magnitude `a` as a Hann main lobe (±2 bins). */
  const partial = (/** @type {number} */ hz, /** @type {number} */ a) => {
    const c = hz / binHz;
    for (let k = Math.max(0, Math.ceil(c - 2)); k <= Math.min(N - 1, Math.floor(c + 2)); k++) {
      const d = Math.abs(k - c);
      const w = d < 1e-6 ? 1 : Math.abs(d - 1) < 1e-6 ? 0.5 : Math.abs(Math.sin(Math.PI * d) / (Math.PI * d * (1 - d * d)));
      spectrum[k] = Math.max(spectrum[k], a * w);
    }
  };
  /** Add a smooth broadband bump between lo and hi Hz (log-shaped), magnitude `a`. */
  const broad = (/** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ a) => {
    const mid = Math.sqrt(lo * hi);
    const w = Math.log(hi / lo) / 2;
    for (let k = 1; k < N; k++) {
      const x = Math.log((k * binHz) / mid) / w;
      if (Math.abs(x) < 1.6) spectrum[k] += a * Math.exp(-x * x * 1.5);
    }
  };
  /** Envelopes at time s: [kick, snare, hat, noteEnv, noteHz, chord index]. @param {number} s */
  const env = (s) => {
    const beat = s * 2;
    const b = Math.floor(beat) % 4;
    const ph = beat % 1;
    const eighth = Math.floor(s * 4);
    return [
      b % 2 === 0 ? Math.exp(-ph * 20) : 0,
      b % 2 === 1 ? Math.exp(-ph * 24) : 0,
      Math.exp(-((beat * 2) % 1) * 40),
      Math.exp(-((s * 4) % 1) * 2.5),
      MELODY[eighth % MELODY.length],
      Math.floor(s / 4) % CHORDS.length,
    ];
  };
  /** @param {number} t @param {number} dt */
  function update(t, dt) {
    const [kick, snare, hat, note, noteHz, ci] = env(t);
    spectrum.fill(0);
    for (const f of DRONE) for (let h = 1; h <= 4; h++) partial(f * h, 0.3 / h);
    for (const f of CHORDS[ci]) for (let h = 1; h <= 5; h++) partial(f * h, 0.09 / h);
    for (let h = 1; h <= 4; h++) partial(noteHz * h, (0.22 * note) / h);
    if (kick > 0.01) {
      broad(40, 150, 0.6 * kick);
      broad(150, 2500, 0.05 * kick * kick);
    }
    if (snare > 0.01) broad(200, 8000, 0.12 * snare);
    if (hat > 0.01) broad(6000, 16000, 0.08 * hat);
    bands.fill(0);
    for (let k = 1; k < N; k++) bands[bandOf[k]] = Math.max(bands[bandOf[k]], Math.min(1, spectrum[k] * 2));
    for (let k = 0; k < N; k++) spectrum[k] = Math.min(1, spectrum[k]);

    sampleClock += Math.round(dt * SR);
    let sum = 0;
    let peak = 0;
    const chord = CHORDS[ci];
    for (let n = 0; n < WAVE; n++) {
      const s = (sampleClock - WAVE + n) / SR;
      let v = 0.3 * Math.sin(2 * Math.PI * 55 * s) + 0.15 * Math.sin(2 * Math.PI * 110 * s);
      for (const f of chord) v += 0.09 * Math.sin(2 * Math.PI * f * s);
      v += 0.22 * note * Math.sin(2 * Math.PI * noteHz * s);
      v += 0.5 * kick * Math.sin(2 * Math.PI * (50 + 60 * kick) * s);
      v = Math.max(-1, Math.min(1, v));
      waveform[n] = v;
      if (n >= WAVE - 512) {
        sum += v * v;
        peak = Math.max(peak, Math.abs(v));
      }
    }
    const eighth = Math.floor(t * 4);
    const onset = eighth !== lastEighth;
    lastEighth = eighth;
    const bass = 0.5 + 1.5 * kick;
    bassAtt += (bass - bassAtt) * (1 - Math.exp(-dt * 5));
    onsetStrength = onset ? (eighth % 2 === 0 ? 0.9 : 0.4) : onsetStrength * Math.exp(-dt * 12);
    frame.rms = Math.sqrt(sum / 512);
    frame.peak = peak;
    frame.bass = bass;
    frame.mid = 0.7 + 1.3 * snare;
    frame.treb = 0.7 + 0.9 * hat;
    frame.bassAtt = bassAtt;
    frame.onset = onset;
    frame.onsetStrength = onsetStrength;
    frame.beatPhase = (t * 2) % 1;
    frame.frameIndex = frameIndex++;
    return /** @type {import('../../web/sdk/tidalviz').AudioFrame} */ (frame);
  }
  return { update };
}
