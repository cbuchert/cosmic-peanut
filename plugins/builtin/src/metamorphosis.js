// @ts-check
/**
 * Metamorphosis — an interlocking tiling that changes shape with the music, printed like a
 * multi-block woodcut, for the `webgl2` renderer. The first of the tessellation visualizers.
 *
 * The engine (lib/tess.js, shaders/tess/tess.glsl) warps a regular p4 or p3 tiling with a smooth
 * field that has the group's symmetry and stays invertible, so the tiles stay a perfect tiling
 * while they turn into hooked, lobed, finned or star-like creatures. The field blends between
 * two motif mixes across the plane (a metamorphosis strip) and its targets step with the music
 * (lib/tess-music.js): once a bar with a confident tempo (strong onsets otherwise), easing over a
 * beat and a half; the spectral centroid picks the family (dark → lobed, bright → hooked); bass
 * and an eased beat surge set the drift; phrase changes and big onsets sweep a figure/ground
 * inversion across the tiles; the spectrum's bands tune the gouges ring by ring.
 *
 * This surface is the flat one: the plane fills the screen and drifts. lib/tess-gl.js renders
 * the print at the Quality scale and presses it into paper at full resolution. frame()
 * allocates nothing.
 *
 * Relief (the showcase of the engine's carved block, TESS_RELIEF): the plane becomes the block
 * the print is pulled from, seen from a camera above it under a raking light (the Light param),
 * relief-mapped with soft shadows. Every beat sends a wave of tiles lifting out from the centre,
 * the spectrum heaves the rings (bass inner, treble outer), onsets pop single tiles, and the
 * figure/ground front turns the tiles over like cards. Relief 0 is the flat print, unchanged.
 *
 * Creatures: "abstract" (default) is the warp above; a group ("fish", "birds", "reptiles",
 * "mammals") or "all" prints the bestiary's animal tiles instead (plugins/builtin/tiles, through
 * the atlas motif: lib/atlas.js, lib/atlas-gl.js), morphing between compatible species on the
 * music's steps; "<group>/<name>" (e.g. p.creatures=fish/koi in the harness) shows one species.
 * Relief carves the animals too: each is a block bevelled along its outline, domed and with its
 * fins raised and its scales carved by the species' height hints (the atlas's height channel),
 * and the beat waves, pops and card turns move each animal as a whole.
 */
import { createAtlas } from "./lib/atlas-gl.js";
import { atlasBlockMax, createCreatures, creatureList, hintMax } from "./lib/atlas.js";
import { blendShapes, createShape, loadBestiary } from "./lib/bestiary.js";
import { createTessPipeline } from "./lib/tess-gl.js";
import { BLEND_PERIOD, createTessState, lightDir, reliefParam, renderScale, symmetryName } from "./lib/tess-music.js";

