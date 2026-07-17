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
      "source_specification_mutations",
      "source_specifications",
      "source_specification_supersessions",
      "design_escalations",
      "reference_registrations",
      "proof_contracts",
    ]) {
      expect(names).toContain(t);
    }
  });
});
