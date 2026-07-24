import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ConversationEventStore } from "./conversationEventStore";
import { initializeSchema } from "./db";
import { replayThenLive } from "./replayThenLive";

describe("replayThenLive", () => {
  it("unsubscribes immediately when a disconnected transport has a blocked write", async () => {
    const db = new DatabaseSync(":memory:");
    initializeSchema(db);
    const store = new ConversationEventStore(db);
    const connection = replayThenLive({
      after: 0,
      sequence: (event: { sequence: number }) => event.sequence,
      replay: () => [],
      subscribe: (listener) => store.subscribe("conversation-1", listener),
      write: () => new Promise<void>(() => {}),
    });

    expect(store.subscriberCount("conversation-1")).toBe(1);
    store.append("conversation-1", {
      type: "conversation.created",
      data: {
        title: "Streaming",
        cadEnvironment: "build123d",
        designId: null,
        sourceSpecificationsRequired: true,
      },
    });
    await Promise.resolve();
    void connection.close();

    expect(store.subscriberCount("conversation-1")).toBe(0);
  });

  it("closes a slow subscriber when its bounded live backlog is full", async () => {
    let publish: ((event: { sequence: number }) => void) | undefined;
    const unsubscribe = vi.fn();
    const onClose = vi.fn();
    const connection = replayThenLive({
      after: 0,
      sequence: (event: { sequence: number }) => event.sequence,
      replay: () => [],
      subscribe: (listener) => {
        publish = listener;
        return unsubscribe;
      },
      write: () => new Promise<void>(() => {}),
      maxBufferedEvents: 2,
      onClose,
    });

    publish!({ sequence: 1 });
    publish!({ sequence: 2 });
    publish!({ sequence: 3 });
    publish!({ sequence: 4 });
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    await connection.close();
  });
});
