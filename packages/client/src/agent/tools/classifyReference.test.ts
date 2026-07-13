import { expect, it, vi } from "vitest";
import { createClassifyReferenceTool } from "./classifyReference";

it("passes the classify tool call ID as the idempotency key", async () => {
  const input = {
    referenceId: "ref-1", status: "active" as const, purpose: "Primary",
    relationships: [], rationale: "Defines form.", specificationLinks: ["spec.form"],
  };
  const classification = {
    ...input, id: "classify-call", conversationId: "conv-1", actor: "agent" as const, timestamp: 1,
  };
  const classify = vi.fn(async () => classification);
  const tool = createClassifyReferenceTool({ persistPending: async () => {}, classify, onAccepted: vi.fn() });

  await tool.execute("classify-call", input);

  expect(classify).toHaveBeenCalledWith(input, "classify-call");
});
