import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  PLAN_COMPONENT_STATUSES,
  PLAN_INTERFACE_KINDS,
  UPDATE_PLAN_TOOL_NAME,
  collectComponentEvidence,
  describePlanStatus,
  latestPlan,
  validatePlanSnapshot,
  type Plan,
} from "../plan";
import { PLAN_CHECK_ENTRY_SCHEMA } from "../planChecks";
import { PLAN_SPEC_SHEET_ROW_SCHEMA } from "../planChecks";

const component = Type.Object({
  id: Type.String({
    description:
      'Stable lowercase slug (e.g. "lid"). Must equal the Compound child label and the script COMPONENT declaration; "probe" is reserved.',
  }),
  description: Type.String({ description: "What this component is, in one sentence." }),
  bbox_mm: Type.Array(Type.Number(), {
      minItems: 3,
      maxItems: 3,
      description: "Target envelope in mm, sorted-compare semantics like EXPECT.bbox_mm.",
    }),
  checks: Type.Array(PLAN_CHECK_ENTRY_SCHEMA, {
      description:
        "CHECKS entries this component must pass, each with a stable id unique within the component. A gate-passed run declaring the component must include every one of them before the component can be marked done.",
    }),
  status: StringEnum(PLAN_COMPONENT_STATUSES as unknown as string[], {
    description:
      '"done" is accepted only with gate evidence; "abandoned" requires abandon_reason and is the only legal way to shrink the plan.',
  }),
  abandon_reason: Type.Optional(
    Type.String({ description: "Why this component is no longer part of the design. Required when abandoned." }),
  ),
  free_floating_reason: Type.Optional(
    Type.String({
      description:
        "Why this component legitimately has no interface holding it. Leave unset for anything that must be supported, fastened, or captive.",
    }),
  ),
});

const planInterface = Type.Object({
  a: Type.String({ description: "Component id." }),
  b: Type.String({ description: "Component id." }),
  kind: StringEnum(PLAN_INTERFACE_KINDS as unknown as string[], {
    description:
      '"clearance" bounds the gap between two components (min_mm 0 allows contact; max_mm 0 demands touching). "captive" declares retention without contact, e.g. a pin inside bores.',
  }),
  min_mm: Type.Optional(Type.Number({ description: "Minimum gap in mm (clearance only), >= 0." })),
  max_mm: Type.Optional(Type.Number({ description: "Maximum gap in mm (clearance only); 0 asserts touching." })),
});

const parameters = Type.Object({
  goal: Type.String({ description: "One-sentence restatement of the user's request." }),
  components: Type.Array(component, { minItems: 1 }),
  interfaces: Type.Array(planInterface, {
    description:
      "Physical relations that hold the assembly together. Every non-free-floating component must appear in at least one, and the graph must be connected.",
  }),
  spec_sheet: Type.Optional(
    Type.Array(PLAN_SPEC_SHEET_ROW_SCHEMA, {
      description:
        "The agent's own reading of every dimension, feature, and spec-table row visible in the request image. Each row links to component checks by {component_id, check_id}, or states why it is unverifiable.",
    }),
  ),
});

/**
 * The plan artifact tool. Always submits a FULL snapshot; the newest accepted
 * snapshot is the plan of record (derived from the transcript, so it survives
 * reloads and compaction). Validation implements the trust model in plan.ts;
 * a rejected snapshot throws, which pi reports to the model as a tool error.
 */
export function createUpdatePlanTool(deps: {
  /** Live view of the session transcript (agent.state.messages). */
  getMessages: () => readonly unknown[];
  /** Whether the pending user turn contains an image and therefore requires a spec sheet. */
  requireSpecSheet?: () => boolean;
  /** Notifies the session only after a snapshot has passed validation. */
  onAccepted?: (plan: Plan) => void;
}): AgentTool<typeof parameters, { plan: Plan }> {
  return {
    name: UPDATE_PLAN_TOOL_NAME,
    label: "Update plan",
    description:
      "Create or revise the complete design plan: goal, components, per-component checks, interfaces, and the image spec sheet when required. For an image request, call this before run_build123d and enumerate every readable dimension, feature, note, and spec-table row in spec_sheet. Each spec row must link to an existing component check with {component_id, check_id}, or state a non-empty unverifiable_reason. Submit the complete plan every time, never a delta.",
    parameters,
    execute: async (_toolCallId, args) => {
      const messages = deps.getMessages();
      const next = args as unknown as Plan;
      const errors = validatePlanSnapshot({
        next,
        previous: latestPlan(messages),
        evidence: collectComponentEvidence(messages),
        requireSpecSheet: deps.requireSpecSheet?.() ?? false,
      });
      if (errors.length > 0) {
        throw new Error(`Plan rejected:\n${errors.map((e) => `- ${e}`).join("\n")}`);
      }
      deps.onAccepted?.(next);
      return {
        content: [
          {
            type: "text",
            text: `Plan accepted: ${describePlanStatus(next)}.\n${JSON.stringify(next)}`,
          },
        ],
        details: { plan: next },
      };
    },
  };
}
