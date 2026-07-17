import { expect, it, vi } from "vitest";
import type { SourceSpecificationInput } from "@chamfer/shared";
import { createRecordReferenceSpecificationsTool } from "./recordReferenceSpecifications";

it("records attachment provenance, region, supersession, and tool-call idempotency", async () => {
  const record = vi.fn(async (input: { specifications: SourceSpecificationInput[] }, _key: string) =>
    input.specifications.map((specification) => ({
    ...specification,
    conversationId: "conversation-1",
    actor: "agent" as const,
    status: "active" as const,
    timestamp: 10,
    })));
  const onAccepted = vi.fn();
  const tool = createRecordReferenceSpecificationsTool({
    persistPending: async () => {},
    record,
    onAccepted,
  });
  const args = {
    specifications: [{
      id: "width-v2",
      requirement: "The body must be 32 mm wide.",
      attachmentId: "reference-2",
      observation: "Corrected width callout reads 32 mm.",
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      supersedesSpecificationId: "width-v1",
    }],
  };

  const result = await tool.execute("reference-spec-call", args);

  expect(record).toHaveBeenCalledWith({
    specifications: [{
      id: "width-v2",
      requirement: "The body must be 32 mm wide.",
      source: {
        attachmentId: "reference-2",
        observation: "Corrected width callout reads 32 mm.",
        region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      },
      supersedesSpecificationId: "width-v1",
    }],
  }, "reference-spec-call");
  expect(onAccepted).toHaveBeenCalledWith(result.details.specifications);
});
