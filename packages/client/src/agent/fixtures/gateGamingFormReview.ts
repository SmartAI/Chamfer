import type { Plan } from "../plan";

/**
 * Scrubbed seq 106 transition from the organic-device forensic session.
 * The original snapshot declared the image-derived shell done immediately after
 * a passing run, without recording any comparison against the source views.
 */
export const SEQ106_PREVIOUS_PLAN: Plan = {
  goal: "Model the organic handheld device shell from the supplied drawing.",
  components: [
    {
      id: "shell",
      description: "Hollow ergonomic shell with a rounded body and swept neck.",
      bbox_mm: [95, 180, 260],
      checks: [
        { id: "envelope", kind: "bbox", size_mm: [95, 180, 260], tol: 2, target: "shell" },
        { id: "nozzle", kind: "hole_through", diameter: 8, count: 1, target: "shell", tol: 0.8 },
        { id: "volume", kind: "volume", range_mm3: [300000, 345000], target: "shell" },
      ],
      free_floating_reason: "Single self-contained product shell.",
      status: "building",
    },
  ],
  interfaces: [],
  spec_sheet: [
    {
      id: "front-envelope",
      source: "image",
      text: "Front view is 95 mm wide and 260 mm high.",
      check_refs: [{ component_id: "shell", check_id: "envelope" }],
    },
    {
      id: "front-form",
      source: "image",
      text: "The body has a rounded asymmetric outline and a swept neck.",
      unverifiable_reason: "Compare the form against the supplied views.",
    },
  ],
};

export const SEQ106_DONE_WITHOUT_FORM_REVIEW: Plan = {
  ...structuredClone(SEQ106_PREVIOUS_PLAN),
  components: SEQ106_PREVIOUS_PLAN.components.map((component) => ({ ...component, status: "done" })),
};

export const SEQ105_GATE_EVIDENCE = {
  role: "toolResult",
  toolName: "run_build123d",
  toolCallId: "seq-105-run",
  isError: false,
  content: [],
  details: {
    gate: { status: "passed" },
    measurements: {
      component: "shell",
      checks: [
        { kind: "bbox", size_mm: [95, 180, 260], tol: 2, target: "shell" },
        { kind: "hole_through", diameter: 8, count: 1, target: "shell", tol: 0.8 },
        { kind: "volume", range_mm3: [300000, 345000], target: "shell" },
      ],
    },
  },
};
