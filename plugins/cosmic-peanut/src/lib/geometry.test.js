// @ts-check
import { describe, expect, it } from "vitest";
import { buildGrid, RESTART } from "./geometry.js";

describe("buildGrid", () => {
  it("gives each ring a closed strip of M + 1 (j, i) vertices, split by primitive restart", () => {
    const { verts, indices } = buildGrid(3, 4);
    expect(RESTART).toBe(0xffffffff);
    expect(verts).toBeInstanceOf(Uint16Array); // 4 bytes a vertex: (j, i) are small integers
    expect(verts.length).toBe(3 * 5 * 2);
    expect(Array.from(verts.slice(0, 10))).toEqual([0, 0, 1, 0, 2, 0, 3, 0, 4, 0]); // j = M closes it
    expect(Array.from(verts.slice(10, 12))).toEqual([0, 1]);
    expect(indices).toBeInstanceOf(Uint32Array);
    expect(indices.length).toBe(3 * 6);
    expect(Array.from(indices.slice(0, 12))).toEqual([0, 1, 2, 3, 4, RESTART, 5, 6, 7, 8, 9, RESTART]);
  });
});
