import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  PLAN_COMPONENT_STATUSES,
  FORM_REVIEW_VIEWS,
  PLAN_INTERFACE_KINDS,
  UPDATE_PLAN_TOOL_NAME,
  acceptedCheckRevisions,
  collectComponentEvidence,
  collectComponentMeasurements,
  collectFusionComponentEvidence,
  describePlanStatus,
  latestPlan,
  normalizePlanSnapshot,
  validatePlanSnapshot,
  type Plan,
} from "../plan";
import { isDomainPlan } from "../domainPlan";
import { PLAN_CHECK_ENTRY_SCHEMA, PLAN_SPEC_SHEET_ROW_SCHEMA } from "../planChecks";

const component = Type.Object({
  id: Type.String({
    description:
      'Stable lowercase slug (e.g. "lid"). Keep it aligned with the environment-native component or body identity; "probe" is reserved.',
  }),
  description: Type.String({ description: "What this component is, in one sentence." }),
  bbox_mm: Type.Array(Type.Number(), {
    minItems: 3,
    maxItems: 3,
    description: "Target envelope in mm, sorted-compare semantics like EXPECT.bbox_mm.",
  }),
  checks: Type.Array(PLAN_CHECK_ENTRY_SCHEMA, {
    description:
      "Typed acceptance entries this component must pass, each with a stable id unique within the component. Current trusted execution evidence must cover every entry before completion.",
  }),
  status: StringEnum(PLAN_COMPONENT_STATUSES as unknown as string[], {
    description:
      '"done" is accepted only with gate evidence and, for an image-derived plan transition, a complete all-match form_review tied to that evidence; "blocked" requires blocked_reason when a genuine limitation prevents completion; "abandoned" requires abandon_reason and is the only legal way to shrink the plan.',
  }),
  abandon_reason: Type.Optional(
    Type.String({ description: "Why this component is no longer part of the design. Required when abandoned." }),
  ),
  blocked_reason: Type.Optional(
    Type.String({ description: "What genuine limitation prevented completion. Required when blocked." }),
  ),
  free_floating_reason: Type.Optional(
    Type.String({
      description:
        "Why this component legitimately has no interface holding it. Leave unset for anything that must be supported, fastened, or captive.",
    }),
  ),
  form_review: Type.Optional(
    Type.Object({
      evidence_id: Type.String({
        description:
          "Evidence id for the reviewed run. Chamfer binds this to the latest eligible gate-passed run for the component.",
      }),
      views: Type.Array(
        Type.Object({
          view: StringEnum(FORM_REVIEW_VIEWS as unknown as string[]),
          verdict: StringEnum(["match", "mismatch"]),
          note: Type.String({ description: "Concrete comparison against this reference-image view." }),
        }),
        { description: "Exactly one verdict for each of the seven inspection views." },
      ),
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
 * A fieldless compatibility schema accepts stale snapshot calls without
 * advertising any writable snapshot contract to current models.
 */
const retiredSnapshotParameters = Type.Object({}, { additionalProperties: true });

export function createRetiredUpdatePlanTool(deps: {
  getMessages: () => readonly unknown[];
}): AgentTool<typeof retiredSnapshotParameters, never> {
  return {
    name: UPDATE_PLAN_TOOL_NAME,
    label: "Update plan",
    description:
      "Retired read-only compatibility endpoint for stale model calls. It never changes a plan. Use create_plan for initial creation or an explicit legacy transition, then revise_plan domain operations for every change.",
    parameters: retiredSnapshotParameters,
    executionMode: "sequential",
    execute: async () => {
      const current = latestPlan(deps.getMessages());
      if (!current) {
        throw new Error(
          "update_plan is retired and no plan was changed. Call record_source_specifications for the durable requirements, then call create_plan. Use revise_plan domain operations for every later mutation.",
        );
      }
      if (isDomainPlan(current)) {
        throw new Error(
          "update_plan is retired and no plan was changed. Call revise_plan with one atomic batch of explicit domain operations against the current authoritative plan.",
        );
      }
      throw new Error(
        "update_plan is retired and the stored legacy snapshot remains unchanged. Call create_plan once with transition_from_legacy=true and the complete normalized active legacy state; after that transition, use revise_plan domain operations for every mutation.",
      );
    },
  };
}

/**
 * The legacy plan artifact tool. It submits a full snapshot and retains the
 * pre-domain-plan validation and evidence bookkeeping contract for older
 * conversations that have not crossed the authoritative-plan migration.
 */
export function createUpdatePlanTool(deps: {
  getMessages: () => readonly unknown[];
  requireSpecSheet?: () => boolean;
  onAccepted?: (plan: Plan) => void;
}): AgentTool<typeof parameters, { plan: Plan }> {
  return {
    name: UPDATE_PLAN_TOOL_NAME,
    label: "Update plan",
    description:
      "Create or revise the complete design plan: goal, components, per-component checks, interfaces, and the image spec sheet when required. Submit the complete plan every time, never a delta. For an image request, call this before run_build123d and enumerate every readable dimension, feature, note, and spec-table row in spec_sheet. Each spec row must link to an existing component check with {component_id, check_id}, or state a non-empty unverifiable_reason. Before changing an image-derived component to done, submit form_review with match verdicts and notes for all seven views; Chamfer will bind form_review evidence_id to the latest eligible gate-passed run for that component. The plan requires a volume check targeting each buildable component, with hi <= 1.5 * lo. A further weakening requires a fresh standalone revision_reason; Chamfer preserves the accepted history and appends the fresh explanation before strict validation.",
    parameters,
    execute: async (_toolCallId, args) => {
      const messages = deps.getMessages();
      const submitted = args as unknown as Plan;
      const previous = latestPlan(messages);
      const evidence = collectComponentEvidence(messages);
      for (const [componentId, latestMeasurements] of collectComponentMeasurements(messages)) {
        const prior = evidence.get(componentId);
        evidence.set(componentId, {
          checks: prior?.checks ?? new Set<string>(),
          evidenceId: prior?.evidenceId,
          latestMeasurements,
        });
      }
      // A Fusion conversation has no run_build123d results; its completion
      // evidence is the newest trusted full inspection at the current revision.
      for (const [componentId, record] of collectFusionComponentEvidence(messages, submitted)) {
        evidence.set(componentId, record);
      }
      const next = normalizePlanSnapshot({ next: submitted, previous, evidence });
      const errors = validatePlanSnapshot({
        next,
        previous,
        evidence,
        requireSpecSheet: deps.requireSpecSheet?.() ?? false,
      });
      if (errors.length > 0) {
        throw new Error(
          `Plan rejected:\n${errors.map((error) => `- ${error}`).join("\n")}\nRevise the Chamfer plan with update_plan; do not search build123d docs for plan-contract errors.`,
        );
      }
      const revisions = acceptedCheckRevisions(next, previous);
      const revisionText = revisions.length === 0
        ? ""
        : `\nCheck revisions recorded and shown to the user:\n${revisions.map((revision) => `- ${revision.componentId}/${revision.checkId}: ${revision.reason}`).join("\n")}`;
      const refits = next.components.flatMap((candidate) =>
        (candidate.checks ?? [])
          .filter((check) => check.refit_to_measurement === true && previous?.components
            .find((priorComponent) => priorComponent.id === candidate.id)?.checks
            ?.find((prior) => prior.id === check.id)?.refit_to_measurement !== true)
          .map((check) => `${candidate.id}/${check.id}`),
      );
      const refitText = refits.length === 0
        ? ""
        : `\nRefit-to-measurement checks shown to the user:\n${refits.map((refit) => `- ${refit}`).join("\n")}`;
      deps.onAccepted?.(next);
      return {
        content: [{
          type: "text",
          text: `Plan accepted: ${describePlanStatus(next)}.${revisionText}${refitText}\n${JSON.stringify(next)}`,
        }],
        details: { plan: next },
      };
    },
  };
}
