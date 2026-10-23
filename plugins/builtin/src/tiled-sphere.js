// @ts-check
/**
 * Tiled Sphere: the interlocking woodcut tiling of the tessellation engine wrapped round a sphere,
 * seen from outside (it floats and turns on a paper ground) or from inside (a tiled dome all
 * round), or both: in auto the camera pushes through the surface on a phrase change and back out
 * on a later one.
 *
 * The sphere is a cube-sphere (lib/cube-sphere.js): six equal-angle faces of CELLS × CELLS p4
 * lattice cells, whose quarter-turn edges the p4 warp carries across. The music (lib/tess-music.js)
 * steps the shapes, sets the turn (bass and an eased beat surge) and sweeps figure/ground fronts
 * from a pole like a terminator; drag orbits outside and looks round inside, easing back on
 * release (lib/sphere-view.js). p4 only: a p3 tiling would need an icosahedral net, whose
 * corners turn by 60°, which p3 cannot absorb. frame() allocates nothing.
 */
import { faceCells, sphereTables } from "./lib/cube-sphere.js";
import { cameraAt, cameraBasis, createDrag, createPush, fillOptions, sphereFrame, threeClassColors, viewName } from "./lib/sphere-view.js";
import { createTessPipeline } from "./lib/tess-gl.js";
import { createTessState, renderScale } from "./lib/tess-music.js";
import { MAX_TILE_COLORS, paletteOf } from "./lib/tess.js";

/** Lattice cells per face: 3 (6 tiles across a face, 24 round the sphere). */
const CELLS = faceCells(3);
/** Turn per unit of glide travel (rad), and the turning axis's tilt and slow sway. */
const SPIN = 0.07;
const TILT = 0.38;
const TILT_SWAY = 0.2;
const TILT_RATE = 0.031;
/** Outside, the eye sits a little above the equator. */
const ORBIT_PITCH = 0.2;
/** Ring pole and key light (world): upper left, towards the viewer. */
const POLE = [-0.55, 0.62, 0.56];
const LIGHT = [-0.45, 0.6, 0.66];

/** @param {number[]} v */
const unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const tess = await createTessPipeline(ctx, "shaders/tess/sphere.frag");
  const state = createTessState();
  const tab = sphereTables(CELLS);
  const push = createPush();
  const drag = createDrag();
  const opts = { symmetry: "p4", palette: "", reactivity: 1, speed: 1, morph: 0.7, ink: 1, hatching: 0.6, height: 1, reduceMotion: false, reduceFlashing: false };
  const pushIn = { view: "auto", stepped: false, reduceMotion: false };
  const cam = { dist: 0, fov: 0, veil: 0, inside: 0 };
  const basis = new Float32Array(12);
  const camMat = basis.subarray(3, 12);
  const rot = new Float32Array(9);
  const pole = new Float32Array(3);
  const pal = new Float32Array(6 + MAX_TILE_COLORS * 3);
  const cls = new Float32Array(9);
  const clsNext = new Float32Array(9);
  const poleW = unit(POLE);
  const light = unit(LIGHT);
  let palName = "";
  let nTiles = 3;
  let blendPhase = 0;

  tess.resize(renderScale(ctx.params.quality));

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u) => {
    // The checkerboard's two classes plus the seams' third.
    gl.uniform3fv(u.u_tCls, cls);
    gl.uniform3fv(u.u_tClsNext, clsNext);
    // The blend wave runs along one lattice direction, which a quarter turn at an edge would
    // break; on the sphere the two motif sets blend in time only.
    gl.uniform3f(u.u_tBlend, 0, 0, blendPhase);
    gl.uniformMatrix3fv(u.u_frame, false, tab.frames);
    gl.uniform4iv(u.u_nb, tab.nb);
    gl.uniform2fv(u.u_nbT, tab.nbT);
    gl.uniform1iv(u.u_flip, tab.flip);
    gl.uniform1f(u.u_N, CELLS);
    gl.uniform3fv(u.u_pole, pole);
    gl.uniform3f(u.u_eye, basis[0], basis[1], basis[2]);
    gl.uniformMatrix3fv(u.u_cam, false, camMat);
    gl.uniform1f(u.u_tanHalf, Math.tan(cam.fov / 2));
    gl.uniformMatrix3fv(u.u_rot, false, rot);
    gl.uniform1f(u.u_inside, cam.inside);
    gl.uniform1f(u.u_veil, cam.veil);
    gl.uniform1f(u.u_discR, cam.dist > 1 ? Math.tan(Math.asin(1 / cam.dist)) / Math.tan(cam.fov / 2) : 0);
    gl.uniform3f(u.u_light, light[0], light[1], light[2]);
  };

  return {
    frame(audio, time) {
      const dt = time.dt;
      fillOptions(ctx, opts);
      const s = state.step(audio, dt, opts);
      blendPhase = s.blend[2];

      pushIn.view = viewName(ctx.params.view);
      pushIn.stepped = s.stepped;
      pushIn.reduceMotion = ctx.reduceMotion;
      push.step(dt, pushIn);
      drag.step(dt, ctx.reduceMotion);
      cameraAt(push.value, cam);
      // Drag orbits the sphere from outside and looks round from inside.
      const w = push.value;
      cameraBasis(cam.dist, drag.yaw * (1 - w), (ORBIT_PITCH + drag.pitch) * (1 - w), drag.yaw * w, drag.pitch * w, basis);

      // The sphere turns with the glide (bass, the eased beat surge); its axis sways slowly.
      sphereFrame(SPIN * s.travel, TILT + TILT_SWAY * Math.sin(TILT_RATE * s.travel), rot);
      for (let i = 0; i < 3; i++) pole[i] = rot[i] * poleW[0] + rot[3 + i] * poleW[1] + rot[6 + i] * poleW[2];

      if (opts.palette !== palName) {
        palName = opts.palette;
        nTiles = paletteOf(palName, pal);
      }
      threeClassColors(pal, nTiles, s.shift, cls, clsNext);
      tess.render(s, surface);
    },

    pointer(e) {
      drag.pointer(e);
    },

    resize() {
      tess.resize();
    },

    params(changed) {
      if ("quality" in changed) tess.resize(renderScale(ctx.params.quality));
    },

    dispose() {
      tess.dispose();
    },
  };
}
