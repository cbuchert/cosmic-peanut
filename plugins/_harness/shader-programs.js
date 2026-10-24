// @ts-check
/**
 * Every WebGL2 program the built-in packs compile, assembled the way each visualizer assembles it
 * (the same include splicing and `#define` injection, through the same helpers where the
 * visualizer exports them), for tests/test_shader_compile.py to compile in WebKit (compile.html)
 * and for shader-programs.test.js to check that no shader file or visualizer is left out.
 *
 * `read(path)` returns a file's text; paths are relative to plugins/ ("builtin/shaders/…").
 * Mirror a visualizer's create() here when it changes how it builds a program (a new variant, a
 * new include): the coverage test catches a new file or visualizer, not a new combination.
 *
 * Dev only, not shipped (plugins/_harness).
 */
import { lookDefines, LOOKS } from "../builtin/src/lib/lattice-look.js";
import { opartDefines } from "../builtin/src/lib/opart.js";
import { glslDefines } from "../builtin/src/lib/skull-bounds.js";
import { assembleShader, STRUCTURE_OPTIONS, STRUCTURES, structureFor } from "../builtin/src/lib/structures.js";
import { includesOf, spliceIncludes, withDefines } from "../builtin/src/lib/tess-gl.js";
import { CINEMA_ASSETS, includeQuad } from "../cosmic-peanut/src/lib/cinema.js";
import { shapeFor } from "../cosmic-peanut/src/lib/shapes.js";

/**
 * @typedef {(path: string) => Promise<string>} Read
 * @typedef {{ viz: string, variant: string, files: string[], vs: string, fs: string }} Program
 *   `files`: the vertex shader's file, the fragment shader's file, then every file spliced in
 */

/**
 * Visualizers whose programs are built inside code this list can't mirror (three.js materials
 * and their onBeforeCompile chunks; the template's inline vertex shader): the test runs each in
 * the harness instead and fails on any shader error. Values: the shader files they compile.
 */
export const IN_HARNESS = {
  tentacube: ["background.vert", "hyperbolic.frag", "tube_pars.vert", "tube.vert", "creature_pars.frag", "creature.frag"].map(
    (f) => "builtin/shaders/tentacube/" + f,
  ),
  orbit: [],
  halo: ["template/src/scene.frag"],
};

/** Canvas 2D visualizers: nothing to compile. */
export const NO_GL = ["bars", "pulsar"];

/**
 * Plain programs: one shared vertex shader, fragment shaders with optional `inc` splicing.
 * @param {Read} read @param {string} viz @param {string} dir @param {string} vsName
 * @param {string[]} fsNames @param {Record<string, string>} [parts] marker → file, spliced by
 *   String.replace (first occurrence), as the visualizer's own `inc` does
 * @returns {Promise<Program[]>}
 */
async function simple(read, viz, dir, vsName, fsNames, parts = {}) {
  const vs = await read(dir + vsName);
  const partText = Object.fromEntries(await Promise.all(Object.entries(parts).map(async ([m, f]) => [m, await read(dir + f)])));
  return Promise.all(
    fsNames.map(async (name) => {
      let fs = await read(dir + name);
      const used = [];
      for (const [marker, f] of Object.entries(parts)) {
        if (fs.includes(marker)) used.push(dir + f);
        fs = fs.replace(marker, partText[marker]);
      }
      return { viz, variant: name, files: [dir + vsName, dir + name, ...used], vs, fs };
    }),
  );
}

/** A program from its own vertex and fragment files. @param {Read} read @param {string} viz @param {string} dir @param {string} v @param {string} f @returns {Promise<Program>} */
async function pair(read, viz, dir, v, f) {
  const [vs, fs] = await Promise.all([read(dir + v), read(dir + f)]);
  return { viz, variant: f, files: [dir + v, dir + f], vs, fs };
}

const TESS = "builtin/shaders/tess/";

/**
 * lib/tess-gl.js createTessPipeline: the surface with the engine (and atlas.glsl for a TESS_ATLAS
 * surface) spliced in; with relief, the relief and height-pass pair, and for an atlas surface the
 * carved animals' pair too (TESS_ATLAS_RELIEF); and paper.frag. Whether relief is on is read from
 * the visualizer's own `createTessPipeline(ctx, "<surface>", { relief: true })` call.
 * @param {Read} read @param {string} viz @param {string} surface file name under shaders/tess/
 * @param {string} entry the visualizer's module, e.g. "builtin/src/metamorphosis.js"
 * @returns {Promise<Program[]>}
 */
