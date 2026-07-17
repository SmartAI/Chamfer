import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SourceSpecificationDto } from "@chamfer/shared";
import { transformLlmContext, type CompactionMessage } from "./contextPolicy";
import { projectSourceSpecifications, SOURCE_SPECIFICATIONS_CONTEXT_MARKER } from "./sourceSpecifications";

const specification: SourceSpecificationDto = {
  id: "plate-width",
  conversationId: "conv-1",
  requirement: "The plate must be 30 mm wide.",
  source: { messageId: "message-1", text: "30 mm plate", start: 8, end: 19 },
  actor: "agent",
  status: "active",
  timestamp: 7,
};

describe("source specification context projection", () => {
  it("is deterministic and remains visible after the source message is compacted away", () => {
    const compaction: CompactionMessage = {
      role: "compaction",
      summary: "Earlier work was summarized.",
      keptTail: 1,
      tokensBefore: 90_000,
      timestamp: 10,
    };
    const messages = [
      { role: "user", content: "Build a 30 mm plate", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Acknowledged" }], timestamp: 2 },
      { role: "user", content: "Continue", timestamp: 3 },
      compaction,
      { role: "assistant", content: [{ type: "text", text: "Continuing" }], timestamp: 4 },
    ] as unknown as AgentMessage[];

    const projected = projectSourceSpecifications(transformLlmContext(messages), [specification]);
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain(SOURCE_SPECIFICATIONS_CONTEXT_MARKER);
    expect(serialized).toContain("plate-width");
    expect(serialized).toContain("30 mm plate");
    expect(serialized).not.toContain("Build a 30 mm plate");
    expect(JSON.stringify(projectSourceSpecifications(transformLlmContext(messages), [specification]))).toBe(serialized);
  });

  it("leaves legacy contexts unchanged when no durable specifications exist", () => {
    const messages = [{ role: "user", content: "legacy", timestamp: 1 }] as AgentMessage[];
    expect(projectSourceSpecifications(messages, [])).toBe(messages);
  });

  it("projects attachment provenance and marks superseded history as non-authoritative", () => {
    const corrected: SourceSpecificationDto = {
      id: "width-v2",
      conversationId: "conv-1",
      requirement: "The corrected width is 32 mm.",
      source: {
        attachmentId: "drawing-2",
        observation: "Corrected width callout reads 32 mm.",
        region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      },
      supersedesSpecificationId: "width-v1",
      actor: "agent",
      status: "active",
      timestamp: 8,
    };
    const historical: SourceSpecificationDto = {
      ...corrected,
      id: "width-v1",
      requirement: "The original width is 30 mm.",
      source: { attachmentId: "drawing-1", observation: "Original width callout reads 30 mm." },
      supersedesSpecificationId: undefined,
      supersededBySpecificationId: "width-v2",
      status: "superseded",
      timestamp: 7,
    };
    const projected = projectSourceSpecifications([], [historical, corrected]);
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain("source attachment drawing-2");
    expect(serialized).toContain("normalized region");
    expect(serialized).toContain("Superseded rows are immutable provenance history, not current requirements");
    expect(serialized).toContain("supersededBy=width-v2");
  });
});
