import * as THREE from "three";
import type {
  MeshPayload,
  ProofContractDto,
  ReferenceMaskEvidence,
  ReferenceRegistrationDto,
  ReferenceViewDirection,
  ShapeProofLandmarkMetric,
  ShapeProofMetricName,
  ShapeProofMetrics,
  ShapeProofRecord,
  ShapeProofThresholds,
  ShapeProofViewRecord,
} from "@chamfer/shared";
import { SHAPE_PROOF_POLICY } from "@chamfer/shared";
import { meshToGeometry } from "@/viewer/meshToGeometry";

type OpenCv = typeof import("@techstark/opencv-js");

export interface BinaryShapeMask {
  width: number;
  height: number;
  data: Uint8Array;
}

interface ArtifactIdentity {
  artifactId?: string;
  artifactVersion?: number;
}

export interface ShapeProofDependencies {
  loadOpenCv?: () => Promise<OpenCv>;
  contourDistancePx?: (source: BinaryShapeMask, rendered: BinaryShapeMask) => Promise<number>;
  renderMask?: (
    mesh: MeshPayload,
    registration: ReferenceRegistrationDto,
  ) => Promise<BinaryShapeMask>;
}

interface ShapeProofWorst {
  metric: ShapeProofMetricName;
  landmarkId?: string;
  detail: string;
  score: number;
}

const DIRECTIONS: Record<ReferenceViewDirection, { direction: [number, number, number]; up: [number, number, number] }> = {
  front: { direction: [0, -1, 0], up: [0, 0, 1] },
  back: { direction: [0, 1, 0], up: [0, 0, 1] },
  left: { direction: [-1, 0, 0], up: [0, 0, 1] },
  right: { direction: [1, 0, 0], up: [0, 0, 1] },
  top: { direction: [0, 0, 1], up: [0, 1, 0] },
  bottom: { direction: [0, 0, -1], up: [0, 1, 0] },
};

let openCvPromise: Promise<OpenCv> | undefined;

export async function loadShapeProofOpenCv(): Promise<OpenCv> {
  if (!openCvPromise) {
    const loading = import("@techstark/opencv-js").then(async (module) => {
      const candidate = ((module as unknown as { default?: OpenCv | Promise<OpenCv> }).default ?? module) as OpenCv | Promise<OpenCv>;
      const cv = await candidate;
      if (cv.Mat) return cv;
      await new Promise<void>((resolve) => {
        (cv as unknown as { onRuntimeInitialized: () => void }).onRuntimeInitialized = resolve;
      });
      return cv;
    });
    openCvPromise = loading;
    void loading.catch(() => {
      if (openCvPromise === loading) openCvPromise = undefined;
    });
  }
  return openCvPromise;
}

export function decodeReferenceMask(mask: ReferenceMaskEvidence): BinaryShapeMask {
  if (!Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width <= 0 || mask.height <= 0) {
    throw new Error("registered source mask dimensions are invalid");
  }
  const pixelCount = mask.width * mask.height;
  const data = new Uint8Array(pixelCount);
  let offset = 0;
  let foreground = false;
  for (const run of mask.rle) {
    if (!Number.isInteger(run) || run < 0 || offset + run > pixelCount) {
      throw new Error("registered source mask run-length encoding is invalid");
    }
    if (foreground) data.fill(255, offset, offset + run);
    offset += run;
    foreground = !foreground;
  }
  if (offset !== pixelCount) throw new Error("registered source mask does not cover its declared dimensions");
  return { width: mask.width, height: mask.height, data };
}

export function encodeShapeMask(mask: BinaryShapeMask): ReferenceMaskEvidence {
  const rle: number[] = [];
  let foreground = false;
  let length = 0;
  for (const value of mask.data) {
    const next = value >= 128;
    if (next === foreground) length += 1;
    else {
      rle.push(length);
      foreground = next;
      length = 1;
    }
  }
  rle.push(length);
  return { width: mask.width, height: mask.height, rle };
}

function foregroundCount(mask: BinaryShapeMask): number {
  let count = 0;
  for (const value of mask.data) if (value >= 128) count += 1;
  return count;
}

