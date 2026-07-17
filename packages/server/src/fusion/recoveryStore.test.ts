import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { appendFusionRecovery, currentFusionRecovery, releaseFusionRecoveriesOwnedByConversation } from "./recoveryStore";

describe("Fusion recovery ledger", () => {
  it("keeps transitions immutable and returns only unresolved endpoint state", () => {
    const db = openDb(":memory:");
    const base = { conversationId: "conversation-1", endpoint: "http://127.0.0.1:27182/mcp", actionId: "secret-action",
      failureClass: "disconnect" as const, precedingRevision: "rev-before" };
    appendFusionRecovery(db, { ...base, state: "diagnosing", diagnosis: "Inspecting after disconnect.",
      allowedOperation: "wait-for-trusted-inspection" }, 1);
    expect(currentFusionRecovery(db, base.endpoint)).toMatchObject({ state: "diagnosing", failureClass: "disconnect" });
    appendFusionRecovery(db, { ...base, state: "resolved", diagnosis: "Trusted inspection proved no document change.",
      allowedOperation: "none", observedRevision: "rev-before" }, 2);
    expect(currentFusionRecovery(db, base.endpoint)).toBeUndefined();
    expect(() => db.prepare("DELETE FROM fusion_recovery_ledger").run()).toThrow(/immutable/);
    expect(JSON.stringify(db.prepare("SELECT action_id FROM fusion_recovery_ledger LIMIT 1").get())).not.toContain("secret-action");
  });

  it("releases an unresolved recovery owned by a deleted conversation without touching history", () => {
    const db = openDb(":memory:");
    appendFusionRecovery(db, { conversationId: "conversation-1", endpoint: "http://127.0.0.1:27182/mcp", actionId: "action-1",
      state: "hard-recovery", failureClass: "revision-uncertain", diagnosis: "Undo could not restore the fingerprint.",
      allowedOperation: "inspect-resulting-state", precedingRevision: "rev-before" }, 1);
    releaseFusionRecoveriesOwnedByConversation(db, "conversation-1", 2);
    expect(currentFusionRecovery(db, "http://127.0.0.1:27182/mcp")).toBeUndefined();
    const rows = db.prepare("SELECT state FROM fusion_recovery_ledger ORDER BY recorded_at").all() as Array<{ state: string }>;
    expect(rows.map((row) => row.state)).toEqual(["hard-recovery", "resolved"]);
  });

  it("does not release an unresolved recovery owned by another conversation", () => {
    const db = openDb(":memory:");
    appendFusionRecovery(db, { conversationId: "conversation-1", endpoint: "http://127.0.0.1:27182/mcp", actionId: "action-1",
      state: "resolved", failureClass: "disconnect", diagnosis: "Resolved earlier.", allowedOperation: "none",
      precedingRevision: "rev-a" }, 1);
    appendFusionRecovery(db, { conversationId: "conversation-2", endpoint: "http://127.0.0.1:27182/mcp", actionId: "action-2",
      state: "hard-recovery", failureClass: "undo-failure", diagnosis: "Undo failed.",
      allowedOperation: "inspect-resulting-state", precedingRevision: "rev-b" }, 2);
    releaseFusionRecoveriesOwnedByConversation(db, "conversation-1", 3);
    expect(currentFusionRecovery(db, "http://127.0.0.1:27182/mcp")).toMatchObject({
      conversationId: "conversation-2", state: "hard-recovery",
    });
  });
});
