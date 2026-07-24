import { describe, expect, it } from "vitest";
import {
  emptyConversationProjection,
  projectConversationEvents,
  type ConversationEvent,
} from "./conversationEvents";

const events: ConversationEvent[] = [
  {
    schemaVersion: 1,
    id: "event-1",
    conversationId: "conversation-1",
    sequence: 1,
    recordedAt: 10,
    type: "conversation.created",
    data: {
      title: "New chat",
      cadEnvironment: "build123d",
      designId: "design-1",
      sourceSpecificationsRequired: true,
    },
  },
  {
    schemaVersion: 1,
    id: "event-2",
    conversationId: "conversation-1",
    sequence: 2,
    recordedAt: 20,
    type: "message.appended",
    data: {
      message: {
        id: "message-1",
        conversationId: "conversation-1",
        seq: 0,
        role: "user",
        contentJson: JSON.stringify({ role: "user", content: "Make a bracket" }),
        createdAt: 20,
      },
      attachments: [],
    },
  },
  {
    schemaVersion: 1,
    id: "event-3",
    conversationId: "conversation-1",
    sequence: 3,
    recordedAt: 30,
    type: "evidence.linked",
    data: { evidenceId: "plan-1", relationship: "plan" },
  },
  {
    schemaVersion: 1,
    id: "event-4",
    conversationId: "conversation-1",
    sequence: 4,
    recordedAt: 40,
    type: "ui.state-updated",
    data: { key: "right-panel", value: { tab: "parameters" } },
  },
];

describe("conversation event projection", () => {
  it("replaying the same portable log is deterministic and matches incremental projection", () => {
    const replayedOnce = projectConversationEvents(events);
    const replayedTwice = projectConversationEvents(JSON.parse(JSON.stringify(events)) as ConversationEvent[]);
    const incremental = events.reduce(
      (projection, event) => projectConversationEvents([event], projection),
      emptyConversationProjection("conversation-1"),
    );

    expect(replayedOnce).toEqual(replayedTwice);
    expect(incremental).toEqual(replayedOnce);
    expect(replayedOnce.evidenceLinks).toEqual([{ evidenceId: "plan-1", relationship: "plan" }]);
    expect(replayedOnce.uiState).toEqual({ "right-panel": { tab: "parameters" } });
  });
});
