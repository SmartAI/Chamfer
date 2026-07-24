import { describe, expect, it } from "vitest";
import {
  AGENT_EVALUATION_PILLARS, PROXY_AUTH_TOKEN, fusionCompletionEvidencePassed, fusionReadinessAllowsInspection,
  isAgentConfigurationIdentity, isCadCodeIdentity, isCadResponse, isFusionExpectedEffect, isMeasurements,
  modelJsonProvider, resolveTurnFunding,
} from "./index";

describe("shared", () => {
  it("exports the local proxy token", () => {
    expect(PROXY_AUTH_TOKEN).toBe("chamfer-local");
  });
  it("defines the fixture-comparable agent evaluation vocabulary once", () => {
    expect(AGENT_EVALUATION_PILLARS).toEqual([
      "taskSuccess",
      "gateIntegrity",
      "cost",
      "latency",
      "toolErrorRate",
    ]);
  });
  it("validates the shared artifact identity forms", () => {
    expect(isAgentConfigurationIdentity({ name: "current", identityHash: "a".repeat(64) })).toBe(true);
    expect(isAgentConfigurationIdentity({ name: "current", identityHash: `sha256:${"a".repeat(64)}` })).toBe(false);
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

// The single funding rule every surface consumes (issue #53): the hosted turn
// seed, title generation, and the client's composer gate and status bar.
describe("resolveTurnFunding", () => {
  const NO_KEYS = {};

  it("runs the selected model on its provider's own key", () => {
    expect(
      resolveTurnFunding({
        selectedProvider: "google",
        keys: { googleApiKey: "***abcd" },
        fallbackProvider: "anthropic",
      }),
    ).toEqual({ kind: "run", model: "selected", funding: "user-key" });
  });

  it("falls back to the deployment model on the demo key when nothing is keyed", () => {
    for (const selectedProvider of ["google", undefined, "mistral"]) {
      expect(
        resolveTurnFunding({ selectedProvider, keys: NO_KEYS, fallbackProvider: "anthropic" }),
      ).toEqual({ kind: "run", model: "fallback", funding: "demo" });
    }
  });

  it("funds the fallback with the user's own key for its provider, not the demo key", () => {
    // Key-first resolution downstream makes this BYOK; labeling it "(demo)"
    // or metering it would be a lie.
    expect(
      resolveTurnFunding({
        selectedProvider: "google",
        keys: { anthropicApiKey: "***abcd" },
        fallbackProvider: "anthropic",
      }),
    ).toEqual({ kind: "run", model: "fallback", funding: "user-key" });
  });

  it("blocks naming the missing provider when nothing can fund the selection", () => {
    expect(
      resolveTurnFunding({ selectedProvider: "google", keys: { anthropicApiKey: "k" }, fallbackProvider: undefined }),
    ).toEqual({ kind: "blocked", missingProvider: "google" });
    expect(
      resolveTurnFunding({ selectedProvider: "anthropic", keys: NO_KEYS, fallbackProvider: undefined }),
    ).toEqual({ kind: "blocked", missingProvider: "anthropic" });
  });

  it("distinguishes unroutable providers and the no-model case", () => {
    expect(
      resolveTurnFunding({ selectedProvider: "mistral", keys: NO_KEYS, fallbackProvider: undefined }),
    ).toEqual({ kind: "unroutable", provider: "mistral" });
    expect(
      resolveTurnFunding({ selectedProvider: undefined, keys: NO_KEYS, fallbackProvider: undefined }),
    ).toEqual({ kind: "no-model" });
  });

  it("treats empty (masked-away) key values as absent", () => {
    expect(
      resolveTurnFunding({ selectedProvider: "google", keys: { googleApiKey: "" }, fallbackProvider: undefined }),
    ).toEqual({ kind: "blocked", missingProvider: "google" });
  });
});

describe("modelJsonProvider", () => {
  it("extracts the provider and tolerates garbage", () => {
    expect(modelJsonProvider(JSON.stringify({ provider: "google", id: "g" }))).toBe("google");
    expect(modelJsonProvider(undefined)).toBeUndefined();
    expect(modelJsonProvider("not json")).toBeUndefined();
    expect(modelJsonProvider(JSON.stringify({ id: "g" }))).toBeUndefined();
  });
});
