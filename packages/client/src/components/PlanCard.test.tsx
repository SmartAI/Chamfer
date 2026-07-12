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
  ],
  interfaces: [{ a: "base", b: "lid", kind: "clearance", min_mm: 0, max_mm: 0 }],
  spec_sheet: [
    {
      id: "housing-volume",
      text: "The housing base has a bounded material volume.",
      source: "image",
      check_refs: [{ component_id: "base", check_index: 0 }],
    },
    {
      id: "surface-finish",
      text: "The drawing specifies a matte surface finish.",
      source: "image",
      unverifiable_reason: "The geometry kernel cannot measure surface finish.",
    },
  ],
};

describe("PlanCard", () => {
  it("collapsed: shows progress over non-abandoned components and the goal", () => {
    render(<PlanCard plan={plan} />);
    expect(screen.getByTestId("plan-progress").textContent).toBe("1/2 components");
    expect(screen.getByTestId("plan-card").textContent).toContain("two-part gearbox housing");
    expect(screen.queryAllByTestId("plan-component")).toHaveLength(0);
  });

  it("expanded: lists every component with status, abandon reason, and the interfaces", () => {
    render(<PlanCard plan={plan} />);
    fireEvent.click(screen.getByTestId("plan-card-toggle"));

    const components = screen.getAllByTestId("plan-component");
    expect(components).toHaveLength(3);
    expect(components.map((c) => c.dataset.status)).toEqual(["done", "building", "abandoned"]);
    expect(screen.getByTestId("plan-abandon-reason").textContent).toContain("user removed it");
    const iface = screen.getByTestId("plan-interface");
    expect(iface.textContent).toContain("base·lid");
    expect(iface.textContent).toContain("≤0mm");
  });

  it("expanded: links spec rows to component checks and distinguishes unverifiable rows", () => {
    const planWithChecks: Plan = {
      ...plan,
      components: plan.components.map((component) =>
        component.id === "base"
          ? {
              ...component,
              checks: [{ kind: "volume", range_mm3: [5000, 6000], target: "base" }],
            }
          : component,
      ),
    };
    render(<PlanCard plan={planWithChecks} />);
    fireEvent.click(screen.getByTestId("plan-card-toggle"));

    const link = screen.getByTestId("plan-spec-check-link");
    expect(link.textContent).toContain("base check 1");
    expect(link.getAttribute("href")).toBe("#plan-check-base-0");
    expect(document.getElementById("plan-check-base-0")?.textContent).toContain("volume");

    const unverifiable = screen.getByTestId("plan-spec-unverifiable");
    expect(unverifiable.textContent).toContain("Unverifiable");
    expect(unverifiable.textContent).toContain("cannot measure surface finish");
    expect(unverifiable.className).toContain("bg-amber-50");
  });
});
