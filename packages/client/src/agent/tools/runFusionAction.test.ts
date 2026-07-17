import { describe, expect, it, vi } from "vitest";
import type { FusionActionRequestDto, FusionActionResultDto } from "@chamfer/shared";
import { createRunFusionActionTool, destructiveAuthorityFromMessages, reconciliationAuthorityFromMessages } from "./runFusionAction";

describe("run_fusion_action", () => {
  it("injects action, model, and reviewed skill identity around the model-authored action contract", async () => {
    const result = { actionId: "call-1", status: "completed", document: { id: "doc-1", name: "Cube" }, precedingRevision: "rev-0", finalRevision: "rev-1", undoEntries: 1, ledgerRecordIds: ["ledger-1"], inspection: {} } as unknown as FusionActionResultDto;
    const execute = vi.fn().mockResolvedValue(result);
    const skills = { foundation: { name: "fusion-foundation", version: "1.0.0" }, loaded: [{ name: "fusion-parametric-features", version: "1.0.0" }] };
    const tool = createRunFusionActionTool({ execute, model: { provider: "openai", model: "gpt-5" }, skillAttribution: () => skills,
      inspectionIdentity: () => ({ inspectionId: "inspection-1", revision: "rev-0" }), destructiveAuthority: () => undefined,
      reconciliationAuthority: () => undefined });

    const output = await tool.execute("call-1", {
      document: { id: "doc-1", name: "Cube" }, expectedRevision: "rev-0", intent: "Create cube",
      strategy: "targeted",
      body: "root.name = 'Cube'", affectedReferences: [], expectedEffects: [{ kind: "body-count", expected: 1 }],
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ actionId: "call-1", expectedEvidenceId: "inspection-1", model: { provider: "openai", model: "gpt-5" }, skills } satisfies Partial<FusionActionRequestDto>), undefined);
    expect(output.details).toMatchObject({ mutated: true, status: "completed", finalRevision: "rev-1", undoEntries: 1 });
    expect(JSON.stringify(output.content)).not.toContain("data:image/png");
    expect(JSON.stringify(output.content)).not.toContain("127.0.0.1");
  });

  it("keeps a completed mutation authoritative when inspection-sheet rendering fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("decode unavailable")));
    const result = {
      actionId: "call-sheet", status: "completed", document: { id: "doc-1", name: "Bracket" },
      precedingRevision: "rev-0", finalRevision: "rev-1", undoEntries: 1, ledgerRecordIds: ["ledger-1"],
      visualArtifact: { artifactId: "inspection-1", artifactVersion: 1 },
      inspection: { current: { screenshots: [{ view: "front", dataUrl: "data:image/png;base64,cG5n" }] } },
    } as unknown as FusionActionResultDto;
    const tool = createRunFusionActionTool({ execute: vi.fn().mockResolvedValue(result), model: { provider: "openai", model: "gpt-5" },
      skillAttribution: () => ({ foundation: { name: "fusion-foundation", version: "1" }, loaded: [] }),
      inspectionIdentity: () => ({ inspectionId: "inspection-0", revision: "rev-0" }), destructiveAuthority: () => undefined,
      reconciliationAuthority: () => undefined });

    const output = await tool.execute("call-sheet", { document: result.document, expectedRevision: "rev-0", intent: "Build bracket",
      strategy: "targeted", body: "root.name = 'Bracket'", affectedReferences: [], expectedEffects: [{ kind: "body-count", expected: 1 }] });

    expect(output.details).toMatchObject({ mutated: true, status: "completed", finalRevision: "rev-1" });
    expect(output.details.visualArtifact).toBeUndefined();
    expect(JSON.stringify(output.content)).toContain("recapture current evidence read-only with inspect_fusion");
    vi.unstubAllGlobals();
  });

  it("does not emit an unbound view sheet when completed artifact persistence is unavailable", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = {
      actionId: "call-no-artifact", status: "completed", document: { id: "doc-1", name: "Bracket" },
      precedingRevision: "rev-0", finalRevision: "rev-1", undoEntries: 1, ledgerRecordIds: ["ledger-1"],
      inspection: { current: { screenshots: [{ view: "front", dataUrl: "data:image/png;base64,cG5n" }] } },
    } as unknown as FusionActionResultDto;
    const tool = createRunFusionActionTool({ execute: vi.fn().mockResolvedValue(result), model: { provider: "openai", model: "gpt-5" },
      skillAttribution: () => ({ foundation: { name: "fusion-foundation", version: "1" }, loaded: [] }),
      inspectionIdentity: () => ({ inspectionId: "inspection-0", revision: "rev-0" }), destructiveAuthority: () => undefined,
      reconciliationAuthority: () => undefined });

    const output = await tool.execute("call-no-artifact", { document: result.document, expectedRevision: "rev-0", intent: "Build bracket",
      strategy: "targeted", body: "root.name = 'Bracket'", affectedReferences: [], expectedEffects: [{ kind: "body-count", expected: 1 }] });

    expect(fetch).not.toHaveBeenCalled();
    expect(output.content).toHaveLength(1);
    expect(output.details.visualArtifact).toBeUndefined();
    expect(JSON.stringify(output.content)).toContain("revision-bound visual persistence is unavailable");
    vi.unstubAllGlobals();
  });

  it("derives destructive authority only from a persisted explicit user request", () => {
    const approved = { role: "user", content: [{ type: "text", text: "REQUEST FUSION REBUILD: Replace the existing design" }] };
    const preserving = { role: "user", content: [{ type: "text", text: "Change the width without rebuilding anything else." }] };
    const question = { role: "user", content: [{ type: "text", text: "Could a rebuild help?" }] };
    const explanation = { role: "user", content: [{ type: "text", text: "Please explain how to rebuild the model." }] };
    const confirmed = { role: "user", content: [{ type: "text", text: "CONFIRM FUSION REBUILD rev-0: Replace the bracket" }] };
    expect(destructiveAuthorityFromMessages([approved], (message) => message === approved ? "message-1" : undefined, "rev-0", "Replace the existing design"))
      .toMatchObject({ basis: "original-replacement-request", evidenceMessageId: "message-1", statement: expect.stringContaining("REQUEST") });
    expect(destructiveAuthorityFromMessages([preserving], () => "message-2")).toBeUndefined();
    expect(destructiveAuthorityFromMessages([approved, preserving], () => "message")).toBeUndefined();
    expect(destructiveAuthorityFromMessages([question], () => "message-3")).toBeUndefined();
    expect(destructiveAuthorityFromMessages([explanation], () => "message-4")).toBeUndefined();
    expect(destructiveAuthorityFromMessages([{ role: "user", content: [{ type: "text", text: "Rebuild the model is the title of the help topic." }] }], () => "message-6", "rev-0", "Rebuild the model"))
      .toBeUndefined();
    expect(destructiveAuthorityFromMessages([confirmed], () => "message-5", "rev-0", "Replace the bracket"))
      .toMatchObject({ basis: "explicit-approval", evidenceMessageId: "message-5" });
    expect(destructiveAuthorityFromMessages([confirmed], () => "message-5", "rev-other", "Replace the bracket")).toBeUndefined();
  });

  it("derives reconciliation authority only from an exact revision-scoped confirmation", () => {
    const references = [{ kind: "parameter" as const, id: "width" }];
    const confirmed = { role: "user", content: [{ type: "text", text: "CONFIRM FUSION RECONCILIATION rec-1 AT rev-0 REFERENCES parameter:width: Adjust width to 20 mm" }] };
    const question = { role: "user", content: [{ type: "text", text: "What changed?" }] };
    expect(reconciliationAuthorityFromMessages([confirmed], () => "message-1", "rev-0", "Adjust width to 20 mm", references))
      .toEqual({ reconciliationId: "rec-1", evidenceMessageId: "message-1", statement: expect.stringContaining("rec-1") });
    expect(reconciliationAuthorityFromMessages([confirmed], () => "message-1", "rev-1", "Adjust width to 20 mm", references)).toBeUndefined();
    expect(reconciliationAuthorityFromMessages([confirmed], () => "message-1", "rev-0", "Adjust width to 20 mm", [])).toBeUndefined();
    expect(reconciliationAuthorityFromMessages([question], () => "message-2", "rev-0", "Adjust width to 20 mm", references)).toBeUndefined();
  });
});
