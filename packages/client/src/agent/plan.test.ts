import { describe, expect, it } from "vitest";
import {
  collectComponentEvidence,
  hasAssemblyEvidence,
  latestPlan,
  parseComponentDeclaration,
  planIncompleteComponents,
  runComponentIds,
  validatePlanSnapshot,
  type Plan,
  type PlanCheckEntry,
} from "./plan";
import { createUpdatePlanTool } from "./tools/updatePlan";

function volumeCheck(id: string, lo = 5000, hi = 6000): PlanCheckEntry {
  return { kind: "volume", range_mm3: [lo, hi], target: id };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    goal: "two-part housing",
    components: [
      { id: "base", description: "housing base", bbox_mm: [100, 80, 30], status: "todo", checks: [volumeCheck("base")] },
      { id: "lid", description: "flat lid", bbox_mm: [100, 80, 5], status: "todo", checks: [volumeCheck("lid")] },
    ],
    interfaces: [{ a: "base", b: "lid", kind: "clearance", min_mm: 0, max_mm: 0 }],
    ...overrides,
  };
}

function gatePassedRun(component: string | string[], checks: unknown[] = []): unknown {
  return {
    role: "toolResult",
    toolName: "run_build123d",
    isError: false,
    content: [],
    details: { gate: { status: "passed", checks: [] }, measurements: { component, checks } },
    timestamp: 1,
  };
}

function planResult(plan: Plan): unknown {
  return {
    role: "toolResult",
    toolName: "update_plan",
    isError: false,
    content: [],
    details: { plan },
    timestamp: 1,
  };
}

