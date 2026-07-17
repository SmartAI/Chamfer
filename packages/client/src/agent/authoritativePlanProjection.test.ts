import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createDomainPlan } from "./domainPlan";
import type { Plan } from "./plan";
import {
  AUTHORITATIVE_PLAN_CONTEXT_MARKER,
  projectAuthoritativePlan,
} from "./authoritativePlanProjection";

const submitted: Plan = {
  goal: "one current plate",
  components: [{
    id: "plate",
    description: "current plate",
    bbox_mm: [20, 20, 5],
    checks: [{ id: "volume", kind: "volume", range_mm3: [1800, 2200], target: "plate" }],
    status: "todo",
    free_floating_reason: "single part",
  }],
  interfaces: [],
};

describe("authoritative plan context projection", () => {
  it("replays one normalized current plan across compaction and stubs every snapshot", () => {
    let next = 0;
    const plan = createDomainPlan(submitted, {
      mutation_id: "create-plan",
      reason: "Initial plan.",
      source_specification_ids: ["spec-plate"],
    }, new Map(), {
      actor: "agent",
      now: () => 10,
      id: (kind) => `${kind}-${++next}`,
    });
    const planResult = {
      role: "toolResult",
      toolName: "create_plan",
      toolCallId: "create-call",
      isError: false,
      content: [{ type: "text", text: `Plan accepted ${JSON.stringify(plan)}` }],
      details: { plan },
      timestamp: 10,
    } as unknown as AgentMessage;
    const visible = [{ role: "user", content: "continue", timestamp: 20 }] as AgentMessage[];
    const projected = projectAuthoritativePlan(visible, [planResult, ...visible]);
    const twice = projectAuthoritativePlan(projected, [planResult, ...visible]);
    expect(twice.flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? content : [];
    }).filter((block) => (block as { text?: string }).text === AUTHORITATIVE_PLAN_CONTEXT_MARKER)).toHaveLength(1);
    const projection = JSON.parse((twice[0] as { content: Array<{ text: string }> }).content[1]!.text) as {
      source_specification_ids: string[];
      immutable_history: unknown[];
    };
    expect(projection.source_specification_ids).toEqual(["spec-plate"]);
    expect(projection.immutable_history).toHaveLength(1);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(projected));
  });

  it("leaves a legacy transcript unchanged", () => {
    const legacy = [{ role: "user", content: "legacy", timestamp: 1 }] as AgentMessage[];
    expect(projectAuthoritativePlan(legacy)).toBe(legacy);
  });
});
