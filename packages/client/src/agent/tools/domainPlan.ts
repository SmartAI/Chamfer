import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ProofContractDto, ReferenceRegistrationDto, SourceSpecificationDto } from "@chamfer/shared";
import {
  CREATE_PLAN_TOOL_NAME,
  FORM_REVIEW_VIEWS,
  PLAN_COMPONENT_STATUSES,
  PLAN_INTERFACE_KINDS,
  REVISE_PLAN_TOOL_NAME,
  collectComponentEvidence,
  collectComponentMeasurements,
  describePlanStatus,
  latestPlan,
  type ComponentEvidence,
  type Plan,
} from "../plan";
import {
  applyDomainPlanRevision,
  createDomainPlan,
  createDomainPlanFingerprint,
  isDomainPlan,
  normalizedLegacyTransitionBaseline,
  type DomainPlan,
  type DomainPlanEnvironment,
  type DomainPlanRevisionBatch,
} from "../domainPlan";
import {
  DOMAIN_PLAN_CHECK_INPUT_SCHEMA,
  DOMAIN_PLAN_CHECK_REVISION_INPUT_SCHEMA,
} from "../planChecks";
import { proofFinalizationPreflightError } from "../proofContract";

const mutationFields = {
  mutation_id: Type.String({
    minLength: 1,
    description: "Idempotency key for this exact plan mutation. Reuse it only for an exact retry.",
  }),
  reason: Type.String({
    minLength: 1,
    description: "Why this plan creation or operation batch is needed. Stored in immutable plan history.",
  }),
};

const domainPlanComponentInput = Type.Object({
  id: Type.String({
    minLength: 1,
    description:
      'Stable lowercase semantic key (e.g. "lid"). Must equal the Compound child label and script COMPONENT declaration; "probe" is reserved.',
  }),
  description: Type.String({ minLength: 1, description: "What this component is, in one sentence." }),
  bbox_mm: Type.Array(Type.Number(), {
    minItems: 3,
    maxItems: 3,
    description: "Target envelope in mm, sorted-compare semantics like EXPECT.bbox_mm.",
  }),
  checks: Type.Array(DOMAIN_PLAN_CHECK_INPUT_SCHEMA, {
    description:
      "Initial acceptance criteria. Chamfer owns revision metadata, retirement state, evidence bindings, and history.",
  }),
  free_floating_reason: Type.Optional(Type.String({
    minLength: 1,
    description: "Why this component legitimately has no interface holding it.",
  })),
}, { additionalProperties: false });

const domainPlanInterfaceInput = Type.Object({
  a: Type.String({ minLength: 1, description: "Component semantic key." }),
  b: Type.String({ minLength: 1, description: "Component semantic key." }),
  kind: StringEnum(PLAN_INTERFACE_KINDS as unknown as string[]),
  min_mm: Type.Optional(Type.Number({ minimum: 0, description: "Minimum gap in mm for a clearance interface." })),
  max_mm: Type.Optional(Type.Number({ minimum: 0, description: "Maximum gap in mm for a clearance interface." })),
}, { additionalProperties: false });

const createParameters = Type.Object({
  ...mutationFields,
  goal: Type.String({ minLength: 1 }),
  components: Type.Array(domainPlanComponentInput, { minItems: 1 }),
  interfaces: Type.Array(domainPlanInterfaceInput),
  transition_from_legacy: Type.Optional(Type.Boolean({
    description: "Set true only for an explicit compatible transition from the current legacy snapshot.",
  })),
});

const setComponentStatus = Type.Object({
  kind: Type.Literal("set_component_status"),
  component_id: Type.String({ minLength: 1 }),
  status: StringEnum(PLAN_COMPONENT_STATUSES.filter((status) => status !== "abandoned") as string[]),
  blocked_reason: Type.Optional(Type.String({ minLength: 1 })),
});

const recordComponentReview = Type.Object({
  kind: Type.Literal("record_component_review"),
  component_id: Type.String({ minLength: 1 }),
  note: Type.String({ minLength: 1 }),
});

const recordFormReview = Type.Object({
  kind: Type.Literal("record_form_review"),
  component_id: Type.String({ minLength: 1 }),
  form_review: Type.Object({
    evidence_id: Type.String({ minLength: 1 }),
    views: Type.Array(Type.Object({
      view: StringEnum(FORM_REVIEW_VIEWS as unknown as string[]),
      verdict: StringEnum(["match", "mismatch"]),
      note: Type.String({ minLength: 1 }),
    }), { minItems: FORM_REVIEW_VIEWS.length, maxItems: FORM_REVIEW_VIEWS.length }),
  }),
});