describe("validatePlanSnapshot", () => {
  const noEvidence = new Map();

  it("accepts a well-formed two-component plan", () => {
    expect(validatePlanSnapshot({ next: makePlan(), previous: undefined, evidence: noEvidence })).toEqual([]);
  });

  it("rejects duplicate, malformed, and reserved component ids", () => {
    const plan = makePlan({
      components: [
        { id: "base", description: "a", status: "todo" },
        { id: "base", description: "b", status: "todo" },
        { id: "Bad Id", description: "c", status: "todo" },
        { id: "probe", description: "d", status: "todo" },
      ],
      interfaces: [],
    });
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors.join("\n")).toMatch(/duplicate component id "base"/);
    expect(errors.join("\n")).toMatch(/"Bad Id"/);
    expect(errors.join("\n")).toMatch(/reserved for diagnostic runs/);
  });

  it("rejects abandoning without a reason", () => {
    const plan = makePlan();
    plan.components[1]!.status = "abandoned";
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors.join("\n")).toMatch(/abandon_reason/);
  });

  it("rejects unknown check kinds", () => {
    const plan = makePlan();
    plan.components[0]!.checks = [
      ...(plan.components[0]!.checks ?? []),
      { kind: "hole_sideways", count: 2 } as unknown as PlanCheckEntry,
    ];
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors.join("\n")).toMatch(/unknown check kind "hole_sideways"/);
  });

  it("rejects missing design evidence and malformed harness checks", () => {
    const plan = makePlan();
    delete plan.components[0]!.bbox_mm;
    plan.components[1]!.checks = [
      volumeCheck("lid"),
      { kind: "hole_through", diameter: -4, count: 1, target: "lid", surprise: true } as unknown as PlanCheckEntry,
    ];
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence }).join("\n");
    expect(errors).toMatch(/component "base": bbox_mm is required/);
    expect(errors).toMatch(/component "lid": check 1/);
    expect(errors).toMatch(/diameter must be a positive number/);
    expect(errors).toMatch(/unknown keys: \["surprise"\]/);
  });

  it("accepts the volume check targeting the component regardless of check order", () => {
    const plan = makePlan();
    plan.components[0]!.checks = [volumeCheck("lid"), volumeCheck("base")];
    expect(validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence })).toEqual([]);
  });

  it("requires a targeted, bounded volume check on every buildable component", () => {
    const plan = makePlan();
    plan.components[0]!.checks = [];
    plan.components[1]!.checks = [{ kind: "volume", range_mm3: [1000, 10000], target: "lid" }];
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors.join("\n")).toMatch(/component "base": checks must include a volume check/);
    expect(errors.join("\n")).toMatch(/component "lid": volume range \[1000, 10000\] is too loose/);

    // An untargeted volume check does not count: it would measure the whole
    // assembly in a multi-component run.
    plan.components[0]!.checks = [{ kind: "volume", range_mm3: [5000, 6000] }];
    const untargeted = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(untargeted.join("\n")).toMatch(/component "base": checks must include a volume check/);

    // Abandoned components are exempt.
    plan.components[0]!.checks = [];
    plan.components[0]!.status = "abandoned";
    plan.components[0]!.abandon_reason = "no longer needed";
    plan.components[1]!.checks = [volumeCheck("lid")];
    expect(validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence })).toEqual([]);
  });

  it("requires interface coverage for every non-free-floating component", () => {
    const plan = makePlan({ interfaces: [] });
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors.filter((e) => e.includes("not held by any interface"))).toHaveLength(2);
  });

  it("accepts an uncovered component with a free_floating_reason", () => {
    const plan = makePlan({
      components: [
        { id: "base", description: "base", bbox_mm: [10, 10, 10], status: "todo", free_floating_reason: "single part on the bench", checks: [volumeCheck("base")] },
        { id: "lid", description: "lid", bbox_mm: [10, 10, 2], status: "todo", free_floating_reason: "user wants it beside the base", checks: [volumeCheck("lid")] },
      ],
      interfaces: [],
    });
    expect(validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence })).toEqual([]);
  });

  it("rejects a disconnected interface graph", () => {
    const plan = makePlan({
      components: [
        { id: "a1", description: "a", status: "todo" },
        { id: "a2", description: "b", status: "todo" },
        { id: "b1", description: "c", status: "todo" },
        { id: "b2", description: "d", status: "todo" },
      ],
      interfaces: [
        { a: "a1", b: "a2", kind: "clearance", min_mm: 0 },
        { a: "b1", b: "b2", kind: "clearance", min_mm: 0 },
      ],
    });
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors.join("\n")).toMatch(/disconnected/);
  });

  it("rejects clearance interfaces without min_mm and captive without endpoints", () => {
    const plan = makePlan({
      interfaces: [
        { a: "base", b: "lid", kind: "clearance" },
        { a: "base", b: "ghost", kind: "captive" },
      ],
    });
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors.join("\n")).toMatch(/requires min_mm/);
    expect(errors.join("\n")).toMatch(/endpoints must be component ids/);
  });

  it("rejects silently dropping a previous component", () => {
    const previous = makePlan();
    const next = makePlan({
      components: [{ id: "base", description: "base", status: "todo", free_floating_reason: "now single-part", checks: [volumeCheck("base")] }],
      interfaces: [],
    });
    const errors = validatePlanSnapshot({ next, previous, evidence: noEvidence });
    expect(errors.join("\n")).toMatch(/component "lid" from the previous plan is missing/);
  });

  it("rejects done without gate evidence and accepts it with evidence covering the planned checks", () => {
    const check: PlanCheckEntry = { kind: "hole_through", diameter: 5.5, count: 4 };
    const plan = makePlan();
    plan.components[0]!.status = "done";
    plan.components[0]!.checks = [check, volumeCheck("base")];

    const without = validatePlanSnapshot({ next: plan, previous: undefined, evidence: new Map() });
    expect(without.join("\n")).toMatch(/no gate-passed run has declared COMPONENT = "base"/);

    // Evidence with the check present in a different key order must pass.
    const evidence = collectComponentEvidence([
      gatePassedRun("base", [{ count: 4, diameter: 5.5, kind: "hole_through" }, { target: "base", range_mm3: [5000, 6000], kind: "volume" }]),
    ]);
    expect(validatePlanSnapshot({ next: plan, previous: undefined, evidence })).toEqual([]);

    // Evidence that ran a different check set must fail.
    const wrongEvidence = collectComponentEvidence([gatePassedRun("base", [{ kind: "bbox", size_mm: [1, 2, 3] }])]);
    const missing = validatePlanSnapshot({ next: plan, previous: undefined, evidence: wrongEvidence });
    expect(missing.join("\n")).toMatch(/was not part of the gate-passed run/);
  });
});

describe("hasAssemblyEvidence", () => {
  const clearanceCheck = { kind: "clearance", a: "base", b: "lid", min_mm: 0, max_mm: 0 };

  it("is vacuously true for single-component or interface-free plans", () => {
    const single = makePlan({
      components: [{ id: "base", description: "base", status: "todo", free_floating_reason: "solo" }],
      interfaces: [],
    });
    expect(hasAssemblyEvidence(single, [])).toBe(true);
    expect(hasAssemblyEvidence(makePlan({ interfaces: [] }), [])).toBe(true);
  });

  it("rejects a run that declares all components but never ran the interface check", () => {
    const plan = makePlan();
    const runWithoutCheck = gatePassedRun(["base", "lid"], [{ kind: "bbox", size_mm: [1, 2, 3], target: "base" }]);
    expect(hasAssemblyEvidence(plan, [runWithoutCheck])).toBe(false);
  });

  it("accepts a run that declares all components and ran the interface check, either endpoint order", () => {
    const plan = makePlan();
    expect(hasAssemblyEvidence(plan, [gatePassedRun(["base", "lid"], [clearanceCheck])])).toBe(true);
    const swapped = { kind: "clearance", a: "lid", b: "base", min_mm: 0, max_mm: 0 };
    expect(hasAssemblyEvidence(plan, [gatePassedRun(["lid", "base"], [swapped])])).toBe(true);
  });

  it("rejects a run whose clearance bounds differ from the planned interface", () => {
    const plan = makePlan();
    const looser = { kind: "clearance", a: "base", b: "lid", min_mm: 0 };
    expect(hasAssemblyEvidence(plan, [gatePassedRun(["base", "lid"], [looser])])).toBe(false);
  });

  it("ignores interfaces whose endpoint was abandoned and captive interfaces", () => {
    const plan = makePlan({
      components: [
        { id: "base", description: "base", status: "todo", checks: [volumeCheck("base")] },
        { id: "lid", description: "lid", status: "abandoned", abandon_reason: "dropped" },
        { id: "pin", description: "pin", status: "todo", checks: [volumeCheck("pin")] },
      ],
      interfaces: [
        { a: "base", b: "lid", kind: "clearance", min_mm: 0 },
        { a: "base", b: "pin", kind: "captive" },
      ],
    });
    // The only live interface is captive (unmeasurable), so any gate-passed run
    // declaring the active components suffices.
    expect(hasAssemblyEvidence(plan, [gatePassedRun(["base", "pin"], [])])).toBe(true);
  });
});

