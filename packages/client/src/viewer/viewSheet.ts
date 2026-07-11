import * as THREE from "three";
import type { MeshPayload } from "@chamfer/shared";
import { meshToGeometry, technicalEdges } from "./meshToGeometry";

const TILE_SIZE = 350;
const SHEET_COLUMNS = 4;
const CAMERA_PADDING = 1.15;
const SHEET_WIDTH = TILE_SIZE * SHEET_COLUMNS;
const SHEET_HEIGHT = TILE_SIZE * 2;

const VIEWS: Array<{ label: string; dir: [number, number, number]; up?: [number, number, number] }> = [
  { label: "isometric", dir: [1, -1, 1] },
  { label: "front", dir: [0, -1, 0] },
  { label: "back", dir: [0, 1, 0] },
  { label: "left", dir: [-1, 0, 0] },
  { label: "right", dir: [1, 0, 0] },
  { label: "top", dir: [0, 0, 1], up: [0, 1, 0] },
  { label: "bottom", dir: [0, 0, -1], up: [0, 1, 0] },
];

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OrthographicFrame {
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
  distance: number;
}

export function tileRect(index: number): TileRect {
  return {
    x: (index % SHEET_COLUMNS) * TILE_SIZE,
    y: Math.floor(index / SHEET_COLUMNS) * TILE_SIZE,
    width: TILE_SIZE,
    height: TILE_SIZE,
  };
}

export function orthographicFrame(radius: number): OrthographicFrame {
  const halfSize = Math.max(radius * CAMERA_PADDING, 1);
  const distance = Math.max(radius * 3, 3);
  return {
    left: -halfSize,
    right: halfSize,
    top: halfSize,
    bottom: -halfSize,
    near: Math.max(0.01, distance - radius * 1.5),
    far: distance + radius * 1.5,
    distance,
  };
}

function requireContext(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser could not create a 2D canvas context");
  return context;
}

function drawTileLabel(context: OffscreenCanvasRenderingContext2D, label: string, rect: TileRect): void {
  context.fillStyle = "rgba(255, 255, 255, 0.9)";
  context.fillRect(rect.x + 12, rect.y + 12, 112, 30);
  context.fillStyle = "#20242a";
  context.font = "600 16px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillText(label, rect.x + 22, rect.y + 27);
}

export async function renderViewSheet(mesh: MeshPayload): Promise<Blob> {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("This browser does not support offscreen canvas rendering");
  }

  const geometry = meshToGeometry(mesh);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bounds = geometry.boundingBox;
  const sphere = geometry.boundingSphere;
  if (!bounds || !sphere) {
    geometry.dispose();
    throw new Error("The CAD mesh has no renderable bounds");
  }

  const webglCanvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const renderer = new THREE.WebGLRenderer({
    canvas: webglCanvas as unknown as HTMLCanvasElement,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(TILE_SIZE, TILE_SIZE, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0xf1f3f5, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const material = new THREE.MeshStandardMaterial({ color: 0x91a0b2, roughness: 0.72, metalness: 0.05 });
  // Same sharp-edge threshold as the interactive viewer: the LLM's self-check
  // reads feature edges (silhouettes, hole rims), not tessellation seams.
  const edgesGeometry = technicalEdges(geometry);
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x20242a });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  scene.add(new THREE.LineSegments(edgesGeometry, edgeMaterial));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x75808c, 1.8));
  const directionalLight = new THREE.DirectionalLight(0xffffff, 2.2);
  scene.add(directionalLight);

  const composite = new OffscreenCanvas(SHEET_WIDTH, SHEET_HEIGHT);
  const context = requireContext(composite);
  context.fillStyle = "#f1f3f5";
  context.fillRect(0, 0, SHEET_WIDTH, SHEET_HEIGHT);

  const frame = orthographicFrame(sphere.radius);
  try {
    for (const [index, view] of VIEWS.entries()) {
      const camera = new THREE.OrthographicCamera(
        frame.left,
        frame.right,
        frame.top,
        frame.bottom,
        frame.near,
        frame.far,
      );
      const direction = new THREE.Vector3(...view.dir).normalize();
      camera.position.copy(sphere.center).addScaledVector(direction, frame.distance);
      camera.up.set(...(view.up ?? [0, 0, 1]));
      camera.lookAt(sphere.center);
      camera.updateProjectionMatrix();
      directionalLight.position.copy(camera.position);

      renderer.render(scene, camera);
      const rect = tileRect(index);
      context.drawImage(webglCanvas, rect.x, rect.y, rect.width, rect.height);
      drawTileLabel(context, view.label, rect);
    }

    const dimensions = bounds.getSize(new THREE.Vector3());
    const rect = tileRect(7);
    context.fillStyle = "#e8ebef";
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    drawTileLabel(context, "dimensions", rect);
    context.fillStyle = "#20242a";
    context.font = "500 22px ui-monospace, monospace";
    context.textBaseline = "middle";
    context.fillText(`X  ${dimensions.x.toFixed(2)} mm`, rect.x + 42, rect.y + 135);
    context.fillText(`Y  ${dimensions.y.toFixed(2)} mm`, rect.x + 42, rect.y + 180);
    context.fillText(`Z  ${dimensions.z.toFixed(2)} mm`, rect.x + 42, rect.y + 225);

    return await composite.convertToBlob({ type: "image/png" });
  } finally {
    renderer.dispose();
    // dispose() alone does not release the underlying WebGL context; without an
    // explicit context loss each sheet render leaks one context until the
    // browser cap (~16) starts evicting live contexts, killing the 3D viewer.
    renderer.forceContextLoss();
    material.dispose();
    edgesGeometry.dispose();
    edgeMaterial.dispose();
    geometry.dispose();
  }
}
