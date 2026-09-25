// @ts-check
import * as THREE from "three";
/** @type {import('../../../tidalviz').CreateVisualizer} */
export default function create(ctx) {
  const t = /** @type {import('../../../tidalviz').ThreeHandles} */ (ctx.three);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshNormalMaterial());
  t.scene.add(cube);
  return {
    frame(audio, time) {
      cube.rotation.x += time.dt;
      cube.rotation.y += time.dt * 0.7;
      cube.scale.setScalar(1 + audio.bassAtt * 0.3);
    },
  };
}
