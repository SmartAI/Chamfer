import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FusionActionLedgerRecordDto, FusionDocumentBindingDto, FusionReadinessDto } from "@chamfer/shared";
import { FusionDocumentStrip } from "./FusionDocumentStrip";

const binding: FusionDocumentBindingDto = {
  conversationId: "conversation-1",
  endpoint: "http://127.0.0.1:27182/mcp",
  document: { id: "creation-1", name: "Bracket", dataFileId: "data-1" },
  identityKind: "durable",
  role: "owner",
  resumable: true,
  boundAt: 1,
  updatedAt: 1,
};

const readiness: FusionReadinessDto = {
  state: "ready",
  label: "Ready",
  diagnosis: "Fusion is ready.",
  endpoint: binding.endpoint,
  checkedAt: "2026-07-14T12:00:00.000Z",
  document: binding.document,
  binding,
  mutationAllowed: false,
};

const revision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function completedAction(document: FusionDocumentBindingDto["document"]): FusionActionLedgerRecordDto {
  return {
    id: "ledger-1", conversationId: binding.conversationId, actionId: "action-1", event: "completed", recordedAt: 3,
    document, expectedRevision: "aaaaaaaa", observedRevision: revision, finalRevision: revision,
    model: { provider: "openai", model: "gpt-5" },
    skills: { foundation: { name: "fusion-foundation", version: "1.0.0" }, loaded: [] }, policyVersion: "fusion-python-v1",
    intent: "Create verified bracket", bodySha256: "abc", affectedReferences: [], expectedEffects: [],
    result: { status: "completed", checks: [{ kind: "body-count", status: "passed" }] }, evidenceIds: ["inspection-2"],
  };
}

