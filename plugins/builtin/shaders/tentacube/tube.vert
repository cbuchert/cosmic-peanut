  // --- tentacle tube (replaces beginnormal_vertex) ---
  int tChain = int(aTube.x + 0.5);
  int tN = int(uNodeCount + 0.5);
  float tF = aTube.y * (uNodeCount - 1.0);
  int tJ = min(int(floor(tF)), tN - 2);
  float tU = tF - float(tJ);
  vec3 tP0 = tubeNode(max(tJ - 1, 0), tChain, 0);
  vec3 tP1 = tubeNode(tJ, tChain, 0);
  vec3 tP2 = tubeNode(tJ + 1, tChain, 0);
  vec3 tP3 = tubeNode(min(tJ + 2, tN - 1), tChain, 0);
  // Catmull-Rom through the nodes: smooth between them, exact at them.
  vec3 tA = 2.0 * tP0 - 5.0 * tP1 + 4.0 * tP2 - tP3;
  vec3 tB = -tP0 + 3.0 * tP1 - 3.0 * tP2 + tP3;
  vec3 tPos = 0.5 * (2.0 * tP1 + (tP2 - tP0) * tU + tA * tU * tU + tB * tU * tU * tU);
  vec3 tTan = normalize(0.5 * ((tP2 - tP0) + 2.0 * tA * tU + 3.0 * tB * tU * tU) + 1e-6);
  vec3 tNrm = mix(tubeNode(tJ, tChain, 1), tubeNode(tJ + 1, tChain, 1), tU);
  vec3 tBin = normalize(cross(tTan, tNrm));
  tNrm = cross(tBin, tTan);
  float tS = aTube.y; // the first ring (s = 0) closes the root end, hidden inside the cube
  float tBulge = 1.0 + uBulgeAmp * pow(max(0.0, sin(tS * 9.0 - uBulge)), 6.0);
  float tRad = uRadius * min(1.0, tS * (uNodeCount - 1.0) * 3.0) * pow(1.0 - tS, 0.8) * (1.0 + 0.35 * exp(-tS * 12.0)) * (1.0 + 0.045 * sin(tS * 90.0)) * tBulge;
  vec3 tDir = cos(aTube.z) * tNrm + sin(aTube.z) * tBin;
  vec3 tubePos = tPos + tDir * tRad;
  vTubeS = tS;
  vec3 objectNormal = tDir;
  // --- end tentacle tube ---