async function tessPipeline(read, viz, surface, entry) {
  const js = await read(entry);
  const call = new RegExp(`createTessPipeline\\(ctx, "shaders/tess/${surface.replace(".", "\\.")}"(, \\{ relief: true \\})?\\)`).exec(js);
  if (!call) throw new Error(`${entry}: no createTessPipeline(ctx, "shaders/tess/${surface}"…) call`);
  const relief = Boolean(call[1]);
  const [vs, engine, paperFs, surfFs] = await Promise.all(["fullscreen.vert", "tess.glsl", "paper.frag", surface].map((f) => read(TESS + f)));
  const atlas = surfFs.includes("#define TESS_ATLAS") ? await read(TESS + "atlas.glsl") : "";
  /** @type {Record<string, string>} */
  const files = { tess: engine + atlas };
  const extra = includesOf(surfFs).filter((n) => n !== "tess");
  const texts = await Promise.all(extra.map((n) => read(TESS + n + ".glsl")));
  extra.forEach((n, i) => (files[n] = texts[i]));
  const src = spliceIncludes(surfFs, files);
  const spliced = [TESS + "tess.glsl", ...(atlas ? [TESS + "atlas.glsl"] : []), ...extra.map((n) => TESS + n + ".glsl")];
  const at = (/** @type {string} */ label, /** @type {string} */ fs) => ({
    viz,
    variant: label ? `${surface} (${label})` : surface,
    files: [TESS + "fullscreen.vert", TESS + surface, ...spliced],
    vs,
    fs,
  });
  /** @type {Program[]} */
  const out = [at("", src)];
  /** @param {string[]} defs @param {string} label */
  const reliefPair = (defs, label) => [
    at(label, withDefines(src, ["TESS_RELIEF", ...defs])),
    at(`${label} height`, withDefines(src, ["TESS_RELIEF", ...defs, "TESS_HEIGHT_PASS"])),
  ];
  if (relief) out.push(...reliefPair([], "relief"));
  if (relief && atlas) out.push(...reliefPair(["TESS_ATLAS_RELIEF"], "relief, atlas"));
  out.push({ viz, variant: "paper.frag", files: [TESS + "fullscreen.vert", TESS + "paper.frag"], vs, fs: paperFs });
  return out;
}

/**
 * src/lattice.js: the scene for each structure the visualizer offers × each Look, the classic
 * composite, and the cinematic composite and bloom programs.
 * @param {Read} read @param {string} viz @returns {Promise<Program[]>}
 */
async function lattice(read, viz) {
  const dir = "builtin/shaders/lattice/";
  const PARTS = ["common", "march", "shade"];
  const [vs, main, cfs, bfs, brdf, ...parts] = await Promise.all(
    ["fullscreen.vert", "lattice.frag", "post.frag", "bloom.frag", "brdf.glsl", ...PARTS.map((n) => n + ".glsl")].map((f) => read(dir + f)),
  );
  /** @type {Record<string, string>} */
  const shared = {};
  PARTS.forEach((n, i) => (shared[n] = parts[i]));
  const names = viz === "tentacle-lattice" ? [structureFor(viz, undefined)] : STRUCTURE_OPTIONS;
  /** @type {Program[]} */
  const out = [];
  for (const name of names) {
    const st = STRUCTURES[name];
    const structure = await read(dir + st.shader);
    for (const lk of LOOKS) {
      const cine = lk === "cinematic";
      const shade = cine ? brdf + "\n" + shared.shade : shared.shade;
      out.push({
        viz,
        variant: `lattice.frag + ${st.shader} (${name}, ${lk})`,
        files: [dir + "fullscreen.vert", dir + "lattice.frag", dir + st.shader, ...PARTS.map((n) => dir + n + ".glsl"), ...(cine ? [dir + "brdf.glsl"] : [])],
        vs,
        fs: assembleShader(main, { ...shared, shade, structure }, [...st.defines, ...lookDefines(lk)]),
      });
    }
  }
  const post = (/** @type {string} */ variant, /** @type {string} */ file, /** @type {string} */ fs) => ({ viz, variant, files: [dir + "fullscreen.vert", dir + file], vs, fs });
  out.push(
    post("post.frag", "post.frag", cfs),
    post("post.frag (cinematic)", "post.frag", assembleShader(cfs, {}, ["CINEMATIC"])),
    post("bloom.frag (karis)", "bloom.frag", assembleShader(bfs, {}, ["KARIS"])),
    post("bloom.frag", "bloom.frag", bfs),
    post("bloom.frag (up)", "bloom.frag", assembleShader(bfs, {}, ["UP"])),
  );
  return out;
}

