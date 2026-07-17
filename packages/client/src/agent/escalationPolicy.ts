import type {
  DesignEscalationDto,
  OpenDesignEscalationInput,
  ProofContractDto,
  SourceSpecificationDto,
} from "@chamfer/shared";
import type { DomainPlanRevisionBatch } from "./domainPlan";
import { checkWeakeningReasons, type Plan, type PlanCheckEntry } from "./plan";

export const DESIGN_ESCALATION_CONTEXT_MARKER = "[Current design clarification state]";

export function pendingDesignEscalation(
  escalations: readonly DesignEscalationDto[],
): DesignEscalationDto | undefined {
  return escalations.find((escalation) => escalation.status === "pending");
}

export function activeSpecificationConflict(
  specifications: readonly SourceSpecificationDto[],
): [SourceSpecificationDto, SourceSpecificationDto] | undefined {
  const active = new Map(
    specifications.filter((specification) => specification.status === "active").map((specification) => [specification.id, specification]),
  );
  for (const specification of active.values()) {
    for (const conflictId of specification.conflictsWithSpecificationIds ?? []) {
      const conflict = active.get(conflictId);
      if (conflict) return [specification, conflict];
    }
  }
  return undefined;
}

export function designActionEscalationError(
  specifications: readonly SourceSpecificationDto[],
  escalations: readonly DesignEscalationDto[],
): string | undefined {
  const pending = pendingDesignEscalation(escalations);
  if (pending) {
    return `Design work is blocked pending the user's answer to one focused question: ${pending.question}`;
  }
  const conflict = activeSpecificationConflict(specifications);
  if (conflict) {
    return `Conflicting active source requirements ${conflict[0].id} and ${conflict[1].id} block this action. Call request_design_clarification with one focused question before choosing either requirement.`;
  }
  return undefined;
}

function currentCheck(plan: Plan, componentId: string, checkId: string): PlanCheckEntry | undefined {
  return plan.components.find((component) => component.id === componentId)?.checks?.find((check) => check.id === checkId);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(left);
  return set.size === right.length && right.every((id) => set.has(id));
}

export function explicitRequirementWeakeningReasons(
  plan: Plan | undefined,
  batch: DomainPlanRevisionBatch,
  specifications: readonly SourceSpecificationDto[],
  contract: ProofContractDto | undefined,
): string[] {
  if (!plan?.domain || !contract) return [];
  const protectedIds = contract.derivation.criteria
    .filter((criterion) => criterion.category === "explicit-requirement" && criterion.sourceSpecificationId)
    .map((criterion) => criterion.sourceSpecificationId!);
  if (protectedIds.length === 0) return [];
  const activeIds = specifications.filter((specification) => specification.status === "active").map((specification) => specification.id);
  if (!sameIds(plan.domain.source_specification_ids, activeIds)) return [];

  const reasons: string[] = [];
  for (const operation of batch.operations) {
    if (operation.kind === "retire_component") {
      reasons.push(`component ${operation.component_id} would be retired`);
    } else if (operation.kind === "retire_check") {
      reasons.push(`check ${operation.component_id}.${operation.check_id} would be retired`);
    } else if (operation.kind === "revise_component") {
      const component = plan.components.find((candidate) => candidate.id === operation.component_id);
      if (component && operation.description !== undefined && operation.description !== component.description) {
        reasons.push(`component ${operation.component_id} would be materially reinterpreted`);
      }
      if (component && operation.bbox_mm !== undefined && JSON.stringify(operation.bbox_mm) !== JSON.stringify(component.bbox_mm)) {
        reasons.push(`component ${operation.component_id} envelope would change`);
      }
    } else if (operation.kind === "revise_goal" && operation.goal !== plan.goal) {
      reasons.push("the accepted design goal would change");
    } else if (operation.kind === "retire_interface") {
      reasons.push(`interface ${operation.interface_id} would be retired`);
    } else if (operation.kind === "revise_check") {
      const previous = currentCheck(plan, operation.component_id, operation.check_id);
      if (!previous) continue;
      const next = { ...operation.check, id: operation.check_id } as PlanCheckEntry;
      for (const reason of checkWeakeningReasons(next, previous)) {
        reasons.push(`check ${operation.component_id}.${operation.check_id} ${reason}`);
      }
    }
  }
  return reasons;
}

export function validateDesignEscalationRequest(
  input: OpenDesignEscalationInput,
  specifications: readonly SourceSpecificationDto[],
  escalations: readonly DesignEscalationDto[],
  blockedWeakeningReasons: readonly string[],
): string | undefined {
  if (pendingDesignEscalation(escalations)) return "one focused design clarification is already pending";
  const activeIds = new Set(specifications.filter((specification) => specification.status === "active").map((item) => item.id));
  if (input.affectedSpecificationIds.some((id) => !activeIds.has(id))) {
    return "every affectedSpecificationId must name a current active source requirement";
  }
  if (input.kind === "conflicting-specifications" && !activeSpecificationConflict(specifications)) {
    return "no declared conflict exists between active source requirements";
  }
  if (input.kind === "explicit-requirement-change" && blockedWeakeningReasons.length === 0) {
    return "no blocked explicit-requirement weakening is awaiting clarification";
  }
  return undefined;
}

export function projectDesignEscalations(
  messages: import("@earendil-works/pi-agent-core").AgentMessage[],
  escalations: readonly DesignEscalationDto[],
): import("@earendil-works/pi-agent-core").AgentMessage[] {
  if (escalations.length === 0) return messages;
  const withoutPrior = messages.filter((message) => {
    const content = (message as { content?: unknown }).content;
    return !Array.isArray(content) || !content.some((block) =>
      typeof block === "object" && block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.startsWith(DESIGN_ESCALATION_CONTEXT_MARKER),
    );
  });
  const rows = escalations.map((escalation) =>
    `- ${escalation.escalationId}: ${escalation.status}; kind=${escalation.kind}; question=${JSON.stringify(escalation.question)}; affected=${escalation.affectedSpecificationIds.join(",")}; resolution=${escalation.resolutionSpecificationIds.join(",")}`,
  );
  return [{
    role: "user",
    content: [{
      type: "text",
      text: `${DESIGN_ESCALATION_CONTEXT_MARKER}\nPending clarification blocks plan mutation and deliverable CAD. A resolved answer is durable source evidence and prior history remains immutable.\n${rows.join("\n")}`,
    }],
    timestamp: escalations[0]!.openedAt,
  } as import("@earendil-works/pi-agent-core").AgentMessage, ...withoutPrior];
}
