import { describe, expect, it } from "vitest";
import type { RecordVisualVerificationBatchInput } from "@chamfer/shared";
import { openDb } from "./db";
import { createAttachment, createConversation, createMessage } from "./conversationStore";
import { classifyReference } from "./referenceClassification";
import { appendEvidenceEvent } from "./evidenceStore";
import {
  listVisualVerificationBatches,
  listVisualVerifications,
  recordVisualVerification,
  recordVisualVerificationBatch,
  VisualVerificationError,
} from "./visualVerification";

const BUILD_COMPARISON_ID = "visual-comparison:artifact-2:2";
const FUSION_COMPARISON_ID = "visual-comparison:fusion-inspection:1";

function recordComparison(
  db: ReturnType<typeof openDb>,
  conversationId: string,
  evidenceId: string,
  candidate: { artifactId: string; artifactVersion: number; inspectionSheetId: string },
): void {
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:visual-comparison:${evidenceId}`,
    type: "visual-comparison.recorded",
    data: {
      comparison: {
        evidenceId,
        status: "match",
        policy: { id: "test-policy", version: 1 },
        algorithm: { id: "test-algorithm", version: 1 },
        thresholds: { silhouetteOverlapMin: 0.9, edgeAlignmentMin: 0.9, edgeTolerancePx: 1 },
        candidate,
        comparisons: [],
      },
    },
  });
}

function fixture() {
  const db = openDb(":memory:");
  const conversation = createConversation(db, "visual verification");
  const other = createConversation(db, "other");
  createMessage(db, conversation.id, { id: "user-message", seq: 0, role: "user", contentJson: "{}" });
  for (const id of ["ref-a", "ref-b"]) {
    createAttachment(db, "user-message", "user-image", {
      mime: "image/png", contentHash: id.padEnd(64, "a"), byteSize: 1, blobPath: `blobs/${id}.png`,
    }, id);
    classifyReference(db, conversation.id, {
      referenceId: id,
      status: "active",
      purpose: "Design evidence",
      relationships: [],
      rationale: "Defines visible form.",
      specificationIds: [],
      noSpecificationReason: "Qualitative test reference without an extractable dimension.",
    });
  }
  createAttachment(db, "user-message", "user-image", {
    mime: "image/png", contentHash: "retirement".padEnd(64, "a"), byteSize: 1, blobPath: "blobs/retirement.png",
  }, "retirement-ref");
  db.prepare("INSERT INTO artifacts (id, conversation_id, version, py_source, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("artifact-2", conversation.id, 2, "box", 2);
  const result = {
    role: "toolResult",
    toolName: "run_build123d",
    details: {
      gate: { status: "passed", checks: [] },
      inspectionSheet: {
        attachmentId: "sheet-2",
        code: { toolCallId: "run-2", artifactId: "artifact-2", artifactVersion: 2 },
        measurements: { bboxMm: [1, 1, 1], volumeMm3: 1, areaMm2: 6, children: [] },
        gate: { status: "passed", checks: [] },
      },
      visualComparison: {
        evidenceId: BUILD_COMPARISON_ID,
        candidate: { artifactId: "artifact-2", artifactVersion: 2, inspectionSheetId: "sheet-2" },
      },
    },
  };
  createMessage(db, conversation.id, { id: "result-message", seq: 1, role: "toolResult", contentJson: JSON.stringify(result) });
  createAttachment(db, "result-message", "view-sheet", {
    mime: "image/png", contentHash: "s".repeat(64), byteSize: 1, blobPath: "blobs/sheet.png",
  }, "sheet-2");
  recordComparison(db, conversation.id, BUILD_COMPARISON_ID, {
    artifactId: "artifact-2", artifactVersion: 2, inspectionSheetId: "sheet-2",
  });
  const input = {
    artifactId: "artifact-2",
    artifactVersion: 2,
    inspectionSheetId: "sheet-2",
    visualComparisonEvidenceId: BUILD_COMPARISON_ID,
    coveredReferenceIds: ["ref-a", "ref-b"],
    verdict: "match" as const,
    observations: [
      { referenceId: "ref-a", relevantViews: ["front"], findings: ["Matches."], affectedComponents: [] },
      { referenceId: "ref-b", relevantViews: ["top"], findings: ["Matches."], affectedComponents: [] },
    ],
  };
  return { db, conversation, other, input };
}

describe("visual verification store", () => {
  it("rejects direct verdict creation when active references require pixel exposure", () => {
    const { db, conversation, input } = fixture();
    expect(() => recordVisualVerification(db, conversation.id, input)).toThrow(/batch workflow/);
  });

  it.each([
    ["cross-conversation", (f: ReturnType<typeof fixture>) => [f.other.id, f.input], /does not belong/],
    ["stale artifact", (f: ReturnType<typeof fixture>) => [f.conversation.id, { ...f.input, artifactVersion: 1 }], /latest artifact/],
    ["mismatched sheet", (f: ReturnType<typeof fixture>) => [f.conversation.id, { ...f.input, inspectionSheetId: "ref-a" }], /current inspection sheet/],
    ["stale comparison", (f: ReturnType<typeof fixture>) => [f.conversation.id, { ...f.input, visualComparisonEvidenceId: "stale-evidence" }], /current measured comparison/],
  ] as const)("rejects %s", (_label, make, pattern) => {
    const f = fixture();
    const [conversationId, input] = make(f);
    expect(() => recordVisualVerification(f.db, conversationId as string, input as typeof f.input)).toThrow(pattern);
    expect(() => recordVisualVerification(f.db, conversationId as string, input as typeof f.input)).toThrow(VisualVerificationError);
  });
});

describe("batched visual verification store", () => {
  function retireReference(db: ReturnType<typeof openDb>, conversationId: string, referenceId: string) {
    classifyReference(db, conversationId, {
      referenceId,
      status: "superseded",
      purpose: "Design evidence",
      relationships: [{ type: "superseded-by", referenceId: "retirement-ref" }],
      rationale: "This reference is not part of this verification target.",
      specificationIds: [],
      noSpecificationReason: "Qualitative test reference without an extractable dimension.",
    });
  }

  function batchInput(index: number) {
    const ids = index === 0 ? ["ref-a"] : ["ref-b"];
    return {
      artifactId: "artifact-2",
      artifactVersion: 2,
      inspectionSheetId: "sheet-2",
      visualComparisonEvidenceId: BUILD_COMPARISON_ID,
      imageLimit: 2,
      activeReferenceIds: ["ref-a", "ref-b"],
      batchIndex: index,
      batchCount: 2,
      coveredReferenceIds: ids,
      observations: ids.map((referenceId) => ({
        referenceId, relevantViews: ["front"], findings: [`${referenceId} matches.`], affectedComponents: [],
      })),
    };
  }

  it("accumulates exact-state batches and creates one final synthesized verdict", () => {
    const { db, conversation } = fixture();
    const first = recordVisualVerificationBatch(db, conversation.id, batchInput(0));
    expect(first.finalVerification).toBeUndefined();
    const final = recordVisualVerificationBatch(db, conversation.id, {
      ...batchInput(1),
      finalVerdict: "match",
      synthesis: "Both references match the current sheet across the relevant views.",
    });
    expect(final.finalVerification).toMatchObject({
      verdict: "match",
      coveredReferenceIds: ["ref-a", "ref-b"],
      observations: [...batchInput(0).observations, ...batchInput(1).observations],
    });
    expect(listVisualVerificationBatches(db, conversation.id)).toHaveLength(2);
  });

  it("creates the canonical final verdict atomically from a single exposed batch", () => {
    const { db, conversation } = fixture();
    retireReference(db, conversation.id, "ref-b");
    const final = recordVisualVerificationBatch(db, conversation.id, {
      artifactId: "artifact-2",
      artifactVersion: 2,
      inspectionSheetId: "sheet-2",
      visualComparisonEvidenceId: BUILD_COMPARISON_ID,
      imageLimit: 3,
      activeReferenceIds: ["ref-a"],
      batchIndex: 0,
      batchCount: 1,
      coveredReferenceIds: ["ref-a"],
      observations: [{ referenceId: "ref-a", relevantViews: ["front"], findings: ["Matches."], affectedComponents: [] }],
      finalVerdict: "match",
      synthesis: "The active reference matches the current sheet.",
    });
    expect(final).toMatchObject({
      batchIndex: 0,
      batchCount: 1,
      finalVerification: { verdict: "match", coveredReferenceIds: ["ref-a"] },
    });
    expect(listVisualVerificationBatches(db, conversation.id)).toHaveLength(1);
  });

  it("accepts the current revision-bound Fusion inspection sheet", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Fusion visual verification", "fusion");
    createMessage(db, conversation.id, { id: "fusion-user", seq: 0, role: "user", contentJson: "{}" });
    createAttachment(db, "fusion-user", "user-image", {
      mime: "image/png", contentHash: "f".repeat(64), byteSize: 1, blobPath: "blobs/fusion-reference.png",
    }, "fusion-ref");
    classifyReference(db, conversation.id, {
      referenceId: "fusion-ref", status: "active", purpose: "Bracket drawing", relationships: [],
      rationale: "Defines the requested Fusion part.", specificationIds: [],
      noSpecificationReason: "Fusion references are verified against native inspection sheets without durable source specifications.",
    });
    db.prepare(`INSERT INTO fusion_inspections
      (id, conversation_id, revision, snapshot_json, checks_json, screenshots_json, camera_restored, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("fusion-inspection", conversation.id, "fusion-revision", "{}", "[]", "[]", 1, 1);
    db.prepare("INSERT INTO artifacts (id, conversation_id, version, py_source, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("fusion-inspection", conversation.id, 1, "fusion-revision:fusion-revision", 1);
    createMessage(db, conversation.id, {
      id: "fusion-result", seq: 1, role: "toolResult", contentJson: JSON.stringify({
        role: "toolResult", toolName: "execute_cad_change", isError: false,
        details: {
          status: "completed",
          visualArtifact: {
            artifactId: "fusion-inspection", artifactVersion: 1, revision: "fusion-revision",
            inspectionSheet: { attachmentId: "fusion-sheet" },
          },
          visualComparison: {
            evidenceId: FUSION_COMPARISON_ID,
            candidate: { artifactId: "fusion-inspection", artifactVersion: 1, inspectionSheetId: "fusion-sheet" },
          },
        },
      }),
    });
    createAttachment(db, "fusion-result", "view-sheet", {
      mime: "image/png", contentHash: "v".repeat(64), byteSize: 1, blobPath: "blobs/fusion-sheet.png",
    }, "fusion-sheet");
    recordComparison(db, conversation.id, FUSION_COMPARISON_ID, {
      artifactId: "fusion-inspection", artifactVersion: 1, inspectionSheetId: "fusion-sheet",
    });

    const input = {
      artifactId: "fusion-inspection", artifactVersion: 1, inspectionSheetId: "fusion-sheet",
      visualComparisonEvidenceId: FUSION_COMPARISON_ID,
      imageLimit: 3, activeReferenceIds: ["fusion-ref"], batchIndex: 0, batchCount: 1,
      coveredReferenceIds: ["fusion-ref"],
      observations: [{ referenceId: "fusion-ref", relevantViews: ["front", "top", "right"], findings: ["Matches."], affectedComponents: [] }],
      finalVerdict: "match", synthesis: "The Fusion bracket matches the active reference.",
    } satisfies RecordVisualVerificationBatchInput;
    expect(recordVisualVerificationBatch(db, conversation.id, input)).toMatchObject({ finalVerification: {
      artifactId: "fusion-inspection", artifactVersion: 1, inspectionSheetId: "fusion-sheet", verdict: "match",
    } });
    createMessage(db, conversation.id, {
      id: "fusion-nonconforming", seq: 2, role: "toolResult", contentJson: JSON.stringify({
        role: "toolResult", toolName: "execute_cad_change", isError: false,
        details: { status: "nonconforming", finalRevision: "fusion-revision-2" },
      }),
    });
    expect(() => recordVisualVerificationBatch(db, conversation.id, input)).toThrow(/latest artifact/);
  });

  it("accepts a read-only inspect_fusion view sheet captured after a sheetless completed action", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Fusion read-only recapture", "fusion");
    createMessage(db, conversation.id, { id: "fusion-user", seq: 0, role: "user", contentJson: "{}" });
    createAttachment(db, "fusion-user", "user-image", {
      mime: "image/png", contentHash: "f".repeat(64), byteSize: 1, blobPath: "blobs/fusion-reference.png",
    }, "fusion-ref");
    classifyReference(db, conversation.id, {
      referenceId: "fusion-ref", status: "active", purpose: "Bracket drawing", relationships: [],
      rationale: "Defines the requested Fusion part.", specificationIds: [],
      noSpecificationReason: "Fusion references are verified against native inspection sheets without durable source specifications.",
    });
    db.prepare(`INSERT INTO fusion_inspections
      (id, conversation_id, revision, snapshot_json, checks_json, screenshots_json, camera_restored, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("fusion-inspection", conversation.id, "fusion-revision", "{}", "[]", "[]", 1, 1);
    db.prepare("INSERT INTO artifacts (id, conversation_id, version, py_source, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("fusion-inspection", conversation.id, 1, "fusion-revision:fusion-revision", 1);
    // The finished design's last mutation carried no sheet - previously a dead end.
    createMessage(db, conversation.id, {
      id: "fusion-action", seq: 1, role: "toolResult", contentJson: JSON.stringify({
        role: "toolResult", toolName: "execute_cad_change", isError: false,
        details: { status: "completed" },
      }),
    });
    createMessage(db, conversation.id, {
      id: "fusion-visual-read", seq: 2, role: "toolResult", contentJson: JSON.stringify({
        role: "toolResult", toolName: "inspect_fusion", isError: false,
        details: { mutated: false, revision: "fusion-revision", inspectionId: "fusion-inspection", viewSheet: true,
          visualArtifact: { artifactId: "fusion-inspection", artifactVersion: 1, revision: "fusion-revision",
            inspectionSheet: { attachmentId: "fusion-sheet" } },
          visualComparison: {
            evidenceId: FUSION_COMPARISON_ID,
            candidate: { artifactId: "fusion-inspection", artifactVersion: 1, inspectionSheetId: "fusion-sheet" },
          } },
      }),
    });
    createAttachment(db, "fusion-visual-read", "view-sheet", {
      mime: "image/png", contentHash: "v".repeat(64), byteSize: 1, blobPath: "blobs/fusion-sheet.png",
    }, "fusion-sheet");
    recordComparison(db, conversation.id, FUSION_COMPARISON_ID, {
      artifactId: "fusion-inspection", artifactVersion: 1, inspectionSheetId: "fusion-sheet",
    });

    expect(recordVisualVerificationBatch(db, conversation.id, {
      artifactId: "fusion-inspection", artifactVersion: 1, inspectionSheetId: "fusion-sheet",
      visualComparisonEvidenceId: FUSION_COMPARISON_ID,
      imageLimit: 3, activeReferenceIds: ["fusion-ref"], batchIndex: 0, batchCount: 1,
      coveredReferenceIds: ["fusion-ref"],
      observations: [{ referenceId: "fusion-ref", relevantViews: ["front", "top", "right"], findings: ["Matches."], affectedComponents: [] }],
      finalVerdict: "match", synthesis: "The Fusion bracket matches the active reference.",
    } satisfies RecordVisualVerificationBatchInput)).toMatchObject({ finalVerification: {
      artifactId: "fusion-inspection", artifactVersion: 1, inspectionSheetId: "fusion-sheet", verdict: "match",
    } });
  });

  it("replays a keyed final batch with the same final verdict and rejects changed reuse", () => {
    const { db, conversation } = fixture();
    retireReference(db, conversation.id, "ref-b");
    const input = {
      artifactId: "artifact-2", artifactVersion: 2, inspectionSheetId: "sheet-2", imageLimit: 3,
      visualComparisonEvidenceId: BUILD_COMPARISON_ID,
      activeReferenceIds: ["ref-a"], batchIndex: 0, batchCount: 1, coveredReferenceIds: ["ref-a"],
      observations: [{ referenceId: "ref-a", relevantViews: ["front"], findings: ["Matches."], affectedComponents: [] }],
      finalVerdict: "match" as const, synthesis: "The active reference matches.",
    };
    const first = recordVisualVerificationBatch(db, conversation.id, input, "batch-call-1");
    expect(recordVisualVerificationBatch(db, conversation.id, input, "batch-call-1")).toEqual(first);
    expect(listVisualVerificationBatches(db, conversation.id)).toHaveLength(1);
    expect(listVisualVerifications(db, conversation.id)).toHaveLength(1);
    expect(() => recordVisualVerificationBatch(db, conversation.id, { ...input, synthesis: "Changed." }, "batch-call-1"))
      .toThrow(/idempotency key conflicts/);
  });

  it("replays a keyed direct visual verdict and rejects changed reuse", () => {
    const { db, conversation, input } = fixture();
    retireReference(db, conversation.id, "ref-a");
    retireReference(db, conversation.id, "ref-b");
    const direct = { ...input, coveredReferenceIds: [], observations: [] };
    const first = recordVisualVerification(db, conversation.id, direct, "visual-call-1");
    expect(recordVisualVerification(db, conversation.id, direct, "visual-call-1")).toEqual(first);
    expect(() => recordVisualVerification(db, conversation.id, { ...direct, verdict: "needs-revision" }, "visual-call-1"))
      .toThrow(/idempotency key conflicts/);
  });

  it.each([
    ["missing first batch", () => batchInput(1), /expected batch 0/],
    ["premature synthesis", () => ({ ...batchInput(0), finalVerdict: "match" as const, synthesis: "Too early." }), /final.*last batch/],
  ])("rejects %s", (_label, make, pattern) => {
    const { db, conversation } = fixture();
    expect(() => recordVisualVerificationBatch(db, conversation.id, make())).toThrow(pattern);
  });

  it("rejects duplicate coverage", () => {
    const { db, conversation } = fixture();
    recordVisualVerificationBatch(db, conversation.id, batchInput(0));
    expect(() => recordVisualVerificationBatch(db, conversation.id, {
      ...batchInput(1), coveredReferenceIds: ["ref-a"], observations: batchInput(0).observations,
    })).toThrow(/coverage/);
    expect(listVisualVerificationBatches(db, conversation.id)).toHaveLength(1);
    expect(() => recordVisualVerificationBatch(db, conversation.id, {
      ...batchInput(1), finalVerdict: "match", synthesis: "Both references match.",
    })).not.toThrow();
  });

  it("rejects a model-selected subset that differs from the deterministic partition", () => {
    const { db, conversation } = fixture();
    expect(() => recordVisualVerificationBatch(db, conversation.id, {
      ...batchInput(0), coveredReferenceIds: ["ref-b"], observations: batchInput(1).observations,
    })).toThrow(/deterministic batch/);
  });

  it("rejects stale identity and a changed active set after progress", () => {
    const { db, conversation } = fixture();
    recordVisualVerificationBatch(db, conversation.id, batchInput(0));
    expect(() => recordVisualVerificationBatch(db, conversation.id, {
      ...batchInput(1), inspectionSheetId: "ref-a",
    })).toThrow(/current inspection sheet/);
    expect(() => recordVisualVerificationBatch(db, conversation.id, {
      ...batchInput(1), activeReferenceIds: ["ref-a"],
    })).toThrow(/active reference set/);
  });
});
