import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InspectionLeaseDto } from "@chamfer/shared";
import { projectInspectionLeases } from "./inspectionLeaseProjection";

const lease: InspectionLeaseDto = {
  id: "lease-1",
  conversationId: "conv-1",
  purpose: "Compare the earlier front profile",
  status: "open",
  evidence: [
    { attachmentId: "ref-1", kind: "user-image", mime: "image/png" },
    { attachmentId: "sheet-1", kind: "view-sheet", mime: "image/png" },
  ],
  openedAt: 123,
};

function references(messages: AgentMessage[]) {
  return messages.flatMap((message) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) ? content : [];
  })
    .filter((block) => (block as { type?: string }).type === "attachment-reference")
    .map((block) => (block as unknown as { attachmentId: string }).attachmentId);
}

describe("inspection lease context projection", () => {
  it("relocates exactly selected evidence into a stable lease recovery message", () => {
    const messages = [{
      role: "toolResult",
      toolCallId: "inspect",
      toolName: "inspect_evidence",
      content: [
        { type: "text", text: "retrieved" },
        { type: "image", data: "transient pixels", mimeType: "image/png" },
      ],
      timestamp: 1,
    }] as AgentMessage[];
    const projected = projectInspectionLeases(messages, [lease]);
    expect(references(projected)).toEqual(["ref-1", "sheet-1"]);
    expect(JSON.stringify(projected)).not.toContain("transient pixels");
    expect(projected.at(-1)).toMatchObject({ role: "user", timestamp: 123 });
    expect(projectInspectionLeases(messages, [lease])).toEqual(projected);
  });

  it("evicts lease pixels immediately when no open lease remains", () => {
    const messages = [{
      role: "toolResult",
      toolCallId: "inspect",
      toolName: "inspect_evidence",
      content: [{ type: "image", data: "pixels", mimeType: "image/png" }],
      timestamp: 1,
    }] as AgentMessage[];
    const projected = projectInspectionLeases(messages, []);
    expect(JSON.stringify(projected)).not.toContain('"data":"pixels"');
    expect(references(projected)).toEqual([]);
  });
});
