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
import { SEQ1_PLAN, SEQ5_PLAN, SEQ44_PLAN, SEQ52_PLAN, SEQ74_PLAN, SEQ80_PLAN } from "./fixtures/gateGamingSession";

function volumeCheck(id: string, lo = 5000, hi = 6000): PlanCheckEntry {
  return { id: "volume", kind: "volume", range_mm3: [lo, hi], target: id };
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

  it("requires a spec sheet for an image-triggered plan", () => {
    const errors = validatePlanSnapshot({
      next: makePlan(),
      previous: undefined,
      evidence: noEvidence,
      requireSpecSheet: true,
    });
    expect(errors).toContain("spec_sheet is required for an image-triggered plan");
  });

  it("rejects spec rows without a check link or unverifiable reason", () => {
    const plan = makePlan({
      spec_sheet: [{ id: "image-width", text: "The overall width is 100 mm.", source: "image" }],
    });
    const errors = validatePlanSnapshot({
      next: plan,
      previous: undefined,
      evidence: noEvidence,
      requireSpecSheet: true,
    });
    expect(errors).toContain(
      'spec_sheet row "image-width": provide non-empty check_refs or a non-empty unverifiable_reason',
    );
  });

  it("rejects dangling spec-sheet check references and accepts existing component checks", () => {
    const plan = makePlan({
      spec_sheet: [
        {
          id: "image-width",
          text: "The overall width is 100 mm.",
          source: "image",
          check_refs: [{ component_id: "base", check_id: "ghost" }],
        },
      ],
    });
    const dangling = validatePlanSnapshot({
      next: plan,
      previous: undefined,
      evidence: noEvidence,
      requireSpecSheet: true,
    });
    expect(dangling).toContain(
      'spec_sheet row "image-width": check_refs[0] does not resolve to an existing component check ({"component_id":"base","check_id":"ghost"})',
    );

    plan.spec_sheet![0]!.check_refs = [{ component_id: "base", check_id: "volume" }];
    expect(
      validatePlanSnapshot({
        next: plan,
        previous: undefined,
        evidence: noEvidence,
        requireSpecSheet: true,
      }),
    ).toEqual([]);
  });

  it("rejects a snapshot that drops the previous plan's spec sheet", () => {
    const previous = makePlan({
      spec_sheet: [
        {
          id: "image-width",
          text: "The overall width is 100 mm.",
          source: "image",
          check_refs: [{ component_id: "base", check_id: "volume" }],
        },
      ],
    });
    const errors = validatePlanSnapshot({
      next: makePlan(),
      previous,
      evidence: noEvidence,
    });
    expect(errors).toContain(
      "spec_sheet cannot be dropped: the previous plan carries one; resubmit it (edited if needed)",
    );
  });

  it("accepts a non-empty unverifiable reason without check references", () => {
    const plan = makePlan({
      spec_sheet: [
        {
          id: "surface-finish",
          text: "The drawing calls for a matte surface finish.",
          source: "image",
          unverifiable_reason: "The geometry kernel cannot measure surface finish.",
        },
      ],
    });
    expect(
      validatePlanSnapshot({
        next: plan,
        previous: undefined,
        evidence: noEvidence,
        requireSpecSheet: true,
      }),
    ).toEqual([]);
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

  it("requires a reason for blocked components and allows them to resume building", () => {
    const blocked = makePlan();
    blocked.components[0]!.status = "blocked";
    expect(validatePlanSnapshot({ next: blocked, previous: undefined, evidence: noEvidence }).join("\n")).toMatch(
      /blocked_reason/,
    );

    blocked.components[0]!.blocked_reason = "The requested loft collapses in the geometry kernel.";
    expect(validatePlanSnapshot({ next: blocked, previous: undefined, evidence: noEvidence })).toEqual([]);

    const resumed = structuredClone(blocked);
    resumed.components[0]!.status = "building";
    delete resumed.components[0]!.blocked_reason;
    expect(validatePlanSnapshot({ next: resumed, previous: blocked, evidence: noEvidence })).toEqual([]);
    expect(planIncompleteComponents(resumed).map((component) => component.id)).toContain("base");
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
      { id: "holes", kind: "hole_through", diameter: -4, count: 1, target: "lid", surprise: true } as unknown as PlanCheckEntry,
    ];
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence }).join("\n");
    expect(errors).toMatch(/component "base": bbox_mm is required/);
    expect(errors).toMatch(/component "lid": check 1/);
    expect(errors).toMatch(/diameter must be a positive number/);
    expect(errors).toMatch(/unknown keys: \["surprise"\]/);
  });

  it("accepts the volume check targeting the component regardless of check order", () => {
    const plan = makePlan();
    plan.components[0]!.checks = [{ ...volumeCheck("lid"), id: "lid-volume" }, volumeCheck("base")];
    expect(validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence })).toEqual([]);
  });

  it("accepts wall thickness, anchored holes, and targeted symmetry checks", () => {
    const plan = makePlan();
    const checks: PlanCheckEntry[] = [
      volumeCheck("base"),
      { id: "wall", kind: "wall_thickness", range_mm: [3.4, 3.6], target: "base" },
      { id: "mount-hole", kind: "hole_through", diameter: 6.5, count: 1, at_mm: [30, 15, 0], tol: 0.25, target: "base" },
      { id: "symmetry", kind: "symmetric", plane: "YZ", target: "base" },
    ];
    plan.components[0]!.checks = checks;
    expect(validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence })).toEqual([]);
  });

  it("rejects malformed wall thickness and hole anchor fields", () => {
    const plan = makePlan();
    plan.components[0]!.checks = [
      volumeCheck("base"),
      { id: "wall", kind: "wall_thickness", range_mm: [4, 3], target: "base" },
      { id: "pocket", kind: "hole_blind", diameter: 5, count: 1, at_mm: [1, 2], target: "base" },
    ] as unknown as PlanCheckEntry[];
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence }).join("\n");
    expect(errors).toMatch(/range_mm must be \[min, max\] with 0 < min <= max/);
    expect(errors).toMatch(/at_mm must be three numbers/);
  });

  it("requires a targeted, bounded volume check on every buildable component", () => {
    const plan = makePlan();
    plan.components[0]!.checks = [];
    plan.components[1]!.checks = [{ id: "volume", kind: "volume", range_mm3: [1000, 10000], target: "lid" }];
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors.join("\n")).toMatch(/component "base": checks must include a volume check/);
    expect(errors.join("\n")).toMatch(/component "lid": volume range \[1000, 10000\] is too loose/);

    // An untargeted volume check does not count: it would measure the whole
    // assembly in a multi-component run.
    plan.components[0]!.checks = [{ id: "volume", kind: "volume", range_mm3: [5000, 6000] }];
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
    const check: PlanCheckEntry = { id: "holes", kind: "hole_through", diameter: 5.5, count: 4 };
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

describe("stable check identity", () => {
  const noEvidence = new Map();

  it("rejects a check without an id, naming the component and check", () => {
    const plan = makePlan();
    plan.components[0]!.checks = [
      { kind: "volume", range_mm3: [5000, 6000], target: "base" } as unknown as PlanCheckEntry,
    ];
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors.join("\n")).toMatch(/component "base": check 0: .*id must be a short slug/);
  });

  it("rejects duplicate check ids within a component but allows reuse across components", () => {
    const plan = makePlan();
    plan.components[0]!.checks = [
      volumeCheck("base"),
      { id: "volume", kind: "bbox", size_mm: [100, 80, 30], target: "base" },
    ];
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors).toContain('component "base": duplicate check id "volume"');

    // Both components carrying a check id "volume" is legitimate.
    expect(validatePlanSnapshot({ next: makePlan(), previous: undefined, evidence: noEvidence })).toEqual([]);
  });

  it("rejects a spec-sheet ref naming a check id that does not exist in the component", () => {
    const plan = makePlan({
      spec_sheet: [
        {
          id: "image-width",
          text: "The overall width is 100 mm.",
          source: "image",
          check_refs: [{ component_id: "base", check_id: "ghost" }],
        },
      ],
    });
    const errors = validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence });
    expect(errors).toContain(
      'spec_sheet row "image-width": check_refs[0] does not resolve to an existing component check ({"component_id":"base","check_id":"ghost"})',
    );
  });

  it("resolves spec-sheet refs by id regardless of check order", () => {
    const plan = makePlan({
      spec_sheet: [
        {
          id: "image-width",
          text: "The overall width is 100 mm.",
          source: "image",
          check_refs: [{ component_id: "base", check_id: "envelope" }],
        },
      ],
    });
    plan.components[0]!.checks = [
      { id: "envelope", kind: "bbox", size_mm: [100, 80, 30], target: "base" },
      volumeCheck("base"),
    ];
    expect(validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence })).toEqual([]);

    // Reordering the checks must not re-point or break the row's link.
    plan.components[0]!.checks = [
      volumeCheck("base"),
      { id: "envelope", kind: "bbox", size_mm: [100, 80, 30], target: "base" },
    ];
    expect(validatePlanSnapshot({ next: plan, previous: undefined, evidence: noEvidence })).toEqual([]);
  });

  it("accepts an id-based snapshot over a legacy previous without check ids", () => {
    const legacy = makePlan();
    legacy.components[0]!.checks = [
      { kind: "volume", range_mm3: [5000, 6000], target: "base" } as unknown as PlanCheckEntry,
    ];
    legacy.spec_sheet = [
      {
        id: "image-width",
        text: "The overall width is 100 mm.",
        source: "image",
        check_refs: [{ component_id: "base", check_index: 0 } as unknown as { component_id: string; check_id: string }],
      },
    ];
    const next = makePlan({
      spec_sheet: [
        {
          id: "image-width",
          text: "The overall width is 100 mm.",
          source: "image",
          check_refs: [{ component_id: "base", check_id: "volume" }],
        },
      ],
    });
    expect(validatePlanSnapshot({ next, previous: legacy, evidence: noEvidence })).toEqual([]);
  });

  it("compares done evidence on the harness check shape, ignoring the plan-only id", () => {
    const plan = makePlan();
    plan.components[0]!.status = "done";
    plan.components[0]!.checks = [
      { id: "holes", kind: "hole_through", diameter: 5.5, count: 4, target: "base" },
      volumeCheck("base"),
    ];
    // Run CHECKS entries never carry ids; the id must not break evidence matching.
    const evidence = collectComponentEvidence([
      gatePassedRun("base", [
        { kind: "hole_through", diameter: 5.5, count: 4, target: "base" },
        { kind: "volume", range_mm3: [5000, 6000], target: "base" },
      ]),
    ]);
    expect(validatePlanSnapshot({ next: plan, previous: undefined, evidence })).toEqual([]);
  });

  // Session regression: seq 1 planned 7 checks with spec rows pointing at them by
  // index; the seq 5 revision deleted the wall_thickness and boss checks. Under
  // index refs the surviving rows silently re-pointed at unrelated checks; under
  // id refs the same edit must surface every orphaned row.
  it("gate-gaming regression: deleting checks dangles their spec rows instead of re-pointing", () => {
    const next = structuredClone(SEQ1_PLAN);
    next.components[0]!.checks = next.components[0]!.checks!.filter(
      (check) => check.id !== "wall" && check.id !== "bosses",
    );
    const errors = validatePlanSnapshot({ next, previous: SEQ1_PLAN, evidence: noEvidence });
    const dangling = errors.filter((e) => e.includes("does not resolve to an existing component check"));
    expect(dangling.some((e) => e.includes('spec_sheet row "shell-wall"'))).toBe(true);
    expect(dangling.some((e) => e.includes('spec_sheet row "bosses"'))).toBe(true);
    expect(dangling).toHaveLength(2);
  });
});

