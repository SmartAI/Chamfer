import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  ReferenceGeometryEvidence,
  ReferenceRegistrationProposal,
  ReferenceSourceRegion,
} from "@chamfer/shared";

type OpenCv = typeof import("@techstark/opencv-js");

export const REFERENCE_EXTRACTOR = { id: "opencv-js-contour", version: 1 } as const;

let openCvPromise: Promise<OpenCv> | undefined;

async function loadOpenCv(): Promise<OpenCv> {
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

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function imageDataOf(image: ImageContent): Promise<ImageData> {
  const bytes = base64Bytes(image.data);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const bitmap = await createImageBitmap(new Blob([buffer], { type: image.mimeType }));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas is unavailable");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

export function pixelRegionOf(region: ReferenceSourceRegion, width: number, height: number) {
  const x = Math.floor(region.x * width);
  const y = Math.floor(region.y * height);
  const right = Math.ceil((region.x + region.width) * width);
  const bottom = Math.ceil((region.y + region.height) * height);
  return { x, y, width: right - x, height: bottom - y };
}

export function encodeBinaryMask(data: ArrayLike<number>): number[] {
  const runs: number[] = [];
  let foreground = false;
  let length = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index]!;
    const next = value > 0;
    if (next === foreground) {
      length += 1;
    } else {
      runs.push(length);
      foreground = next;
      length = 1;
    }
  }
  runs.push(length);
  return runs;
}

function scaleTransform(
  proposal: ReferenceRegistrationProposal,
  sourceWidth: number,
  sourceHeight: number,
): ReferenceGeometryEvidence["scaleTransform"] {
  if (!proposal.scaleAnchor) return undefined;
  const pixelLength = Math.hypot(
    (proposal.scaleAnchor.end.x - proposal.scaleAnchor.start.x) * sourceWidth,
    (proposal.scaleAnchor.end.y - proposal.scaleAnchor.start.y) * sourceHeight,
  );
  if (!(pixelLength > 0)) return undefined;
  return {
    specificationId: proposal.scaleAnchor.specificationId,
    physicalLengthMm: proposal.scaleAnchor.physicalLengthMm,
    pixelLength,
    mmPerPixel: proposal.scaleAnchor.physicalLengthMm / pixelLength,
  };
}

function cropImageData(source: ImageData, region: ReturnType<typeof pixelRegionOf>): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas is unavailable");
  context.putImageData(source, 0, 0);
  return context.getImageData(region.x, region.y, region.width, region.height);
}

function contourCandidate(cv: OpenCv, gray: InstanceType<OpenCv["Mat"]>, thresholdType: number) {
  const binary = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.threshold(gray, binary, 0, 255, thresholdType + cv.THRESH_OTSU);
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const imageArea = gray.rows * gray.cols;
    let best: { contour: InstanceType<OpenCv["Mat"]>; area: number } | undefined;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const area = Math.abs(cv.contourArea(contour));
      if (area < imageArea * 0.002 || area > imageArea * 0.95 || area <= (best?.area ?? 0)) continue;
      best?.contour.delete();
      best = { contour: contour.clone(), area };
    }
    return best;
  } finally {
    binary.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function extractWithOpenCv(cv: OpenCv, crop: ImageData) {
  const source = cv.matFromImageData(crop);
  const gray = new cv.Mat();
  let contour: InstanceType<OpenCv["Mat"]> | undefined;
  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    const darkOnLight = contourCandidate(cv, gray, cv.THRESH_BINARY_INV);
    const lightOnDark = contourCandidate(cv, gray, cv.THRESH_BINARY);
    const selected = !darkOnLight || (lightOnDark?.area ?? 0) > darkOnLight.area
      ? lightOnDark
      : darkOnLight;
    const rejected = selected === darkOnLight ? lightOnDark : darkOnLight;
    rejected?.contour.delete();
    if (!selected) throw new Error("no isolated object contour was found");
    contour = selected.contour;

    const vector = new cv.MatVector();
    const mask = new cv.Mat(crop.height, crop.width, cv.CV_8UC1, new cv.Scalar(0));
    const simplified = new cv.Mat();
    try {
      vector.push_back(contour);
      cv.drawContours(mask, vector, 0, new cv.Scalar(255), cv.FILLED);
      const perimeter = cv.arcLength(contour, true);
      cv.approxPolyDP(contour, simplified, Math.max(0.75, perimeter * 0.0025), true);
      const points: Array<[number, number]> = [];
      for (let index = 0; index < simplified.rows; index += 1) {
        const point = simplified.intPtr(index, 0) as Int32Array;
        points.push([point[0]!, point[1]!]);
      }
      if (points.length < 3) throw new Error("the extracted contour is degenerate");
      return {
        mask: { width: crop.width, height: crop.height, rle: encodeBinaryMask(mask.data ?? mask.data8U) },
        contour: { points, areaPx2: selected.area },
      };
    } finally {
      vector.delete();
      mask.delete();
      simplified.delete();
    }
  } finally {
    contour?.delete();
    source.delete();
    gray.delete();
  }
}

export async function extractReferenceGeometry(
  image: ImageContent,
  proposal: ReferenceRegistrationProposal,
  dependencies: { load?: () => Promise<OpenCv> } = {},
): Promise<ReferenceGeometryEvidence> {
  const source = await imageDataOf(image);
  const regionPx = pixelRegionOf(proposal.sourceRegion, source.width, source.height);
  const base = {
    sourceSizePx: { width: source.width, height: source.height },
    regionPx,
    scaleTransform: scaleTransform(proposal, source.width, source.height),
  };
  try {
    const cv = await (dependencies.load ?? loadOpenCv)();
    const extracted = extractWithOpenCv(cv, cropImageData(source, regionPx));
    return {
      ...base,
      extraction: { status: "succeeded", extractor: REFERENCE_EXTRACTOR },
      ...extracted,
    };
  } catch (error) {
    return {
      ...base,
      extraction: {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        extractor: REFERENCE_EXTRACTOR,
      },
    };
  }
}
