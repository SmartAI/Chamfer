import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ReferenceRecordDto } from "@chamfer/shared";
import {
  pendingReferenceIds,
  projectClassifiedReferences,
  referenceRecordText,
} from "./referenceClassification";

const reference = {
  type: "attachment-reference",
  attachmentId: "ref-a",
  kind: "user-image",
  mimeType: "image/png",
} as const;

function user(): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "build this" }, reference],
    timestamp: 1,
  } as unknown as AgentMessage;
}

const classified: ReferenceRecordDto = {
  referenceId: "ref-a",
  conversationId: "conv-1",
  attachmentAvailable: true,
  status: "complementary",
  purpose: "Front view",
  relationships: [{ type: "complements", referenceId: "ref-b" }],
  rationale: "Adds the missing front orientation.",
  specificationLinks: ["plan.spec_sheet.front-width"],
  actor: "agent",
  timestamp: 10,
  history: [],
};

describe("reference context projection", () => {
  it("keeps unclassified attachment references available for pixel materialization", () => {
    const messages = [user()];
    const projected = projectClassifiedReferences(messages, []);
    expect((projected[0] as unknown as { content: Array<{ text?: string }> }).content.at(-1)?.text)
      .toContain("Pending reference images: ref-a");
    expect(pendingReferenceIds(messages, [])).toEqual(["ref-a"]);
  });

  it("replaces successfully classified pixels with a deterministic compact record", () => {
    const projected = projectClassifiedReferences([user()], [classified]);
    const content = (projected[0] as unknown as { content: Array<{ type: string; text?: string }> }).content;

    expect(content).not.toContainEqual(expect.objectContaining({ type: "attachment-reference" }));
    expect(content[1]).toEqual({ type: "text", text: referenceRecordText(classified) });
    expect(content[1]?.text).toContain("ref-a");
    expect(content[1]?.text).toContain("complementary");
    expect(pendingReferenceIds([user()], [classified])).toEqual([]);
  });

  it("is byte-stable for reload projection", () => {
    expect(JSON.stringify(projectClassifiedReferences([user()], [classified]))).toBe(
      JSON.stringify(projectClassifiedReferences([user()], [classified])),
    );
  });
});
