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
 * beat surge drift the view through the plane, phrase changes sweep a figure/ground front out
 * from the centre to the rim, and a drag carries the plane and steers the drift.
 * frame() allocates nothing.
 */
import { createTessPipeline } from "./lib/tess-gl.js";
import { createDiskOptions, createDiskView, createDiskWarp, diskGeometry, diskGroup, readDiskParams } from "./lib/tess-disk.js";
import { createTessState, renderScale } from "./lib/tess-music.js";

/** The disk's radius: this fraction of half the short side. */
const FILL = 0.96;
/** The rings reach 1 where a kite is this many full-resolution px (the visible rim). */
const RING_EDGE_PX = 3;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const tess = await createTessPipeline(ctx, "shaders/tess/disk.frag");
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
  }
  applyTiling();
  tess.resize(renderScale(ctx.params.quality));

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u, w, h) => {
    const radius = 0.5 * FILL * Math.min(w, h);
    const m = view.m;
    gl.uniform3f(u.u_disk, 0.5 * w, 0.5 * h, radius);
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
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3fv(u.u_chart, chart);
    gl.uniformMatrix3fv(u.u_H, false, H);
    gl.uniform2fv(u.u_cK, centres);
    gl.uniform2fv(u.u_wA, warp.amps);
    gl.uniform1f(u.u_kiteA, kiteA);
    // Ring 1 where a kite is RING_EDGE_PX: ½ √A R (1 − |w|²) = px → hyperbolic radius 2 atanh |w|.
    const px = (RING_EDGE_PX * w) / Math.max(1, ctx.size.width);
    const rim = Math.sqrt(Math.max(0, 1 - px / Math.max(1e-6, 0.5 * kiteA * radius)));
    gl.uniform1f(u.u_ringR, 2 * Math.atanh(Math.min(rim, 0.999999)));
  };

  return {
    frame(audio, time) {
      const dt = time.dt;
      readDiskParams(ctx.params, ctx, opts);
      if (opts.tiling !== tilingName) {
        tilingName = opts.tiling;
        view.setTiling(tilingName);
        applyTiling();
      }
      const s = state.step(audio, dt, opts);
      warp.set(s.morphW, s.theta);
      const travel = first ? 0 : s.travel - lastTravel;
      first = false;
      lastTravel = s.travel;
      view.step(travel, dt, 0.5 * FILL * Math.min(ctx.size.cssWidth, ctx.size.cssHeight), ctx.reduceMotion);
      tess.render(s, surface);
    },

    resize() {
      tess.resize();
    },

    params(changed) {
      if ("quality" in changed) tess.resize(renderScale(ctx.params.quality));
    },

    pointer(e) {
      view.pointer(e);
    },

    dispose() {
      gl.deleteTexture(colTex);
      tess.dispose();
    },
  };
}
