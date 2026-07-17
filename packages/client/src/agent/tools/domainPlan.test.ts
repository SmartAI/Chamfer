import { describe, expect, it } from "vitest";
import { createCreatePlanTool, createRevisePlanTool } from "./domainPlan";

const input = {
  mutation_id: "create-spacer",
  reason: "Create the plan from the recorded source requirement.",
  goal: "10 mm spacer",
  components: [{
    id: "spacer",
    description: "10 mm cube spacer",
    bbox_mm: [10, 10, 10],
    checks: [{ id: "volume", kind: "volume", range_mm3: [900, 1100], target: "spacer" }],
    free_floating_reason: "single part",
  }],
  interfaces: [],
};

describe("domain plan tools", () => {
  it("deduplicates an exact create retry and rejects conflicting mutation id reuse", async () => {
    const messages: unknown[] = [];
    const tool = createCreatePlanTool({
      getMessages: () => messages,
      getSourceSpecificationIds: () => ["spec-spacer"],
    });
    const first = await tool.execute("call-1", input as never);
    messages.push({
      role: "toolResult",
      toolName: "create_plan",
      toolCallId: "call-1",
      isError: false,
      details: first.details,
    });

    const retry = await tool.execute("call-2", input as never);
    expect(retry.details.deduped).toBe(true);
    expect(retry.details.plan).toEqual(first.details.plan);
    await expect(tool.execute("call-3", { ...input, goal: "different target" } as never)).rejects.toThrow(
      /mutation_id.*different/i,
    );
  });

  it("derives the form-review policy from active reference provenance", async () => {
    const tool = createCreatePlanTool({
      getMessages: () => [],
      getSourceSpecificationIds: () => ["spec-spacer"],
      getSourceSpecifications: () => [{
        id: "spec-spacer",
        conversationId: "conversation-1",
        requirement: "Match the reference spacer.",
        source: { attachmentId: "reference-1", observation: "The drawing shows the spacer." },
        actor: "agent",
        status: "active",
        timestamp: 1,
      }],
    });

    const created = await tool.execute("call-reference", input as never);
    expect(created.details.plan.domain.requires_form_review).toBe(true);
    expect(created.details.plan.domain).not.toHaveProperty("reference_source_specification_ids");
  });

  it("preserves check identity and derives audit flags around a semantic check revision", async () => {
    const messages: unknown[] = [];
    const create = createCreatePlanTool({
      getMessages: () => messages,
      getSourceSpecificationIds: () => ["spec-spacer"],
    });
    const created = await create.execute("create", input as never);
    messages.push({
      role: "toolResult",
      toolName: "create_plan",
      toolCallId: "create",
      isError: false,
      details: created.details,
    }, {
      role: "toolResult",
      toolName: "run_build123d",
      toolCallId: "run-outside-range",
      isError: false,
      details: {
        gate: { status: "failed" },
        measurements: { component: "spacer", checks: [], volumeMm3: 1_200 },
      },
    });
    const revise = createRevisePlanTool({ getMessages: () => messages });
    const revised = await revise.execute("revise", {
      mutation_id: "revise-volume-range",
      reason: "The source-derived solid-volume estimate includes the specified boss.",
      operations: [{
        kind: "revise_check",
        component_id: "spacer",
        check_id: "volume",
        check: { kind: "volume", range_mm3: [900, 1_300], target: "spacer" },
      }],
    } as never);

    expect(revised.details.plan.components[0]?.checks?.[0]).toMatchObject({
      id: "volume",
      revision_reason: "The source-derived solid-volume estimate includes the specified boss.",
      refit_to_measurement: true,
    });
  });

  it("upgrades a legacy snapshot only through an explicit compatible transition", async () => {
    const legacy = {
      goal: input.goal,
      components: [
        ...input.components.map((component) => ({ ...component, status: "todo" })),
        {
          id: "retired",
          description: "retired helper",
          bbox_mm: [1, 1, 1],
          checks: [{ id: "volume", kind: "volume", range_mm3: [0.9, 1.1], target: "retired" }],
          status: "abandoned",
          abandon_reason: "No longer required.",
          free_floating_reason: "retired",
        },
      ],
      interfaces: [],
    };
    const messages: unknown[] = [{
      role: "toolResult",
      toolName: "update_plan",
      isError: false,
      details: { plan: legacy },
    }];
    const tool = createCreatePlanTool({
      getMessages: () => messages,
      getSourceSpecificationIds: () => ["spec-spacer"],
    });

    await expect(tool.execute("transition-implicit", input as never)).rejects.toThrow(/transition_from_legacy=true/);
    const transitioned = await tool.execute("transition-explicit", {
      ...input,
      transition_from_legacy: true,
    } as never);
    expect(transitioned.details.plan.domain.format).toBe("domain-operations-v1");
    expect(transitioned.details.plan.components.map((component) => component.id)).toEqual(["spacer"]);
  });

  it("keeps system-owned state and audit fields out of model-authored schemas", () => {
    const create = createCreatePlanTool({
      getMessages: () => [],
      getSourceSpecificationIds: () => ["spec-spacer"],
    });
    const revise = createRevisePlanTool({ getMessages: () => [] });
    const exposed = JSON.stringify([create.parameters, revise.parameters]);

    for (const field of [
      "entity_id",
      "criteria_revision",
      "retired_revision",
      "revision_reason",
      "removed",
      "refit_to_measurement",
      "abandon_reason",
      "review_history",
      "completion",
      "immutable_history",
      "created_at",
      "actor",
      "timestamp",
    ]) {
      expect(exposed).not.toContain(`\"${field}\"`);
    }

    const createSchema = create.parameters as unknown as {
      properties: { components: { items: { properties: Record<string, unknown> } } };
    };
    expect(createSchema.properties.components.items.properties).not.toHaveProperty("status");

    const reviseSchema = revise.parameters as unknown as {
      properties: { operations: { items: { anyOf: Array<{ properties: Record<string, { const?: string }> }> } } };
    };
    const operations = reviseSchema.properties.operations.items.anyOf;
    expect(operations.map((schema) => schema.properties.kind?.const).sort()).toEqual([
      "add_check",
      "add_component",
      "add_interface",
      "record_component_review",
      "record_form_review",
      "retire_check",
      "retire_component",
      "retire_interface",
      "revise_check",
      "revise_component",
      "revise_goal",
      "set_component_status",
      "set_source_specifications",
    ]);
    const addComponent = operations.find((schema) => schema.properties.kind?.const === "add_component") as unknown as {
      properties: { component: { properties: Record<string, unknown> } };
    };
    expect(addComponent.properties.component.properties).not.toHaveProperty("status");
    const reviseCheck = operations.find((schema) => schema.properties.kind?.const === "revise_check") as unknown as {
      properties: { check: { anyOf: Array<{ properties: Record<string, unknown> }> } };
    };
    expect(reviseCheck.properties.check.anyOf.every((schema) => !("id" in schema.properties))).toBe(true);
  });
});
