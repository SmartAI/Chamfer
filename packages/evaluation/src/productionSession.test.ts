import { describe, expect, it, vi } from "vitest";
import type { ProductionConversationSnapshot } from "./observation";
import {
  evaluateThroughProductionSession,
  PlaywrightProductionSession,
  type ProductionSession,
} from "./productionSession";
import type { EvaluationTask } from "./schema";

const task: EvaluationTask = {
  schemaVersion: 1,
  id: "production-session-fixture",
  taskVersion: 1,
  category: "conflicting-evidence",
  prompt: "synthetic conflict",
  expectedOutcome: "escalated",
  requiredProofEvidence: ["focused-question"],
  modelConfiguration: { provider: "fixture", model: "fixture", repetitions: 1 },
  proofPolicy: { id: "policy", version: 1 },
};

describe("production session reuse", () => {
  it("creates the first conversation before waiting for the empty-homepage composer", async () => {
    const click = vi.fn(async () => {
      throw new Error("conversation-clicked");
    });
    const waitForFunction = vi.fn();
    const page = {
      goto: vi.fn(),
      getByText: vi.fn(() => ({ count: vi.fn(async () => 0) })),
      request: {
        get: vi.fn(async () => ({
          ok: () => true,
          status: () => 200,
          json: async () => ({
            modelJson: JSON.stringify({ provider: "fixture", id: "fixture" }),
          }),
        })),
      },
      getByTestId: vi.fn((id: string) => id === "sidebar"
        ? { getByRole: () => ({ first: () => ({ click }) }) }
        : {}),
      waitForResponse: vi.fn(() => new Promise(() => undefined)),
      waitForFunction,
    };
    const session = new PlaywrightProductionSession(page as never, "http://localhost:5273");

    await expect(session.run(task)).rejects.toThrow("conversation-clicked");
    expect(click).toHaveBeenCalledOnce();
    expect(waitForFunction).not.toHaveBeenCalled();
  });

  it("delegates the complete turn once and only analyzes its durable output", async () => {
    const durable: ProductionConversationSnapshot = {
      messages: [{
        seq: 1,
        contentJson: JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "Which dimension should govern?" }],
          usage: { input: 1, output: 1, totalTokens: 2 },
        }),
      }],
      proofContracts: [],
      artifacts: [],
      visualVerifications: [],
      proofReports: [],
      elapsedMs: 40,
      configuredProvider: "fixture",
      configuredModel: "fixture",
    };
    const run = vi.fn(async () => durable);
    const session: ProductionSession = { run };
    const result = await evaluateThroughProductionSession(session, task, "sha256:prompt");
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(task);
    expect(result.observation).toMatchObject({ finalStatus: "escalated", evidence: ["focused-question"] });
  });
});
