import { describe, expect, it } from "vitest";
import type { MeshPayload, ProofContractDto, ReferenceRegistrationDto } from "@chamfer/shared";
import { SHAPE_PROOF_POLICY } from "@chamfer/shared";
import {
  compareShapeMasks,
  evaluateMultiViewShapeProof,
  decodeReferenceMask,
  evaluateSingleViewShapeProof,
  planShapeProofBatches,
  shapeProofCoverageErrors,
  thresholdsForRegistration,
  type BinaryShapeMask,
} from "./shapeProof";

const WIDTH = 24;
const HEIGHT = 24;
const MM_PER_PIXEL = 0.1;

function contourPoints(candidate: BinaryShapeMask): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const filled = (x: number, y: number) =>
    x >= 0 && x < candidate.width && y >= 0 && y < candidate.height && candidate.data[y * candidate.width + x]! >= 128;
  for (let y = 0; y < candidate.height; y += 1) {
    for (let x = 0; x < candidate.width; x += 1) {
      if (filled(x, y) && (!filled(x - 1, y) || !filled(x + 1, y) || !filled(x, y - 1) || !filled(x, y + 1))) {
        points.push([x, y]);
      }
    }
  }
  return points;
}

async function fixtureContourDistance(source: BinaryShapeMask, rendered: BinaryShapeMask): Promise<number> {
  const sourcePoints = contourPoints(source);
  const renderPoints = contourPoints(rendered);
  if (sourcePoints.length === 0 && renderPoints.length === 0) return 0;
  if (sourcePoints.length === 0 || renderPoints.length === 0) return Math.hypot(source.width, source.height);
  const mean = (from: Array<[number, number]>, to: Array<[number, number]>) =>
    from.reduce((total, [x, y]) => total + Math.min(...to.map(([tx, ty]) => Math.hypot(tx - x, ty - y))), 0) / from.length;
  return Math.max(mean(sourcePoints, renderPoints), mean(renderPoints, sourcePoints));
}

function mask(predicate: (x: number, y: number) => boolean, edgeValue = 255): BinaryShapeMask {
  const data = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (predicate(x, y)) data[y * WIDTH + x] = edgeValue;
    }
  }
  return { width: WIDTH, height: HEIGHT, data };
}

function rectangle(left = 6, top = 6, right = 17, bottom = 17, edgeValue = 255) {
  return mask((x, y) => x >= left && x <= right && y >= top && y <= bottom, edgeValue);
}

function encode(data: Uint8Array): number[] {
  const runs: number[] = [];
  let foreground = false;
  let length = 0;
  for (const value of data) {
    const next = value >= 128;
    if (next === foreground) length += 1;
    else {
      runs.push(length);
      foreground = next;
      length = 1;
    }
  }
  runs.push(length);
  return runs;
}

function registration(source = rectangle()): ReferenceRegistrationDto {
  return {
    registrationId: "registration-1",
    conversationId: "conversation-1",
    revision: 1,
    status: "current",
    referenceId: "reference-1",
    sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
    projection: "orthographic",
    direction: "front",
    scaleAnchor: {
      specificationId: "overall-width",
      start: { x: 0.25, y: 0.9 },
      end: { x: 0.75, y: 0.9 },
      physicalLengthMm: 1.2,
    },
    visibleLandmarks: [],
    uncertainty: { level: "low", notes: "Synthetic fixture.", occluded: false },
    geometry: {
      sourceSizePx: { width: WIDTH, height: HEIGHT },
      regionPx: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      extraction: { status: "succeeded", extractor: { id: "opencv-js-contour", version: 1 } },
      mask: { width: WIDTH, height: HEIGHT, rle: encode(source.data) },
      contour: { points: [[6, 6], [17, 6], [17, 17], [6, 17]], areaPx2: 121 },
      scaleTransform: {
        specificationId: "overall-width",
        physicalLengthMm: 1.2,
        pixelLength: 12,
        mmPerPixel: MM_PER_PIXEL,
      },
    },
    eligibility: { status: "eligible", reasons: [] },
    timestamp: 1,
  };
}

