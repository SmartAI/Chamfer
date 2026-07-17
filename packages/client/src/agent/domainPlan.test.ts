import { describe, expect, it } from "vitest";
import {
  collectComponentEvidence,
  latestPlan,
  validateRunChecksConformance,
  type Plan,
  type PlanCheckEntry,
} from "./plan";
import {
  applyDomainPlanRevision,
  createDomainPlan,
  isDomainPlan,
  type DomainPlanEnvironment,
  type DomainPlanRevisionBatch,
} from "./domainPlan";

const checks = [
  { id: "envelope", kind: "bbox", size_mm: [20, 20, 5], target: "plate" },
  { id: "volume", kind: "volume", range_mm3: [1800, 2200], target: "plate" },
] as Plan["components"][number]["checks"];

const submitted: Plan = {
  goal: "20 x 20 x 5 mm plate",
  components: [
    {
      id: "plate",
      description: "rectangular plate",
      bbox_mm: [20, 20, 5],
      checks,
      status: "todo",
      free_floating_reason: "single part",
    },
  ],
  interfaces: [],
};

function environment(): DomainPlanEnvironment {
  let next = 0;
  return {
    actor: "agent",
    now: () => 1_000 + next,
    id: (kind) => `${kind}-${++next}`,
  };
}

function passingEvidence() {
  const runChecks = checks?.map((check) => {
    const { id: _id, ...runCheck } = check;
    return runCheck;
  });
  return collectComponentEvidence([
    {
      role: "toolResult",
      toolName: "run_build123d",
      toolCallId: "run-plate-v1",
      isError: false,
      details: {
        gate: { status: "passed" },
        measurements: { component: "plate", checks: runChecks },
      },
    },
  ]);
}

function revise(plan: ReturnType<typeof createDomainPlan>, batch: DomainPlanRevisionBatch) {
  const evidence = passingEvidence();
  for (const [componentId, record] of evidence) {
    record.planId = plan.domain.plan_id;
    record.criteriaRevision = plan.components.find((component) => component.id === componentId)?.criteria_revision;
  }
  return applyDomainPlanRevision(plan, batch, evidence, environment());
}