const setSourceSpecifications = Type.Object({
  kind: Type.Literal("set_source_specifications"),
  source_specification_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

const reviseComponent = Type.Object({
  kind: Type.Literal("revise_component"),
  component_id: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String({ minLength: 1 })),
  bbox_mm: Type.Optional(Type.Array(Type.Number(), { minItems: 3, maxItems: 3 })),
  free_floating_reason: Type.Optional(Type.String({ minLength: 1 })),
});

const addComponent = Type.Object({
  kind: Type.Literal("add_component"),
  component: domainPlanComponentInput,
});

const retireComponent = Type.Object({
  kind: Type.Literal("retire_component"),
  component_id: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
});

const addCheck = Type.Object({
  kind: Type.Literal("add_check"),
  component_id: Type.String({ minLength: 1 }),
  check: DOMAIN_PLAN_CHECK_INPUT_SCHEMA,
});

const reviseCheck = Type.Object({
  kind: Type.Literal("revise_check"),
  component_id: Type.String({ minLength: 1 }),
  check_id: Type.String({ minLength: 1 }),
  check: DOMAIN_PLAN_CHECK_REVISION_INPUT_SCHEMA,
});

const retireCheck = Type.Object({
  kind: Type.Literal("retire_check"),
  component_id: Type.String({ minLength: 1 }),
  check_id: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
});

const reviseGoal = Type.Object({ kind: Type.Literal("revise_goal"), goal: Type.String({ minLength: 1 }) });

const addInterface = Type.Object({
  kind: Type.Literal("add_interface"),
  interface: domainPlanInterfaceInput,
});

const retireInterface = Type.Object({
  kind: Type.Literal("retire_interface"),
  interface_id: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
});

const operation = Type.Union([
  setComponentStatus,
  recordComponentReview,
  recordFormReview,
  setSourceSpecifications,
  reviseComponent,
  addComponent,
  retireComponent,
  addCheck,
  reviseCheck,
  retireCheck,
  reviseGoal,
  addInterface,
  retireInterface,
]);

const reviseParameters = Type.Object({
  ...mutationFields,
  operations: Type.Array(operation, { minItems: 1 }),
});

function environment(): DomainPlanEnvironment {
  return {
    actor: "agent",
    now: () => Date.now(),
    id: (kind) => `${kind}-${crypto.randomUUID()}`,
  };
}

function evidenceFrom(messages: readonly unknown[]): Map<string, ComponentEvidence> {
  const evidence = collectComponentEvidence(messages);
  for (const [componentId, latestMeasurements] of collectComponentMeasurements(messages)) {
    const prior = evidence.get(componentId);
    evidence.set(componentId, {
      checks: prior?.checks ?? new Set<string>(),
      evidenceId: prior?.evidenceId,
      planId: prior?.planId,
      criteriaRevision: prior?.criteriaRevision,
      latestMeasurements,
    });
  }
  return evidence;
}

function requiresFormReview(specifications: readonly SourceSpecificationDto[]): boolean {
  return specifications.some((specification) =>
    specification.status === "active" && "attachmentId" in specification.source,
  );
}

function result(plan: DomainPlan, deduped = false) {
  return {
    content: [{
      type: "text" as const,
      text: `Plan accepted: ${describePlanStatus(plan)}. Revision ${plan.domain.revision}, criteria revision ${plan.domain.criteria_revision}.\n${JSON.stringify(plan)}`,
    }],
    details: { plan, deduped },
  };
}

export function createCreatePlanTool(deps: {
  getMessages: () => readonly unknown[];
  getSourceSpecificationIds: () => string[];
  getSourceSpecifications?: () => readonly SourceSpecificationDto[];
  onAccepted?: (plan: DomainPlan) => void | Promise<void>;
}): AgentTool<typeof createParameters, { plan: DomainPlan; deduped: boolean }> {
  return {
    name: CREATE_PLAN_TOOL_NAME,
    label: "Create plan",
    description:
      "Create the initial design plan after recording durable source specifications for text or reference evidence. Chamfer links every active source specification and opens immutable revision history. Use revise_plan for every later change.",
    parameters: createParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, args) => {
      const existing = latestPlan(deps.getMessages());
      const submitted = {
        goal: args.goal,
        components: args.components.map((component) => ({ ...component, status: "todo" as const })),
        interfaces: args.interfaces,
      } as unknown as Plan;
      if (existing) {
        if (isDomainPlan(existing)) {
          const prior = existing.domain.history.find((entry) => entry.mutation_id === args.mutation_id);
          if (prior?.revision === 1) {
            const fingerprint = createDomainPlanFingerprint(submitted, {
              mutation_id: args.mutation_id,
              reason: args.reason,
              source_specification_ids: deps.getSourceSpecificationIds(),
              requires_form_review: requiresFormReview(deps.getSourceSpecifications?.() ?? []),
            });
            if (fingerprint === prior.fingerprint) return result(existing, true);
            throw new Error(`mutation_id ${JSON.stringify(args.mutation_id)} was already used with different content`);
          }
          throw new Error("an operation-backed plan already exists; use revise_plan");
        }
        if (!args.transition_from_legacy) {
          throw new Error("a legacy snapshot plan already exists; set transition_from_legacy=true and submit its normalized current state for an explicit compatible transition");
        }
      }
      const plan = createDomainPlan(
        submitted,
        {
          mutation_id: args.mutation_id,
          reason: args.reason,
          source_specification_ids: deps.getSourceSpecificationIds(),
          requires_form_review: requiresFormReview(deps.getSourceSpecifications?.() ?? []),
        },
        evidenceFrom(deps.getMessages()),
        environment(),
        existing && !isDomainPlan(existing) ? normalizedLegacyTransitionBaseline(existing) : undefined,
      );
      await deps.onAccepted?.(plan);
      return result(plan);
    },
  };
}

