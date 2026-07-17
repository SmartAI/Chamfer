import type { ComponentEvidence, FormReview, Plan, PlanCheckEntry, PlanComponent, PlanInterface } from "./plan";
import { applyPlanEvidenceAnnotations, validatePlanSnapshot } from "./plan";

export type DomainPlan = Plan & { domain: NonNullable<Plan["domain"]> };

export interface DomainPlanEnvironment {
  actor: "agent";
  now: () => number;
  id: (kind: "plan" | "interface") => string;
}

export interface CreateDomainPlanMetadata {
  mutation_id: string;
  reason: string;
  source_specification_ids: string[];
  requires_form_review?: boolean;
}

type SetComponentStatusOperation = {
  kind: "set_component_status";
  component_id: string;
  status: PlanComponent["status"];
  blocked_reason?: string;
};

type RecordComponentReviewOperation = {
  kind: "record_component_review";
  component_id: string;
  note: string;
};

type RecordFormReviewOperation = {
  kind: "record_form_review";
  component_id: string;
  form_review: FormReview;
};

type SetSourceSpecificationsOperation = {
  kind: "set_source_specifications";
  source_specification_ids: string[];
  /** System-derived from current provenance and omitted from the model schema. */
  requires_form_review?: boolean;
};

type ReviseComponentOperation = {
  kind: "revise_component";
  component_id: string;
  description?: string;
  bbox_mm?: number[];
  free_floating_reason?: string;
};

type AddComponentOperation = {
  kind: "add_component";
  component: PlanComponent;
};

type RetireComponentOperation = {
  kind: "retire_component";
  component_id: string;
  reason: string;
};

type AddCheckOperation = {
  kind: "add_check";
  component_id: string;
  check: PlanCheckEntry;
};

type ReviseCheckOperation = {
  kind: "revise_check";
  component_id: string;
  check_id: string;
  check: PlanCheckEntry;
};

type RetireCheckOperation = {
  kind: "retire_check";
  component_id: string;
  check_id: string;
  reason: string;
};

type ReviseGoalOperation = { kind: "revise_goal"; goal: string };

type AddInterfaceOperation = {
  kind: "add_interface";
  interface: PlanInterface;
};

type RetireInterfaceOperation = {
  kind: "retire_interface";
  interface_id: string;
  reason: string;
};

export type DomainPlanOperation =
  | SetComponentStatusOperation
  | RecordComponentReviewOperation
  | RecordFormReviewOperation
  | SetSourceSpecificationsOperation
  | ReviseComponentOperation
  | AddComponentOperation
  | RetireComponentOperation
  | AddCheckOperation
  | ReviseCheckOperation
  | RetireCheckOperation
  | ReviseGoalOperation
  | AddInterfaceOperation
  | RetireInterfaceOperation;

export interface DomainPlanRevisionBatch {
  mutation_id: string;
  reason: string;
  operations: DomainPlanOperation[];
}

type DomainCheck = PlanCheckEntry & { retired_revision?: number };

