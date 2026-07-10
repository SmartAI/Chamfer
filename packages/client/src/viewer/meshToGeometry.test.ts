import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { MeshPayload } from "@chamfer/shared";
import { meshToGeometry } from "./meshToGeometry";

// Unit cube: 8 corners, each as an (x, y, z) triple.
function unitCubeMesh(): MeshPayload {
  const positions = new Float32Array([
    0, 0, 0, // 0
    1, 0, 0, // 1
    1, 1, 0, // 2
    0, 1, 0, // 3
    0, 0, 1, // 4
    1, 0, 1, // 5
    1, 1, 1, // 6
    0, 1, 1, // 7
  ]);
  // Standard 12-triangle (36-index) cube index buffer.
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, // back
    4, 6, 5, 4, 7, 6, // front
    0, 4, 5, 0, 5, 1, // bottom
    3, 2, 6, 3, 6, 7, // top
    0, 3, 7, 0, 7, 4, // left
    1, 5, 6, 1, 6, 2, // right
  ]);
  return { positions, indices };
}

describe("meshToGeometry", () => {
  it("builds a BufferGeometry with position, index, and normal attributes", () => {
    const mesh = unitCubeMesh();
    const geometry = meshToGeometry(mesh);

    expect(geometry).toBeInstanceOf(THREE.BufferGeometry);

    const position = geometry.getAttribute("position");
    expect(position).toBeDefined();
    expect(position.count).toBe(8);
    expect(position.itemSize).toBe(3);

    const index = geometry.getIndex();
    expect(index).toBeDefined();
    expect(index?.count).toBe(36);

    const normal = geometry.getAttribute("normal");
    expect(normal).toBeDefined();
    expect(normal.count).toBe(8);
  });
});
