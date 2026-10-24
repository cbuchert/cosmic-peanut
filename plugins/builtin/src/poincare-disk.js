// @ts-check
/**
 * Poincaré Disk — interlocking creatures tiling the hyperbolic plane, seen in the Poincaré
 * disk (they shrink towards the rim forever), printed like a multi-block woodcut, for the
 * `webgl2` renderer. A tessellation surface: the engine's print look (lib/tess-gl.js,
 * shaders/tess/tess.glsl tessPrint) and music state (lib/tess-music.js) on a hyperbolic tiling.
 *
 * The tiles are the kites of a {p,q} tiling (lib/tess-disk.js): fundamental domains of its
 * rotation group, warped by a field that commutes with that group, so they stay congruent and
 * still tile exactly; a proper 3-colouring comes from a finite quotient of the group. The music
 * morphs the creatures once a bar (the spectral centroid picks the family), bass and an eased
 * beat surge drift the view through the plane, and phrase changes sweep a figure/ground front out
 * from the centre to the rim.
 *
 * Scene "sphere" (shaders/tess/disk3d.frag, motion in lib/disk3d.js): the print is a lacquered
 * coin floating in a large sphere tiled inside (the cube-sphere of Tiled Sphere), which turns the
 * other way. Mids spin the coin, bass tilts and wobbles it, its rim is the live waveform; each
 * beat kicks the tiling along a new direction and lifts a ripple of tiles where it lands; the
 * spectrum heaves the tiles ring by ring; treble glints along the gouges. The camera orbits,
 * swoops, skims and pulls back, a move per phrase; a drag takes it over. Scene "flat" is the print
 * alone, exactly as it first was (its drag carries the plane).
 *
 * Relief (default 0.6; lib/disk-relief.js, disk.glsl diskRelief): the kites are carved like the
 * engine's woodblock: raised, bevelled tiles, gouges cut, features raised, scaled to each kite's
 * size so the rim stays clean. On the coin the ripple and the heave lift whole kites (the latest
 * beat's ripple and the previous one's running out, by hyperbolic distance from each impact),
 * onsets pop kites near the ripple's front and phrase changes turn the kites over like cards,
 * relief-marched with self-shadowing under the lacquer; the flat scene is the block under a raking
 * light with the engine's waves. Light turns the key light. Relief 0 renders exactly as before.
 * frame() allocates nothing.
 */
import {
  createKitePops,
  KITE_BEAT,
  KITE_HEAVE,
  kiteBound,
  keyLight,
  POP_BOOST,
  reliefMix,
  rippleMax,
  sphereLiftMax,
} from "./lib/disk-relief.js";
import { COIN, createCoinMotion, createCounterSpin, createDirector, createDrive, createKicks, createWaveRim, RIPPLE_REACH, RIPPLE_SPEED, SPHERE_R } from "./lib/disk3d.js";
import { faceCells, sphereTables } from "./lib/cube-sphere.js";
import { sphereFrame, threeClassColors } from "./lib/sphere-view.js";
import { createTessPipeline } from "./lib/tess-gl.js";
import { createDiskOptions, createDiskView, createDiskWarp, diskGeometry, diskGroup, kiteIds, readDiskParams } from "./lib/tess-disk.js";
import { createTessState, LIFT_VARY, lightDir, REDUCED_FLASH_LIFT, REDUCED_GLIDE, renderScale } from "./lib/tess-music.js";
import { MAX_TILE_COLORS, paletteOf } from "./lib/tess.js";

/** The disk's radius: this fraction of half the short side. */
const FILL = 0.96;
/** The rings reach 1 where a kite is this many full-resolution px (the visible rim). */
const RING_EDGE_PX = 3;

/** Sphere scene: lattice cells per wall face, the wall's tilt, the rings' outer radius on the
 * face (hyperbolic), fog, the lift heights (world units) per unit of Reactivity. */
