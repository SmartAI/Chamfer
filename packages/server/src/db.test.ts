import { describe, expect, it } from "vitest";
import { openDb } from "./db";

describe("db", () => {
  it("creates all tables in memory", () => {
    const db = openDb(":memory:");
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    for (const t of [
      "conversations",
      "messages",
      "attachments",
      "artifacts",
      "settings",
      "evidence_events",
      "evidence_deletion_authorizations",
      "headless_runs",
      "cad_gate_evidence",
      "designs",
      "design_revisions",
      "design_revision_gate_evidence",
    ]) {
      expect(names).toContain(t);
    }
    for (const legacy of [
      "source_specification_mutations",
      "source_specifications",
      "design_escalations",
      "reference_registrations",
      "proof_contracts",
    ]) {
      expect(names).not.toContain(legacy);
    }
  });
});