function silhouetteIou(source: BinaryShapeMask, rendered: BinaryShapeMask): number {
  if (source.width !== rendered.width || source.height !== rendered.height) {
    throw new Error("source and render masks do not share one registered pixel grid");
  }
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < source.data.length; index += 1) {
    const sourcePixel = source.data[index]! >= 128;
    const renderPixel = rendered.data[index]! >= 128;
    if (sourcePixel && renderPixel) intersection += 1;
    if (sourcePixel || renderPixel) union += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

interface ContourDistanceEvidence {
  points: Array<[number, number]>;
  distances: Float32Array;
}

function contourDistanceEvidence(cv: OpenCv, mask: BinaryShapeMask): ContourDistanceEvidence | undefined {
  const source = cv.matFromArray(mask.height, mask.width, cv.CV_8UC1, mask.data);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let selected: InstanceType<OpenCv["Mat"]> | undefined;
  try {
    cv.findContours(source, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    let selectedArea = 0;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const area = Math.abs(cv.contourArea(contour));
      if (area > selectedArea) {
        selected?.delete();
        selected = contour.clone();
        selectedArea = area;
      }
      contour.delete();
    }
    if (!selected || selected.rows === 0) return undefined;

    const points: Array<[number, number]> = [];
    for (let index = 0; index < selected.rows; index += 1) {
      const point = selected.intPtr(index, 0) as Int32Array;
      points.push([point[0]!, point[1]!]);
    }

    const vector = new cv.MatVector();
    const contourPixels = new cv.Mat(mask.height, mask.width, cv.CV_8UC1, new cv.Scalar(255));
    const distances = new cv.Mat();
    try {
      vector.push_back(selected);
      cv.drawContours(contourPixels, vector, 0, new cv.Scalar(0), 1);
      cv.distanceTransform(contourPixels, distances, cv.DIST_L2, cv.DIST_MASK_PRECISE);
      const values = new Float32Array(distances.data32F);
      return {
        points,
        distances: values,
      };
    } finally {
      vector.delete();
      contourPixels.delete();
      distances.delete();
    }
  } finally {
    selected?.delete();
    source.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function directionalMean(points: readonly [number, number][], distanceMap: Float32Array, width: number): number {
  if (points.length === 0) return 0;
  let total = 0;
  for (const [x, y] of points) total += distanceMap[y * width + x] ?? 0;
  return total / points.length;
}

async function symmetricContourDistancePx(
  source: BinaryShapeMask,
  rendered: BinaryShapeMask,
  loadOpenCv: () => Promise<OpenCv>,
  override?: ShapeProofDependencies["contourDistancePx"],
): Promise<number> {
  if (override) return override(source, rendered);
  const sourceCount = foregroundCount(source);
  const renderCount = foregroundCount(rendered);
  if (sourceCount === 0 && renderCount === 0) return 0;
  if (sourceCount === 0 || renderCount === 0) return Math.hypot(source.width, source.height);
  const cv = await loadOpenCv();
  const sourceEvidence = contourDistanceEvidence(cv, source);
  const renderEvidence = contourDistanceEvidence(cv, rendered);
  if (!sourceEvidence || !renderEvidence) return Math.hypot(source.width, source.height);
  const sourceToRender = directionalMean(sourceEvidence.points, renderEvidence.distances, source.width);
  const renderToSource = directionalMean(renderEvidence.points, sourceEvidence.distances, source.width);
  return Math.max(sourceToRender, renderToSource);
}

export function thresholdsForRegistration(registration: ReferenceRegistrationDto): ShapeProofThresholds {
  const sourceResolutionMm = registration.geometry.scaleTransform?.mmPerPixel;
  if (!(sourceResolutionMm && Number.isFinite(sourceResolutionMm) && sourceResolutionMm > 0)) {
    throw new Error("registered physical source resolution is unavailable");
  }
  const resolutionThreshold = sourceResolutionMm * SHAPE_PROOF_POLICY.sourceResolutionMultiplier;
  const contourThreshold = Math.max(SHAPE_PROOF_POLICY.minContourToleranceMm, resolutionThreshold);
  return {
    silhouetteIouMin: SHAPE_PROOF_POLICY.minSilhouetteIou,
    symmetricContourDistanceMmMax: contourThreshold,
    landmarkPositionErrorMmMax: Math.max(SHAPE_PROOF_POLICY.minLandmarkToleranceMm, resolutionThreshold),
    sourceResolutionMm,
  };
}

function boundaryPoints(mask: BinaryShapeMask): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const foreground = (x: number, y: number) =>
    x >= 0 && x < mask.width && y >= 0 && y < mask.height && mask.data[y * mask.width + x]! >= 128;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (foreground(x, y) &&
          (!foreground(x - 1, y) || !foreground(x + 1, y) || !foreground(x, y - 1) || !foreground(x, y + 1))) {
        points.push([x, y]);
      }
    }
  }
  return points;
}

