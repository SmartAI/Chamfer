import { describe, expect, it } from "vitest";
import { SEQ1_PLAN } from "./fixtures/gateGamingSession";
import { SEQ54_RUN_CHECKS } from "./fixtures/runConformanceFixture";
import { validateRunChecksConformance, type Plan } from "./plan";

function oneComponentPlan(): Plan {
  return {
    goal: "Build a checked housing",
    components: [
      {
        id: "housing",
        description: "single housing",
        bbox_mm: [100, 80, 30],
        status: "building",
        free_floating_reason: "single component",
        checks: [
          { id: "volume", kind: "volume", range_mm3: [5000, 6000], target: "housing" },
          { id: "holes", kind: "hole_through", diameter: 6, count: 4, tol: 0.5, target: "housing" },
        ],
      },
    ],
    interfaces: [],
  };
}

describe("run CHECKS plan conformance", () => {
  it("rejects a missing or weakened legacy check and names the explicit transition recovery", () => {
    const errors = validateRunChecksConformance(oneComponentPlan(), {
      component: "housing",
      checks: [
        { kind: "volume", range_mm3: [4500, 6500], target: "housing" },
      ],
    });

    expect(errors.join("\n")).toContain('component "housing" planned check "holes" is missing');
    expect(errors.join("\n")).toContain('component "housing" planned check "volume" is weaker in this run');
    expect(errors.join("\n")).toContain("create_plan and transition_from_legacy=true");
    expect(errors.join("\n")).toContain("revise_plan");
  });

  it("accepts matching and tighter run checks, and ignores extra checks", () => {
    expect(
      validateRunChecksConformance(oneComponentPlan(), {
        component: "housing",
        checks: [
          { kind: "volume", range_mm3: [5200, 5800], target: "housing" },
          { kind: "hole_through", diameter: 6, count: 4, tol: 0.2, target: "housing" },
          { kind: "count_faces", count: [8, 30], target: "housing" },
        ],
      }),
    ).toEqual([]);
  });

  it("exempts probes and accepts checks matching a legitimately revised plan", () => {
    expect(validateRunChecksConformance(oneComponentPlan(), { component: "probe", checks: [] })).toEqual([]);

    const revised = oneComponentPlan();
    revised.components[0]!.checks![0] = {
      id: "volume",
      kind: "volume",
      range_mm3: [4500, 6500],
      target: "housing",
      revision_reason: "The drawing includes an internal rib omitted from the estimate.",
    };
    expect(
      validateRunChecksConformance(revised, {
        component: "housing",
        checks: [
          { kind: "volume", range_mm3: [4500, 6500], target: "housing" },
          { kind: "hole_through", diameter: 6, count: 4, tol: 0.5, target: "housing" },
        ],
      }),
    ).toEqual([]);
  });

  it("gate-gaming regression: rejects the seq 54 run that shed wall, button, and boss checks", () => {
    const errors = validateRunChecksConformance(SEQ1_PLAN, {
      component: "shell",
      checks: SEQ54_RUN_CHECKS,
    }).join("\n");

    expect(errors).toContain('planned check "wall" is missing');
    expect(errors).toContain('planned check "buttons" is missing');
    expect(errors).toContain('planned check "bosses" is missing');
  });
});