/**
 * The cosmic-peanut pack: each visualizer's line program, the soft-lines blit (lib/soft.js), and
 * the cinematic look's quad program (lib/cinema.js includeQuad) and post chain (createCinema).
 * @param {Read} read @param {string} viz @returns {Promise<Program[]>}
 */
async function cosmicPeanut(read, viz) {
  const P = "cosmic-peanut/";
  const field = viz === "mobius-field";
  const shape = field ? null : shapeFor(viz);
  const lineVs = field ? "shaders/field.vert" : /** @type {NonNullable<typeof shape>} */ (shape).vert;
  const lineFs = field ? "shaders/field.frag" : "shaders/rings.frag";
  const quadVs = field ? "shaders/quad-field.vert" : /** @type {NonNullable<typeof shape>} */ (shape).quadVert;
  const quadFs = field ? "shaders/quad-field.frag" : "shaders/quad-rings.frag";
  const [lv, lf, blitVs, blitFs, qv, qf, quadLib, down, up, composite] = await Promise.all(
    [lineVs, lineFs, "shaders/blit.vert", "shaders/blit.frag", quadVs, quadFs, CINEMA_ASSETS.quad, CINEMA_ASSETS.down, CINEMA_ASSETS.up, CINEMA_ASSETS.composite].map(
      (f) => read(P + f),
    ),
  );
  const blit = (/** @type {string} */ file, /** @type {string} */ fs) => ({ viz, variant: file, files: [P + "shaders/blit.vert", P + file], vs: blitVs, fs });
  return [
    { viz, variant: lineFs, files: [P + lineVs, P + lineFs], vs: lv, fs: lf },
    blit("shaders/blit.frag", blitFs),
    { viz, variant: `${quadFs} (cinematic)`, files: [P + quadVs, P + quadFs, P + CINEMA_ASSETS.quad], vs: includeQuad(qv, quadLib), fs: qf },
    blit(CINEMA_ASSETS.down, down),
    blit(CINEMA_ASSETS.up, up),
    blit(CINEMA_ASSETS.composite, composite),
  ];
}

