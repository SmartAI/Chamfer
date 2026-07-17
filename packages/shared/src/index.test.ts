import { describe, expect, it } from "vitest";
import {
  PROXY_AUTH_TOKEN, fusionCompletionEvidencePassed, fusionReadinessAllowsInspection,
  isCadCodeIdentity, isCadResponse, isFusionExpectedEffect, isMeasurements,
} from "./index";

describe("shared", () => {
  it("exports the local proxy token", () => {
    expect(PROXY_AUTH_TOKEN).toBe("chamfer-local");
  });
  it("guards CadResponse shapes", () => {
    expect(isCadResponse({ id: 1, ok: false, cmd: "run", error: "boom" })).toBe(true);
    expect(isCadResponse({ nope: true })).toBe(false);
  });
  it("keeps trusted Fusion inspection available only in document-safe readiness states", () => {
    expect(fusionReadinessAllowsInspection("ready")).toBe(true);
    expect(fusionReadinessAllowsInspection("read-only")).toBe(true);
    expect(fusionReadinessAllowsInspection("degraded")).toBe(true);
    expect(fusionReadinessAllowsInspection("wrong-document")).toBe(false);
    expect(fusionReadinessAllowsInspection("busy")).toBe(false);
  });
  it("validates nested Fusion check fields from the canonical runtime schema", () => {
    expect(isFusionExpectedEffect({ kind: "holes", expected: 4, diameterMm: 5, edgeOffsetMm: 12, through: true, bodyId: "body-1" })).toBe(true);
    expect(isFusionExpectedEffect({ kind: "parameter", name: "plate_length", expectedMm: 120, toleranceMm: 0.05 })).toBe(true);
    expect(isFusionExpectedEffect({ kind: "appearance", targetRgb: [30, 90, 180], tolerance: 0 })).toBe(true);
    expect(isFusionExpectedEffect({
      kind: "hole-pattern", expected: 2, diameterMm: 7, through: true,
      centersMm: [[20, 20, 8], [80, 20, 8]], normal: [0, 0, 1], toleranceMm: 0.05,
    })).toBe(true);
    expect(isFusionExpectedEffect({ kind: "pocket", name: "Pocket", diameterMm: 40, depthMm: 4, centerMm: [0, 0], toleranceMm: 0.05 })).toBe(true);
    expect(isFusionExpectedEffect({ kind: "holes", expected: 4, diameterMm: "5" })).toBe(false);
    expect(isFusionExpectedEffect({ kind: "appearance", targetRgb: [30, 90] })).toBe(false);
    expect(isFusionExpectedEffect({ kind: "hole-pattern", expected: 2, centersMm: [[20, 20]], normal: [0, 0, 1] })).toBe(false);
    expect(isFusionExpectedEffect({ kind: "visual-evidence", requiredViews: ["isometric", "sideways"] })).toBe(false);
  });
  it("uses one completion-evidence rule for verified Fusion lifecycle eligibility", () => {
    const evidence = { event: "completed" as const, finalRevision: "rev-1", result: {
      status: "completed", checks: [{ kind: "body-count", status: "passed", detail: "one body" }],
    } };
    expect(fusionCompletionEvidencePassed(evidence, "rev-1")).toBe(true);
    expect(fusionCompletionEvidencePassed({ ...evidence, result: { status: "completed", checks: [] } }, "rev-1")).toBe(false);
    expect(fusionCompletionEvidencePassed({ ...evidence, result: { status: "completed", checks: [
      { kind: "body-count", status: "failed", detail: "none" },
    ] } }, "rev-1")).toBe(false);
    expect(fusionCompletionEvidencePassed(evidence, "rev-2")).toBe(false);
  });
  it("guards rendered CAD identity and measurement shapes", () => {
    expect(isCadCodeIdentity({ toolCallId: "run-1", artifactId: "artifact-1", artifactVersion: 1 })).toBe(true);
    expect(isCadCodeIdentity({})).toBe(false);
    expect(isCadCodeIdentity({ toolCallId: "run-1", artifactVersion: 1.5 })).toBe(false);

    const measurements = {
      bboxMm: [10, 20, 30],
      volumeMm3: 100,
      areaMm2: 200,
      children: [{ label: "body", bboxMm: [10, 20, 30], volumeMm3: 100 }],
    };
    expect(isMeasurements(measurements)).toBe(true);
    expect(isMeasurements({ ...measurements, bboxMm: [10, 20] })).toBe(false);
    expect(isMeasurements({ ...measurements, children: [{ label: "body" }] })).toBe(false);
  });
});
