import { describe, expect, it } from "vitest";
import type { VisualVerificationRecordDto } from "@chamfer/shared";
import { currentVisualEvidence, currentVisualVerification, latestVisualVerification, validateVisualFinalization } from "./visualVerification";

const currentEvidence = {
  conversationId: "conversation-a",
  artifactId: "artifact-2",
  artifactVersion: 2,
  inspectionSheetId: "sheet-2",
  activeReferenceIds: ["ref-a", "ref-b"],
};

const accepted: VisualVerificationRecordDto = {
  id: "verification-1",
  conversationId: "conversation-a",
  artifactId: "artifact-2",
  artifactVersion: 2,
  inspectionSheetId: "sheet-2",
  coveredReferenceIds: ["ref-a", "ref-b"],
  verdict: "match",
  observations: [
    { referenceId: "ref-a", relevantViews: ["front"], findings: ["Profile matches."], affectedComponents: [] },
    { referenceId: "ref-b", relevantViews: ["top"], findings: ["Hole layout matches."], affectedComponents: [] },
  ],
  recordedAt: 10,
};

describe("visual finalization validation", () => {
  const rejectedCases: Array<[string, VisualVerificationRecordDto | undefined, string]> = [
    ["missing", undefined, "missing-verification"],
    ["cross-conversation", { ...accepted, conversationId: "conversation-b" }, "ownership-mismatch"],
    ["stale artifact identity", { ...accepted, artifactId: "artifact-1" }, "stale-artifact"],
    ["stale artifact version", { ...accepted, artifactVersion: 1 }, "stale-artifact"],
    ["stale sheet", { ...accepted, inspectionSheetId: "sheet-1" }, "stale-sheet"],
    ["incomplete coverage", { ...accepted, coveredReferenceIds: ["ref-a"], observations: accepted.observations.slice(0, 1) }, "incomplete-coverage"],
    ["needs revision", { ...accepted, verdict: "needs-revision" }, "needs-revision"],
  ];
  it.each(rejectedCases)("rejects %s evidence", (_label, record, reason) => {
    expect(validateVisualFinalization(currentEvidence, record)).toMatchObject({ ok: false, reason });
  });

  it("names uncovered references and stale evidence in one recovery nudge", () => {
    const result = validateVisualFinalization(currentEvidence, {
      ...accepted,
      artifactId: "artifact-1",
      artifactVersion: 1,
      inspectionSheetId: "sheet-1",
      coveredReferenceIds: ["ref-a"],
      observations: accepted.observations.slice(0, 1),
    });
    expect(result).toMatchObject({ ok: false, reason: "stale-artifact" });
    if (result.ok) throw new Error("expected rejection");
    expect(result.nudge).toContain("ref-b");
    expect(result.nudge).toContain("artifact-1");
    expect(result.nudge).toContain("sheet-1");
  });

  it("accepts exact current evidence", () => {
    expect(validateVisualFinalization(currentEvidence, accepted)).toEqual({ ok: true });
  });

  it("preserves text-only finalization without a visual record", () => {
    expect(validateVisualFinalization({ ...currentEvidence, activeReferenceIds: [] }, undefined)).toEqual({ ok: true });
  });

  it("selects only the latest accepted visual-verification tool result", () => {
    expect(latestVisualVerification([
      { role: "toolResult", toolName: "record_visual_verification", isError: false, details: accepted },
      { role: "toolResult", toolName: "record_visual_verification", isError: true, details: { ...accepted, verdict: "needs-revision" } },
    ])).toBe(accepted);
  });

  it("invalidates an older passing sheet when a newer artifact-producing run fails", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "run_build123d",
        isError: false,
        details: {
          inspectionSheet: {
            attachmentId: "sheet-2",
            code: { artifactId: "artifact-2", artifactVersion: 2 },
            gate: { status: "passed" },
          },
        },
      },
      {
        role: "toolResult",
        toolName: "run_build123d",
        isError: true,
        details: {
          code: { artifactId: "artifact-3", artifactVersion: 3 },
          gate: { status: "failed" },
        },
      },
    ];

    expect(currentVisualEvidence("conversation-a", messages as never[], [])).toBeUndefined();
  });

  it("shows a visual verdict only when it matches the newest passing artifact and sheet", () => {
    const currentRun = {
      role: "toolResult",
      toolName: "run_build123d",
      isError: false,
      details: {
        inspectionSheet: {
          attachmentId: "sheet-2",
          code: { artifactId: "artifact-2", artifactVersion: 2 },
          gate: { status: "passed" },
        },
      },
    };
    const verification = {
      role: "toolResult",
      toolName: "record_visual_verification",
      isError: false,
      details: accepted,
    };

    expect(currentVisualVerification([currentRun, verification])).toBe(accepted);
    expect(currentVisualVerification([
      currentRun,
      verification,
      {
        role: "toolResult",
        toolName: "run_build123d",
        isError: false,
        details: {
          inspectionSheet: {
            attachmentId: "sheet-3",
            code: { artifactId: "artifact-3", artifactVersion: 3 },
            gate: { status: "passed" },
          },
        },
      },
    ])).toBeUndefined();
  });

  it("hides a matching artifact verdict when the active reference set has changed", () => {
    const currentRun = {
      role: "toolResult",
      toolName: "run_build123d",
      isError: false,
      details: {
        inspectionSheet: {
          attachmentId: "sheet-2",
          code: { artifactId: "artifact-2", artifactVersion: 2 },
          gate: { status: "passed" },
        },
      },
    };
    const verification = {
      role: "toolResult",
      toolName: "record_visual_verification",
      isError: false,
      details: accepted,
    };
    const references = [
      { referenceId: "ref-a", status: "active" },
      { referenceId: "ref-b", status: "complementary" },
      { referenceId: "ref-c", status: "active" },
    ];

    expect(currentVisualVerification([currentRun, verification], references as never[])).toBeUndefined();
  });
});