describe("check monotonicity", () => {
  const noEvidence = new Map();

  /** A one-component plan whose single component carries the given checks. */
  function checkedPlan(checks: PlanCheckEntry[]): Plan {
    return makePlan({
      components: [
        {
          id: "base",
          description: "housing base",
          bbox_mm: [100, 80, 30],
          status: "building",
          free_floating_reason: "single part",
          checks,
        },
      ],
      interfaces: [],
    });
  }

  function validateRevision(previousChecks: PlanCheckEntry[], nextChecks: PlanCheckEntry[]): string[] {
    return validatePlanSnapshot({
      next: checkedPlan(nextChecks),
      previous: checkedPlan(previousChecks),
      evidence: noEvidence,
    });
  }

  const baseVolume: PlanCheckEntry = { id: "volume", kind: "volume", range_mm3: [5000, 6000], target: "base" };

  it("rejects widening a range without a revision_reason and accepts it with one", () => {
    const widened: PlanCheckEntry = { id: "volume", kind: "volume", range_mm3: [5000, 7000], target: "base" };
    const errors = validateRevision([baseVolume], [widened]);
    expect(errors.join("\n")).toMatch(/component "base": check "volume": range_mm3 \[5000, 7000\] is not within the previous \[5000, 6000\]/);
    expect(errors.join("\n")).toMatch(/revision_reason/);

    const reasoned = { ...widened, revision_reason: "The drawing's rib volume was excluded from the first estimate." };
    expect(validateRevision([baseVolume], [reasoned])).toEqual([]);
  });

  it("rejects loosening a tolerance without a reason, including the documented default", () => {
    const tight: PlanCheckEntry = { id: "envelope", kind: "bbox", size_mm: [100, 80, 30], tol: 0.5, target: "base" };
    const loose: PlanCheckEntry = { id: "envelope", kind: "bbox", size_mm: [100, 80, 30], tol: 2, target: "base" };
    const errors = validateRevision([baseVolume, tight], [baseVolume, loose]);
    expect(errors.join("\n")).toMatch(/component "base": check "envelope": tol raised from 0.5 to 2/);

    // Removing an explicit tol falls back to the documented default (0.5): not a weakening here.
    const defaulted: PlanCheckEntry = { id: "envelope", kind: "bbox", size_mm: [100, 80, 30], target: "base" };
    expect(validateRevision([baseVolume, tight], [baseVolume, defaulted])).toEqual([]);
    // But dropping tol from a tighter-than-default check is a weakening.
    const tighter: PlanCheckEntry = { id: "envelope", kind: "bbox", size_mm: [100, 80, 30], tol: 0.2, target: "base" };
    expect(validateRevision([baseVolume, tighter], [baseVolume, defaulted]).join("\n")).toMatch(/tol raised from 0.2 to 0.5/);
  });

  it("rejects deleting a check outright and accepts a removed tombstone with a reason", () => {
    const holes: PlanCheckEntry = { id: "holes", kind: "hole_through", diameter: 6, count: 4, target: "base" };
    const errors = validateRevision([baseVolume, holes], [baseVolume]);
    expect(errors.join("\n")).toMatch(/component "base": check "holes" was deleted without a trace/);
    expect(errors.join("\n")).toMatch(/"removed": true/);

    const tombstone = { ...holes, removed: true as const, revision_reason: "The four corner holes are not visible in any view." };
    expect(validateRevision([baseVolume, holes], [baseVolume, tombstone])).toEqual([]);

    // A tombstone without a reason is structurally invalid.
    const silent = { ...holes, removed: true as const };
    expect(validateRevision([baseVolume, holes], [baseVolume, silent]).join("\n")).toMatch(/removed.*revision_reason|revision_reason.*removed/);
  });

  it("rejects kind, target, and hole-count changes without a reason", () => {
    const holes: PlanCheckEntry = { id: "holes", kind: "hole_through", diameter: 6, count: 4, target: "base" };
    const kindChanged = validateRevision(
      [baseVolume, holes],
      [baseVolume, { id: "holes", kind: "hole_blind", diameter: 6, count: 4, target: "base" }],
    );
    expect(kindChanged.join("\n")).toMatch(/check "holes": kind changed from "hole_through" to "hole_blind"/);

    const countReduced = validateRevision(
      [baseVolume, holes],
      [baseVolume, { id: "holes", kind: "hole_through", diameter: 6, count: 2, target: "base" }],
    );
    expect(countReduced.join("\n")).toMatch(/check "holes": count changed from 4 to 2/);

    const retargeted = validateRevision(
      [{ ...baseVolume, target: "base" }],
      [{ id: "volume", kind: "volume", range_mm3: [5000, 6000], target: "lid" }],
    );
    expect(retargeted.join("\n")).toMatch(/check "volume": target changed/);
  });

  it("accepts pure tightening and new checks without reasons", () => {
    const next: PlanCheckEntry[] = [
      { id: "volume", kind: "volume", range_mm3: [5200, 5800], target: "base" },
      { id: "envelope", kind: "bbox", size_mm: [100, 80, 30], tol: 0.2, target: "base" },
      { id: "wall", kind: "wall_thickness", range_mm: [2.8, 3.2], target: "base" },
    ];
    expect(
      validateRevision([baseVolume, { id: "envelope", kind: "bbox", size_mm: [100, 80, 30], tol: 0.5, target: "base" }], next),
    ).toEqual([]);
  });

  it("treats bbox size_mm as sorted, like the harness compare", () => {
    const prev: PlanCheckEntry = { id: "envelope", kind: "bbox", size_mm: [180, 95, 260], tol: 2, target: "base" };
    const reordered: PlanCheckEntry = { id: "envelope", kind: "bbox", size_mm: [95, 180, 260], tol: 2, target: "base" };
    expect(validateRevision([baseVolume, prev], [baseVolume, reordered])).toEqual([]);
  });

  it("exempts checks on components abandoned in the next snapshot", () => {
    const previous = checkedPlan([baseVolume]);
    const next = checkedPlan([]);
    next.components[0]!.status = "abandoned";
    next.components[0]!.abandon_reason = "the user removed the part";
    next.components[0]!.checks = [];
    expect(validatePlanSnapshot({ next, previous, evidence: noEvidence })).toEqual([]);
  });

  it("keeps a recorded revision_reason and a tombstone in later snapshots", () => {
    const widened: PlanCheckEntry = {
      id: "volume",
      kind: "volume",
      range_mm3: [5000, 7000],
      target: "base",
      revision_reason: "Recount of the rib volume.",
    };
    // Dropping the reason next snapshot hides the audit trail: rejected.
    const dropped = validateRevision([widened], [{ id: "volume", kind: "volume", range_mm3: [5000, 7000], target: "base" }]);
    expect(dropped.join("\n")).toMatch(/check "volume": revision_reason cannot be dropped once recorded/);

    // A tombstone cannot silently vanish either.
    const tombstone = {
      id: "holes",
      kind: "hole_through",
      diameter: 6,
      count: 4,
      target: "base",
      removed: true,
      revision_reason: "Not visible in any view.",
    } as PlanCheckEntry;
    const vanished = validateRevision([baseVolume, tombstone], [baseVolume]);
    expect(vanished.join("\n")).toMatch(/check "holes" was deleted without a trace/);
    // Carrying it forward is fine, and reinstating it as a live check is free.
    expect(validateRevision([baseVolume, tombstone], [baseVolume, tombstone])).toEqual([]);
    const reinstated: PlanCheckEntry = { id: "holes", kind: "hole_through", diameter: 6, count: 4, target: "base" };
    expect(validateRevision([baseVolume, tombstone], [baseVolume, reinstated])).toEqual([]);
  });

  it("pairs legacy previous checks by content so unchanged checks need no reason", () => {
    const legacyPrevious = checkedPlan([
      { kind: "volume", range_mm3: [5000, 6000], target: "base" } as unknown as PlanCheckEntry,
      { kind: "bbox", size_mm: [100, 80, 30], tol: 0.5, target: "base" } as unknown as PlanCheckEntry,
    ]);
    // Same criteria, ids introduced, order swapped: free.
    const next = checkedPlan([
      { id: "envelope", kind: "bbox", size_mm: [100, 80, 30], tol: 0.5, target: "base" },
      baseVolume,
    ]);
    expect(validatePlanSnapshot({ next, previous: legacyPrevious, evidence: noEvidence })).toEqual([]);

    // Weakening while introducing ids still trips the ratchet (positional pairing).
    const weakened = checkedPlan([
      { id: "volume", kind: "volume", range_mm3: [4000, 6000], target: "base" },
      { id: "envelope", kind: "bbox", size_mm: [100, 80, 30], tol: 0.5, target: "base" },
    ]);
    expect(
      validatePlanSnapshot({ next: weakened, previous: legacyPrevious, evidence: noEvidence }).join("\n"),
    ).toMatch(/check "volume": range_mm3 \[4000, 6000\] is not within the previous \[5000, 6000\]/);
  });

  // Session regressions: the three real weakening steps, replayed as snapshot pairs.
  it("gate-gaming regression: each recorded weakening step is rejected without reasons", () => {
    const seq1to5 = validatePlanSnapshot({ next: SEQ5_PLAN, previous: SEQ1_PLAN, evidence: noEvidence }).join("\n");
    expect(seq1to5).toMatch(/check "wall" was deleted without a trace/);
    expect(seq1to5).toMatch(/check "bosses" was deleted without a trace/);
    expect(seq1to5).toMatch(/check "volume": range_mm3 \[230000, 310000\] is not within the previous \[130000, 190000\]/);

    const seq44to52 = validatePlanSnapshot({ next: SEQ52_PLAN, previous: SEQ44_PLAN, evidence: noEvidence }).join("\n");
    expect(seq44to52).toMatch(/check "envelope": tol raised from 1.5 to 2/);
    expect(seq44to52).toMatch(/check "nozzle": tol raised from 0.8 to 1/);
    expect(seq44to52).toMatch(/check "symmetry": plane changed/);
    expect(seq44to52).toMatch(/check "symmetry": tol_pct raised from 3 to 5/);
    expect(seq44to52).toMatch(/check "volume": range_mm3 \[230000, 300000\] is not within the previous \[245000, 300000\]/);
    expect(seq44to52).toMatch(/check "button-hole" was deleted without a trace/);
    expect(seq44to52).toMatch(/check "buttons" was deleted without a trace/);

    const seq74to80 = validatePlanSnapshot({ next: SEQ80_PLAN, previous: SEQ74_PLAN, evidence: noEvidence }).join("\n");
    expect(seq74to80).toMatch(/check "symmetry" was deleted without a trace/);
    expect(seq74to80).toMatch(/check "volume": range_mm3 \[220000, 300000\] is not within the previous \[230000, 300000\]/);
  });

  it("gate-gaming regression: the same steps pass once every weakening carries a reason", () => {
    const reasoned = structuredClone(SEQ80_PLAN);
    const checks = reasoned.components[0]!.checks!;
    checks.find((c) => c.id === "volume")!.revision_reason = "Physical shell volume re-derived from the actual wall layout.";
    checks.push({
      id: "symmetry",
      kind: "symmetric",
      plane: "XZ",
      tol_pct: 5,
      target: "shell",
      removed: true,
      revision_reason: "The asymmetric nozzle makes the mirror check unusable.",
    } as PlanCheckEntry);
    expect(validatePlanSnapshot({ next: reasoned, previous: SEQ74_PLAN, evidence: noEvidence })).toEqual([]);
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

  it("planIncompleteComponents excludes done, abandoned, and blocked", () => {
    const plan = makePlan({
      components: [
        { id: "a1", description: "a", status: "done" },
        { id: "a2", description: "b", status: "building" },
        { id: "a3", description: "c", status: "abandoned", abandon_reason: "gone" },
        { id: "a4", description: "d", status: "todo" },
        { id: "a5", description: "e", status: "blocked", blocked_reason: "kernel limitation" },
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

  it("rejects an image-triggered snapshot without a spec sheet", async () => {
    const tool = createUpdatePlanTool({ getMessages: () => [], requireSpecSheet: () => true });
    await expect(tool.execute("t1", makePlan() as never, undefined as never, undefined as never)).rejects.toThrow(
      /Plan rejected:[\s\S]*spec_sheet is required for an image-triggered plan/,
    );
  });

  it("confirms newly accepted check revisions in the tool result text", async () => {
    const previous = makePlan();
    const tool = createUpdatePlanTool({ getMessages: () => [planResult(previous)] });
    const next = makePlan();
    next.components[0]!.checks = [
      {
        id: "volume",
        kind: "volume",
        range_mm3: [4500, 6000],
        target: "base",
        revision_reason: "The pocket volume was missing from the estimate.",
      },
    ];
    const result = await tool.execute("t1", next as never, undefined as never, undefined as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Check revisions recorded and shown to the user:");
    expect(text).toContain('base/volume: The pocket volume was missing from the estimate.');

    // Resubmitting the same snapshot records nothing new.
    const again = await tool
      .execute("t2", next as never, undefined as never, undefined as never)
      .catch(() => undefined);
    // (previous is still the old plan in this stub, so the confirmation repeats;
    // the no-repeat behavior is asserted through getMessages returning the accepted snapshot)
    const toolWithHistory = createUpdatePlanTool({ getMessages: () => [planResult(previous), planResult(next)] });
    const repeat = await toolWithHistory.execute("t3", next as never, undefined as never, undefined as never);
    const repeatText = (repeat.content[0] as { text: string }).text;
    expect(repeatText).not.toContain("Check revisions recorded and shown to the user:");
    expect(again).toBeDefined();
  });

  it("returns a row-level update_plan error for an unmapped spec row", async () => {
    const tool = createUpdatePlanTool({ getMessages: () => [], requireSpecSheet: () => true });
    const plan = makePlan({
      spec_sheet: [{ id: "finish", text: "The finish is matte.", source: "image" }],
    });
    await expect(tool.execute("t1", plan as never, undefined as never, undefined as never)).rejects.toThrow(
      /spec_sheet row "finish": provide non-empty check_refs or a non-empty unverifiable_reason/,
    );
  });
});