describe("evidence and plan derivation from the transcript", () => {
  it("collects evidence only from gate-passed runs and ignores probes and failures", () => {
    const evidence = collectComponentEvidence([
      gatePassedRun("probe"),
      gatePassedRun(["base", "lid"]),
      {
        role: "toolResult",
        toolName: "run_build123d",
        details: { gate: { status: "failed" }, measurements: { component: "pin" } },
      },
    ]);
    expect([...evidence.keys()].sort()).toEqual(["base", "lid"]);
  });

  it("latestPlan returns the newest accepted snapshot and skips errored results", () => {
    const first = makePlan({ goal: "v1" });
    const second = makePlan({ goal: "v2" });
    const messages = [
      planResult(first),
      planResult(second),
      { role: "toolResult", toolName: "update_plan", isError: true, content: [], timestamp: 2 },
    ];
    expect(latestPlan(messages)?.goal).toBe("v2");
    expect(latestPlan([])).toBeUndefined();
  });

  it("planIncompleteComponents excludes done and abandoned", () => {
    const plan = makePlan({
      components: [
        { id: "a1", description: "a", status: "done" },
        { id: "a2", description: "b", status: "building" },
        { id: "a3", description: "c", status: "abandoned", abandon_reason: "gone" },
        { id: "a4", description: "d", status: "todo" },
      ],
    });
    expect(planIncompleteComponents(plan).map((c) => c.id)).toEqual(["a2", "a4"]);
  });

  it("runComponentIds normalizes string, array, and absent declarations", () => {
    expect(runComponentIds({ component: "lid" })).toEqual(["lid"]);
    expect(runComponentIds({ component: ["a", "b", 3 as unknown as string] })).toEqual(["a", "b"]);
    expect(runComponentIds({})).toEqual([]);
    expect(runComponentIds(undefined)).toEqual([]);
  });

  it("parses only one unambiguous top-level literal component declaration", () => {
    expect(parseComponentDeclaration('COMPONENT = "lid"\nresult = Box(1, 1, 1)')).toEqual(["lid"]);
    expect(parseComponentDeclaration('text = """\nCOMPONENT = "probe"\n"""\nresult = Box(1, 1, 1)')).toBeUndefined();
    expect(parseComponentDeclaration('COMPONENT = ["base", name]\nresult = Box(1, 1, 1)')).toBeUndefined();
    expect(parseComponentDeclaration('COMPONENT = "base"\nCOMPONENT = "probe"')).toBeUndefined();
    expect(parseComponentDeclaration('COMPONENT = b"probe"')).toBeUndefined();
  });
});

describe("createUpdatePlanTool", () => {
  it("accepts a valid snapshot and returns it in details with a compact text body", async () => {
    const tool = createUpdatePlanTool({ getMessages: () => [] });
    const result = await tool.execute("t1", makePlan() as never, undefined as never, undefined as never);
    expect(result.details?.plan.goal).toBe("two-part housing");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^Plan accepted: 2 components \(2 todo\), 1 interfaces\./);
    expect(text).toContain('"goal":"two-part housing"');
  });

  it("rejects an invalid snapshot with every error listed", async () => {
    const tool = createUpdatePlanTool({ getMessages: () => [planResult(makePlan())] });
    const next = makePlan({
      components: [{ id: "base", description: "base", status: "done" }],
      interfaces: [],
    });
    await expect(tool.execute("t1", next as never, undefined as never, undefined as never)).rejects.toThrow(
      /Plan rejected:[\s\S]*"lid" from the previous plan is missing[\s\S]*no gate-passed run/,
    );
  });
});