const CRITERIA_OPERATIONS = new Set<DomainPlanOperation["kind"]>([
  "revise_component",
  "add_component",
  "retire_component",
  "add_check",
  "revise_check",
  "retire_check",
  "revise_goal",
  "add_interface",
  "retire_interface",
  "set_source_specifications",
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function domainMutationFingerprint(value: unknown): string {
  return canonical(value);
}

export function createDomainPlanFingerprint(submitted: Plan, metadata: CreateDomainPlanMetadata): string {
  const reason = requiredText(metadata.reason, "reason");
  return domainMutationFingerprint({ kind: "create", submitted, metadata: { ...metadata, reason } });
}

export function isDomainPlan(plan: Plan | undefined): plan is DomainPlan {
  return plan?.domain?.format === "domain-operations-v1";
}

function requiredText(value: string, label: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${label} must be a non-empty string`);
  return result;
}

function normalizedComponent(
  component: PlanComponent,
  criteriaRevision: number,
): PlanComponent {
  return {
    ...structuredClone(component),
    criteria_revision: criteriaRevision,
    checks: (component.checks ?? []).map((check) => structuredClone(check)),
  };
}

function normalizedInterface(
  planInterface: PlanInterface,
  environment: DomainPlanEnvironment,
): PlanInterface {
  return {
    ...structuredClone(planInterface),
    entity_id: environment.id("interface"),
  };
}

function assertSourceLinks(ids: string[]): void {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("an initial domain plan must link at least one active design specification");
  }
  const normalized = ids.map((id) => requiredText(id, "source specification id"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("source specification ids must be unique");
  }
}

export function createDomainPlan(
  submitted: Plan,
  metadata: CreateDomainPlanMetadata,
  evidence: Map<string, ComponentEvidence>,
  environment: DomainPlanEnvironment,
  compatiblePrevious?: Plan,
): DomainPlan {
  const mutationId = requiredText(metadata.mutation_id, "mutation_id");
  const reason = requiredText(metadata.reason, "reason");
  assertSourceLinks(metadata.source_specification_ids);
  const timestamp = environment.now();
  const fingerprint = createDomainPlanFingerprint(submitted, { ...metadata, reason });
  const plan: DomainPlan = {
    ...structuredClone(submitted),
    components: submitted.components.map((component) => normalizedComponent(component, 1)),
    interfaces: (submitted.interfaces ?? []).map((item) => normalizedInterface(item, environment)),
    domain: {
      format: "domain-operations-v1",
      plan_id: environment.id("plan"),
      revision: 1,
      criteria_revision: 1,
      source_specification_ids: [...metadata.source_specification_ids],
      requires_form_review: metadata.requires_form_review ?? false,
      actor: environment.actor,
      created_at: timestamp,
      history: [
        {
          mutation_id: mutationId,
          fingerprint,
          revision: 1,
          criteria_revision: 1,
          criteria_changed: true,
          reason,
          actor: environment.actor,
          timestamp,
          operations: [{ kind: "create_plan" }],
          invalidated_evidence_ids: [],
        },
      ],
    },
  };
  const errors = validatePlanSnapshot({ next: plan, previous: compatiblePrevious, evidence });
  if (errors.length > 0) throw new Error(`Plan rejected:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  return plan;
}

/** Current legacy entities used as the compatibility baseline for an explicit transition. */
export function normalizedLegacyTransitionBaseline(plan: Plan): Plan {
  return {
    goal: plan.goal,
    components: plan.components
      .filter((component) => component.status !== "abandoned" && component.retired_revision === undefined)
      .map((component) => ({
        ...structuredClone(component),
        checks: (component.checks ?? []).filter((check) =>
          check.removed !== true && (check as { retired_revision?: number }).retired_revision === undefined,
        ),
      })),
    interfaces: (plan.interfaces ?? []).filter((planInterface) => planInterface.retired_revision === undefined),
  };
}

function activeComponent(plan: DomainPlan, id: string): PlanComponent {
  const component = plan.components.find((candidate) => candidate.id === id);
  if (!component) throw new Error(`component ${JSON.stringify(id)} does not exist`);
  if (component.retired_revision !== undefined || component.status === "abandoned") {
    throw new Error(`component ${JSON.stringify(id)} is retired`);
  }
  return component;
}

function activeCheck(component: PlanComponent, id: string): DomainCheck {
  const check = (component.checks ?? []).find((candidate) => candidate.id === id) as DomainCheck | undefined;
  if (!check) throw new Error(`check ${JSON.stringify(id)} does not exist on component ${JSON.stringify(component.id)}`);
  if (check.retired_revision !== undefined || check.removed === true) {
    throw new Error(`check ${JSON.stringify(id)} on component ${JSON.stringify(component.id)} is retired`);
  }
  return check;
}

function touchComponent(
  component: PlanComponent,
  criteriaRevision: number,
  invalidated: Set<string>,
): void {
  component.criteria_revision = criteriaRevision;
  if (component.completion) invalidated.add(component.completion.evidence_id);
  delete component.completion;
  if (component.status === "done") component.status = "building";
  delete component.form_review;
}

function sameSemanticInterface(left: PlanInterface, right: PlanInterface): boolean {
  if (left.retired_revision !== undefined) return false;
  return left.a === right.a && left.b === right.b && left.kind === right.kind;
}

export function applyDomainPlanRevision(
  current: DomainPlan,
  submitted: DomainPlanRevisionBatch,
  evidence: Map<string, ComponentEvidence>,
  environment: DomainPlanEnvironment,
): DomainPlan {
  if (!isDomainPlan(current)) throw new Error("revise_plan requires an operation-backed plan");
  const mutationId = requiredText(submitted.mutation_id, "mutation_id");
  const reason = requiredText(submitted.reason, "reason");
  if (!Array.isArray(submitted.operations) || submitted.operations.length === 0) {
    throw new Error("operations must contain at least one explicit domain operation");
  }
  const fingerprint = domainMutationFingerprint({ reason, operations: submitted.operations });
  const priorMutation = current.domain.history.find((entry) => entry.mutation_id === mutationId);
  if (priorMutation) {
    if (priorMutation.fingerprint !== fingerprint) {
      throw new Error(`mutation_id ${JSON.stringify(mutationId)} was already used with different content`);
    }
    return structuredClone(current);
  }

  let next = structuredClone(current);
  const revision = current.domain.revision + 1;
  const criteriaChanged = submitted.operations.some((operation) => CRITERIA_OPERATIONS.has(operation.kind));
  const criteriaRevision = current.domain.criteria_revision + (criteriaChanged ? 1 : 0);
  const invalidated = new Set<string>();
  const touchedComponents = new Set<string>();

  for (const operation of submitted.operations) {
    switch (operation.kind) {
      case "set_component_status": {
        const component = activeComponent(next, operation.component_id);
        if (operation.status === "abandoned") throw new Error("use retire_component to retire a component");
        component.status = operation.status;
        component.blocked_reason = operation.status === "blocked"
          ? requiredText(operation.blocked_reason ?? "", "blocked_reason")
          : undefined;
        break;
      }
      case "record_component_review": {
        const component = activeComponent(next, operation.component_id);
        component.review_history = [
          ...(component.review_history ?? []),
          {
            revision,
            note: requiredText(operation.note, "review note"),
            actor: environment.actor,
            timestamp: environment.now(),
          },
        ];
        break;
      }
      case "record_form_review": {
        const component = activeComponent(next, operation.component_id);
        component.form_review = structuredClone(operation.form_review);
        break;
      }
      case "set_source_specifications": {
        assertSourceLinks(operation.source_specification_ids);
        next.domain.source_specification_ids = [...operation.source_specification_ids];
        next.domain.requires_form_review = operation.requires_form_review ?? false;
        for (const component of next.components) {
          if (component.retired_revision !== undefined || component.status === "abandoned") continue;
          touchComponent(component, criteriaRevision, invalidated);
          touchedComponents.add(component.id);
        }
        break;
      }
      case "revise_component": {
        const component = activeComponent(next, operation.component_id);
        if (operation.description === undefined && operation.bbox_mm === undefined && operation.free_floating_reason === undefined) {
          throw new Error("revise_component must change description, bbox_mm, or free_floating_reason");
        }
        if (operation.description !== undefined) component.description = requiredText(operation.description, "description");
        if (operation.bbox_mm !== undefined) component.bbox_mm = structuredClone(operation.bbox_mm);
        if (operation.free_floating_reason !== undefined) {
          component.free_floating_reason = requiredText(operation.free_floating_reason, "free_floating_reason");
        }
        touchComponent(component, criteriaRevision, invalidated);
        touchedComponents.add(component.id);
        break;
      }
      case "add_component": {
        if (next.components.some((candidate) => candidate.id === operation.component.id)) {
          throw new Error(`component ${JSON.stringify(operation.component.id)} already exists`);
        }
        next.components.push(normalizedComponent(operation.component, criteriaRevision));
        touchedComponents.add(operation.component.id);
        break;
      }
      case "retire_component": {
        const component = activeComponent(next, operation.component_id);
        touchComponent(component, criteriaRevision, invalidated);
        component.status = "abandoned";
        component.abandon_reason = requiredText(operation.reason, "retirement reason");
        component.retired_revision = revision;
        touchedComponents.add(component.id);
        for (const planInterface of next.interfaces) {
          if (planInterface.retired_revision === undefined &&
              (planInterface.a === component.id || planInterface.b === component.id)) {
            planInterface.retired_revision = revision;
          }
        }
        break;
      }
      case "add_check": {
        const component = activeComponent(next, operation.component_id);
        if ((component.checks ?? []).some((candidate) => candidate.id === operation.check.id)) {
          throw new Error(`check ${JSON.stringify(operation.check.id)} already exists on component ${JSON.stringify(component.id)}`);
        }
        touchComponent(component, criteriaRevision, invalidated);
        component.checks = [...(component.checks ?? []), structuredClone(operation.check)];
        touchedComponents.add(component.id);
        break;
      }
      case "revise_check": {
        const component = activeComponent(next, operation.component_id);
        const check = activeCheck(component, operation.check_id);
        if (operation.check.id !== operation.check_id) throw new Error("a revised check must preserve its stable check id");
        touchComponent(component, criteriaRevision, invalidated);
        const index = component.checks!.indexOf(check);
        const priorReason = check.revision_reason?.trim();
        const submittedReason = operation.check.revision_reason?.trim();
        const revisionReason = priorReason
          ? `${priorReason}\n${submittedReason && submittedReason !== priorReason ? submittedReason : reason}`
          : (submittedReason ?? reason);
        component.checks![index] = {
          ...structuredClone(operation.check),
          revision_reason: revisionReason,
        } as DomainCheck;
        touchedComponents.add(component.id);
        break;
      }
      case "retire_check": {
        const component = activeComponent(next, operation.component_id);
        const check = activeCheck(component, operation.check_id);
        touchComponent(component, criteriaRevision, invalidated);
        check.removed = true;
        check.revision_reason = requiredText(operation.reason, "retirement reason");
        check.retired_revision = revision;
        touchedComponents.add(component.id);
        break;
      }
      case "revise_goal": {
        next.goal = requiredText(operation.goal, "goal");
        for (const component of next.components) {
          if (component.retired_revision !== undefined || component.status === "abandoned") continue;
          touchComponent(component, criteriaRevision, invalidated);
          touchedComponents.add(component.id);
        }
        break;
      }
      case "add_interface": {
        activeComponent(next, operation.interface.a);
        activeComponent(next, operation.interface.b);
        if (next.interfaces.some((candidate) => sameSemanticInterface(candidate, operation.interface))) {
          throw new Error("an active interface with the same endpoints and kind already exists");
        }
        next.interfaces.push(normalizedInterface(operation.interface, environment));
        break;
      }
      case "retire_interface": {
        const planInterface = next.interfaces.find((candidate) => candidate.entity_id === operation.interface_id);
        if (!planInterface) throw new Error(`interface ${JSON.stringify(operation.interface_id)} does not exist`);
        if (planInterface.retired_revision !== undefined) throw new Error(`interface ${JSON.stringify(operation.interface_id)} is retired`);
        requiredText(operation.reason, "retirement reason");
        planInterface.retired_revision = revision;
        break;
      }
    }
  }

  for (const componentId of touchedComponents) {
    const component = next.components.find((candidate) => candidate.id === componentId);
    if (component?.status === "done") {
      throw new Error(`component ${JSON.stringify(componentId)} changed criteria and needs new gate evidence before it can be done`);
    }
  }

  next.domain.revision = revision;
  next.domain.criteria_revision = criteriaRevision;
  next.domain.history.push({
    mutation_id: mutationId,
    fingerprint,
    revision,
    criteria_revision: criteriaRevision,
    criteria_changed: criteriaChanged,
    reason,
    actor: environment.actor,
    timestamp: environment.now(),
    operations: structuredClone(submitted.operations),
    invalidated_evidence_ids: [...invalidated],
  });

  // Refit audit flags are derived from current evidence. They are never accepted
  // as model-authored operation fields.
  next = applyPlanEvidenceAnnotations(next, current, evidence) as DomainPlan;

  const errors = validatePlanSnapshot({ next, previous: current, evidence });
  if (errors.length > 0) throw new Error(`Plan revision rejected:\n${errors.map((error) => `- ${error}`).join("\n")}`);

  for (const operation of submitted.operations) {
    if (operation.kind !== "set_component_status" || operation.status !== "done") continue;
    const component = activeComponent(next, operation.component_id);
    const evidenceId = evidence.get(component.id)?.evidenceId;
    if (!evidenceId) throw new Error(`component ${JSON.stringify(component.id)} has no completion evidence`);
    component.completion = { evidence_id: evidenceId, criteria_revision: component.criteria_revision ?? criteriaRevision };
  }
  return next;
}
