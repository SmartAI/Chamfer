import { describe, expect, it } from "vitest";
import {
  collectComponentEvidence,
  collectFusionComponentEvidence,
  collectComponentMeasurements,
  applyPlanEvidenceAnnotations,
  FORM_REVIEW_VIEWS,
  hasAssemblyEvidence,
  latestPlan,
  normalizePlanSnapshot,
  parseComponentDeclaration,
  planIncompleteComponents,
  runComponentIds,
  validatePlanSnapshot,
  validateFusionActionPlan,
  type Plan,
  type PlanCheckEntry,
} from "./plan";
import { createRetiredUpdatePlanTool, createUpdatePlanTool } from "./tools/updatePlan";
import { SEQ105_GATE_EVIDENCE, SEQ106_DONE_WITHOUT_FORM_REVIEW, SEQ106_PREVIOUS_PLAN } from "./fixtures/gateGamingFormReview";
import {
  SEQ1_PLAN,
  SEQ5_PLAN,
  SEQ44_PLAN,
  SEQ52_PLAN,
  SEQ74_PLAN,
  SEQ80_PLAN,
  SEQ91_SHELL_MEASUREMENT,
  SEQ100_PLAN,
} from "./fixtures/gateGamingSession";
import {
  BOOKKEEPING_CURRENT_EVIDENCE,
  BOOKKEEPING_FRESH_REASON,
  BOOKKEEPING_FRESH_SPEC_REASON,
  BOOKKEEPING_PREVIOUS_PLAN,
  BOOKKEEPING_PRIOR_REASON,
  BOOKKEEPING_PRIOR_SPEC_REASON,
  BOOKKEEPING_STALE_EVIDENCE_PLAN,
  bookkeepingFurtherWeakening,
  bookkeepingSpecRepoint,
} from "./fixtures/planBookkeepingRegression";

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

