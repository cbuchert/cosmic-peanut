// @ts-check
/**
 * Orbit — 64 glowing pillars on a ring for the `three` renderer.
 *
 * One InstancedMesh (one draw call) whose per-instance scale and colour follow `audio.bands`,
 * updated through a reused Object3D/Color so the frame loop allocates nothing. The camera circles
 * the ring at a rate locked to the tempo and dips on each beat (`beatPhase`). Bloom comes from
 * `three/addons` (EffectComposer + UnrealBloomPass) at half resolution, so `autoRender` is off.
 *
 * Transparent canvas: the scene has no background and renders over 0,0,0,0, so every pass works on
 * "light on black". UnrealBloomPass doesn't keep a meaningful alpha, so the OutputPass (already the
 * last, full-screen pass) rewrites alpha = max(r, g, b) of its final colour: premultiplied glow
 * that matches the old opaque look over black and floats over the desktop, at no extra pass.
 */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { alphaFromBrightness } from "./lib/alpha.js";
import { createFlashLimiter } from "./lib/flash.js";

const COUNT = 64;
const RADIUS = 4;
const TAU = Math.PI * 2;

/** @type {import('../tidalviz').CreateVisualizer} */
export default function create(ctx) {
  const three = /** @type {import('../tidalviz').ThreeHandles} */ (ctx.three);
  const { renderer } = three;
  three.autoRender = false;

  const scene = new THREE.Scene();
  scene.background = null; // transparent: the shell supplies black or the desktop
  scene.fog = new THREE.FogExp2(0x020208, 0.045);
  const camera = new THREE.PerspectiveCamera(50, ctx.size.width / ctx.size.height, 0.1, 200);
  three.scene = scene;
  three.camera = camera;

  // Pillars: unit box with its base at y = 0 so scaling y grows it upward.
  const pillarGeo = new THREE.BoxGeometry(0.22, 1, 0.22).translate(0, 0.5, 0);
  const pillarMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const pillars = new THREE.InstancedMesh(pillarGeo, pillarMat, COUNT);
  pillars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pillars.setColorAt(0, new THREE.Color()); // allocates instanceColor
  /** @type {THREE.InstancedBufferAttribute} */ (pillars.instanceColor).setUsage(THREE.DynamicDrawUsage);
  scene.add(pillars);

  // Mirror image under a dark glossy floor line: a second instanced mesh sharing the matrices.
  const reflectMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, depthWrite: false });
  const reflection = new THREE.InstancedMesh(pillarGeo, reflectMat, COUNT);
  reflection.instanceMatrix = pillars.instanceMatrix;
  reflection.instanceColor = pillars.instanceColor;
  reflection.scale.y = -1;
  scene.add(reflection);

  // Core: a wireframe icosahedron that swells with the bass.
  const coreGeo = new THREE.IcosahedronGeometry(1, 2);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.55 });
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.y = 1.2;
  scene.add(core);

  // Floor ring and a static star field (built once).
  const ringGeo = new THREE.RingGeometry(RADIUS - 0.35, RADIUS + 0.35, 128);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);

  const starPos = new Float32Array(1500 * 3);
  for (let i = 0; i < 1500; i++) {
    const r = 30 + Math.random() * 60;
    const th = Math.random() * TAU;
    const ph = Math.acos(Math.random() * 1.6 - 0.6);
    starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    starPos[i * 3 + 1] = r * Math.cos(ph);
    starPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0x8899ff, size: 0.12, sizeAttenuation: true, fog: false });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  // Post: render → half-res bloom → output (tone map + sRGB + alpha from brightness).
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(1); // sizes below are already drawing-buffer pixels
  const bloom = new UnrealBloomPass(new THREE.Vector2(ctx.size.width / 2, ctx.size.height / 2), 1, 0.4, 0.15);
  composer.addPass(new RenderPass(scene, camera, null, new THREE.Color(0x000000), 0)); // clear to 0,0,0,0
  composer.addPass(bloom);
  const output = new OutputPass();
  output.material.fragmentShader = alphaFromBrightness(output.material.fragmentShader);
  composer.addPass(output);
  const prevToneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  // Reused per-frame scratch.
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const base = new THREE.Color();
  const hsl = { h: 0, s: 0, l: 0 };
  const levels = new Float32Array(COUNT);
  const flash = createFlashLimiter();
  let kick = 0;
  let orbit = 0;

  function applyParams() {
    base.set(/** @type {string} */ (ctx.params.color));
    base.getHSL(hsl);
    coreMat.color.copy(base).lerp(color.set(0xffffff), 0.5);
    ringMat.color.copy(base);
  }

  function resize() {
    const { width, height } = ctx.size;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    composer.setSize(width, height);
    bloom.setSize(Math.round(width / 2), Math.round(height / 2)); // composer.setSize resets it to full
  }

  applyParams();
  resize();

  return {
    frame(audio, time) {
      const dt = time.dt;
      const spin = Number(ctx.params.spin);

      // One revolution every 16 beats when the tempo is known, a slow drift otherwise.
      const beatsPerSec = audio.bpm > 0 ? audio.bpm / 60 : 0.5;
      orbit += (dt * beatsPerSec * TAU * spin) / 16;
      const dip = audio.bpm > 0 ? (1 - audio.beatPhase) ** 4 : 0;
      const dist = 11 - 0.6 * dip;
      camera.position.set(Math.cos(orbit) * dist, 4.6 + Math.sin(orbit * 0.5) * 1.2 - 0.25 * dip, Math.sin(orbit) * dist);
      camera.lookAt(0, 0.9, 0);

      // Pillars
      const bands = audio.bands;
      const keep = 0.75 ** (dt * 60);
      for (let i = 0; i < COUNT; i++) {
        // Lows at the front and back, highs at the sides: fold 64 bands over the ring twice.
        const b = i < COUNT / 2 ? i * 2 : (COUNT - 1 - i) * 2;
        const v = bands[b];
        levels[i] = v > levels[i] ? v : levels[i] * keep + v * (1 - keep);
        const lv = levels[i];
        const a = (i / COUNT) * TAU;
        dummy.position.set(Math.cos(a) * RADIUS, 0, Math.sin(a) * RADIUS);
        dummy.rotation.set(0, -a, 0);
        dummy.scale.set(1, 0.08 + lv * 3.2, 1);
        dummy.updateMatrix();
        pillars.setMatrixAt(i, dummy.matrix);
        color.setHSL((hsl.h + 1 - (b / 64) * 0.16) % 1, 0.9, 0.06 + lv * 0.38);
        pillars.setColorAt(i, color);
      }
      pillars.instanceMatrix.needsUpdate = true;
      /** @type {THREE.InstancedBufferAttribute} */ (pillars.instanceColor).needsUpdate = true;

      core.rotation.y += dt * 0.3 * spin;
      core.rotation.x += dt * 0.17 * spin;
      core.scale.setScalar(0.7 + 0.35 * Math.min(2, audio.bassAtt));
      stars.rotation.y -= dt * 0.01 * spin;

      // Beat flash through bloom strength: a full-screen brightness change, so rate-limited.
      kick = audio.onset ? Math.min(1, 0.4 + audio.onsetStrength) : kick * Math.exp(-dt * 5);
      const pulse = flash.step(kick, dt, ctx.reduceFlashing);
      bloom.strength = Number(ctx.params.bloom) * (0.5 + 0.5 * pulse);

      composer.render(dt);
    },

    resize,

    params() {
      applyParams();
    },

    dispose() {
      renderer.toneMapping = prevToneMapping;
      composer.dispose();
      bloom.dispose();
      for (const g of [pillarGeo, coreGeo, ringGeo, starGeo]) g.dispose();
      for (const m of [pillarMat, reflectMat, coreMat, ringMat, starMat]) m.dispose();
      pillars.dispose();
      scene.clear();
    },
  };
}
