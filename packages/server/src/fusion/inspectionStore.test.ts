import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { createConversation } from "../conversationStore";
import { ensureFusionVisualArtifact } from "./inspectionStore";

describe("ensureFusionVisualArtifact", () => {
  it("mints one artifact per inspection id and reuses it on re-registration", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Fusion artifacts", "fusion");

    const first = ensureFusionVisualArtifact(db, conversation.id, "inspection-1", "revision-1");
    expect(first).toEqual({ artifactId: "inspection-1", artifactVersion: 1 });
    // A same-revision re-inspection keeps its inspection id; registration must
    // return the existing identity instead of failing on the primary key.
    expect(ensureFusionVisualArtifact(db, conversation.id, "inspection-1", "revision-1")).toEqual(first);

    const second = ensureFusionVisualArtifact(db, conversation.id, "inspection-2", "revision-2");
    expect(second).toEqual({ artifactId: "inspection-2", artifactVersion: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE conversation_id = ?").get(conversation.id))
      .toEqual({ count: 2 });
  });
});
