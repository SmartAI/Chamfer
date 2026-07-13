import { describe, expect, it } from "vitest";
import { planVisualVerificationBatches, preferQueuedVisualBatchPlan, projectVisualVerificationBatch, reconcileVisualVerificationBatches, validateProjectedVisualBatchInput } from "./visualVerificationBatching";

const evidence = {
  conversationId: "conversation-a",
  artifactId: "artifact-3",
  artifactVersion: 3,
  inspectionSheetId: "sheet-3",
  activeReferenceIds: ["ref-d", "ref-a", "ref-c", "ref-b", "ref-e"],
};

describe("visual verification batch planning", () => {
  it("projects one active reference through a final 1/1 batch with exactly sheet and reference pixels", () => {
    const single = planVisualVerificationBatches({
      ...evidence,
      activeReferenceIds: ["ref-a"],
    }, { contextWindow: 100_000, maxInputImages: 3 });
    expect(single.batches).toHaveLength(1);
    expect(single.batches[0]?.imageIds).toEqual(["sheet-3", "ref-a"]);

    const durable = [{
      role: "user",
      timestamp: 1,
      content: [
        { type: "attachment-reference", attachmentId: "ref-a", kind: "user-image", mimeType: "image/png" },
      ],
    }] as never;
    const projected = projectVisualVerificationBatch(durable, durable, single, {
      status: "pending", nextBatchIndex: 0, carriedObservations: [],
    });
    const batchMessage = projected.at(-1) as { content: Array<{ type: string; text?: string; attachmentId?: string }> };
    expect(batchMessage.content.filter((block) => block.type === "attachment-reference").map((block) => block.attachmentId))
      .toEqual(["sheet-3", "ref-a"]);
    expect(batchMessage.content[0]?.text).toContain("batch 1/1");

    expect(validateProjectedVisualBatchInput(single, {
      status: "pending", nextBatchIndex: 0, carriedObservations: [],
    }, {
      artifactId: single.artifactId,
      artifactVersion: single.artifactVersion,
      inspectionSheetId: single.inspectionSheetId,
      imageLimit: single.imageLimit,
      activeReferenceIds: single.activeReferenceIds,
      batchIndex: 0,
      batchCount: 1,
      coveredReferenceIds: ["ref-a"],
      observations: [{ referenceId: "ref-a", relevantViews: ["front"], findings: ["Matches."], affectedComponents: [] }],
      finalVerdict: "match",
      synthesis: "The sole active reference matches the current sheet.",
    })).toBeUndefined();
  });

  it("prefers the turn-end queued revision while message normalization catches up", () => {
    const stale = planVisualVerificationBatches(evidence, { contextWindow: 100_000, maxInputImages: 3 });
    const queued = planVisualVerificationBatches({
      ...evidence, artifactId: "artifact-4", artifactVersion: 4, inspectionSheetId: "sheet-4",
    }, { contextWindow: 100_000, maxInputImages: 3 });
    expect(preferQueuedVisualBatchPlan(stale, queued)).toBe(queued);
    expect(preferQueuedVisualBatchPlan(stale, undefined)).toBe(stale);
  });

  it("honors a declared image limit while reserving one image for the current sheet", () => {
    const plan = planVisualVerificationBatches(evidence, { contextWindow: 100_000, maxInputImages: 3 });
    expect(plan.imageLimit).toBe(3);
    expect(plan.batches.map((batch) => batch.referenceIds)).toEqual([
      ["ref-a", "ref-b"],
      ["ref-c", "ref-d"],
      ["ref-e"],
    ]);
    expect(plan.batches.every((batch) => batch.imageIds[0] === "sheet-3" && batch.imageIds.length <= 3)).toBe(true);
  });

  it("uses a conservative fallback and tighter context estimate", () => {
    expect(planVisualVerificationBatches(evidence, { contextWindow: 100_000 }).imageLimit).toBe(4);
    expect(planVisualVerificationBatches(evidence, { contextWindow: 8_000, maxInputImages: 20 }).imageLimit).toBe(2);
  });

  it("reports batching as unsupported instead of exceeding a declared or estimated limit", () => {
    expect(planVisualVerificationBatches(evidence, { contextWindow: 100_000, maxInputImages: 1 })).toMatchObject({
      imageLimit: 1,
      batches: [],
      unsupportedReason: expect.stringContaining("two images"),
    });
    expect(planVisualVerificationBatches(evidence, { contextWindow: 1_000, maxInputImages: 20 })).toMatchObject({
      imageLimit: 0,
      batches: [],
      unsupportedReason: expect.stringContaining("context"),
    });
  });

  it("replays identical durable state as byte-identical batches and compact full-set records", () => {
    const first = planVisualVerificationBatches(evidence, { contextWindow: 100_000, maxInputImages: 3 });
    const second = planVisualVerificationBatches({ ...evidence, activeReferenceIds: [...evidence.activeReferenceIds] }, { contextWindow: 100_000, maxInputImages: 3 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.fullSetRecord).toBe("ref-a|ref-b|ref-c|ref-d|ref-e");
  });
});

describe("visual verification batch reconciliation", () => {
  const plan = planVisualVerificationBatches(evidence, { contextWindow: 100_000, maxInputImages: 3 });
  const first = {
    id: "batch-1", conversationId: "conversation-a", artifactId: "artifact-3", artifactVersion: 3,
    inspectionSheetId: "sheet-3", activeReferenceIds: ["ref-a", "ref-b", "ref-c", "ref-d", "ref-e"],
    imageLimit: 3, batchIndex: 0, batchCount: 3, coveredReferenceIds: ["ref-a", "ref-b"],
    observations: [
      { referenceId: "ref-a", relevantViews: ["front"], findings: ["A matches."], affectedComponents: [] },
      { referenceId: "ref-b", relevantViews: ["top"], findings: ["B matches."], affectedComponents: [] },
    ], recordedAt: 1,
  };

  it("carries accepted observations forward and selects the next missing batch", () => {
    expect(reconcileVisualVerificationBatches(plan, [first])).toMatchObject({
      status: "pending",
      nextBatchIndex: 1,
      carriedObservations: first.observations,
    });
  });

  it.each([
    ["changed active set", { ...first, activeReferenceIds: ["ref-a", "ref-b"] }],
    ["duplicate batch", [first, { ...first, id: "batch-copy" }]],
    ["out-of-order missing batch", { ...first, batchIndex: 1, coveredReferenceIds: ["ref-c", "ref-d"] }],
  ])("rejects %s durable progress", (_label, candidate) => {
    const records = Array.isArray(candidate) ? candidate : [candidate];
    expect(reconcileVisualVerificationBatches(plan, records)).toMatchObject({ status: "invalid" });
  });

  it("ignores historical batches for an old artifact when a new revision starts", () => {
    const newPlan = planVisualVerificationBatches({
      ...evidence, artifactId: "artifact-4", artifactVersion: 4, inspectionSheetId: "sheet-4",
    }, { contextWindow: 100_000, maxInputImages: 3 });
    expect(reconcileVisualVerificationBatches(newPlan, [first])).toMatchObject({
      status: "pending", nextBatchIndex: 0, carriedObservations: [],
    });
  });

  it("projects one shared sheet, the exact subset, full records, and carried observations", () => {
    const durable = [{
      role: "user", timestamp: 1, content: ["ref-a", "ref-b", "ref-c", "ref-d", "ref-e"].map((attachmentId) => ({
        type: "attachment-reference", attachmentId, kind: "user-image", mimeType: "image/png",
      })),
    }, {
      role: "toolResult", toolName: "run_build123d", timestamp: 2, content: [{
        type: "attachment-reference", attachmentId: "sheet-3", kind: "view-sheet", mimeType: "image/png",
      }],
    }] as never;
    const projected = projectVisualVerificationBatch(durable, durable, plan, {
      status: "pending", nextBatchIndex: 1, carriedObservations: first.observations,
    });
    const serialized = JSON.stringify(projected);
    expect(serialized.match(/"type":"attachment-reference"/g)).toHaveLength(3);
    expect(serialized).toContain('"attachmentId":"sheet-3"');
    expect(serialized).toContain('"attachmentId":"ref-c"');
    expect(serialized).toContain('"attachmentId":"ref-d"');
    expect(serialized).not.toContain('"attachmentId":"ref-a"');
    expect(serialized).toContain("activeSet=ref-a|ref-b|ref-c|ref-d|ref-e");
    expect(serialized).toContain("ref-a|views=front|findings=A matches.");
  });

  it("reconstructs compacted active references from durable IDs and full classification records", () => {
    const records = evidence.activeReferenceIds.map((referenceId) => ({
      referenceId, conversationId: "conversation-a", attachmentAvailable: true,
      status: "active" as const, purpose: `Purpose ${referenceId}`, relationships: [],
      rationale: "Defines form.", specificationLinks: [`spec.${referenceId}`], history: [],
    }));
    const compactedPlan = planVisualVerificationBatches(evidence, { contextWindow: 100_000, maxInputImages: 3 }, records);
    const onlySheet = [{
      role: "toolResult", toolName: "run_build123d", timestamp: 2, content: [{
        type: "attachment-reference", attachmentId: "sheet-3", kind: "view-sheet", mimeType: "image/png",
      }],
    }] as never;
    const projected = projectVisualVerificationBatch(onlySheet, onlySheet, compactedPlan, {
      status: "pending", nextBatchIndex: 0, carriedObservations: [],
    });
    const serialized = JSON.stringify(projected);
    expect(serialized.match(/"type":"attachment-reference"/g)).toHaveLength(3);
    expect(serialized).toContain('"attachmentId":"ref-a"');
    expect(serialized).toContain('"attachmentId":"ref-b"');
    expect(serialized).toContain("status=active");
    expect(serialized).toContain("spec.ref-a");
  });

  it("removes native current-sheet pixels before synthesizing exactly one durable sheet", () => {
    const nativeSheet = [{
      role: "toolResult", toolName: "run_build123d", timestamp: 2,
      details: { inspectionSheet: { attachmentId: "sheet-3" } },
      content: [{ type: "image", data: "native-sheet", mimeType: "image/png" }],
    }] as never;
    const projected = projectVisualVerificationBatch(nativeSheet, nativeSheet, plan, {
      status: "pending", nextBatchIndex: 0, carriedObservations: [],
    });
    const serialized = JSON.stringify(projected);
    const batchContent = (projected.at(-1) as { content: Array<{ type?: string; attachmentId?: string }> }).content;
    expect(serialized).not.toContain("native-sheet");
    expect(batchContent.filter((block) => block.attachmentId === "sheet-3")).toHaveLength(1);
    expect(batchContent.filter((block) => block.type === "attachment-reference")).toHaveLength(3);
  });

  it("strips unrelated native and leased images so the appended batch is the sole image authority", () => {
    const noisyProjection = [{
      role: "toolResult", toolName: "inspect_evidence", timestamp: 1, content: [
        { type: "image", data: "leased-native", mimeType: "image/png" },
        { type: "attachment-reference", attachmentId: "unrelated-lease", kind: "user-image", mimeType: "image/png" },
        { type: "text", text: "Keep this durable observation." },
      ],
    }] as never;
    const projected = projectVisualVerificationBatch(noisyProjection, noisyProjection, plan, {
      status: "pending", nextBatchIndex: 0, carriedObservations: [],
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("leased-native");
    expect(serialized).not.toContain("unrelated-lease");
    expect(serialized).toContain("Keep this durable observation.");
    expect(serialized.match(/"type":"attachment-reference"/g)).toHaveLength(3);
  });

  it("rejects tool arguments that invent a different provider limit or partition", () => {
    const input = {
      artifactId: plan.artifactId, artifactVersion: plan.artifactVersion, inspectionSheetId: plan.inspectionSheetId,
      imageLimit: 4, activeReferenceIds: plan.activeReferenceIds, batchIndex: 0, batchCount: plan.batches.length,
      coveredReferenceIds: plan.batches[0]!.referenceIds,
      observations: plan.batches[0]!.referenceIds.map((referenceId) => ({
        referenceId, relevantViews: ["front"], findings: ["Matches."], affectedComponents: [],
      })),
    };
    expect(validateProjectedVisualBatchInput(plan, { status: "pending", nextBatchIndex: 0, carriedObservations: [] }, input))
      .toContain("model-derived");
  });
});
