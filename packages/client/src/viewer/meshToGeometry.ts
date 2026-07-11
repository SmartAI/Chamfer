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

/** Only triangle pairs meeting at more than this angle draw an edge line. The
 * EdgesGeometry default of 1° outlines the entire tessellation on curved
 * surfaces (every facet seam qualifies); 20° keeps real feature edges — box
 * corners, chamfers, hole rims — while smooth curvature stays clean. */
export const EDGE_THRESHOLD_DEG = 20;

/** Sharp-feature edge lines shared by the interactive viewer overlay and the
 * seven-view sheet, so both render the same technical edges. */
export function technicalEdges(geometry: THREE.BufferGeometry): THREE.EdgesGeometry {
  return new THREE.EdgesGeometry(geometry, EDGE_THRESHOLD_DEG);
}