describe("FusionDocumentStrip", () => {
  it("shows the bound document identity, role, and revision", () => {
    render(<FusionDocumentStrip
      readiness={readiness}
      binding={{ ...binding, document: { ...binding.document, versionNumber: 1, versionId: "fake-version-1" } }}
      revision={revision}
    />);

    expect(screen.getByTestId("fusion-bound-document").textContent).toContain("Bracket");
    expect(screen.getByTestId("fusion-ownership-role").textContent).toBe("Owner");
    expect(screen.getByTestId("fusion-identity-kind").textContent).toBe("Saved Fusion document");
    expect(screen.getByTestId("fusion-resumability").textContent).toBe("Resumable");
    expect(screen.getByTestId("fusion-saved-version").textContent).toContain("Fusion version 1");
    expect(screen.getByTestId("fusion-saved-version").textContent).toContain("fake-version-1");
    expect(screen.getByTestId("fusion-revision").textContent).toContain("bbbbbbbbbbbb");
    expect(screen.queryByTestId("viewer")).toBeNull();
  });

  it("prominently separates verified unsaved work and requires an explicit Save click", () => {
    const provisional = { ...binding, document: { id: "creation-1", name: "Unsaved Bracket" }, identityKind: "provisional" as const };
    const onSave = vi.fn();

    render(<FusionDocumentStrip readiness={{ ...readiness, binding: provisional }} binding={provisional}
      revision={revision} latestAction={completedAction(provisional.document)} onSave={onSave} />);

    expect(screen.getByRole("status", { name: "Verified unsaved Fusion work" }).textContent)
      .toContain("Verified, not saved");
    fireEvent.click(screen.getByRole("button", { name: "Save verified Fusion document" }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("does not offer Save for unverified, durable-clean, or read-only work", () => {
    const provisional = { ...binding, document: { id: "creation-1", name: "Unsaved" }, identityKind: "provisional" as const };
    const { rerender } = render(<FusionDocumentStrip readiness={readiness} binding={provisional}
      revision={revision} onSave={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Save verified Fusion document" })).toBeNull();

    rerender(<FusionDocumentStrip readiness={readiness} binding={binding}
      revision={revision} latestAction={completedAction(binding.document)} onSave={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Save verified Fusion document" })).toBeNull();

    rerender(<FusionDocumentStrip readiness={readiness} binding={{ ...provisional, role: "read-only" }}
      revision={revision} latestAction={completedAction(provisional.document)} onSave={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Save verified Fusion document" })).toBeNull();
  });

  it("offers Save for verified modifications to an already durable document", () => {
    render(<FusionDocumentStrip readiness={{ ...readiness, documentModified: true }} binding={binding}
      revision={revision} latestAction={completedAction(binding.document)} onSave={() => undefined} />);
    expect(screen.getByRole("button", { name: "Save verified Fusion document" })).not.toBeNull();
  });

  it("offers ownership transfer only to a resumable read-only conversation", () => {
    const readOnly = { ...binding, role: "read-only" as const };
    const onTransfer = vi.fn();
    const { rerender } = render(<FusionDocumentStrip readiness={readiness} binding={readOnly} onTransfer={onTransfer} />);
    fireEvent.click(screen.getByRole("button", { name: "Transfer ownership to this conversation" }));
    expect(onTransfer).toHaveBeenCalledOnce();

    rerender(<FusionDocumentStrip readiness={readiness} binding={{ ...readOnly, resumable: false }} onTransfer={onTransfer} />);
    expect(screen.queryByRole("button", { name: "Transfer ownership to this conversation" })).toBeNull();
  });

  it("shows reconciliation outcomes for manual Fusion edits", () => {
    render(<FusionDocumentStrip readiness={readiness} binding={binding} reconciliation={{
      id: "reconciliation-1", conversationId: binding.conversationId, recordedAt: 3, document: binding.document,
      precedingRevision: "aaaaaaaa", observedRevision: revision, status: "reconciled",
      reason: "unambiguous-manual-edit", summary: "modified parameter width (expression, valueMm)",
      changes: [{ kind: "parameter", entityId: "width", name: "width", change: "modified", fields: ["expression", "valueMm"] }],
      refreshedReferences: [{ id: "width", kind: "parameter", nativeToken: "width-current", semanticDescriptor: "parameter:width" }],
      refreshedChecks: [{ kind: "body-count", status: "passed", detail: "Expected 1 bodies; found 1." }],
      evidenceId: "inspection-2",
    }} />);
    expect(screen.getByTestId("fusion-reconciliation").textContent).toContain("Manual edit reconciled");
    expect(screen.getByTestId("fusion-reconciliation").textContent).toContain("modified parameter width");
    expect(screen.getByTestId("fusion-reconciliation").getAttribute("data-status")).toBe("reconciled");
  });

  it("shows exception-based escalation for ambiguous manual edits", () => {
    render(<FusionDocumentStrip readiness={readiness} binding={binding} reconciliation={{
      id: "reconciliation-2", conversationId: binding.conversationId, recordedAt: 3, document: binding.document,
      precedingRevision: "aaaaaaaa", observedRevision: revision, status: "needs-user",
      reason: "ambiguous-entity-identity", summary: "A feature identity resolves more than once.", changes: [],
      refreshedReferences: [], refreshedChecks: [], evidenceId: "inspection-2",
    }} />);
    expect(screen.getByTestId("fusion-reconciliation").textContent).toContain("User direction required");
    expect(screen.getByTestId("fusion-reconciliation").getAttribute("data-status")).toBe("needs-user");
  });

  it("shows concise recovery diagnosis and the only allowed operation", () => {
    const recovery = {
      id: "recovery-1", conversationId: binding.conversationId, state: "hard-recovery" as const,
      failureClass: "revision-uncertain" as const,
      diagnosis: "Trusted inspection found a different engineering revision after interruption.",
      allowedOperation: "inspect-resulting-state" as const, precedingRevision: "aaaaaaaa",
      observedRevision: revision, evidenceIds: ["inspection-2"], recordedAt: 4,
    };
    render(<FusionDocumentStrip readiness={{ ...readiness, state: "degraded", label: "Recovery required",
      diagnosis: recovery.diagnosis, mutationAllowed: false, recovery }} binding={binding}
      revision={revision} latestAction={completedAction(binding.document)}
      onSave={() => undefined} onTransfer={() => undefined} onInspect={() => undefined} />);
    expect(screen.getByTestId("fusion-recovery").textContent).toContain("Recovery required");
    expect(screen.getByTestId("fusion-recovery").textContent).toContain(recovery.diagnosis);
    expect(screen.getByTestId("fusion-recovery").textContent).toContain("Inspect the resulting engineering state");
    expect(screen.queryByRole("button", { name: "Save verified Fusion document" })).toBeNull();
    expect(screen.queryByText("Transfer ownership to this conversation")).toBeNull();
  });

  it("separates camera degradation from unchanged engineering state and offers an inspect retry", () => {
    const onInspect = vi.fn();
    render(<FusionDocumentStrip readiness={{ ...readiness, state: "degraded", label: "Degraded",
      diagnosis: "Fusion did not restore the exact prior camera; modeling remains blocked.",
      mutationAllowed: false, cameraRestored: false }} binding={binding} onInspect={onInspect} />);
    expect(screen.getByTestId("fusion-camera-recovery").textContent).toContain("Engineering state is unchanged");
    expect(screen.getByTestId("fusion-camera-recovery").textContent).toContain("restore the camera in Fusion, then inspect again");
    fireEvent.click(screen.getByRole("button", { name: "Inspect Fusion document" }));
    expect(onInspect).toHaveBeenCalledOnce();
  });

  it("surfaces save and transfer failures as alerts", () => {
    render(<FusionDocumentStrip readiness={readiness} binding={binding} saveError="Fusion Save was canceled." />);
    expect(screen.getByRole("alert").textContent).toContain("Fusion Save was canceled.");
  });
});