function registeredView(
  id: string,
  referenceId: string,
  direction: ReferenceRegistrationDto["direction"],
  source = rectangle(),
  landmarks: ReferenceRegistrationDto["visibleLandmarks"] = [],
): ReferenceRegistrationDto {
  return {
    ...registration(source),
    registrationId: id,
    referenceId,
    direction,
    visibleLandmarks: landmarks,
  };
}

function multiViewContract(registrations: readonly ReferenceRegistrationDto[]): ProofContractDto {
  const value = contract();
  if (value.derivation.shapeProof.status === "not-applicable") throw new Error("fixture contract is not reference-backed");
  value.derivation.shapeProof.registrations = registrations.map((item) => ({
    registrationId: item.registrationId,
    referenceId: item.referenceId,
    revision: item.revision,
    eligibility: "eligible",
  }));
  return value;
}

function contract(): ProofContractDto {
  return {
    contractId: "contract-1",
    conversationId: "conversation-1",
    revision: 1,
    status: "current",
    proofStatus: "pending",
    frozenAt: 1,
    derivation: {
      planId: "plan-1",
      planRevision: 1,
      criteriaRevision: 1,
      sourceSpecificationIds: ["overall-width"],
      component: { id: "part", description: "fixture" },
      criteria: [],
      plannedChecks: [],
      unavailableEvidence: [],
      invalidatedEvidenceIds: [],
      proofPolicy: { id: "proven-single-part-reference", version: 1 },
      shapeProof: {
        status: "required",
        reason: "Synthetic eligible fixture.",
        registrations: [{
          registrationId: "registration-1",
          referenceId: "reference-1",
          revision: 1,
          eligibility: "eligible",
        }],
      },
    },
  };
}

const emptyMesh: MeshPayload = { positions: new Float32Array(), indices: new Uint32Array() };

describe("single-view shape metrics", () => {
  it("reports deterministic metrics for exact, translated, scaled, missing, distorted, and anti-aliased masks", async () => {
    const source = rectangle();
    const cases = {
      exact: rectangle(),
      translation: rectangle(8, 6, 19, 17),
      scaleError: rectangle(4, 4, 19, 19),
      missingGeometry: mask(() => false),
      contourDistortion: mask((x, y) => x >= 6 && x <= 17 && y >= 6 && y <= 17 && x + y >= 15),
      antiAliasedEdges: rectangle(6, 6, 17, 17, 180),
    };

    const metrics = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([name, candidate]) =>
      [name, await compareShapeMasks(source, candidate, MM_PER_PIXEL, { contourDistancePx: fixtureContourDistance })] as const,
    )));

    expect(metrics.exact).toMatchObject({ silhouetteIou: 1, symmetricContourDistanceMm: 0 });
    expect(metrics.antiAliasedEdges).toMatchObject({ silhouetteIou: 1, symmetricContourDistanceMm: 0 });
    expect(metrics.translation!.silhouetteIou).toBeCloseTo(120 / 168, 6);
    expect(metrics.translation!.symmetricContourDistanceMm).toBeGreaterThan(0);
    expect(metrics.scaleError!.silhouetteIou).toBeCloseTo(144 / 256, 6);
    expect(metrics.scaleError!.symmetricContourDistanceMm).toBeGreaterThan(metrics.translation!.symmetricContourDistanceMm);
    expect(metrics.missingGeometry).toMatchObject({ silhouetteIou: 0 });
    expect(metrics.missingGeometry!.symmetricContourDistanceMm).toBeCloseTo(Math.hypot(WIDTH, HEIGHT) * MM_PER_PIXEL, 6);
    expect(metrics.contourDistortion!.silhouetteIou).toBeLessThan(1);
    expect(metrics.contourDistortion!.symmetricContourDistanceMm).toBeGreaterThan(0);
  }, 30_000);

  it("resolves immutable product thresholds from registered source resolution", () => {
    const thresholds = thresholdsForRegistration(registration());
    expect(thresholds).toEqual({
      silhouetteIouMin: SHAPE_PROOF_POLICY.minSilhouetteIou,
      symmetricContourDistanceMmMax: 0.2,
      landmarkPositionErrorMmMax: 0.25,
      sourceResolutionMm: MM_PER_PIXEL,
    });
  });

  it("binds a failed comparison and corrected pass to the same target and policy", async () => {
    const target = registration();
    const wrong = await evaluateSingleViewShapeProof(
      emptyMesh,
      contract(),
      target,
      { artifactId: "artifact-1", artifactVersion: 1 },
      { renderMask: async () => rectangle(8, 6, 19, 17), contourDistancePx: fixtureContourDistance },
    );
    const corrected = await evaluateSingleViewShapeProof(
      emptyMesh,
      contract(),
      target,
      { artifactId: "artifact-2", artifactVersion: 2 },
      { renderMask: async () => rectangle(), contourDistancePx: fixtureContourDistance },
    );

    expect(wrong.status).toBe("failed");
    expect(corrected.status).toBe("passed");
    expect(corrected.registration).toEqual(wrong.registration);
    expect(corrected.policy).toEqual(wrong.policy);
    expect(corrected.thresholds).toEqual(wrong.thresholds);
    expect(corrected.contract).toEqual(wrong.contract);
  }, 30_000);

  it("rejects malformed immutable source masks instead of treating them as a pass", () => {
    const malformed = registration();
    malformed.geometry.mask!.rle = [1];
    expect(() => decodeReferenceMask(malformed.geometry.mask!)).toThrow(/does not cover/);
  });
});

