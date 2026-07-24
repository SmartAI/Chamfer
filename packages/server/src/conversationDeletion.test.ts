import { describe, expect, it } from "vitest";
import type { ImageBlobStore } from "./imageBlobStore";
import { openDb } from "./db";
import { createConversation } from "./conversationStore";
import { deleteConversationWithAttachments } from "./conversationDeletion";
import { ConversationEventStore } from "./conversationEventStore";
import { projectEvidence } from "./evidenceStore";

const unusedBlobStore: ImageBlobStore = {
  write: async () => { throw new Error("unused"); },
  read: async () => { throw new Error("unused"); },
  remove: () => {},
  maintain: () => ({ fileSystemBefore: [], fileSystemAfter: [], removed: [], failed: [] }),
};

describe("conversation deletion", () => {
  it("evicts both projections when an event stream identity is deleted", async () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Before deletion");
    const events = new ConversationEventStore(db);
    expect(events.project(conversation.id).conversation?.title).toBe("Before deletion");
    expect(projectEvidence(db, conversation.id).events).toEqual([]);

    await deleteConversationWithAttachments(db, unusedBlobStore, conversation.id);
    events.append(conversation.id, {
      type: "conversation.created",
      data: {
        title: "After deletion",
        cadEnvironment: "build123d",
        designId: null,
        sourceSpecificationsRequired: true,
      },
    });

    expect(events.project(conversation.id).conversation?.title).toBe("After deletion");
    expect(projectEvidence(db, conversation.id).events).toEqual([]);
  });
});
