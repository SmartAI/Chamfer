import { describe, expect, it } from "vitest";
import type { ConversationDto } from "@chamfer/shared";
import { openDb } from "./db";
import { fakeLlm } from "./fakeLlm";
import { createConversation } from "./conversationStore";
import { createOnlineApp } from "../../online/src/onlineApp";
import { stubBlobStore, stubOnlineHosting } from "./onlineTestSupport";

// Regression guard for the hosted sidebar dot: online, a build123d conversation
// emits no gate verdict, so a produced model (`hasArtifact`) is its only success
// signal. The dot turned green live off the artifact_updated event but reverted
// to a hollow "no run yet" ring on reload because createOnlineApp mounted the
// conversation list WITHOUT a hasArtifact source. These tests pin the list to
// the hosted artifact store so the green dot survives a refresh.

async function listConversationsVia(app: ReturnType<typeof createOnlineApp>): Promise<ConversationDto[]> {
  return (await (await app.request("/api/conversations")).json()) as ConversationDto[];
}

describe("online conversation status dot", () => {
  it("reports hasArtifact in the list for a conversation with a hosted model", async () => {
    const db = openDb(":memory:");
    const produced = createConversation(db, "Rectangular Mounting Plate");
    const empty = createConversation(db, "Cylindrical Spacer");
    const online = createOnlineApp(db, fakeLlm(), stubBlobStore, {
      agent: stubOnlineHosting(new Set([produced.id])),
    });

    const list = await listConversationsVia(online);
    // The produced conversation flips the sidebar dot green on reload...
    expect(list.find((c) => c.id === produced.id)?.hasArtifact).toBe(true);
    // ...while one with no export stays neutral, not falsely verified.
    expect(list.find((c) => c.id === empty.id)?.hasArtifact).toBeUndefined();
  });

  it("leaves hasArtifact absent when hosting is not configured", async () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Rectangular Mounting Plate");
    const online = createOnlineApp(db, fakeLlm(), stubBlobStore);

    const list = await listConversationsVia(online);
    // No hosting means no artifacts are ever produced online, so the field must
    // stay absent rather than default to a misleading verdict.
    expect(list.find((c) => c.id === conversation.id)?.hasArtifact).toBeUndefined();
  });
});