const WALL_CELLS = faceCells(12);
const WALL_TILT = 0.2;
const FACE_RING_R = 4.6;
const FOG = 0.045;
const RIPPLE_H = 0.1;
const HEAVE_H = 0.06;
const TREBLE_TAU = 0.08;
/** Key light and the wall's ring pole (world). */
const LIGHT = [-0.45, 0.78, 0.43];
const POLE = [0.3, 0.9, -0.3];
/** Ripple impacts drift with the plane: until the next beat they ride on the kicked tiling. */
/** Relief: the flat scene's camera height over the face (half short sides of the view, as
 * Metamorphosis's), and the texture unit of the kite-id table (the colour table is on 1, the
 * height map on 3). */
const CAM_DIST = 2.2;
const ID_UNIT = 2;

/** @param {number[]} v */
const unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  // Both scenes carve the kites (lib/disk-relief.js) while Relief is above 0; at 0 they run
  // their plain programs, exactly the print as it was before relief.
  const [tess, tess3d] = await Promise.all([
    createTessPipeline(ctx, "shaders/tess/disk.frag", { relief: true }),
    createTessPipeline(ctx, "shaders/tess/disk3d.frag", { relief: true }),
  ]);
  const state = createTessState();
  const warp = createDiskWarp();
  const opts = createDiskOptions();
  readDiskParams(ctx.params, ctx, opts);
  let tilingName = opts.tiling;
  const view = createDiskView(tilingName);
  let lastTravel = 0;
  let first = true;

  // Per tiling: the quotient's matrices and colour table (a texture), the chart and kites.
  const rho = new Int32Array(32);
  const centres = new Float32Array(8);
  const tile = new Float32Array(3);
  const chart = new Float32Array(3);
  let H = new Float32Array(36);
  let r = 2;
  let p = 7;
  let kiteA = 1;
  /** @type {Int32Array[]} */
  let gens = [];
  const colTex = gl.createTexture();
  const idTex = gl.createTexture();
  function applyTiling() {
    const g = diskGroup(tilingName);
    const geo = diskGeometry(tilingName);
    r = g.r;
    p = g.p;
    rho.fill(0);
    rho.set(g.rho);
    gens = [g.A, g.B, g.C];
    H = geo.H;
    centres.set(geo.centres);
    tile[0] = geo.tiling.alpha;
    tile[1] = geo.tiling.cx;
    tile[2] = geo.tiling.r;
    chart[0] = geo.m;
    chart[1] = geo.km;
    chart[2] = geo.kv;
    kiteA = Math.sqrt(geo.kiteArea);
    gl.bindTexture(gl.TEXTURE_2D, colTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, r * r, r * r, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, g.table);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, idTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, r * r, r * r, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, kiteIds(tilingName));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  applyTiling();
  const scale = renderScale(ctx.params.quality);
  tess.resize(scale);
  tess3d.resize(scale);

  /** The hyperbolic tiling's uniforms (both scenes). @param {WebGL2RenderingContext} gl @param {Record<string, WebGLUniformLocation | null>} u */
  const diskUniforms = (gl, u) => {
    const m = view.m;
    gl.uniform4f(u.u_M0, m[0], m[1], m[2], m[3]);
    gl.uniform4f(u.u_M1, m[4], m[5], m[6], m[7]);
    gl.uniform1f(u.u_conj, m[8]);
    gl.uniform2f(u.u_O, view.centre[0], view.centre[1]);
    gl.uniform3fv(u.u_tile, tile);
    gl.uniform1i(u.u_gR, r);
    gl.uniform1i(u.u_gP, p);
    gl.uniform4iv(u.u_gRho, rho);
    gl.uniform4iv(u.u_gA, gens[0]);
    gl.uniform4iv(u.u_gB, gens[1]);
    gl.uniform4iv(u.u_gC, gens[2]);
    gl.uniform4iv(u.u_gE0, view.e0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, colTex);
    gl.uniform1i(u.u_gCol, 1);
    if (u.u_gId) {
      // Relief programs only (the kite ids; null elsewhere).
      gl.activeTexture(gl.TEXTURE0 + ID_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, idTex);
      gl.uniform1i(u.u_gId, ID_UNIT);
      gl.uniform2f(u.u_kH, hRange[0], hRange[1]);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3fv(u.u_chart, chart);
    gl.uniformMatrix3fv(u.u_H, false, H);
    gl.uniform2fv(u.u_cK, centres);
    gl.uniform2fv(u.u_wA, warp.amps);
    gl.uniform1f(u.u_kiteA, kiteA);
  };

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u, w, h) => {
    const radius = 0.5 * FILL * Math.min(w, h);
    gl.uniform3f(u.u_disk, 0.5 * w, 0.5 * h, radius);
    diskUniforms(gl, u);
    // Ring 1 where a kite is RING_EDGE_PX: ½ √A R (1 − |w|²) = px → hyperbolic radius 2 atanh |w|.
    const px = (RING_EDGE_PX * w) / Math.max(1, ctx.size.width);
    const rim = Math.sqrt(Math.max(0, 1 - px / Math.max(1e-6, 0.5 * kiteA * radius)));
    gl.uniform1f(u.u_ringR, 2 * Math.atanh(Math.min(rim, 0.999999)));
    gl.uniform3fv(u.u_light, lightF); // relief programs only (null elsewhere: a no-op)
    gl.uniform1f(u.u_camD, (CAM_DIST * 0.5 * Math.min(w, h)) / radius);
  };

  // ---- Relief (both scenes) ------------------------------------------------------------------
  /** The height map's range (world units): lowest, span (u_kH). */
  const hRange = new Float32Array([0, 1]);
  const lightF = new Float32Array(3);
  /** @param {number} lo @param {number} hi */
  const setRange = (lo, hi) => {
    hRange[0] = lo;
    hRange[1] = Math.max(1e-4, hi - lo);
  };

  // ---- The sphere scene ----------------------------------------------------------------------
  const drive = createDrive();
  const coin = createCoinMotion();
  const counter = createCounterSpin();
  const kicks = createKicks();
  const rim = createWaveRim();
  const director = createDirector();
  const tab = sphereTables(WALL_CELLS);
  const pal = new Float32Array(6 + MAX_TILE_COLORS * 3);
  const cls = new Float32Array(9);
  const clsNext = new Float32Array(9);
  const rimU = new Float32Array(rim.ring.length);
  const cam = new Float32Array(9);
  const coinM = new Float32Array(9);
  const wall = new Float32Array(9);
  const pole = new Float32Array(3);
  const light = unit(LIGHT);
  const poleW = unit(POLE);
  const iw = new Float64Array(2);
  const keyL = new Float64Array(3);
  const kitePops = createKitePops();
  const kLift = new Float32Array(4);
  let agePrev = 99;
  let lastAge = 99;
  const driveIn = { live: false, bassAtt: 1, env: 0, reactivity: 1, reduceMotion: false };
  const coinIn = { midAtt: 1, bassAtt: 1, env: 0, reactivity: 1, reduceMotion: false, pace: 1 };
  const kickIn = { env: 0, reactivity: 1, period: 0.5 };
  const dirIn = { stepped: false, speed: 1, intensity: 0, reduceMotion: false, camera: "auto", normal: coin.normal };
  let palName = "";
  let nTiles = 3;
  let blendPhase = 0;
  let treble = 0;
  let clock = 0;
  let react = 1;

  /** The camera basis (columns right, up, forward) from the director's eye and target. */
  function cameraMatrix() {
    const e = director.eye;
    const t = director.target;
    let fx = t[0] - e[0];
    let fy = t[1] - e[1];
    let fz = t[2] - e[2];
    let l = Math.hypot(fx, fy, fz) || 1;
    fx /= l;
    fy /= l;
    fz /= l;
    // right = forward × up(0, 1, 0)
    let rx = -fz;
    let rz = fx;
    l = Math.hypot(rx, rz) || 1;
    rx /= l;
    rz /= l;
    // up = right × forward
    const ux = -rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy;
    cam.set([rx, 0, rz, ux, uy, uz, fx, fy, fz]);
  }

  /** World → coin: the coin is R = tilt · spin about y; store Rᵀ column-major (R row by row). */
  function coinMatrix() {
    const n = coin.normal;
    const cs = Math.cos(coin.spin);
    const ss = Math.sin(coin.spin);
    // Tilt: the rotation taking +y to n, about (n.z, 0, −n.x).
    let ax = n[2];
    let az = -n[0];
    const sinT = Math.hypot(ax, az);
    const cosT = n[1];
    if (sinT > 1e-9) {
      ax /= sinT;
      az /= sinT;
    } else {
      ax = 1;
      az = 0;
    }
    const k = 1 - cosT;
    // Rodrigues with axis (ax, 0, az).
    const t00 = cosT + ax * ax * k;
    const t01 = -az * sinT;
    const t02 = ax * az * k;
    const t10 = az * sinT;
    const t11 = cosT;
    const t12 = -ax * sinT;
    const t20 = az * ax * k;
    const t21 = ax * sinT;
    const t22 = cosT + az * az * k;
    // Spin about y: S = [[c, 0, s], [0, 1, 0], [−s, 0, c]]; R = T · S.
    const r00 = t00 * cs - t02 * ss;
    const r01 = t01;
    const r02 = t00 * ss + t02 * cs;
    const r10 = t10 * cs - t12 * ss;
    const r11 = t11;
    const r12 = t10 * ss + t12 * cs;
    const r20 = t20 * cs - t22 * ss;
    const r21 = t21;
    const r22 = t20 * ss + t22 * cs;
    coinM.set([r00, r01, r02, r10, r11, r12, r20, r21, r22]);
  }

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface3d = (gl, u) => {
    gl.uniform3fv(u.u_tCls, cls);
    gl.uniform3fv(u.u_tClsNext, clsNext);
    gl.uniform3f(u.u_tBlend, 0, 0, blendPhase);
    diskUniforms(gl, u);
    gl.uniform1f(u.u_ringR, FACE_RING_R);
    gl.uniform2f(u.u_I, view.tracked[0], view.tracked[1]);
    gl.uniform2f(u.u_I2, view.trackedPrev[0], view.trackedPrev[1]); // relief programs only
    gl.uniform2f(u.u_Iw, iw[0], iw[1]);
    gl.uniformMatrix3fv(u.u_frame, false, tab.frames);
    gl.uniform4iv(u.u_nb, tab.nb);
    gl.uniform2fv(u.u_nbT, tab.nbT);
    gl.uniform1iv(u.u_flip, tab.flip);
    gl.uniform1f(u.u_N, WALL_CELLS);
    gl.uniform3fv(u.u_pole, pole);
    gl.uniform3f(u.u_eye, director.eye[0], director.eye[1], director.eye[2]);
    gl.uniformMatrix3fv(u.u_cam, false, cam);
    gl.uniform1f(u.u_tanHalf, Math.tan(director.fov / 2));
    gl.uniformMatrix3fv(u.u_coin, false, coinM);
    gl.uniform1fv(u.u_rim, rimU);
    gl.uniform4f(u.u_coinG, COIN.face, COIN.face + COIN.bevel, COIN.half, COIN.face + COIN.bevel + 2.5 * COIN.waveAmp);
    gl.uniformMatrix3fv(u.u_wall, false, wall);
    gl.uniform1f(u.u_SR, SPHERE_R);
    gl.uniform3f(u.u_light, keyL[0], keyL[1], keyL[2]);
    gl.uniform4fv(u.u_kLift, kLift); // relief programs only
    gl.uniform4fv(u.u_kPop, kitePops.pops);
    gl.uniform2f(u.u_kick, kicks.age, kickIn.period);
    gl.uniform2f(u.u_lift, RIPPLE_H * react, HEAVE_H * react);
    gl.uniform2f(u.u_treble, treble, clock);
    gl.uniform1f(u.u_fog, FOG);
  };

  /** The impact's place on the face now: T⁻¹ of the tracked tiling point (T is a rotation). */
  function impactOnFace() {
    const m = view.m;
    const x = view.tracked[0];
    const y = view.tracked[1];
    // T⁻¹(z) = (d z − b) / (−c z + a)
    const nr = m[6] * x - m[7] * y - m[2];
    const ni = m[6] * y + m[7] * x - m[3];
    const dr = -(m[4] * x - m[5] * y) + m[0];
    const di = -(m[4] * y + m[5] * x) + m[1];
    const q = dr * dr + di * di;
    iw[0] = (nr * dr + ni * di) / q;
    iw[1] = (ni * dr - nr * di) / q;
  }

  /** @param {import('../tidalviz').AudioFrame} audio @param {number} dt */
  function frame3d(audio, dt) {
    opts.symmetry = "p4"; // the wall's cube-sphere needs the quarter turns; the face has its own warp
    const s = state.step(audio, dt, opts);
    warp.set(s.morphW, s.theta);
    blendPhase = s.blend[2];
    react = Math.max(0, Math.min(2, opts.reactivity));
    clock += dt;
    const live = !audio.silent;
    driveIn.live = live;
    driveIn.bassAtt = live ? audio.bassAtt : 1;
    driveIn.env = s.env;
    driveIn.reactivity = react;
    driveIn.reduceMotion = ctx.reduceMotion;
    drive.step(dt, driveIn);

    coinIn.midAtt = live ? audio.midAtt : 1;
    coinIn.bassAtt = live ? audio.bassAtt : 1;
    coinIn.env = s.env;
    coinIn.reactivity = react;
    coinIn.reduceMotion = ctx.reduceMotion;
    coinIn.pace = drive.level;
    coin.step(dt, coinIn);
    counter.step(dt, coin.spinRate, opts.spin);

    // The tiling: a drift at the drive's pace, plus a kick along a new direction each beat.
    const pace = drive.level * Math.max(0, opts.speed);
    const travel = pace * dt * (ctx.reduceMotion ? REDUCED_GLIDE : 1);
    first = true; // the flat scene re-bases its travel when it comes back
    kickIn.env = s.env;
    kickIn.reactivity = ctx.reduceMotion ? react * 0.3 : react;
    kickIn.period = live && audio.bpm > 0 ? 60 / audio.bpm : 0.5;
    const before = kicks.count;
    const dist = kicks.step(dt, kickIn);
    if (kicks.count !== before) {
      // The previous impact's ripple runs out (relief), its age carried on from the beat's.
      view.trackedPrev[0] = view.tracked[0];
      view.trackedPrev[1] = view.tracked[1];
      agePrev = lastAge;
      // A new impact: carry the face point it lands on as a tiling point from now on.
      const m = view.m;
      const x = kicks.impact[0];
      const y = kicks.impact[1];
      const nr = m[0] * x - m[1] * y + m[2];
      const ni = m[0] * y + m[1] * x + m[3];
      const dr = m[4] * x - m[5] * y + m[6];
      const di = m[4] * y + m[5] * x + m[7];
      const q = dr * dr + di * di;
      view.tracked[0] = (nr * dr + ni * di) / q;
      view.tracked[1] = (ni * dr - nr * di) / q;
    }
    agePrev += dt;
    lastAge = kicks.age;
    view.nudge(dist, kicks.dir[0], kicks.dir[1]);
    view.step(travel, dt, 300, ctx.reduceMotion);
    impactOnFace();

    rimU.set(rim.build(audio.waveform, dt, live ? react : 0));
    for (let i = 0; i < rimU.length; i++) rimU[i] *= COIN.waveAmp;
    const tr = live ? react * Math.max(0, Math.min(1.5, audio.trebAtt - 0.8)) : 0;
    treble += (tr - treble) * (1 - Math.exp(-dt / TREBLE_TAU));

    // Relief: the ripple and the heave lift whole kites (their share reliefMix), the rest of
    // them swells the face smoothly as before; onsets pop kites near the ripple's front.
    keyLight(opts.light, light, keyL);
    if (s.relief > 0) {
      const q = reliefMix(s.relief);
      const calm = ctx.reduceFlashing ? REDUCED_FLASH_LIFT : 1;
      const front = kicks.age * RIPPLE_SPEED;
      kitePops.step(s.pops, front < 3 * RIPPLE_REACH ? front : -1, POP_BOOST * q);
      kLift[0] = q * calm * KITE_BEAT * react;
      kLift[1] = q * calm * KITE_HEAVE * react;
      kLift[2] = 1 - q;
      kLift[3] = agePrev;
      const lift = sphereLiftMax(kicks.age, agePrev, kickIn.period, kLift[0], kLift[1], s.bands, kitePops.pops);
      let band = 0;
      for (let i = 0; i < s.bands.length; i++) band = Math.max(band, s.bands[i]);
      const swell = (1 - q) * (RIPPLE_H * react * rippleMax(kicks.age, kickIn.period) + HEAVE_H * react * band);
      const b = kiteBound({ relief: s.relief, kiteA, lift, flipping: s.flipping, hop: s.flipHop, smooth: swell });
      setRange(b.lo, b.hi);
    }

    dirIn.stepped = s.stepped;
    dirIn.speed = pace;
    dirIn.intensity = drive.surge + drive.presence * Math.max(0, drive.bass);
    dirIn.reduceMotion = ctx.reduceMotion;
    dirIn.camera = opts.camera;
    director.step(dt, dirIn);
    cameraMatrix();
    coinMatrix();

    sphereFrame(counter.angle, WALL_TILT, wall);
    for (let i = 0; i < 3; i++) pole[i] = wall[i] * poleW[0] + wall[3 + i] * poleW[1] + wall[6 + i] * poleW[2];
    if (opts.palette !== palName) {
      palName = opts.palette;
      nTiles = paletteOf(palName, pal);
    }
    threeClassColors(pal, nTiles, s.shift, cls, clsNext);
    tess3d.render(s, surface3d);
  }

  return {
    frame(audio, time) {
      const dt = time.dt;
      readDiskParams(ctx.params, ctx, opts);
      if (opts.tiling !== tilingName) {
        tilingName = opts.tiling;
        view.setTiling(tilingName);
        applyTiling();
      }
      if (opts.scene !== "flat") {
        frame3d(audio, dt);
        return;
      }
      const s = state.step(audio, dt, opts);
      warp.set(s.morphW, s.theta);
      const travel = first ? 0 : s.travel - lastTravel;
      first = false;
      lastTravel = s.travel;
      view.step(travel, dt, 0.5 * FILL * Math.min(ctx.size.cssWidth, ctx.size.cssHeight), ctx.reduceMotion);
      if (s.relief > 0) {
        // The engine's waves and pops by ring (diskKiteLift in disk.frag), × Relief.
        let top = 0;
        for (let i = 0; i < s.lift.length; i++) top = Math.max(top, s.lift[i]);
        let pop = 0;
        for (let k = 0; k < 3; k++) pop += Math.max(0, s.pops[4 * k]);
        const lift = s.relief * (top * (1 + LIFT_VARY) + pop);
        const b = kiteBound({ relief: s.relief, kiteA, lift, flipping: s.flipping, hop: s.flipHop, smooth: 0 });
        setRange(b.lo, b.hi);
        lightDir(opts.light, lightF);
      }
      tess.render(s, surface);
    },

    resize() {
      tess.resize();
      tess3d.resize();
    },

    params(changed) {
      if ("quality" in changed) {
        const sc = renderScale(ctx.params.quality);
        tess.resize(sc);
        tess3d.resize(sc);
      }
    },

    pointer(e) {
      if (opts.scene === "flat") view.pointer(e);
      else director.pointer(e);
    },

    dispose() {
      gl.deleteTexture(colTex);
      gl.deleteTexture(idTex);
      tess.dispose();
      tess3d.dispose();
    },
  };
}
