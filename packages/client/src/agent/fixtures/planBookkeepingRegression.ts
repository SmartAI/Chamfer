import type { Plan } from "../plan";

export const BOOKKEEPING_PRIOR_REASON = "First revision: corrected the synthetic body-volume estimate.";
export const BOOKKEEPING_FRESH_REASON = "Second revision: included the synthetic mounting flange.";
export const BOOKKEEPING_PRIOR_SPEC_REASON = "First revision: linked the synthetic width callout to its outline check.";
export const BOOKKEEPING_FRESH_SPEC_REASON = "Second revision: the synthetic callout now governs material volume.";

const views = ["isometric", "front", "back", "left", "right", "top", "bottom"] as const;

export const BOOKKEEPING_PREVIOUS_PLAN: Plan = {
  goal: "Create a synthetic single-component fixture",
  components: [{
    id: "widget",
    description: "Synthetic test component",
    bbox_mm: [30, 20, 10],
    status: "building",
    free_floating_reason: "The fixture intentionally contains one component.",
    checks: [
      {
        id: "volume",
        kind: "volume",
        range_mm3: [1000, 1200],
        target: "widget",
        revision_reason: BOOKKEEPING_PRIOR_REASON,
        refit_to_measurement: true,
      },
      { id: "outline", kind: "bbox", size_mm: [30, 20, 10], target: "widget" },
    ],
  }],
  interfaces: [],
  spec_sheet: [{
    id: "width",
    text: "The synthetic fixture is 30 mm wide.",
    source: "image",
    check_refs: [{ component_id: "widget", check_id: "outline" }],
    revision_reason: BOOKKEEPING_PRIOR_SPEC_REASON,
  }],
};

export const BOOKKEEPING_CURRENT_EVIDENCE = {
  role: "toolResult",
  toolCallId: "current-widget-evidence",
  toolName: "run_build123d",
  content: [{ type: "text", text: "Synthetic measurements" }],
  details: {
    gate: { status: "passed", checks: [] },
    measurements: {
      component: "widget",
      checks: [
        { kind: "volume", range_mm3: [1000, 1200], target: "widget" },
        { kind: "bbox", size_mm: [30, 20, 10], target: "widget" },
      ],
      volumeMm3: 1100,
    },
  },
  isError: false,
  timestamp: 2,
};

export const BOOKKEEPING_STALE_EVIDENCE_PLAN: Plan = {
  ...structuredClone(BOOKKEEPING_PREVIOUS_PLAN),
  components: [{
    ...structuredClone(BOOKKEEPING_PREVIOUS_PLAN.components[0]!),
    status: "done",
    checks: BOOKKEEPING_PREVIOUS_PLAN.components[0]!.checks!.map((check) => {
      const copy = structuredClone(check);
      delete copy.revision_reason;
      delete copy.refit_to_measurement;
      return copy;
    }),
    form_review: {
      evidence_id: "guessed-stale-evidence",
      views: views.map((view) => ({ view, verdict: "match", note: `Synthetic ${view} view matches.` })),
    },
  }],
  spec_sheet: BOOKKEEPING_PREVIOUS_PLAN.spec_sheet!.map((row) => {
    const copy = structuredClone(row);
    delete copy.revision_reason;
    return copy;
  }),
};

export function bookkeepingFurtherWeakening(reason: string | null = BOOKKEEPING_FRESH_REASON): Plan {
  const next = structuredClone(BOOKKEEPING_PREVIOUS_PLAN);
  next.components[0]!.checks![0] = {
    id: "volume",
    kind: "volume",
    range_mm3: [900, 1300],
    target: "widget",
    ...(reason ? { revision_reason: reason } : {}),
  };
  return next;
}

export function bookkeepingSpecRepoint(reason: string | null = BOOKKEEPING_FRESH_SPEC_REASON): Plan {
  const next = structuredClone(BOOKKEEPING_PREVIOUS_PLAN);
  next.spec_sheet![0] = {
    ...next.spec_sheet![0]!,
    check_refs: [{ component_id: "widget", check_id: "volume" }],
    ...(reason ? { revision_reason: reason } : { revision_reason: undefined }),
  };
  return next;
}