export function createRevisePlanTool(deps: {
  getMessages: () => readonly unknown[];
  getSourceSpecifications?: () => readonly SourceSpecificationDto[];
  getProofContracts?: () => readonly ProofContractDto[];
  getReferenceRegistrations?: () => readonly ReferenceRegistrationDto[];
  getActiveReferenceIds?: () => readonly string[];
  onAccepted?: (plan: DomainPlan) => void | Promise<void>;
}): AgentTool<typeof reviseParameters, { plan: DomainPlan; deduped: boolean }> {
  return {
    name: REVISE_PLAN_TOOL_NAME,
    label: "Revise plan",
    description:
      "Revise the current plan with one atomic batch of explicit operations. Use set_source_specifications whenever current source identities change. Status and review operations preserve criteria revisions. Criteria operations advance criteria revision and invalidate dependent completion evidence. Never submit a replacement plan snapshot.",
    parameters: reviseParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, args) => {
      const current = latestPlan(deps.getMessages());
      if (!isDomainPlan(current)) {
        throw new Error("revise_plan requires an operation-backed plan created by create_plan");
      }
      const finalizationError = proofFinalizationPreflightError(
        current,
        deps.getProofContracts?.() ?? [],
        args.operations,
        deps.getReferenceRegistrations?.() ?? [],
        deps.getMessages(),
        deps.getActiveReferenceIds?.() ?? [],
      );
      if (finalizationError) throw new Error(finalizationError);
      const previousRevision = current.domain.revision;
      const specifications = (deps.getSourceSpecifications?.() ?? []).filter((specification) => specification.status === "active");
      const currentIds = specifications.map((specification) => specification.id);
      const operations = (args.operations as unknown as DomainPlanRevisionBatch["operations"]).map((operation) => {
        if (operation.kind === "add_component") {
          return { ...operation, component: { ...operation.component, status: "todo" as const } };
        }
        if (operation.kind === "revise_check") {
          return { ...operation, check: { ...operation.check, id: operation.check_id } };
        }
        if (operation.kind === "set_source_specifications") {
          const supplied = new Set(operation.source_specification_ids);
          if (supplied.size !== currentIds.length || currentIds.some((id) => !supplied.has(id))) {
            throw new Error(`set_source_specifications must cover the exact active source identities: ${currentIds.join(", ")}`);
          }
          return {
            ...operation,
            source_specification_ids: currentIds,
            requires_form_review: requiresFormReview(specifications),
          };
        }
        return operation;
      });
      const plan = applyDomainPlanRevision(
        current,
        { ...args, operations } as unknown as DomainPlanRevisionBatch,
        evidenceFrom(deps.getMessages()),
        environment(),
      );
      const deduped = plan.domain.revision === previousRevision;
      if (!deduped) await deps.onAccepted?.(plan);
      return result(plan, deduped);
    },
  };
}