/** Every program, in visualizer order. @param {Read} read @returns {Promise<Program[]>} */
export async function shaderPrograms(read) {
  const B = "builtin/shaders/";
  const skullDir = B + "skull/";
  const [skullVs, opart, skullFs, skullComp] = await Promise.all(["fullscreen.vert", "opart.glsl", "skull.frag", "composite.frag"].map((f) => read(skullDir + f)));
  // src/skull.js: its array sizes (RIPPLES, WAVE_POINTS, EMITTERS, SECTORS) and head.
  const skullHead = "#version 300 es\nprecision highp float;\n" + glslDefines() + opartDefines({ ripples: 8, wave: 32, emitters: 6, sectors: 16 }) + opart + "\n";
  const tb = B + "tetraballs/";
  const [tbVs, tbCommon, tbMat, tbSurf, tbVol, tbComp] = await Promise.all(
    ["fullscreen.vert", "common.glsl", "materials.glsl", "surface.glsl", "volume.glsl", "composite.frag"].map((f) => read(tb + f)),
  );
  const tbHead = "#version 300 es\n";

  const groups = await Promise.all([
    Promise.all([
      pair(read, "undertow", B + "undertow/", "fullscreen.vert", "warp.frag"),
      pair(read, "undertow", B + "undertow/", "wave.vert", "wave.frag"),
      pair(read, "undertow", B + "undertow/", "fullscreen.vert", "composite.frag"),
    ]),
    simple(read, "stargate", B + "stargate/", "fullscreen.vert", ["stargate.frag"]),
    simple(read, "blaze", B + "blaze/", "fullscreen.vert", ["curl.frag", "velocity.frag", "scalar.frag", "composite.frag", "divergence.frag", "pressure.frag", "project.frag"], {
      "// #include noise": "noise.glsl",
    }),
    Promise.all([pair(read, "blaze", B + "blaze/", "spark.vert", "spark.frag")]),
    Promise.all([
      pair(read, "cascade", B + "cascade/", "fullscreen.vert", "update.frag"),
      pair(read, "cascade", B + "cascade/", "water.vert", "water.frag"),
      pair(read, "cascade", B + "cascade/", "mist.vert", "mist.frag"),
      pair(read, "cascade", B + "cascade/", "fullscreen.vert", "advect.frag"),
      pair(read, "cascade", B + "cascade/", "fullscreen.vert", "blur.frag"),
      pair(read, "cascade", B + "cascade/", "fullscreen.vert", "composite.frag"),
    ]),
    simple(read, "radar", B + "radar/", "fullscreen.vert", ["paint.frag", "composite.frag"]),
    simple(read, "tiedye", B + "tiedye/", "fullscreen.vert", ["tiedye.frag", "composite.frag"]),
    [
      { viz: "skull", variant: "skull.frag", files: [skullDir + "fullscreen.vert", skullDir + "skull.frag", skullDir + "opart.glsl"], vs: skullVs, fs: skullHead + skullFs },
      { viz: "skull", variant: "composite.frag", files: [skullDir + "fullscreen.vert", skullDir + "composite.frag", skullDir + "opart.glsl"], vs: skullVs, fs: skullHead + skullComp },
    ],
    simple(read, "darksun", B + "darksun/", "fullscreen.vert", ["darksun.frag", "backdrop.frag"], { "// #include noise": "noise.glsl" }),
    simple(read, "eclipse", B + "eclipse/", "fullscreen.vert", ["eclipse.frag", "clouds.frag"], { "// #include noise": "noise.glsl" }),
    simple(read, "marbling", B + "marbling/", "fullscreen.vert", ["sim.frag", "resample.frag", "composite.frag"], {
      "#include sample.glsl": "sample.glsl",
      "#include events.glsl": "events.glsl",
    }),
    simple(
      read,
      "laminar",
      B + "laminar/",
      "fullscreen.vert",
      ["advect.frag", "correct.frag", "curl.frag", "viscous.frag", "divergence.frag", "pressure.frag", "project.frag", "resample.frag", "composite.frag"],
      { "// #include common": "common.glsl" },
    ),
    [
      { viz: "tetraballs", variant: "surface.glsl", files: [tb + "fullscreen.vert", tb + "surface.glsl", tb + "common.glsl", tb + "materials.glsl"], vs: tbVs, fs: tbHead + tbCommon + tbMat + tbSurf },
      { viz: "tetraballs", variant: "volume.glsl", files: [tb + "fullscreen.vert", tb + "volume.glsl", tb + "common.glsl"], vs: tbVs, fs: tbHead + tbCommon + tbVol },
      { viz: "tetraballs", variant: "composite.frag", files: [tb + "fullscreen.vert", tb + "composite.frag"], vs: tbVs, fs: tbComp },
    ],
    lattice(read, "lattice"),
    lattice(read, "tentacle-lattice"),
    tessPipeline(read, "metamorphosis", "metamorphosis.frag", "builtin/src/metamorphosis.js"),
    // lib/atlas-gl.js createAtlas (Metamorphosis's bestiary motif).
    Promise.all([pair(read, "metamorphosis", TESS, "fullscreen.vert", "atlas-bake.frag")]),
    tessPipeline(read, "tile-horizon", "tile-horizon.frag", "builtin/src/tile-horizon.js"),
    tessPipeline(read, "endless-zoom", "endless-zoom.frag", "builtin/src/endless-zoom.js"),
    tessPipeline(read, "tiled-sphere", "sphere.frag", "builtin/src/tiled-sphere.js"),
    tessPipeline(read, "tiled-torus", "torus.frag", "builtin/src/tiled-torus.js"),
    Promise.all([pair(read, "tiled-torus", TESS, "fullscreen.vert", "torus-disp.frag")]),
    tessPipeline(read, "poincare-disk", "disk.frag", "builtin/src/poincare-disk.js"),
    tessPipeline(read, "poincare-disk", "disk3d.frag", "builtin/src/poincare-disk.js"),
    cosmicPeanut(read, "cosmic-peanut"),
    cosmicPeanut(read, "mobius"),
    cosmicPeanut(read, "mobius-field"),
  ]);
  return groups.flat();
}
