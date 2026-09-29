// @ts-check
/**
 * Tentacube — a rounded cube with a tentacle on every face, pulsing, twisting and twitching to the
 * music in a drifting hyperbolic tiling (after a Winamp-era visualizer).
 *
 * Creature (src/lib/creature.js): the bass swells the cube through a spring; strong onsets kick a
 * quaternion spring a quarter turn about one of the cube's own axes (seeded PRNG), so it twists,
 * overshoots and settles, over a slow idle tumble; sharp flux/treble attacks add small, fast
 * jolts. Tentacles (src/lib/tentacle.js): six verlet chains, roots pinned to the moving faces,
 * integrated at a fixed 240 Hz step (identical at any display rate) with a pull toward the face
 * normal and a root→tip ripple from the mids/highs, so they drag, overshoot and whip. Each tube is
 * one preallocated mesh placed in the vertex shader from a small float texture of node positions
 * and rotation-minimizing frames (MeshPhysicalMaterial + onBeforeCompile).
 *
 * Material: a sequencer crossfades chrome → iridescent → emissive → obsidian every N bars or on a
 * sustained energy change; the blended parameters go to the physical material each frame.
 *
 * Background (src/lib/hyperbolic.js, shaders/tentacube/hyperbolic.frag): a {p,q} tiling of the
 * Poincaré disk seen through a drifting Möbius view transform (rebased on the CPU so it never
 * loses precision). The same shader renders a small equirect every few frames → PMREM → the
 * scene environment, so the chrome reflects hyperbolic space.
 *
 * Transparent canvas: everything renders over 0,0,0,0. The creature is opaque (alpha 1); the
 * background and bloom add light only. Bloom's blend is changed to leave alpha alone, and the
 * output pass sets alpha = max(alpha, r, g, b), so glow is premultiplied light and the creature
 * stays solid over a light desktop with background "none".
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import {
  createMorph,
  createRng,
  createSpring,
  createSurge,
  createTransient,
  createTwist,
  createTwitch,
  effectiveMotion,
  PRESETS,
  pulseTarget,
  quatFromRotVec,
  quatMul,
  quatRotate,
} from "./lib/creature.js";
import { createDrift, tiling } from "./lib/hyperbolic.js";
import { computeFrames, createChains, createStepper } from "./lib/tentacle.js";

/** Physics step (s) and the most steps one frame may run. */
const H = 1 / 240;
const MAX_STEPS = 12;
const CUBE = 1.3; // edge length
const HALF = CUBE / 2;
const REACH = 2.3; // tentacle length at length = 1
const RADIAL = 18; // tube sides
const RING_PER_NODE = 3;
const TWIST_COOLDOWN = 1.4; // s between beat twists
const ENV_EVERY = 4; // frames between environment-map refreshes
const TAU = Math.PI * 2;

/** Face normals and a perpendicular "side" vector per face (the ripple plane / frame start). */
const FACES = new Float32Array([
  1, 0, 0, 0, 1, 0,
  -1, 0, 0, 0, 1, 0,
  0, 1, 0, 0, 0, 1,
  0, -1, 0, 0, 0, 1,
  0, 0, 1, 1, 0, 0,
  0, 0, -1, 1, 0, 0,
]);

/** @type {Record<string, [number, number]>} */
const TILINGS = { "{7,3}": [7, 3], "{5,4}": [5, 4], "{4,5}": [4, 5] };

/**
 * Preset material parameters (linear colours), in PRESETS order:
 * color rgb, metalness, roughness, clearcoat, clearcoatRoughness, iridescence, emissive rgb,
 * emissiveIntensity, envMapIntensity, rim, rim rgb, bands.
 */