describe("multi-view shape proof", () => {
  it("evaluates every required view in deterministic batches and reports the worst landmark", async () => {
    const landmarkSource = mask((x, y) => x >= 6 && x <= 17 && y >= 6 && y <= 17 && !(x === 10 && y === 10));
    const landmarkRender = mask((x, y) => x >= 6 && x <= 17 && y >= 6 && y <= 17 && !(x === 14 && y === 10));
    const views = [
      registeredView("registration-c", "reference-c", "top", landmarkSource, [{
        id: "slot-center",
        label: "Slot center",
        position: { x: 10 / (WIDTH - 1), y: 10 / (HEIGHT - 1) },
      }]),
      registeredView("registration-a", "reference-a", "front"),
      registeredView("registration-b", "reference-b", "right"),
    ];
    const proof = await evaluateMultiViewShapeProof(
      emptyMesh,
      multiViewContract(views),
      views,
      { artifactId: "artifact-multi", artifactVersion: 4 },
      ["reference-c", "reference-a", "reference-b"],
      {
        renderMask: async (_mesh, item) => item.registrationId === "registration-b"
          ? mask((x, y) => x >= 6 && x <= 17 && y >= 6 && y <= 17 && x + y >= 15)
          : item.registrationId === "registration-c"
            ? landmarkRender
            : rectangle(),
        contourDistancePx: fixtureContourDistance,
      },
    );

    expect(proof.coverage.batches).toEqual([
      ["registration-a", "registration-b"],
      ["registration-c"],
    ]);
    expect(proof.views.map((view) => [view.registration.id, view.status])).toEqual([
      ["registration-a", "passed"],
      ["registration-b", "failed"],
      ["registration-c", "failed"],
    ]);
    expect(proof.views[1]!.metrics!.symmetricContourDistanceMm).toBeGreaterThan(0);
    expect(proof.views[2]!.metrics!.landmarks[0]).toMatchObject({
      id: "slot-center",
      status: "failed",
    });
    expect(proof.worst).toMatchObject({
      metric: "landmark-position",
      landmarkId: "slot-center",
      detail: expect.stringContaining("Worst top view (reference-c)"),
    });
  });

  it("fails closed for missing, duplicate, stale, artifact-mismatched, and active-set-mismatched coverage", async () => {
    const views = [
      registeredView("registration-a", "reference-a", "front"),
      registeredView("registration-b", "reference-b", "right"),
      registeredView("registration-c", "reference-c", "top"),
    ];
    const frozen = multiViewContract(views);
    const proof = await evaluateMultiViewShapeProof(
      emptyMesh,
      frozen,
      views,
      { artifactId: "artifact-1", artifactVersion: 1 },
      views.map((view) => view.referenceId),
      { renderMask: async () => rectangle(), contourDistancePx: fixtureContourDistance },
    );
    expect(shapeProofCoverageErrors(
      proof,
      frozen,
      views,
      { id: "artifact-1", version: 1 },
      views.map((view) => view.referenceId),
    )).toEqual([]);

    const missing = structuredClone(proof);
    missing.views.pop();
    expect(shapeProofCoverageErrors(missing, frozen, views, { id: "artifact-1", version: 1 }, views.map((view) => view.referenceId)).join(" "))
      .toMatch(/missing or duplicated/);
    const duplicate = structuredClone(proof);
    duplicate.views[2] = structuredClone(duplicate.views[1]!);
    expect(shapeProofCoverageErrors(duplicate, frozen, views, { id: "artifact-1", version: 1 }, views.map((view) => view.referenceId)).join(" "))
      .toMatch(/missing or duplicated/);
    expect(shapeProofCoverageErrors(proof, frozen, views, { id: "artifact-2", version: 2 }, views.map((view) => view.referenceId)).join(" "))
      .toMatch(/different CAD artifact/);
    expect(shapeProofCoverageErrors(proof, { ...frozen, revision: 2 }, views, { id: "artifact-1", version: 1 }, views.map((view) => view.referenceId)).join(" "))
      .toMatch(/stale proof-contract or criteria revision/);
    const revisedCriteria = structuredClone(frozen);
    revisedCriteria.derivation.criteriaRevision += 1;
    expect(shapeProofCoverageErrors(proof, revisedCriteria, views, { id: "artifact-1", version: 1 }, views.map((view) => view.referenceId)).join(" "))
      .toMatch(/stale proof-contract or criteria revision/);
    expect(shapeProofCoverageErrors(proof, frozen, [{ ...views[0]!, revision: 2 }, ...views.slice(1)], { id: "artifact-1", version: 1 }, views.map((view) => view.referenceId)).join(" "))
      .toMatch(/stale, missing, or ineligible/);
    expect(shapeProofCoverageErrors(proof, frozen, views, { id: "artifact-1", version: 1 }, ["reference-a"]).join(" "))
      .toMatch(/active reference set changed/);
    const mixedBatch = structuredClone(proof);
    mixedBatch.coverage.batches[0]!.reverse();
    expect(shapeProofCoverageErrors(mixedBatch, frozen, views, { id: "artifact-1", version: 1 }, views.map((view) => view.referenceId)).join(" "))
      .toMatch(/deterministic partition/);
  });

  it("replays identical durable state as identical partitions and metric records", async () => {
    const views = [
      registeredView("registration-z", "reference-z", "top"),
      registeredView("registration-a", "reference-a", "front"),
      registeredView("registration-m", "reference-m", "right"),
    ];
    expect(planShapeProofBatches(views.map((view) => view.registrationId)))
      .toEqual(planShapeProofBatches([...views].reverse().map((view) => view.registrationId)));
    const evaluate = () => evaluateMultiViewShapeProof(
      emptyMesh,
      multiViewContract(views),
      views,
      { artifactId: "artifact-replay", artifactVersion: 7 },
      views.map((view) => view.referenceId),
      { renderMask: async () => rectangle(), contourDistancePx: fixtureContourDistance },
    );
    expect(await evaluate()).toEqual(await evaluate());
  });
});
