import { expect, it, vi } from "vitest";
import { createRecordSourceSpecificationsTool } from "./recordSourceSpecifications";

it("derives exact persisted provenance and sends the tool call id as the idempotency key", async () => {
  const text = "Build a 30 mm plate with two holes.";
  const record = vi.fn(async (input, _key: string) => input.specifications.map((specification: {
    id: string;
    requirement: string;
    source: { messageId: string; text: string; start: number; end: number };
  }) => ({
    ...specification,
    conversationId: "conv-1",
    actor: "agent" as const,
    status: "active" as const,
    timestamp: 7,
  })));
  const onAccepted = vi.fn();
  const tool = createRecordSourceSpecificationsTool({
    persistPending: async () => {},
    sourceMessage: () => ({ id: "message-1", text }),
    record,
    onAccepted,
  });

  const result = await tool.execute("source-call", {
    specifications: [{
      id: "plate-width",
      requirement: "The plate must be 30 mm wide.",
      sourceQuote: "30 mm plate",
    }],
  });

  expect(record).toHaveBeenCalledWith({
    specifications: [{
      id: "plate-width",
      requirement: "The plate must be 30 mm wide.",
      source: { messageId: "message-1", text: "30 mm plate", start: 8, end: 19 },
    }],
  }, "source-call");
  expect(onAccepted).toHaveBeenCalledWith(result.details.specifications);
});

it("rejects non-verbatim and ambiguous quotes before persistence", async () => {
  const record = vi.fn();
  const tool = createRecordSourceSpecificationsTool({
    persistPending: async () => {},
    sourceMessage: () => ({ id: "message-1", text: "Use two 5 mm holes, each spaced 5 mm from an edge." }),
    record,
    onAccepted: vi.fn(),
  });

  await expect(tool.execute("missing", {
    specifications: [{ id: "diameter", requirement: "Holes must be 6 mm.", sourceQuote: "6 mm holes" }],
  })).rejects.toThrow(/not exact text/);
  await expect(tool.execute("ambiguous", {
    specifications: [{ id: "five-mm", requirement: "Honor 5 mm.", sourceQuote: "5 mm" }],
  })).rejects.toThrow(/ambiguous/);
  expect(record).not.toHaveBeenCalled();
});