const P = {
  color: 0, metal: 3, rough: 4, coat: 5, coatRough: 6, irid: 7, emis: 8, emisI: 11, env: 12, rim: 13,
  rimC: 14, bands: 17, n: 18,
};
const PRESET_VALUES = new Float32Array([
  // chrome
  0.95, 0.95, 0.98, 1, 0.08, 0, 0.1, 0, 0, 0, 0, 0, 0.95, 0, 0, 0, 0, 0,
  // iridescent (oil slick: thin film over dark metal)
  0.35, 0.35, 0.4, 0.85, 0.14, 0.6, 0.1, 1, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 0,
  // emissive (colour set per frame)
  0.03, 0.03, 0.04, 0.2, 0.4, 0, 0.1, 0, 1, 1, 1, 0.9, 0.35, 0.4, 1, 1, 1, 1,
  // obsidian glass with a rim light
  0.012, 0.01, 0.016, 0, 0.1, 1, 0.03, 0, 0, 0, 0, 0, 0.9, 2.6, 0.25, 0.12, 1, 0,
]);

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const three = /** @type {import('../tidalviz').ThreeHandles} */ (ctx.three);
  const { renderer } = three;
  three.autoRender = false;

  const dir = "shaders/tentacube/";
  const [bgVert, bgFrag, tubePars, tubeMain, crPars, crMain] = await Promise.all(
    ["background.vert", "hyperbolic.frag", "tube_pars.vert", "tube.vert", "creature_pars.frag", "creature.frag"].map(
      (f) => ctx.assets.text(dir + f),
    ),
  );

  const scene = new THREE.Scene();
  scene.background = null;
  const camera = new THREE.PerspectiveCamera(40, ctx.size.width / ctx.size.height, 0.1, 100);
  three.scene = scene;
  three.camera = camera;

  // --- Background: full-screen hyperbolic tiling ---------------------------------------------
  const bgUniforms = {
    uM0: { value: new THREE.Vector4(1, 0, 0, 0) },
    uM1: { value: new THREE.Vector4(0, 0, 1, 0) },
    uConj: { value: 0 },
    uTile: { value: new THREE.Vector3() },
    uMode: { value: 0 },
    uAspect: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uHue: { value: 0.62 },
    uGlow: { value: 1 },
    uFill: { value: 0.022 },
  };
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const bgMat = new THREE.ShaderMaterial({
    uniforms: bgUniforms,
    vertexShader: bgVert,
    fragmentShader: bgFrag,
    depthTest: false,
    depthWrite: false,
  });
  const bg = new THREE.Mesh(quadGeo, bgMat);
  bg.frustumCulled = false;
  bg.renderOrder = -1;
  scene.add(bg);

  // Environment: the same shader over an equirect, then PMREM.
  const envUniforms = { ...bgUniforms, uMode: { value: 1 }, uGlow: { value: 1 }, uFill: { value: 0.08 } };
  const envMat = new THREE.ShaderMaterial({
    uniforms: envUniforms,
    vertexShader: bgVert,
    fragmentShader: bgFrag,
    depthTest: false,
    depthWrite: false,
  });
  const envScene = new THREE.Scene();
  const envQuad = new THREE.Mesh(quadGeo, envMat);
  envQuad.frustumCulled = false;
  envScene.add(envQuad);
  const envCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const envRT = new THREE.WebGLRenderTarget(512, 256, { type: THREE.HalfFloatType, depthBuffer: false });
  envRT.texture.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  /** @type {THREE.WebGLRenderTarget | null} */
  let envTarget = null;

  // --- Creature materials -----------------------------------------------------------------------
  const crUniforms = {
    uRim: { value: 0 },
    uRimColor: { value: new THREE.Color() },
    uBands: { value: 0 },
    uTime: { value: 0 },
    uSlick: { value: 0 },
  };
  const matOpts = { iridescenceIOR: 1.7, iridescenceThicknessRange: /** @type {[number, number]} */ ([180, 820]) };
  const cubeMat = new THREE.MeshPhysicalMaterial(matOpts);
  cubeMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, crUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vTubeS;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vTubeS = -1.0;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + crPars)
      .replace("#include <aomap_fragment>", "#include <aomap_fragment>\n" + crMain);
  };
  cubeMat.customProgramCacheKey = () => "tentacube-cube";

  const tubeUniforms = {
    uNodes: { value: /** @type {THREE.DataTexture | null} */ (null) },
    uNodeCount: { value: 24 },
    uRadius: { value: 0.2 },
    uBulge: { value: 0 },
    uBulgeAmp: { value: 0 },
  };
  const tubeMat = new THREE.MeshPhysicalMaterial(matOpts);
  tubeMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, crUniforms, tubeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + tubePars)
      .replace("#include <beginnormal_vertex>", tubeMain)
      .replace("#include <begin_vertex>", "vec3 transformed = tubePos;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + crPars)
      .replace("#include <aomap_fragment>", "#include <aomap_fragment>\n" + crMain);
  };
  tubeMat.customProgramCacheKey = () => "tentacube-tube";

  const cubeGeo = new RoundedBoxGeometry(CUBE, CUBE, CUBE, 5, 0.26);
  const cube = new THREE.Mesh(cubeGeo, cubeMat);
  scene.add(cube);

  const key = new THREE.DirectionalLight(0xffffff, 0.15);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x6f5cff, 0.2);
  fill.position.set(-4, -2, 1);
  scene.add(fill);

  // --- Tentacles (rebuilt when "segments" changes) --------------------------------------------
  /** @type {ReturnType<typeof createChains>} */
  let chains;
  /** @type {Float32Array} */
  let frames;
  /** @type {Float32Array} */
  let tangents;
  /** @type {Float32Array} */
  let nodeData;
  /** @type {THREE.DataTexture} */
  let nodeTex;
  /** @type {THREE.BufferGeometry} */
  let tubeGeo;
  /** @type {THREE.Mesh} */
  let tubes;

  function buildTentacles() {
    const nodes = Math.max(8, Math.round(Number(ctx.params.segments)));
    if (tubes) {
      scene.remove(tubes);
      tubeGeo.dispose();
      nodeTex.dispose();
    }
    chains = createChains(6, nodes);
    frames = new Float32Array(6 * nodes * 6);
    tangents = new Float32Array(6 * nodes * 3);
    nodeData = new Float32Array(nodes * 6 * 3 * 4);
    nodeTex = new THREE.DataTexture(nodeData, nodes, 18, THREE.RGBAFormat, THREE.FloatType);
    nodeTex.magFilter = nodeTex.minFilter = THREE.NearestFilter;
    nodeTex.needsUpdate = true;
    tubeUniforms.uNodes.value = nodeTex;
    tubeUniforms.uNodeCount.value = nodes;

    const rings = (nodes - 1) * RING_PER_NODE + 1;
    const perTube = rings * (RADIAL + 1);
    const attr = new Float32Array(6 * perTube * 3);
    const index = [];
    for (let c = 0; c < 6; c++) {
      for (let r = 0; r < rings; r++) {
        for (let k = 0; k <= RADIAL; k++) {
          const v = c * perTube + r * (RADIAL + 1) + k;
          attr[v * 3] = c;
          attr[v * 3 + 1] = r / (rings - 1);
          attr[v * 3 + 2] = (k / RADIAL) * TAU;
          if (r < rings - 1 && k < RADIAL) {
            const a = v;
            const b = v + RADIAL + 1;
            index.push(a, a + 1, b, b, a + 1, b + 1);
          }
        }
      }
    }
    tubeGeo = new THREE.BufferGeometry();
    tubeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6 * perTube * 3), 3));
    tubeGeo.setAttribute("aTube", new THREE.BufferAttribute(attr, 3));
    // Placeholder: the vertex shader computes the normal, but without a normal attribute three
    // switches physical materials to flat shading.
    tubeGeo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(6 * perTube * 3), 3));
    tubeGeo.setIndex(index);
    tubes = new THREE.Mesh(tubeGeo, tubeMat);
    tubes.frustumCulled = false;
    scene.add(tubes);
    placeRoots();
    chains.reset();
  }

  // --- Dynamics -----------------------------------------------------------------------------------
  const rng = createRng(0x7e57ac1e);
  const twist = createTwist(rng);
  const twitch = createTwitch(rng);
  const transient = createTransient();
  const pulse = createSpring(2.2, 0.45);
  pulse.x = 1;
  const stepper = createStepper(H, MAX_STEPS);
  const morph = createMorph();
  const glowSurge = createSurge();
  const bgSurge = createSurge();
  const motion = { twitch: 1, drift: 1, tumble: 1 };
  const drift = createDrift(tiling(7, 3));

  // Scratch (no allocation in frame()).
  const qc = new Float64Array(4);
  const qt = new Float64Array(4);
  const v3 = new Float64Array(3);
  const blend = new Float32Array(P.n);
  const emisHue = new THREE.Color();
  let sinceTwist = TWIST_COOLDOWN;
  let rippleTime = 0;
  let bulge = 0;
  let clock = 0;
  let frameNo = 0;
  let swayT = 0;

  /** Pin every chain root to its face of the cube in its current pose (qc, twitch pos, pulse). */
  function placeRoots() {
    const s = pulse.x;
    const px = twitch.pos[0], py = twitch.pos[1], pz = twitch.pos[2];
    for (let i = 0; i < 6; i++) {
      const o = i * 6;
      quatRotate(qc, FACES[o], FACES[o + 1], FACES[o + 2], v3, 0);
      const nx = v3[0], ny = v3[1], nz = v3[2];
      quatRotate(qc, FACES[o + 3], FACES[o + 4], FACES[o + 5], v3, 0);
      const d = HALF * s * 0.78; // a little inside, so the open root end stays hidden
      chains.anchor(i, px + nx * d, py + ny * d, pz + nz * d, nx, ny, nz, v3[0], v3[1], v3[2]);
    }
  }

  /** qc = twitch rotation ∘ twist orientation. */
  function composePose() {
    quatFromRotVec(qt, twitch.rot[0], twitch.rot[1], twitch.rot[2]);
    quatMul(qc, qt, twist.q);
  }

  function applyTiling() {
    const t = TILINGS[/** @type {string} */ (ctx.params.tiling)] ?? TILINGS["{7,3}"];
    const tl = tiling(t[0], t[1]);
    drift.tiling = tl;
    drift.rebase();
    bgUniforms.uTile.value.set(tl.alpha, tl.cx, tl.r);
  }

  function applyTentacleParams() {
    const drag = Number(ctx.params.drag);
    chains.segLen = (REACH * Number(ctx.params.length)) / (chains.nodes - 1);
    chains.stiffness = 130 - 105 * drag; // more drag → looser, more inertia
    chains.damping = 3.4 - 2.2 * drag;
    tubeUniforms.uRadius.value = 0.17 * Math.min(1.4, Math.max(0.7, Math.sqrt(Number(ctx.params.length))));
  }

  // --- Post ---------------------------------------------------------------------------------------
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(1);
  const bloom = new UnrealBloomPass(new THREE.Vector2(ctx.size.width / 2, ctx.size.height / 2), 0.8, 0.5, 0.82);
  // Add bloom light but leave the scene's alpha (the creature's coverage) alone.
  bloom.blendMaterial.blending = THREE.CustomBlending;
  bloom.blendMaterial.blendEquation = THREE.AddEquation;
  bloom.blendMaterial.blendSrc = THREE.SrcAlphaFactor;
  bloom.blendMaterial.blendDst = THREE.OneFactor;
  bloom.blendMaterial.blendSrcAlpha = THREE.ZeroFactor;
  bloom.blendMaterial.blendDstAlpha = THREE.OneFactor;
  composer.addPass(new RenderPass(scene, camera, null, new THREE.Color(0x000000), 0));
  composer.addPass(bloom);
  const output = new OutputPass();
  output.material.fragmentShader = keepAlpha(output.material.fragmentShader);
  composer.addPass(output);
  const prevToneMapping = renderer.toneMapping;
  const prevExposure = renderer.toneMappingExposure;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  function resize() {
    const { width, height } = ctx.size;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    composer.setSize(width, height);
    bloom.setSize(Math.round(width / 2), Math.round(height / 2));
    // Screen → disk: corners just past the rim, so the edge tiles crowd toward it.
    const aspect = width / height;
    const k = 1.06 / Math.hypot(aspect, 1);
    bgUniforms.uAspect.value.set(aspect * k, k);
  }

  function applyParams() {
    bg.visible = ctx.params.background !== "none";
    applyTiling();
    applyTentacleParams();
  }

  composePose();
  buildTentacles();
  applyParams();
  resize();
  refreshEnv();

  function refreshEnv() {
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(envRT);
    renderer.render(envScene, envCam);
    renderer.setRenderTarget(prevTarget);
    envTarget = pmrem.fromEquirectangular(envRT.texture, envTarget);
    scene.environment = envTarget.texture;
  }

  /** Blend the preset table by the morph weights into `blend`. */
  function blendPresets() {
    const w = morph.weights;
    for (let k = 0; k < P.n; k++) {
      let v = 0;
      for (let i = 0; i < 4; i++) v += w[i] * PRESET_VALUES[i * P.n + k];
      blend[k] = v;
    }
  }

  /** @param {THREE.MeshPhysicalMaterial} m @param {number} emisScale */
  function applyMaterial(m, emisScale) {
    m.color.setRGB(blend[P.color], blend[P.color + 1], blend[P.color + 2]);
    m.metalness = blend[P.metal];
    m.roughness = blend[P.rough];
    // Keep clearcoat/iridescence above 0 so their shader defines never flip (no recompiles).
    m.clearcoat = Math.max(1e-3, blend[P.coat]);
    m.clearcoatRoughness = blend[P.coatRough];
    m.iridescence = Math.max(1e-3, blend[P.irid]);
    m.emissive.setRGB(blend[P.emis] * emisHue.r, blend[P.emis + 1] * emisHue.g, blend[P.emis + 2] * emisHue.b);
    m.emissiveIntensity = blend[P.emisI] * emisScale;
    m.envMapIntensity = blend[P.env];
  }

  return {
    frame(audio, time) {
      const dt = time.dt;
      clock += dt;
      frameNo++;
      effectiveMotion(Number(ctx.params.twitch), ctx.reduceMotion, motion);
      const pulseAmt = Number(ctx.params.pulse);

      // Audio events, once per frame.
      sinceTwist += dt;
      if (audio.onset && audio.onsetStrength >= 0.5 && sinceTwist >= TWIST_COOLDOWN) {
        twist.kick(audio.onsetStrength * (ctx.reduceMotion ? 0.6 : 1));
        sinceTwist = 0;
      }
      const attack = transient.step(audio.flux, audio.treb, dt);
      if (attack > 0 && motion.twitch > 0) twitch.jolt(attack * motion.twitch);
      else if (audio.onset && motion.twitch > 0) twitch.jolt(0.25 * motion.twitch * audio.onsetStrength);
      const pulseGoal = pulseTarget(audio.bassAtt, pulseAmt);
      const mids = Math.min(1.5, Math.max(0, audio.midAtt - 0.5));
      const highs = Math.min(1.5, Math.max(0, audio.trebAtt - 0.5));
      chains.rippleAmp = 0.04 + 0.11 * mids + 0.07 * highs;
      if (audio.onset) bulge = 0;

      // Physics at a fixed step.
      const steps = stepper.advance(dt);
      const idle = 0.22 * motion.tumble;
      for (let s = 0; s < steps; s++) {
        twist.step(H, idle);
        twitch.step(H);
        pulse.step(H, pulseGoal);
        rippleTime += H;
        chains.rippleTime = rippleTime;
        composePose();
        placeRoots();
        chains.step(H);
      }

      // Cube pose.
      cube.position.set(twitch.pos[0], twitch.pos[1], twitch.pos[2]);
      cube.quaternion.set(qc[0], qc[1], qc[2], qc[3]);
      cube.scale.setScalar(pulse.x);

      // Tentacle nodes + frames → texture.
      computeFrames(chains, frames, tangents);
      const nodes = chains.nodes;
      for (let c = 0; c < 6; c++) {
        for (let j = 0; j < nodes; j++) {
          const src = (c * nodes + j) * 3;
          const f = (c * nodes + j) * 6;
          const row0 = ((c * 3) * nodes + j) * 4;
          const row1 = ((c * 3 + 1) * nodes + j) * 4;
          const row2 = ((c * 3 + 2) * nodes + j) * 4;
          nodeData[row0] = chains.pos[src];
          nodeData[row0 + 1] = chains.pos[src + 1];
          nodeData[row0 + 2] = chains.pos[src + 2];
          nodeData[row1] = frames[f];
          nodeData[row1 + 1] = frames[f + 1];
          nodeData[row1 + 2] = frames[f + 2];
          nodeData[row2] = frames[f + 3];
          nodeData[row2 + 1] = frames[f + 4];
          nodeData[row2 + 2] = frames[f + 5];
        }
      }
      nodeTex.needsUpdate = true;
      bulge += dt * 7;
      tubeUniforms.uBulge.value = bulge;
      tubeUniforms.uBulgeAmp.value = 0.35 * Math.exp(-bulge * 0.35) * Math.min(2, pulseAmt);

      // Material morph.
      morph.step(dt, /** @type {string} */ (ctx.params.morph), /** @type {string} */ (ctx.params.material), audio.rms, audio.bpm);
      blendPresets();
      emisHue.setHSL((0.42 + 0.08 * Math.sin(clock * 0.1) + audio.centroid * 0.15) % 1, 1, 0.5);
      const glow = glowSurge.step(audio.onset, audio.onsetStrength, dt, ctx.reduceFlashing);
      applyMaterial(cubeMat, 0.8 + 0.7 * glow);
      applyMaterial(tubeMat, 0.8 + 0.7 * glow);
      crUniforms.uRim.value = blend[P.rim];
      crUniforms.uRimColor.value.setRGB(blend[P.rimC], blend[P.rimC + 1], blend[P.rimC + 2]);
      crUniforms.uBands.value = blend[P.bands];
      crUniforms.uSlick.value = morph.weights[1];
      crUniforms.uTime.value = clock;

      // Background drift + pulse.
      const speed = (0.1 + 0.08 * Math.min(1.5, Math.max(0, audio.bassAtt - 0.8))) * motion.drift;
      drift.step(dt, speed, 0.05 * motion.drift * Math.sin(clock * 0.07));
      const m = drift.m;
      bgUniforms.uM0.value.set(m[0], m[1], m[2], m[3]);
      bgUniforms.uM1.value.set(m[4], m[5], m[6], m[7]);
      bgUniforms.uConj.value = m[8];
      bgUniforms.uTime.value = clock;
      bgUniforms.uHue.value = (0.62 + clock * 0.004 + audio.centroid * 0.1) % 1;
      const bgPulse = bgSurge.step(audio.onset, audio.onsetStrength, dt, ctx.reduceFlashing);
      bgUniforms.uGlow.value = 0.4 + 0.12 * Math.min(1.5, audio.bassAtt) + 0.3 * bgPulse;
      if (frameNo % ENV_EVERY === 0) refreshEnv();

      // Camera: a slow sway (none under Reduce Motion).
      swayT += dt * motion.drift;
      const dist = Number(ctx.params.distance);
      const sway = ctx.reduceMotion ? 0 : 1;
      camera.position.set(Math.sin(swayT * 0.13) * 1.2 * sway, 0.5 + Math.sin(swayT * 0.09) * 0.6 * sway, dist);
      camera.lookAt(0, 0, 0);

      bloom.strength = Number(ctx.params.bloom) * 0.8;
      composer.render(dt);
    },

    resize,

    params(changed) {
      if (changed && "segments" in changed) buildTentacles();
      applyParams();
    },

    dispose() {
      renderer.toneMapping = prevToneMapping;
      renderer.toneMappingExposure = prevExposure;
      scene.environment = null;
      composer.dispose();
      bloom.dispose();
      output.dispose();
      pmrem.dispose();
      envTarget?.dispose();
      envRT.dispose();
      for (const g of [quadGeo, cubeGeo, tubeGeo]) g.dispose();
      for (const mt of [bgMat, envMat, cubeMat, tubeMat]) mt.dispose();
      nodeTex.dispose();
      scene.clear();
      envScene.clear();
    },
  };
}

/**
 * Output pass: keep the scene's alpha (the opaque creature) and add premultiplied glow,
 * alpha = max(alpha, r, g, b). The source must end with main's closing brace.
 * @param {string} src
 */
function keepAlpha(src) {
  const end = src.lastIndexOf("}");
  return (
    src.slice(0, end) +
    "  gl_FragColor.a = max(gl_FragColor.a, max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b)));\n" +
    src.slice(end)
  );
}
