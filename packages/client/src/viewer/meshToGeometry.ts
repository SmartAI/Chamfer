import * as THREE from "three";
import type { MeshPayload } from "@chamfer/shared";

/**
 * Converts a worker-produced MeshPayload (flat position/index typed arrays)
 * into a THREE.BufferGeometry ready for rendering, with vertex normals
 * computed for lighting.
 */
export function meshToGeometry(mesh: MeshPayload): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}