function gatePassedRun(component: string | string[], checks: unknown[] = [], measurements: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "toolResult",
    toolName: "run_build123d",
    isError: false,
    content: [],
    details: { gate: { status: "passed", checks: [] }, measurements: { component, checks, ...measurements } },
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

  it("rejects spec rows without a check link or unverifiable reason", () => {
    const plan = makePlan({
      spec_sheet: [{ id: "image-width", text: "The overall width is 100 mm.", source: "image" }],
    });
    const errors = validatePlanSnapshot({
      next: plan,
      previous: undefined,
      evidence: noEvidence,
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

  it("keeps every published spec-sheet row by stable id", () => {
    const previous = makePlan({
      spec_sheet: [
        {
          id: "image-width",
          text: "The overall width is 100 mm.",
          source: "image",
          check_refs: [{ component_id: "base", check_id: "volume" }],
        },
        {
          id: "surface-finish",
          text: "The drawing calls for a matte surface finish.",
          source: "image",
          unverifiable_reason: "The geometry kernel cannot measure surface finish.",
        },
      ],
    });
    const next = structuredClone(previous);
    next.spec_sheet = next.spec_sheet!.filter((row) => row.id !== "surface-finish");

    expect(validatePlanSnapshot({ next, previous, evidence: noEvidence })).toContain(
      'spec_sheet row "surface-finish" from the previous plan is missing: published rows cannot be deleted',
    );
  });

  it("requires a persistent revision reason when a spec row is repointed or downgraded", () => {
    const previous = makePlan({
      components: makePlan().components.map((component) =>
        component.id === "base"
          ? {
              ...component,
              checks: [
                volumeCheck("base"),
                { id: "envelope", kind: "bbox" as const, size_mm: [100, 80, 30], target: "base" },
              ],
            }
          : component,
      ),
      spec_sheet: [
        {
          id: "image-width",
          text: "The overall width is 100 mm.",
          source: "image",
          check_refs: [{ component_id: "base", check_id: "envelope" }],
        },
      ],
    });
    const repointed = structuredClone(previous);
    repointed.spec_sheet![0]!.check_refs = [{ component_id: "base", check_id: "volume" }];
    expect(validatePlanSnapshot({ next: repointed, previous, evidence: noEvidence }).join("\n")).toMatch(
      /spec_sheet row "image-width".*repointed.*revision_reason/,
    );

    repointed.spec_sheet![0]!.revision_reason = "The image dimension labels material volume, not the envelope.";
    expect(validatePlanSnapshot({ next: repointed, previous, evidence: noEvidence })).toEqual([]);

    const repointedAgain = structuredClone(repointed);
    repointedAgain.spec_sheet![0]!.check_refs = [{ component_id: "base", check_id: "envelope" }];
    expect(validatePlanSnapshot({ next: repointedAgain, previous: repointed, evidence: noEvidence }).join("\n")).toMatch(
      /append a new explanation.*previous revision_reason/,
    );
    repointedAgain.spec_sheet![0]!.revision_reason =
      "The image dimension labels material volume, not the envelope. A clearer source image restores the envelope callout.";
    expect(validatePlanSnapshot({ next: repointedAgain, previous: repointed, evidence: noEvidence })).toEqual([]);

    const reasonDropped = structuredClone(repointed);
    delete reasonDropped.spec_sheet![0]!.revision_reason;
    expect(validatePlanSnapshot({ next: reasonDropped, previous: repointed, evidence: noEvidence }).join("\n")).toMatch(
      /revision_reason cannot be dropped/,
    );

    const downgraded = structuredClone(previous);
    delete downgraded.spec_sheet![0]!.check_refs;
    downgraded.spec_sheet![0]!.unverifiable_reason = "The drawing is too blurred to verify the dimension.";
    expect(validatePlanSnapshot({ next: downgraded, previous, evidence: noEvidence }).join("\n")).toMatch(
      /spec_sheet row "image-width".*unverifiable.*revision_reason/,
    );
    downgraded.spec_sheet![0]!.revision_reason = "The source crop is illegible at its native resolution.";
    expect(validatePlanSnapshot({ next: downgraded, previous, evidence: noEvidence })).toEqual([]);
  });

  it("allows spec-row text edits and new rows without revision reasons", () => {
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
    const next = structuredClone(previous);
    next.spec_sheet![0]!.text = "The overall body width is 100 mm.";
    next.spec_sheet!.push({
      id: "surface-finish",
      text: "The drawing calls for a matte surface finish.",
      source: "image",
      unverifiable_reason: "The geometry kernel cannot measure surface finish.",
    });

    expect(validatePlanSnapshot({ next, previous, evidence: noEvidence })).toEqual([]);
  });

  it("gate-gaming regression: rejects deleted and silently downgraded image evidence rows", () => {
    const weakened = structuredClone(SEQ1_PLAN);
    weakened.spec_sheet = weakened.spec_sheet!
      .filter((row) => !new Set(["buttons", "bosses", "vent-pattern"]).has(row.id))
      .map((row) =>
        row.id === "shell-wall"
          ? {
              ...row,
              check_refs: undefined,
              unverifiable_reason: "Confirmed visually rather than by a kernel check.",
            }
          : row,
      );

    const errors = validatePlanSnapshot({ next: weakened, previous: SEQ1_PLAN, evidence: noEvidence }).join("\n");
    expect(errors).toContain('spec_sheet row "buttons" from the previous plan is missing');
    expect(errors).toContain('spec_sheet row "bosses" from the previous plan is missing');
    expect(errors).toContain('spec_sheet row "vent-pattern" from the previous plan is missing');
    expect(errors).toMatch(/spec_sheet row "shell-wall" was downgraded to unverifiable.*revision_reason/);

    const reasoned = structuredClone(SEQ1_PLAN);
    const wall = reasoned.spec_sheet!.find((row) => row.id === "shell-wall")!;
    delete wall.check_refs;
    wall.unverifiable_reason = "The kernel cannot sample the compound curvature reliably.";
    wall.revision_reason = "The source dimension describes nominal thickness across a blended transition.";
    expect(validatePlanSnapshot({ next: reasoned, previous: SEQ1_PLAN, evidence: noEvidence })).toEqual([]);
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

  it("requires a complete all-match form review tied to the latest evidence for image-plan done transitions", () => {
    const previous = makePlan({
      components: [{ id: "base", description: "housing base", bbox_mm: [100, 80, 30], status: "building", checks: [volumeCheck("base")], free_floating_reason: "single component" }],
      interfaces: [],
      spec_sheet: [{ id: "outline", text: "Rounded housing outline.", source: "image", check_refs: [{ component_id: "base", check_id: "volume" }] }],
    });
    const next = structuredClone(previous);
    next.components[0]!.status = "done";
    const evidence = collectComponentEvidence([{ ...gatePassedRun("base", [{ target: "base", range_mm3: [5000, 6000], kind: "volume" }]), toolCallId: "run-latest" }]);

    expect(validatePlanSnapshot({ next, previous, evidence }).join("\n")).toMatch(/form_review.*isometric/i);

    next.components[0]!.form_review = {
      evidence_id: "run-latest",
      views: [
        { view: "isometric", verdict: "match", note: "Overall form matches." },
        { view: "front", verdict: "match", note: "Front outline matches." },
        { view: "back", verdict: "match", note: "Back outline matches." },
        { view: "left", verdict: "match", note: "Left profile matches." },
        { view: "right", verdict: "mismatch", note: "Neck bends too far." },
        { view: "top", verdict: "match", note: "Top outline matches." },
        { view: "bottom", verdict: "match", note: "Bottom outline matches." },
      ],
    };
    expect(validatePlanSnapshot({ next, previous, evidence }).join("\n")).toMatch(/right.*mismatch/i);

    next.components[0]!.form_review.views[4] = { view: "right", verdict: "match", note: "Right profile matches." };
    next.components[0]!.form_review.evidence_id = "run-stale";
    expect(validatePlanSnapshot({ next, previous, evidence }).join("\n")).toMatch(/run-stale.*latest gate-passed evidence.*run-latest/i);

    next.components[0]!.form_review.evidence_id = "run-latest";
    expect(validatePlanSnapshot({ next, previous, evidence })).toEqual([]);
  });

  it("leaves text-only done transitions unaffected by form review", () => {
    const previous = makePlan();
    previous.components[0]!.status = "building";
    const next = structuredClone(previous);
    next.components[0]!.status = "done";
    const evidence = collectComponentEvidence([{ ...gatePassedRun("base", [{ target: "base", range_mm3: [5000, 6000], kind: "volume" }]), toolCallId: "run-1" }]);
    expect(validatePlanSnapshot({ next, previous, evidence })).toEqual([]);
  });

  it("keeps image form review permanent and tied to the latest evidence after completion", () => {
    const previous = structuredClone(SEQ106_PREVIOUS_PLAN);
    const evidence = collectComponentEvidence([SEQ105_GATE_EVIDENCE]);
    const done = structuredClone(SEQ106_DONE_WITHOUT_FORM_REVIEW);
    const views = FORM_REVIEW_VIEWS.map((view) => ({ view, verdict: "match" as const, note: `${view} matches.` }));
    done.components[0]!.form_review = { evidence_id: "seq-105-run", views };
    expect(validatePlanSnapshot({ next: done, previous, evidence })).toEqual([]);

    const dropped = structuredClone(done);
    delete dropped.components[0]!.form_review;
    expect(validatePlanSnapshot({ next: dropped, previous: done, evidence }).join("\n")).toMatch(
      /form_review is missing the isometric view/,
    );

    const newerEvidence = collectComponentEvidence([
      SEQ105_GATE_EVIDENCE,
      { ...SEQ105_GATE_EVIDENCE, toolCallId: "seq-107-run", timestamp: 107 },
    ]);
    expect(validatePlanSnapshot({ next: done, previous: done, evidence: newerEvidence }).join("\n")).toMatch(
      /seq-105-run.*latest gate-passed evidence.*seq-107-run/,
    );
  });

  it("gate-gaming regression: rejects the scrubbed seq 106 done transition without a form review", () => {
    const evidence = collectComponentEvidence([SEQ105_GATE_EVIDENCE]);
    expect(
      validatePlanSnapshot({ next: SEQ106_DONE_WITHOUT_FORM_REVIEW, previous: SEQ106_PREVIOUS_PLAN, evidence }).join("\n"),
    ).toMatch(/form_review is missing the isometric view/);
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

  it("requires each later weakening to append a fresh reason without erasing history", () => {
    const previouslyWidened: PlanCheckEntry = {
      id: "volume",
      kind: "volume",
      range_mm3: [4500, 6500],
      target: "base",
      revision_reason: "Included the internal rib volume.",
    };
    const widenedAgain: PlanCheckEntry = {
      ...previouslyWidened,
      range_mm3: [4400, 6500],
    };
    expect(validateRevision([previouslyWidened], [widenedAgain]).join("\n")).toMatch(
      /append a new explanation.*previous revision_reason/,
    );

    widenedAgain.revision_reason =
      "Included the internal rib volume. Later review found an omitted mounting flange.";
    expect(validateRevision([previouslyWidened], [widenedAgain])).toEqual([]);
  });

  it("accepts subset tightening for face and edge count intervals", () => {
    const previousCounts: PlanCheckEntry[] = [
      baseVolume,
      { id: "faces", kind: "count_faces", count: [10, 20], target: "base" },
      { id: "edges", kind: "count_edges", count: [20, 40], target: "base" },
    ];
    const tightened: PlanCheckEntry[] = [
      baseVolume,
      { id: "faces", kind: "count_faces", count: [12, 18], target: "base" },
      { id: "edges", kind: "count_edges", count: [25, 35], target: "base" },
    ];
    expect(validateRevision(previousCounts, tightened)).toEqual([]);
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

  it("flags the scrubbed seq 80 to 100 volume refit around the latest failed-gate measurement", () => {
    const evidence = new Map([
      ["shell", { checks: new Set<string>(), latestMeasurements: { volumeMm3: SEQ91_SHELL_MEASUREMENT } }],
    ]);
    const annotated = applyPlanEvidenceAnnotations(SEQ100_PLAN, SEQ80_PLAN, evidence);
    expect(annotated.components[0]!.checks!.find((check) => check.id === "volume")).toMatchObject({
      refit_to_measurement: true,
      revision_reason: "The measured shell includes the swept neck and nozzle wall.",
    });
    expect(validatePlanSnapshot({ next: annotated, previous: SEQ80_PLAN, evidence })).toEqual([]);
  });

  it("flags every range-shaped check only when its revision newly captures the latest measurement", () => {
    const previous = checkedPlan([
      baseVolume,
      { id: "wall", kind: "wall_thickness", range_mm: [2, 3], target: "base" },
      { id: "faces", kind: "count_faces", count: [10, 20], target: "base" },
      { id: "edges", kind: "count_edges", count: [20, 30], target: "base" },
    ]);
    const next = checkedPlan([
      { ...baseVolume, range_mm3: [5900, 6500], revision_reason: "Recomputed material volume." },
      { id: "wall", kind: "wall_thickness", range_mm: [3, 4], target: "base", revision_reason: "Corrected the wall interval." },
      { id: "faces", kind: "count_faces", count: [20, 30], target: "base", revision_reason: "Included blended faces." },
      { id: "edges", kind: "count_edges", count: [25, 35], target: "base", revision_reason: "Included seam edges." },
    ]);
    const evidence = new Map([
      ["base", { checks: new Set<string>(), latestMeasurements: { volumeMm3: 6200, wallThicknessMm: [3.2, 3.8] as [number, number], faceCount: 24, edgeCount: 25 } }],
    ]);
    const checks = applyPlanEvidenceAnnotations(next, previous, evidence).components[0]!.checks!;
    expect(checks.map((check) => [check.id, check.refit_to_measurement])).toEqual([
      ["volume", true],
      ["wall", true],
      ["faces", true],
      ["edges", undefined],
    ]);
  });

  it("does not flag without a measurement or when the previous interval already contained it, and preserves old flags", () => {
    const previous = checkedPlan([{ ...baseVolume, refit_to_measurement: true } as PlanCheckEntry]);
    const revised = checkedPlan([{ ...baseVolume, range_mm3: [4500, 6500], revision_reason: "Re-estimated volume." }]);
    expect(applyPlanEvidenceAnnotations(revised, previous, new Map()).components[0]!.checks![0]).toMatchObject({
      refit_to_measurement: true,
    });
    const unflaggedPrevious = checkedPlan([baseVolume]);
    const evidence = new Map([["base", { checks: new Set<string>(), latestMeasurements: { volumeMm3: 5500 } }]]);
    expect(applyPlanEvidenceAnnotations(revised, unflaggedPrevious, evidence).components[0]!.checks![0]!.refit_to_measurement).toBeUndefined();
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

  it("retains the newest measurements from a failed gate separately from completion evidence", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "run_build123d",
        isError: false,
        details: {
          gate: { status: "passed", checks: [] },
          measurements: { component: "shell", checks: [], volumeMm3: 250000 },
        },
      },
      {
        role: "toolResult",
        toolName: "run_build123d",
        isError: false,
        details: {
          gate: { status: "failed", checks: [] },
          measurements: { component: "shell", checks: [], volumeMm3: SEQ91_SHELL_MEASUREMENT },
        },
      },
    ];
    expect(collectComponentMeasurements(messages).get("shell")?.volumeMm3).toBe(SEQ91_SHELL_MEASUREMENT);
    expect(collectComponentEvidence(messages).get("shell")?.checks).toEqual(new Set());
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

describe("retired update_plan compatibility tool", () => {
  it("rejects a new snapshot and names create_plan recovery", async () => {
    const tool = createRetiredUpdatePlanTool({ getMessages: () => [] });
    expect(tool.parameters).toMatchObject({ properties: {}, additionalProperties: true });
    expect(JSON.stringify(tool.parameters)).not.toMatch(/"(?:goal|components|interfaces|spec_sheet)"/);
    await expect(tool.execute("t1", makePlan() as never)).rejects.toThrow(
      /update_plan is retired and no plan was changed[\s\S]*create_plan/,
    );
  });

  it("rejects a legacy replacement without changing the stored snapshot", async () => {
    const legacy = makePlan();
    const tool = createRetiredUpdatePlanTool({ getMessages: () => [planResult(legacy)] });
    const omittedState = makePlan({ components: [legacy.components[0]!], interfaces: [] });

    await expect(tool.execute("t1", omittedState as never)).rejects.toThrow(
      /stored legacy snapshot remains unchanged[\s\S]*create_plan[\s\S]*transition_from_legacy=true[\s\S]*revise_plan/,
    );
    expect(latestPlan([planResult(legacy)])).toEqual(legacy);
  });

  it("routes attempted domain snapshot replacement to revise_plan", async () => {
    const domain = {
      ...makePlan(),
      domain: { format: "domain-operations-v1" },
    } as Plan;
    const tool = createRetiredUpdatePlanTool({ getMessages: () => [planResult(domain)] });
    await expect(tool.execute("t1", makePlan() as never)).rejects.toThrow(
      /no plan was changed[\s\S]*revise_plan[\s\S]*explicit domain operations/,
    );
  });

  it("binds form review to current evidence and restores accepted audit bookkeeping before validation", async () => {
    const messages = [planResult(BOOKKEEPING_PREVIOUS_PLAN), BOOKKEEPING_CURRENT_EVIDENCE];
    const tool = createUpdatePlanTool({ getMessages: () => messages });

    const result = await tool.execute("normalize-current-evidence", BOOKKEEPING_STALE_EVIDENCE_PLAN as never);

    const component = result.details?.plan.components[0]!;
    expect(component.form_review?.evidence_id).toBe("current-widget-evidence");
    expect(component.checks?.[0]).toMatchObject({
      revision_reason: BOOKKEEPING_PRIOR_REASON,
      refit_to_measurement: true,
    });
    expect(result.details?.plan.spec_sheet?.[0]?.revision_reason).toBe(BOOKKEEPING_PRIOR_SPEC_REASON);
  });

  it("binds form review to current evidence even without a prior accepted plan", async () => {
    const tool = createUpdatePlanTool({ getMessages: () => [BOOKKEEPING_CURRENT_EVIDENCE] });

    const result = await tool.execute("normalize-initial-evidence", BOOKKEEPING_STALE_EVIDENCE_PLAN as never);

    expect(result.details?.plan.components[0]!.form_review?.evidence_id).toBe("current-widget-evidence");
  });

  it("appends standalone fresh check and spec explanations to exact accepted history", async () => {
    const checkTool = createUpdatePlanTool({ getMessages: () => [planResult(BOOKKEEPING_PREVIOUS_PLAN)] });
    const checkResult = await checkTool.execute("append-check-reason", bookkeepingFurtherWeakening() as never);
    expect(checkResult.details?.plan.components[0]!.checks?.[0]).toMatchObject({
      revision_reason: `${BOOKKEEPING_PRIOR_REASON}\n${BOOKKEEPING_FRESH_REASON}`,
      refit_to_measurement: true,
    });

    const specTool = createUpdatePlanTool({ getMessages: () => [planResult(BOOKKEEPING_PREVIOUS_PLAN)] });
    const specResult = await specTool.execute("append-spec-reason", bookkeepingSpecRepoint() as never);
    expect(specResult.details?.plan.spec_sheet?.[0]?.revision_reason).toBe(
      `${BOOKKEEPING_PRIOR_SPEC_REASON}\n${BOOKKEEPING_FRESH_SPEC_REASON}`,
    );
  });

  it("still rejects further weakening with no fresh reason and quotes recovery state", async () => {
    const tool = createUpdatePlanTool({ getMessages: () => [planResult(BOOKKEEPING_PREVIOUS_PLAN)] });

    await expect(tool.execute("missing-fresh-reason", bookkeepingFurtherWeakening(null) as never)).rejects.toThrow(
      new RegExp(`current accepted revision_reason is ${JSON.stringify(BOOKKEEPING_PRIOR_REASON)}[\\s\\S]*update_plan[\\s\\S]*do not search build123d docs`, "i"),
    );
  });

  it("does not restore model-authored checks or specification rows that were deleted", () => {
    const submitted = structuredClone(BOOKKEEPING_PREVIOUS_PLAN);
    submitted.components[0]!.checks = submitted.components[0]!.checks!.filter((check) => check.id !== "outline");
    submitted.spec_sheet = [];
    const evidence = collectComponentEvidence([BOOKKEEPING_CURRENT_EVIDENCE]);

    const normalized = normalizePlanSnapshot({ next: submitted, previous: BOOKKEEPING_PREVIOUS_PLAN, evidence });

    expect(normalized.components[0]!.checks?.some((check) => check.id === "outline")).toBe(false);
    expect(normalized.spec_sheet).toEqual([]);
    const errors = validatePlanSnapshot({ next: normalized, previous: BOOKKEEPING_PREVIOUS_PLAN, evidence }).join("\n");
    expect(errors).toContain('check "outline" was deleted without a trace');
    expect(errors).toContain("spec_sheet cannot be dropped");
  });

  it("discloses deterministic bookkeeping and strict volume rules in the tool contract", () => {
    const tool = createUpdatePlanTool({ getMessages: () => [] });
    expect(tool.description).toContain("bind form_review evidence_id");
    expect(tool.description).toContain("fresh standalone revision_reason");
    expect(tool.description).toContain("preserves the accepted history");
    expect(tool.description).toContain("volume check targeting each buildable component");
    expect(tool.description).toContain("hi <= 1.5 * lo");
  });

  it("requires a planned Fusion completion contract and nothing per action", () => {
    const bodyCount = { kind: "body-count", expected: 1 } as const;
    const material = { kind: "material", expected: "Aluminum" } as const;
    const plan = makePlan({ components: [{ id: "plate", description: "plate", status: "todo", checks: [
      { id: "body", kind: "fusion_effect", effect: bodyCount },
      { id: "mat", kind: "fusion_effect", effect: material },
    ] }] });
    // The plan is the completion contract, verified once at the final
    // completion inspection; actions carry no mandatory per-step predictions.
    expect(validateFusionActionPlan(plan)).toEqual([]);
    // A plan without any active fusion_effect completion criteria is not a
    // Fusion completion contract.
    const empty = makePlan({ components: [{ id: "plate", description: "plate", status: "todo", checks: [] }] });
    expect(validateFusionActionPlan(empty)).toEqual([
      "the accepted Fusion plan contains no active fusion_effect checks",
    ]);
  });
});

describe("collectFusionComponentEvidence", () => {
  const bodyCount = { kind: "body-count", expected: 1 } as const;
  const material = { kind: "material", expected: "Aluminum" } as const;
  const fusionPlan = (status: "building" | "done" = "building") => makePlan({
    components: [{ id: "baseplate", description: "plate", bbox_mm: [180, 120, 24], status, checks: [
      { id: "volume", kind: "volume", range_mm3: [280_000, 320_000], target: "baseplate" },
      { id: "body", kind: "fusion_effect", effect: bodyCount },
      { id: "mat", kind: "fusion_effect", effect: material },
    ] }],
    interfaces: [],
  });
  const inspection = (overrides: Record<string, unknown> = {}) => ({
    role: "toolResult", toolName: "inspect_fusion", isError: false,
    details: {
      mutated: false, inspectionId: "insp-9", revision: "rev-final", viewSheet: false,
      evaluatedChecks: [
        { input: bodyCount, status: "passed" },
        { input: material, status: "passed" },
      ],
      bodyVolumesMm3: [300_000],
      ...overrides,
    },
  });

  it("derives done evidence from a passing full inspection at the current revision", () => {
    const plan = fusionPlan("done");
    const evidence = collectFusionComponentEvidence([inspection()], plan);
    const record = evidence.get("baseplate");
    expect(record?.evidenceId).toBe("insp-9");
    // The evidence covers every plan check, so the done transition validates.
    expect(validatePlanSnapshot({ next: plan, previous: fusionPlan(), evidence })).toEqual([]);
  });

  it("yields no evidence when a later action makes the inspection stale", () => {
    const staleMessages = [inspection(), {
      role: "toolResult", toolName: "run_fusion_action", isError: false,
      details: { mutated: true, status: "completed", finalRevision: "rev-newer",
        inspection: { current: { id: "insp-10", revision: "rev-newer" } } },
    }];
    expect(collectFusionComponentEvidence(staleMessages, fusionPlan()).size).toBe(0);
  });

  it("does not cover checks that failed or were not evaluated", () => {
    const partial = inspection({ evaluatedChecks: [
      { input: bodyCount, status: "passed" },
      { input: material, status: "failed" },
    ] });
    const plan = fusionPlan("done");
    const evidence = collectFusionComponentEvidence([partial], plan);
    const errors = validatePlanSnapshot({ next: plan, previous: fusionPlan(), evidence }).join("\n");
    expect(errors).toContain('cannot be "done"');
  });

  it("covers a plain volume plan check from the single body's measured volume", () => {
    const outOfRange = inspection({ bodyVolumesMm3: [500_000] });
    const plan = fusionPlan("done");
    const errors = validatePlanSnapshot({
      next: plan, previous: fusionPlan(),
      evidence: collectFusionComponentEvidence([outOfRange], plan),
    }).join("\n");
    expect(errors).toContain('cannot be "done"');
  });
});
