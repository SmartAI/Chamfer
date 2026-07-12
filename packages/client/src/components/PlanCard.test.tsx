import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlanCard } from "./PlanCard";
import type { Plan } from "@/agent/plan";

const plan: Plan = {
  goal: "two-part gearbox housing",
  components: [
    { id: "base", description: "housing base", status: "done" },
    { id: "lid", description: "flat lid", status: "building" },
    { id: "rib", description: "stiffening rib", status: "abandoned", abandon_reason: "user removed it" },
    {
      id: "boss",
      description: "internal mounting boss",
      status: "blocked",
      blocked_reason: "The required loft repeatedly collapses in the geometry kernel.",
    },
  ],
  interfaces: [{ a: "base", b: "lid", kind: "clearance", min_mm: 0, max_mm: 0 }],
  spec_sheet: [
    {
      id: "housing-volume",
      text: "The housing base has a bounded material volume.",
      source: "image",
      check_refs: [{ component_id: "base", check_id: "volume" }],
    },
    {
      id: "surface-finish",
      text: "The drawing specifies a matte surface finish.",
      source: "image",
      unverifiable_reason: "The geometry kernel cannot measure surface finish.",
      revision_reason: "The original evidence link measured geometry, not finish.",
    },
  ],
};

describe("PlanCard", () => {
  it("collapsed: shows progress over non-abandoned components and the goal", () => {
    render(<PlanCard plan={plan} />);
    expect(screen.getByTestId("plan-progress").textContent).toBe("1/3 components");
    expect(screen.getByTestId("plan-card").textContent).toContain("two-part gearbox housing");
    expect(screen.queryAllByTestId("plan-component")).toHaveLength(0);
  });

  it("expanded: lists every component with status, abandon reason, and the interfaces", () => {
    render(<PlanCard plan={plan} />);
    fireEvent.click(screen.getByTestId("plan-card-toggle"));

    const components = screen.getAllByTestId("plan-component");
    expect(components).toHaveLength(4);
    expect(components.map((c) => c.dataset.status)).toEqual(["done", "building", "abandoned", "blocked"]);
    expect(screen.getByTestId("plan-abandon-reason").textContent).toContain("user removed it");
    const iface = screen.getByTestId("plan-interface");
    expect(iface.textContent).toContain("base·lid");
    expect(iface.textContent).toContain("≤0mm");
    const blockedReason = screen.getByTestId("plan-blocked-reason");
    expect(blockedReason.textContent).toContain("required loft repeatedly collapses");
    expect(blockedReason.className).toContain("text-red-700");
  });

  it("expanded: links spec rows to component checks by id and distinguishes unverifiable rows", () => {
    const planWithChecks: Plan = {
      ...plan,
      components: plan.components.map((component) =>
        component.id === "base"
          ? {
              ...component,
              checks: [{ id: "volume", kind: "volume", range_mm3: [5000, 6000], target: "base" }],
            }
          : component,
      ),
    };
    render(<PlanCard plan={planWithChecks} />);
    fireEvent.click(screen.getByTestId("plan-card-toggle"));

    const link = screen.getByTestId("plan-spec-check-link");
    expect(link.textContent).toContain("base volume");
    expect(link.getAttribute("href")).toBe("#plan-check-base-volume");
    expect(document.getElementById("plan-check-base-volume")?.textContent).toContain("volume");

    const unverifiable = screen.getByTestId("plan-spec-unverifiable");
    expect(unverifiable.textContent).toContain("Unverifiable");
    expect(unverifiable.textContent).toContain("cannot measure surface finish");
    expect(unverifiable.className).toContain("bg-amber-50");
    expect(screen.getByTestId("plan-spec-revision").textContent).toContain(
      "Revised: The original evidence link measured geometry, not finish.",
    );
  });

  it("still renders legacy snapshots whose checks and refs predate stable ids", () => {
    const legacyPlan = {
      ...plan,
      components: plan.components.map((component) =>
        component.id === "base"
          ? { ...component, checks: [{ kind: "volume", range_mm3: [5000, 6000], target: "base" }] }
          : component,
      ),
      spec_sheet: [
        {
          id: "housing-volume",
          text: "The housing base has a bounded material volume.",
          source: "image",
          check_refs: [{ component_id: "base", check_index: 0 }],
        },
      ],
    } as unknown as Plan;
    render(<PlanCard plan={legacyPlan} />);
    fireEvent.click(screen.getByTestId("plan-card-toggle"));

    const link = screen.getByTestId("plan-spec-check-link");
    expect(link.textContent).toContain("base check 1");
    expect(link.getAttribute("href")).toBe("#plan-check-base-0");
    expect(document.getElementById("plan-check-base-0")?.textContent).toContain("volume");
  });

  it("renders persisted check revision reasons beside live and removed checks", () => {
    const revised: Plan = {
      ...plan,
      components: plan.components.map((component) =>
        component.id === "base"
          ? {
              ...component,
              checks: [
                {
                  id: "volume",
                  kind: "volume",
                  range_mm3: [4500, 6500],
                  target: "base",
                  revision_reason: "Included the drawing's internal rib.",
                },
                {
                  id: "holes",
                  kind: "hole_through",
                  diameter: 4,
                  count: 2,
                  target: "base",
                  removed: true,
                  revision_reason: "The detail view shows these are surface marks.",
                },
              ],
            }
          : component,
      ),
    };
    render(<PlanCard plan={revised} />);
    fireEvent.click(screen.getByTestId("plan-card-toggle"));

    const revisions = screen.getAllByTestId("plan-check-revision");
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.textContent).toContain("Revised: Included the drawing's internal rib.");
    expect(revisions[1]?.textContent).toContain("hole_through (removed)");
    expect(revisions[1]?.textContent).toContain("surface marks");
  });

  it("renders a completed component's per-view form review", () => {
    const reviewed: Plan = structuredClone(plan);
    reviewed.components[0]!.form_review = {
      evidence_id: "run-106",
      views: [
        { view: "isometric", verdict: "match", note: "Dominant form agrees." },
        { view: "front", verdict: "match", note: "Silhouette agrees." },
        { view: "back", verdict: "match", note: "Rear profile agrees." },
        { view: "left", verdict: "match", note: "Left profile agrees." },
        { view: "right", verdict: "match", note: "Right profile agrees." },
        { view: "top", verdict: "match", note: "Top profile agrees." },
        { view: "bottom", verdict: "match", note: "Base agrees." },
      ],
    };
    render(<PlanCard plan={reviewed} />);
    fireEvent.click(screen.getByTestId("plan-card-toggle"));

    const verdicts = screen.getAllByTestId("plan-form-review-verdict");
    expect(verdicts).toHaveLength(7);
    expect(verdicts[0]?.textContent).toContain("isometric");
    expect(verdicts[0]?.textContent).toContain("Dominant form agrees.");
  });
});