function nearestPoint(points: readonly [number, number][], target: readonly [number, number]): [number, number] | undefined {
  let nearest: [number, number] | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.hypot(point[0] - target[0], point[1] - target[1]);
    if (distance < nearestDistance ||
        (distance === nearestDistance && nearest && (point[1] < nearest[1] || (point[1] === nearest[1] && point[0] < nearest[0])))) {
      nearest = point;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function registeredPositionPx(
  registration: ReferenceRegistrationDto,
  landmark: ReferenceRegistrationDto["visibleLandmarks"][number],
  mask: BinaryShapeMask,
): [number, number] {
  return [
    ((landmark.position.x - registration.sourceRegion.x) / registration.sourceRegion.width) * (mask.width - 1),
    ((landmark.position.y - registration.sourceRegion.y) / registration.sourceRegion.height) * (mask.height - 1),
  ];
}

/**
 * Landmarks are semantic points proposed before CAD exists.
 * Product code binds each point to the nearest source-mask boundary, then compares
 * that immutable boundary anchor with the nearest boundary in the rendered mask.
 * This supports outline vertices and internal feature boundaries without accepting
 * agent-authored rendered coordinates.
 */
export function compareVisibleLandmarks(
  source: BinaryShapeMask,
  rendered: BinaryShapeMask,
  registration: ReferenceRegistrationDto,
  thresholds: ShapeProofThresholds,
): ShapeProofLandmarkMetric[] {
  const sourceBoundary = boundaryPoints(source);
  const renderedBoundary = boundaryPoints(rendered);
  return registration.visibleLandmarks.map((landmark) => {
    const proposed = registeredPositionPx(registration, landmark, source);
    const sourceAnchor = nearestPoint(sourceBoundary, proposed);
    if (!sourceAnchor) {
      return {
        id: landmark.id,
        label: landmark.label,
        status: "error",
        detail: "The registered source mask has no boundary supporting this landmark.",
      };
    }
    const renderedPosition = nearestPoint(renderedBoundary, sourceAnchor);
    if (!renderedPosition) {
      return {
        id: landmark.id,
        label: landmark.label,
        status: "error",
        detail: "The rendered mask has no boundary supporting this landmark.",
      };
    }
    const positionErrorMm = Math.hypot(
      renderedPosition[0] - sourceAnchor[0],
      renderedPosition[1] - sourceAnchor[1],
    ) * thresholds.sourceResolutionMm;
    return {
      id: landmark.id,
      label: landmark.label,
      positionErrorMm,
      status: positionErrorMm <= thresholds.landmarkPositionErrorMmMax ? "passed" : "failed",
    };
  });
}

export async function compareShapeMasks(
  source: BinaryShapeMask,
  rendered: BinaryShapeMask,
  mmPerPixel: number,
  dependencies: Pick<ShapeProofDependencies, "loadOpenCv" | "contourDistancePx"> = {},
): Promise<ShapeProofMetrics> {
  const contourDistancePx = await symmetricContourDistancePx(
    source,
    rendered,
    dependencies.loadOpenCv ?? loadShapeProofOpenCv,
    dependencies.contourDistancePx,
  );
  return {
    silhouetteIou: silhouetteIou(source, rendered),
    symmetricContourDistanceMm: contourDistancePx * mmPerPixel,
    landmarks: [],
  };
}

export async function renderRegisteredOrthographicMask(
  mesh: MeshPayload,
  registration: ReferenceRegistrationDto,
): Promise<BinaryShapeMask> {
  if (typeof OffscreenCanvas === "undefined") throw new Error("offscreen canvas rendering is unavailable");
  if (!registration.direction) throw new Error("registered orthographic direction is unavailable");
  const sourceMask = registration.geometry.mask;
  const mmPerPixel = registration.geometry.scaleTransform?.mmPerPixel;
  if (!sourceMask || !(mmPerPixel && mmPerPixel > 0)) throw new Error("registered mask or physical scale is unavailable");

  const geometry = meshToGeometry(mesh);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bounds = geometry.boundingBox;
  const sphere = geometry.boundingSphere;
  if (!bounds || !sphere) {
    geometry.dispose();
    throw new Error("the CAD mesh has no renderable bounds");
  }

  const canvas = new OffscreenCanvas(sourceMask.width, sourceMask.height);
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas as unknown as HTMLCanvasElement,
    antialias: true,
    preserveDrawingBuffer: true,
    alpha: false,
  });
  renderer.setSize(sourceMask.width, sourceMask.height, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const view = DIRECTIONS[registration.direction];
  const halfWidthMm = sourceMask.width * mmPerPixel / 2;
  const halfHeightMm = sourceMask.height * mmPerPixel / 2;
  const distance = Math.max(sphere.radius * 3, 3);
  const camera = new THREE.OrthographicCamera(
    -halfWidthMm,
    halfWidthMm,
    halfHeightMm,
    -halfHeightMm,
    Math.max(0.01, distance - sphere.radius * 1.5),
    distance + sphere.radius * 1.5,
  );
  const direction = new THREE.Vector3(...view.direction).normalize();
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.up.set(...view.up);
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();

  try {
    renderer.render(scene, camera);
    const composite = new OffscreenCanvas(sourceMask.width, sourceMask.height);
    const context = composite.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D mask readback is unavailable");
    context.drawImage(canvas, 0, 0);
    const rgba = context.getImageData(0, 0, sourceMask.width, sourceMask.height).data;
    const data = new Uint8Array(sourceMask.width * sourceMask.height);
    for (let index = 0; index < data.length; index += 1) {
      const offset = index * 4;
      const luminance = (rgba[offset] ?? 0) * 0.2126 + (rgba[offset + 1] ?? 0) * 0.7152 + (rgba[offset + 2] ?? 0) * 0.0722;
      data[index] = luminance >= 128 ? 255 : 0;
    }
    return { width: sourceMask.width, height: sourceMask.height, data };
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
    material.dispose();
    geometry.dispose();
  }
}

function worstMetric(metrics: ShapeProofMetrics, thresholds: ShapeProofThresholds): ShapeProofWorst {
  const iouFailed = metrics.silhouetteIou < thresholds.silhouetteIouMin;
  const candidates: ShapeProofWorst[] = [{
    metric: "silhouette-iou",
    score: iouFailed
      ? 1 + (thresholds.silhouetteIouMin - metrics.silhouetteIou) / thresholds.silhouetteIouMin
      : (1 - metrics.silhouetteIou) / Math.max(1e-9, 1 - thresholds.silhouetteIouMin),
    detail: iouFailed
      ? `Silhouette IoU ${metrics.silhouetteIou.toFixed(4)} is below the required ${thresholds.silhouetteIouMin.toFixed(4)}.`
      : `Silhouette IoU ${metrics.silhouetteIou.toFixed(4)} satisfies the required ${thresholds.silhouetteIouMin.toFixed(4)}.`,
  }];
  const contourFailed = metrics.symmetricContourDistanceMm > thresholds.symmetricContourDistanceMmMax;
  candidates.push({
    metric: "contour-distance",
    score: contourFailed
      ? 1 + (metrics.symmetricContourDistanceMm - thresholds.symmetricContourDistanceMmMax) /
        thresholds.symmetricContourDistanceMmMax
      : metrics.symmetricContourDistanceMm / thresholds.symmetricContourDistanceMmMax,
    detail: contourFailed
      ? `Symmetric contour distance ${metrics.symmetricContourDistanceMm.toFixed(3)} mm exceeds the allowed ${thresholds.symmetricContourDistanceMmMax.toFixed(3)} mm.`
      : `Symmetric contour distance ${metrics.symmetricContourDistanceMm.toFixed(3)} mm satisfies the allowed ${thresholds.symmetricContourDistanceMmMax.toFixed(3)} mm.`,
  });
  for (const landmark of metrics.landmarks) {
    const error = landmark.positionErrorMm;
    const failed = landmark.status !== "passed";
    candidates.push({
      metric: "landmark-position",
      landmarkId: landmark.id,
      score: error === undefined
        ? Number.POSITIVE_INFINITY
        : failed
          ? 1 + (error - thresholds.landmarkPositionErrorMmMax) / thresholds.landmarkPositionErrorMmMax
          : error / thresholds.landmarkPositionErrorMmMax,
      detail: error === undefined
        ? `Landmark ${landmark.label} (${landmark.id}) could not be evaluated: ${landmark.detail ?? "position unavailable"}`
        : failed
          ? `Landmark ${landmark.label} (${landmark.id}) position error ${error.toFixed(3)} mm exceeds the allowed ${thresholds.landmarkPositionErrorMmMax.toFixed(3)} mm.`
          : `Landmark ${landmark.label} (${landmark.id}) position error ${error.toFixed(3)} mm satisfies the allowed ${thresholds.landmarkPositionErrorMmMax.toFixed(3)} mm.`,
    });
  }
  return candidates.reduce((worst, candidate) => candidate.score > worst.score ? candidate : worst);
}

function fallbackThresholds(registration: ReferenceRegistrationDto | undefined): ShapeProofThresholds {
  try {
    if (!registration) throw new Error("missing registration");
    return thresholdsForRegistration(registration);
  } catch {
    return {
      silhouetteIouMin: SHAPE_PROOF_POLICY.minSilhouetteIou,
      symmetricContourDistanceMmMax: SHAPE_PROOF_POLICY.minContourToleranceMm,
      landmarkPositionErrorMmMax: SHAPE_PROOF_POLICY.minLandmarkToleranceMm,
      sourceResolutionMm: registration?.geometry.scaleTransform?.mmPerPixel ?? 0,
    };
  }
}

function errorView(
  registration: ReferenceRegistrationDto | undefined,
  identity: { registrationId: string; revision: number; referenceId: string },
  error: unknown,
): ShapeProofViewRecord {
  return {
    status: "error",
    registration: {
      id: registration?.registrationId ?? identity.registrationId,
      revision: registration?.revision ?? identity.revision,
      referenceId: registration?.referenceId ?? identity.referenceId,
      direction: registration?.direction ?? "front",
    },
    render: {},
    thresholds: fallbackThresholds(registration),
    worst: {
      metric: "evaluation",
      detail: error instanceof Error ? error.message : String(error),
    },
  };
}

async function evaluateView(
  mesh: MeshPayload,
  contract: ProofContractDto,
  registration: ReferenceRegistrationDto,
  dependencies: ShapeProofDependencies = {},
): Promise<ShapeProofViewRecord> {
  if (registration.status !== "current" || registration.eligibility.status !== "eligible") {
    throw new Error("the proof registration is stale or ineligible");
  }
  if (!registration.direction || !registration.geometry.mask) throw new Error("registered direction or source mask is unavailable");
  const binding = contract.derivation.shapeProof.status === "not-applicable"
    ? undefined
    : contract.derivation.shapeProof.registrations.find((candidate) => candidate.registrationId === registration.registrationId);
  if (!binding || binding.revision !== registration.revision) throw new Error("proof contract registration identity is stale");

  const thresholds = thresholdsForRegistration(registration);
  const source = decodeReferenceMask(registration.geometry.mask);
  const rendered = await (dependencies.renderMask ?? renderRegisteredOrthographicMask)(mesh, registration);
  const metrics = await compareShapeMasks(source, rendered, thresholds.sourceResolutionMm, dependencies);
  metrics.landmarks = compareVisibleLandmarks(source, rendered, registration, thresholds);
  const worst = worstMetric(metrics, thresholds);
  const landmarkError = metrics.landmarks.some((landmark) => landmark.status === "error");
  const passed = metrics.silhouetteIou >= thresholds.silhouetteIouMin &&
    metrics.symmetricContourDistanceMm <= thresholds.symmetricContourDistanceMmMax &&
    metrics.landmarks.every((landmark) => landmark.status === "passed");
  return {
    status: landmarkError ? "error" : passed ? "passed" : "failed",
    registration: {
      id: registration.registrationId,
      revision: registration.revision,
      referenceId: registration.referenceId,
      direction: registration.direction,
    },
    render: {
      mask: encodeShapeMask(rendered),
    },
    thresholds,
    metrics,
    worst: { metric: worst.metric, landmarkId: worst.landmarkId, detail: worst.detail },
  };
}

export function planShapeProofBatches(registrationIds: readonly string[]): string[][] {
  const sorted = [...registrationIds].sort();
  const batchSize = SHAPE_PROOF_POLICY.evaluationBatchSize;
  const batches: string[][] = [];
  for (let offset = 0; offset < sorted.length; offset += batchSize) {
    batches.push(sorted.slice(offset, offset + batchSize));
  }
  return batches;
}

function aggregateRecord(
  contract: ProofContractDto,
  artifact: Required<ArtifactIdentity>,
  activeReferenceIds: readonly string[],
  batches: string[][],
  views: ShapeProofViewRecord[],
): ShapeProofRecord {
  const worstView = views.reduce((worst, view) => {
    if (!worst) return view;
    if (view.status === "error" && worst.status !== "error") return view;
    if (view.status !== "error" && worst.status === "error") return worst;
    const viewScore = view.metrics ? worstMetric(view.metrics, view.thresholds).score : Number.POSITIVE_INFINITY;
    const worstScore = worst.metrics ? worstMetric(worst.metrics, worst.thresholds).score : Number.POSITIVE_INFINITY;
    return viewScore > worstScore ? view : worst;
  }, undefined as ShapeProofViewRecord | undefined) ?? errorView(undefined, {
    registrationId: "missing",
    revision: 0,
    referenceId: "missing",
  }, "the proof contract contains no required registered views");
  const status = views.some((view) => view.status === "error")
    ? "error" as const
    : views.length > 0 && views.every((view) => view.status === "passed")
      ? "passed" as const
      : "failed" as const;
  return {
    status,
    evaluator: { ...SHAPE_PROOF_POLICY.evaluator },
    policy: { id: SHAPE_PROOF_POLICY.id, version: SHAPE_PROOF_POLICY.version },
    contract: {
      id: contract.contractId,
      revision: contract.revision,
      criteriaRevision: contract.derivation.criteriaRevision,
    },
    coverage: {
      activeReferenceIds: [...new Set(activeReferenceIds)].sort(),
      requiredRegistrationIds: contract.derivation.shapeProof.status === "not-applicable"
        ? []
        : contract.derivation.shapeProof.registrations.map((binding) => binding.registrationId).sort(),
      batches,
    },
    views,
    registration: worstView.registration,
    artifact: { id: artifact.artifactId, version: artifact.artifactVersion },
    render: worstView.render,
    thresholds: worstView.thresholds,
    metrics: worstView.metrics,
    worst: {
      metric: worstView.worst.metric,
      landmarkId: worstView.worst.landmarkId,
      detail: `Worst ${worstView.registration.direction} view (${worstView.registration.referenceId}): ${worstView.worst.detail}`,
    },
  };
}

export async function evaluateMultiViewShapeProof(
  mesh: MeshPayload,
  contract: ProofContractDto,
  registrations: readonly ReferenceRegistrationDto[],
  artifact: ArtifactIdentity,
  activeReferenceIds: readonly string[],
  dependencies: ShapeProofDependencies = {},
): Promise<ShapeProofRecord> {
  if (!artifact.artifactId || !artifact.artifactVersion) throw new Error("durable CAD artifact identity is unavailable");
  if (contract.derivation.shapeProof.status !== "required") throw new Error("the proof contract does not require shape proof");
  const byId = new Map(registrations.map((registration) => [registration.registrationId, registration]));
  const bindings = [...contract.derivation.shapeProof.registrations]
    .filter((binding) => binding.eligibility === "eligible")
    .sort((left, right) => left.registrationId.localeCompare(right.registrationId));
  const batches = planShapeProofBatches(bindings.map((binding) => binding.registrationId));
  const bindingById = new Map(bindings.map((binding) => [binding.registrationId, binding]));
  const views: ShapeProofViewRecord[] = [];
  for (const batch of batches) {
    for (const registrationId of batch) {
      const binding = bindingById.get(registrationId)!;
      const registration = byId.get(registrationId);
      try {
        if (!registration || registration.revision !== binding.revision || registration.referenceId !== binding.referenceId) {
          throw new Error("the required current reference registration is missing or mismatched");
        }
        views.push(await evaluateView(mesh, contract, registration, dependencies));
      } catch (error) {
        views.push(errorView(registration, binding, error));
      }
    }
  }
  return aggregateRecord(
    contract,
    { artifactId: artifact.artifactId, artifactVersion: artifact.artifactVersion },
    activeReferenceIds,
    batches,
    views,
  );
}

export async function evaluateSingleViewShapeProof(
  mesh: MeshPayload,
  contract: ProofContractDto,
  registration: ReferenceRegistrationDto,
  artifact: ArtifactIdentity,
  dependencies: ShapeProofDependencies = {},
): Promise<ShapeProofRecord> {
  return evaluateMultiViewShapeProof(
    mesh,
    contract,
    [registration],
    artifact,
    [registration.referenceId],
    dependencies,
  );
}

export function shapeProofErrorRecord(
  contract: ProofContractDto,
  registration: ReferenceRegistrationDto | undefined,
  artifact: ArtifactIdentity,
  error: unknown,
): ShapeProofRecord {
  const identity = {
    registrationId: registration?.registrationId ?? "missing",
    revision: registration?.revision ?? 0,
    referenceId: registration?.referenceId ?? "missing",
  };
  const view = errorView(registration, identity, error);
  return aggregateRecord(
    contract,
    { artifactId: artifact.artifactId ?? "missing", artifactVersion: artifact.artifactVersion ?? 0 },
    registration ? [registration.referenceId] : [],
    planShapeProofBatches([identity.registrationId]),
    [view],
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Strictly reconciles durable coverage before it may authorize finalization. */
export function shapeProofCoverageErrors(
  record: ShapeProofRecord,
  contract: ProofContractDto,
  registrations: readonly ReferenceRegistrationDto[],
  artifact: { id: string; version: number },
  activeReferenceIds: readonly string[],
): string[] {
  if (contract.derivation.shapeProof.status !== "required") return ["the current proof contract does not require shape proof"];
  if (!record.coverage || !Array.isArray(record.views)) {
    return ["aggregate multi-view coverage is unavailable on this legacy shape-proof record"];
  }
  const errors: string[] = [];
  const bindings = contract.derivation.shapeProof.registrations
    .filter((binding) => binding.eligibility === "eligible")
    .sort((left, right) => left.registrationId.localeCompare(right.registrationId));
  const requiredIds = bindings.map((binding) => binding.registrationId);
  if (new Set(requiredIds).size !== requiredIds.length) errors.push("required registration coverage contains duplicate identities");
  if (record.contract.id !== contract.contractId || record.contract.revision !== contract.revision ||
      record.contract.criteriaRevision !== contract.derivation.criteriaRevision) {
    errors.push("shape proof targets a stale proof-contract or criteria revision");
  }
  if (record.policy.id !== SHAPE_PROOF_POLICY.id || record.policy.version !== SHAPE_PROOF_POLICY.version ||
      record.evaluator.id !== SHAPE_PROOF_POLICY.evaluator.id ||
      record.evaluator.version !== SHAPE_PROOF_POLICY.evaluator.version) {
    errors.push("shape proof uses a stale evaluator or threshold policy");
  }
  if (record.artifact.id !== artifact.id || record.artifact.version !== artifact.version) {
    errors.push("shape proof targets a different CAD artifact");
  }
  const expectedActive = [...new Set(activeReferenceIds)].sort();
  if (!sameStrings(record.coverage.activeReferenceIds, expectedActive)) {
    errors.push("active reference set changed after shape-proof evaluation");
  }
  if (!sameStrings(record.coverage.requiredRegistrationIds, requiredIds)) {
    errors.push("required registered-view coverage is missing, duplicated, or mismatched");
  }
  const expectedBatches = planShapeProofBatches(requiredIds);
  if (JSON.stringify(record.coverage.batches) !== JSON.stringify(expectedBatches)) {
    errors.push("shape-proof batches do not match the deterministic partition");
  }
  const current = new Map(registrations
    .filter((registration) => registration.status === "current")
    .map((registration) => [registration.registrationId, registration]));
  const viewIds = record.views.map((view) => view.registration.id).sort();
  if (!sameStrings(viewIds, requiredIds) || new Set(viewIds).size !== viewIds.length) {
    errors.push("per-view proof coverage is missing or duplicated");
  }
  for (const binding of bindings) {
    const registration = current.get(binding.registrationId);
    const view = record.views.find((candidate) => candidate.registration.id === binding.registrationId);
    if (!registration || registration.revision !== binding.revision || registration.referenceId !== binding.referenceId ||
        registration.eligibility.status !== "eligible") {
      errors.push(`registration ${binding.registrationId} is stale, missing, or ineligible`);
      continue;
    }
    if (!view || view.registration.revision !== binding.revision || view.registration.referenceId !== binding.referenceId ||
        view.registration.direction !== registration.direction) {
      errors.push(`view ${binding.registrationId} has mismatched registration identity`);
      continue;
    }
    if (view.status !== "passed" || !view.metrics) {
      errors.push(`view ${binding.registrationId} ${view.status}: ${view.worst.detail}`);
    }
  }
  if (record.status !== "passed") errors.push(`aggregate shape proof ${record.status}: ${record.worst.detail}`);
  return errors;
}
