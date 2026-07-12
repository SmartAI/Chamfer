import { describe, expect, it } from "vitest";
import { collectComponentEvidence, validatePlanSnapshot, type Plan } from "./plan";
import {
  SEQ105_GATE_EVIDENCE,
  SEQ106_DONE_WITHOUT_FORM_REVIEW,
  SEQ106_PREVIOUS_PLAN,
} from "./fixtures/gateGamingFormReview";

const views = ["isometric", "front", "back", "left", "right", "top", "bottom"] as const;

function reviewedDonePlan(): Plan {
  const plan = structuredClone(SEQ106_DONE_WITHOUT_FORM_REVIEW);
  plan.components[0]!.form_review = {
    evidence_id: "seq-105-run",
    views: views.map((view) => ({ view, verdict: "match", note: `${view} form matches the reference.` })),
  };
  return plan;
}

describe("image-plan form review", () => {
  const evidence = collectComponentEvidence([SEQ105_GATE_EVIDENCE]);

  it("rejects the scrubbed seq 106 done transition without a form review", () => {
    expect(
      validatePlanSnapshot({ next: SEQ106_DONE_WITHOUT_FORM_REVIEW, previous: SEQ106_PREVIOUS_PLAN, evidence }).join("\n"),
    ).toMatch(/form_review is missing the isometric view/);
  });

  it("requires every view, verdict, and note", () => {
    const plan = reviewedDonePlan();
    plan.components[0]!.form_review!.views = plan.components[0]!.form_review!.views.slice(1);
    expect(validatePlanSnapshot({ next: plan, previous: SEQ106_PREVIOUS_PLAN, evidence }).join("\n")).toMatch(
      /form_review is missing the isometric view/,
    );

    plan.components[0]!.form_review!.views.unshift({ view: "isometric", verdict: "match", note: "" });
    expect(validatePlanSnapshot({ next: plan, previous: SEQ106_PREVIOUS_PLAN, evidence }).join("\n")).toMatch(
      /form_review isometric note must be non-empty/,
    );
  });

  it("rejects a mismatch naming its view and stale evidence", () => {
    const plan = reviewedDonePlan();
    plan.components[0]!.form_review!.views[4] = {
      view: "right",
      verdict: "mismatch",
      note: "The neck bends too far.",
    };
    expect(validatePlanSnapshot({ next: plan, previous: SEQ106_PREVIOUS_PLAN, evidence }).join("\n")).toMatch(
      /form_review right verdict is mismatch/,
    );

    plan.components[0]!.form_review!.views[4] = { view: "right", verdict: "match", note: "Right form matches." };
    plan.components[0]!.form_review!.evidence_id = "older-run";
    expect(validatePlanSnapshot({ next: plan, previous: SEQ106_PREVIOUS_PLAN, evidence }).join("\n")).toMatch(
      /older-run.*latest gate-passed evidence.*seq-105-run/,
    );
  });

  it("accepts all matches tied to current evidence and leaves text-only plans unaffected", () => {
    expect(validatePlanSnapshot({ next: reviewedDonePlan(), previous: SEQ106_PREVIOUS_PLAN, evidence })).toEqual([]);

    const previous = structuredClone(SEQ106_PREVIOUS_PLAN);
    delete previous.spec_sheet;
    const next = structuredClone(SEQ106_DONE_WITHOUT_FORM_REVIEW);
    delete next.spec_sheet;
    expect(validatePlanSnapshot({ next, previous, evidence })).toEqual([]);
  });
});