/** Plane units per half the short side of the view (p4 tiles are half a unit: ~9 across). */
const ZOOM = 2.3;
/** Drift (plane units per second at glide speed 1) and its slow change of heading (rad/s). */
const DRIFT = 0.12;
const HEADING_RATE = 0.031;
/** Slow turn of the whole view (rad per unit of glide travel). */
const TURN = 0.006;
/** Ring scale: the screen's corners are ring 1 (half-diagonal of 16:9 in half-short-side units). */
const RING_SPAN = 2.05;
/** Relief camera height above the block, in half-short-sides of the view (perspective parallax). */
const CAM_DIST = 2.2;
/** Atlas mode: plane units per half the short side (animals larger than the abstract tiles). */
const ATLAS_ZOOM = 1.8;
/** Atlas mode: the offset wraps every WRAP cells of the tile's lattice (class colourings repeat). */
const WRAP = 6;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const tess = await createTessPipeline(ctx, "shaders/tess/metamorphosis.frag", { relief: true });
  const state = createTessState();
  const opts = {
    symmetry: "p4",
    palette: "",
    reactivity: 1,
    speed: 1,
    morph: 0.7,
    ink: 1,
    hatching: 0.6,
    height: 1,
    reduceMotion: false,
    reduceFlashing: false,
    relief: 0,
    reliefBlock: 1,
  };
  const light = new Float32Array(3);
  let ox = 0.37;
  let oy = 0.21;
  let clock = 0;
  let lastTravel = 0;
  let cr = 1;
  let sr = 0;

  tess.resize(renderScale(ctx.params.quality));

  // The bestiary, loaded the first time Creatures leaves "abstract".
  const creatures = createCreatures();
  const shape = createShape();
  const morphIn = { stepped: false, morph: 0.7, reduceMotion: false };
  /** @type {Awaited<ReturnType<typeof createAtlas>> | null} */
  let atlas = null;
  /** @type {import('./lib/bestiary.js').Species[]} */
  let bestiary = [];
  let loading = false;
  let selected = "";
  let atlasOn = false;
  let zoom = ZOOM;
  const basis = new Float64Array(4);
  let tileState = /** @type {ReturnType<typeof createTessState> | null} */ (null);
  /** The tallest carved animal of the selection, in RELIEF_BLOCKs (the relief march's bound). */
  let animalBlock = 1;

  async function select(/** @type {string} */ value) {
    selected = value;
    if (value === "abstract") return;
    if (!atlas && !loading) {
      loading = true;
      try {
        bestiary = await loadBestiary(ctx.assets, ctx.log);
        const a = await createAtlas(ctx);
        a.setLibrary(bestiary); // plain tiles have no art: their sets are empty
        atlas = a;
      } catch (e) {
        ctx.log(`bestiary: ${e instanceof Error ? e.message : e}`);
      }
      loading = false;
    }
    const ids = creatureList(selected, bestiary.map((sp) => sp.id));
    creatures.setSpecies(bestiary.filter((sp) => ids.includes(sp.id)));
    // Over the whole selection, so it holds through every morph (plain tiles have no hint).
    animalBlock = atlasBlockMax(Math.max(0, ...bestiary.filter((sp) => ids.includes(sp.id)).map(hintMax)));
  }
  await select(String(ctx.params.creatures ?? "abstract"));

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u) => {
    gl.uniform2f(u.u_O, ox, oy);
    gl.uniform2f(u.u_rot, cr, sr);
    gl.uniform1f(u.u_zoom, zoom);
    gl.uniform3f(u.u_tRing, ox, oy, zoom * RING_SPAN);
    gl.uniform3fv(u.u_light, light); // relief programs only (null elsewhere: a no-op)
    gl.uniform1f(u.u_camD, CAM_DIST * zoom);
    if (atlasOn && atlas && tileState) atlas.bind(gl, u, tileState, opts.palette, creatures.dip);
    else if (atlas) atlas.unbind(gl, u);
  };

  /** Wrap (ox, oy) into `period` cells of the lattice (a.x, a.y, b.x, b.y) × scale. */
  function wrapBy(/** @type {ArrayLike<number>} */ L, /** @type {number} */ sc, /** @type {number} */ period) {
    const ax = L[0] * sc;
    const ay = L[1] * sc;
    const bx = L[2] * sc;
    const by = L[3] * sc;
    const det = ax * by - bx * ay;
    let la = (ox * by - oy * bx) / det;
    let lb = (oy * ax - ox * ay) / det;
    la -= period * Math.floor(la / period);
    lb -= period * Math.floor(lb / period);
    ox = la * ax + lb * bx;
    oy = la * ay + lb * by;
  }

  return {
    frame(audio, time) {
      const dt = time.dt;
      const p = ctx.params;
      atlasOn = selected !== "abstract" && atlas !== null && creatures.active;
      // The atlas's tile types have 2 or 3 colour classes: the p3 state gives all three colours.
      opts.symmetry = atlasOn ? "p3" : symmetryName(p.symmetry);
      opts.palette = String(p.palette);
      opts.reactivity = Number(p.reactivity);
      opts.speed = Number(p.speed);
      opts.morph = Number(p.morph);
      opts.ink = Number(p.ink);
      opts.hatching = Number(p.hatching);
      opts.height = ctx.size.height;
      opts.reduceMotion = ctx.reduceMotion;
      opts.reduceFlashing = ctx.reduceFlashing;
      opts.relief = reliefParam(p.relief);
      // Carved animals stand taller where their hints raise them (the march starts above them).
      opts.reliefBlock = atlasOn ? animalBlock : 1;
      lightDir(Number(p.light), light);
      const s = state.step(audio, dt, opts);
      tileState = s;
      zoom = atlasOn ? ATLAS_ZOOM : ZOOM;
      if (atlasOn && atlas) {
        morphIn.stepped = s.stepped;
        morphIn.morph = opts.morph;
        morphIn.reduceMotion = ctx.reduceMotion;
        const c = creatures.step(dt, morphIn);
        if (c.changed) {
          blendShapes(c.a, c.b, c.w, shape);
          atlas.bake(shape, c.a.id, c.b.id, c.erodeA, c.erodeB, c.a.dome + (c.b.dome - c.a.dome) * c.w, c.moving);
        }
      }

      // Drift along a slowly turning heading; the view turns a little as it travels.
      const step = s.travel - lastTravel;
      lastTravel = s.travel;
      clock += dt * (ctx.reduceMotion ? 0.25 : 1);
      const heading = 0.6 + 0.9 * Math.sin(clock * HEADING_RATE);
      ox += Math.cos(heading) * DRIFT * step;
      oy += Math.sin(heading) * DRIFT * step;
      // Keep the offset small: the tiling and the metamorphosis wave both repeat every
      // BLEND_PERIOD lattice steps, so wrap there (in lattice coordinates). The atlas wraps by
      // WRAP cells of its own lattice (plane units), where its colouring repeats too.
      if (atlasOn && atlas) wrapBy(atlas.uniforms.L, atlas.uniforms.scale, WRAP);
      else {
        const b = s.group.basis;
        basis[0] = b[0][0];
        basis[1] = b[0][1];
        basis[2] = b[1][0];
        basis[3] = b[1][1];
        wrapBy(basis, 1, BLEND_PERIOD);
      }
      const turn = TURN * s.travel;
      cr = Math.cos(turn);
      sr = Math.sin(turn);

      tess.render(s, surface, atlasOn ? 1 : 0);
    },

    resize() {
      tess.resize();
    },

    params(changed) {
      if ("quality" in changed) tess.resize(renderScale(ctx.params.quality));
      if ("creatures" in changed) select(String(ctx.params.creatures));
    },

    dispose() {
      tess.dispose();
      atlas?.dispose();
    },
  };
}