describe("domain plan revisions", () => {
  it("normalizes initial plans with source links and component criteria revisions", () => {
    const plan = createDomainPlan(
      submitted,
      {
        mutation_id: "create-plate",
        reason: "Initial plan from the source requirements.",
        source_specification_ids: ["spec-envelope"],
      },
      new Map(),
      environment(),
    );

    expect(isDomainPlan(plan)).toBe(true);
    expect(plan.domain).toMatchObject({
      revision: 1,
      criteria_revision: 1,
      source_specification_ids: ["spec-envelope"],
    });
    expect(plan.components[0]).toMatchObject({
      id: "plate",
      criteria_revision: 1,
    });
    expect(plan.components[0]!.checks).toEqual(checks);
    expect(plan.domain.history).toEqual([
      expect.objectContaining({
        mutation_id: "create-plate",
        revision: 1,
        criteria_revision: 1,
        criteria_changed: true,
      }),
    ]);
  });

  it("advances plan history without invalidating completion evidence for status and review operations", () => {
    const created = createDomainPlan(
      submitted,
      {
        mutation_id: "create-plate",
        reason: "Initial plan.",
        source_specification_ids: ["spec-envelope"],
      },
      new Map(),
      environment(),
    );
    const done = revise(created, {
      mutation_id: "finish-plate",
      reason: "The current run passed every plate criterion.",
      operations: [{ kind: "set_component_status", component_id: "plate", status: "done" }],
    });
    const reviewed = revise(done, {
      mutation_id: "review-plate",
      reason: "Recorded a review note without changing the target.",
      operations: [{ kind: "record_component_review", component_id: "plate", note: "Dimensions rechecked." }],
    });

    expect(done.domain).toMatchObject({ revision: 2, criteria_revision: 1 });
    expect(done.components[0]!.completion).toEqual({ evidence_id: "run-plate-v1", criteria_revision: 1 });
    expect(reviewed.domain).toMatchObject({ revision: 3, criteria_revision: 1 });
    expect(reviewed.components[0]!.completion).toEqual(done.components[0]!.completion);
    expect(reviewed.components[0]!.id).toBe(created.components[0]!.id);
  });

  it("increments criteria revisions and invalidates only dependent component completion evidence", () => {
    const pegChecks = [
      { id: "envelope", kind: "bbox", size_mm: [5, 5, 10], target: "peg" },
      { id: "volume", kind: "volume", range_mm3: [225, 275], target: "peg" },
    ] as Plan["components"][number]["checks"];
    const twoComponents: Plan = {
      ...submitted,
      components: [
        submitted.components[0]!,
        {
          id: "peg",
          description: "alignment peg",
          bbox_mm: [5, 5, 10],
          checks: pegChecks,
          status: "todo",
          free_floating_reason: "independent fixture component",
        },
      ],
    };
    const evidence = collectComponentEvidence([
      {
        role: "toolResult",
        toolName: "run_build123d",
        toolCallId: "run-plate-v1",
        isError: false,
        details: { gate: { status: "passed" }, measurements: { component: "plate", checks: checks?.map(({ id: _id, ...check }) => check) } },
      },
      {
        role: "toolResult",
        toolName: "run_build123d",
        toolCallId: "run-peg-v1",
        isError: false,
        details: { gate: { status: "passed" }, measurements: { component: "peg", checks: pegChecks?.map(({ id: _id, ...check }) => check) } },
      },
    ]);
    const created = createDomainPlan(
      twoComponents,
      {
        mutation_id: "create-plate",
        reason: "Initial plan.",
        source_specification_ids: ["spec-envelope"],
      },
      new Map(),
      environment(),
    );
    for (const [componentId, record] of evidence) {
      record.planId = created.domain.plan_id;
      record.criteriaRevision = created.components.find((component) => component.id === componentId)?.criteria_revision;
    }
    const done = applyDomainPlanRevision(created, {
      mutation_id: "finish-components",
      reason: "Both components passed.",
      operations: [
        { kind: "set_component_status", component_id: "plate", status: "done" },
        { kind: "set_component_status", component_id: "peg", status: "done" },
      ],
    }, evidence, environment());
    const changed = applyDomainPlanRevision(done, {
      mutation_id: "widen-plate",
      reason: "A later source reading establishes a 22 mm width.",
      operations: [{ kind: "revise_component", component_id: "plate", bbox_mm: [22, 20, 5] }],
    }, evidence, environment());

    expect(changed.domain).toMatchObject({ revision: 3, criteria_revision: 2 });
    expect(changed.components[0]).toMatchObject({
      criteria_revision: 2,
      status: "building",
    });
    expect(changed.components[0]!.completion).toBeUndefined();
    expect(changed.components[1]).toMatchObject({
      id: "peg",
      status: "done",
      completion: { evidence_id: "run-peg-v1", criteria_revision: 1 },
    });
    expect(changed.domain.history.at(-1)).toMatchObject({
      invalidated_evidence_ids: ["run-plate-v1"],
      criteria_changed: true,
    });
    expect(done.components[0]!.completion).toEqual({ evidence_id: "run-plate-v1", criteria_revision: 1 });
  });

  it("applies operation batches atomically and rejects conflicting mutation retries", () => {
    const created = createDomainPlan(
      submitted,
      {
        mutation_id: "create-plate",
        reason: "Initial plan.",
        source_specification_ids: ["spec-envelope"],
      },
      new Map(),
      environment(),
    );
    const batch: DomainPlanRevisionBatch = {
      mutation_id: "atomic-revision",
      reason: "Both changes belong to one revision.",
      operations: [
        { kind: "revise_component", component_id: "plate", description: "revised plate" },
        { kind: "set_component_status", component_id: "missing", status: "building" },
      ],
    };

    expect(() => revise(created, batch)).toThrow(/missing/);
    expect(created.components[0]!.description).toBe("rectangular plate");
    expect(created.domain.revision).toBe(1);

    const accepted = revise(created, {
      mutation_id: "review-once",
      reason: "One review mutation.",
      operations: [{ kind: "record_component_review", component_id: "plate", note: "Reviewed." }],
    });
    const exactRetry = revise(accepted, {
      mutation_id: "review-once",
      reason: "One review mutation.",
      operations: [{ kind: "record_component_review", component_id: "plate", note: "Reviewed." }],
    });
    expect(exactRetry).toEqual(accepted);
    expect(() => revise(accepted, {
      mutation_id: "review-once",
      reason: "Conflicting reuse.",
      operations: [{ kind: "record_component_review", component_id: "plate", note: "Different." }],
    })).toThrow(/mutation_id.*different/i);
  });

  it("keeps retired entities as immutable audit tombstones", () => {
    const created = createDomainPlan(
      submitted,
      {
        mutation_id: "create-plate",
        reason: "Initial plan.",
        source_specification_ids: ["spec-envelope"],
      },
      new Map(),
      environment(),
    );
    const retired = revise(created, {
      mutation_id: "retire-plate",
      reason: "The user explicitly removed the plate.",
      operations: [{ kind: "retire_component", component_id: "plate", reason: "Removed by the user." }],
    });

    expect(retired.components).toHaveLength(1);
    expect(retired.components[0]).toMatchObject({
      id: created.components[0]!.id,
      status: "abandoned",
      retired_revision: 2,
      abandon_reason: "Removed by the user.",
    });
    expect(retired.domain).toMatchObject({ revision: 2, criteria_revision: 2 });
  });

  it("uses author check IDs and preserves interface identities when retiring them", () => {
    const connected: Plan = {
      ...submitted,
      components: [
        { ...submitted.components[0]!, free_floating_reason: "independent fixture component" },
        {
          id: "peg",
          description: "alignment peg",
          bbox_mm: [5, 5, 10],
          checks: [{ id: "volume", kind: "volume", range_mm3: [225, 275], target: "peg" }],
          status: "todo",
          free_floating_reason: "independent fixture component",
        },
      ],
      interfaces: [{ a: "plate", b: "peg", kind: "captive" }],
    };
    const created = createDomainPlan(
      connected,
      {
        mutation_id: "create-connected",
        reason: "Initial plan.",
        source_specification_ids: ["spec-envelope"],
      },
      new Map(),
      environment(),
    );
    const interfaceId = created.interfaces[0]!.entity_id!;
    const retired = applyDomainPlanRevision(created, {
      mutation_id: "retire-entities",
      reason: "The envelope check and captive relation no longer apply.",
      operations: [
        { kind: "retire_check", component_id: "plate", check_id: "envelope", reason: "Superseded criterion." },
        { kind: "retire_interface", interface_id: interfaceId, reason: "No longer connected." },
      ],
    }, new Map(), environment());
    const retiredEnvelope = retired.components[0]!.checks![0] as PlanCheckEntry & { retired_revision: number };

    expect(retiredEnvelope).toMatchObject({
      id: "envelope",
      removed: true,
      retired_revision: 2,
    });
    expect(retired.interfaces[0]).toMatchObject({
      entity_id: interfaceId,
      retired_revision: 2,
    });
    expect(retired.interfaces[0]).not.toHaveProperty("criteria_revision");
  });

  it("continues to read the newest legacy snapshot plan", () => {
    const legacy = structuredClone(submitted);
    expect(latestPlan([
      { role: "toolResult", toolName: "update_plan", isError: false, details: { plan: legacy } },
    ])).toEqual(legacy);
  });

  it("does not require CAD code to reproduce system-only criterion metadata", () => {
    const plan = createDomainPlan(
      submitted,
      {
        mutation_id: "create-plate",
        reason: "Initial plan.",
        source_specification_ids: ["spec-envelope"],
      },
      new Map(),
      environment(),
    );
    const runChecks = checks?.map((check) => {
      const { id: _id, ...runCheck } = check;
      return runCheck;
    });

    expect(validateRunChecksConformance(plan, { component: "plate", checks: runChecks })).toEqual([]);
  });

  it("makes source reconciliation a criteria revision and invalidates dependent completion", () => {
    const created = createDomainPlan(submitted, {
      mutation_id: "create-v1",
      reason: "Initial source coverage.",
      source_specification_ids: ["width-v1"],
    }, new Map(), environment());
    const completed = structuredClone(created);
    completed.components[0]!.status = "done";
    completed.components[0]!.completion = { evidence_id: "run-v1", criteria_revision: 1 };

    const reconciled = applyDomainPlanRevision(completed, {
      mutation_id: "source-v2",
      reason: "Adopt the corrected source identity.",
      operations: [{ kind: "set_source_specifications", source_specification_ids: ["width-v2"] }],
    }, new Map(), environment());

    expect(reconciled.domain).toMatchObject({
      revision: 2,
      criteria_revision: 2,
      source_specification_ids: ["width-v2"],
    });
    expect(reconciled.components[0]).toMatchObject({ status: "building", criteria_revision: 2 });
    expect(reconciled.components[0]!.completion).toBeUndefined();
    expect(reconciled.domain.history.at(-1)?.invalidated_evidence_ids).toEqual(["run-v1"]);
  });

  it("rejects unbound or stale completion evidence after a criteria revision", () => {
    const created = createDomainPlan(submitted, {
      mutation_id: "create-bound",
      reason: "Initial source coverage.",
      source_specification_ids: ["width-v1"],
    }, new Map(), environment());
    const unbound = passingEvidence();
    expect(() => applyDomainPlanRevision(created, {
      mutation_id: "finish-unbound",
      reason: "Attempt to reuse an unstamped run.",
      operations: [{ kind: "set_component_status", component_id: "plate", status: "done" }],
    }, unbound, environment())).toThrow(/not bound to plan/);

    for (const record of unbound.values()) {
      record.planId = created.domain.plan_id;
      record.criteriaRevision = 1;
    }
    const revised = applyDomainPlanRevision(created, {
      mutation_id: "criteria-v2",
      reason: "Change the component envelope.",
      operations: [{ kind: "revise_component", component_id: "plate", bbox_mm: [22, 20, 5] }],
    }, unbound, environment());
    expect(() => applyDomainPlanRevision(revised, {
      mutation_id: "finish-stale",
      reason: "Attempt to reuse criteria-v1 evidence.",
      operations: [{ kind: "set_component_status", component_id: "plate", status: "done" }],
    }, unbound, environment())).toThrow(/criteria revision 2/);
  });

  it("does not fall back to older completion evidence after a newer nonconforming run", () => {
    const evidence = collectComponentEvidence([{
      role: "toolResult",
      toolName: "run_build123d",
      toolCallId: "current-pass",
      isError: false,
      details: {
        gate: { status: "passed" },
        measurements: { component: "plate", checks: checks?.map(({ id: _id, ...check }) => check) },
      },
    }, {
      role: "toolResult",
      toolName: "run_build123d",
      toolCallId: "newer-nonconforming",
      isError: true,
      details: {
        gate: { status: "passed" },
        measurements: { component: "plate", checks: [] },
        planConformance: {
          status: "failed",
          planId: "plan-1",
          componentCriteriaRevisions: { plate: 1 },
        },
      },
    }]);
    expect(evidence.has("plate")).toBe(false);
  });
});
