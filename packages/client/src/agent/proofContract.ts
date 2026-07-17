import type {
  ComponentIntegrityMeasurement,
  CreateProofContractInput,
  ProofContractCriterionDto,
  ProofContractDto,
  ProofContractPlannedCheckDto,
  ReferenceRegistrationDto,
  ShapeProofRecord,
  SourceSpecificationDto,
} from "@chamfer/shared";
import { REFERENCE_PROOF_POLICY, TEXT_PROOF_POLICY } from "@chamfer/shared";
import { harnessCheckForm, parseComponentDeclaration, PROBE_COMPONENT, runComponentIds, type Plan } from "./plan";
import { isDomainPlan } from "./domainPlan";
import { shapeProofCoverageErrors } from "./shapeProof";

function activeComponents(plan: Plan) {
  return plan.components.filter((component) =>
    component.status !== "abandoned" && component.retired_revision === undefined,
  );
}

export function proofRunIdentityErrors(
  plan: Plan,
  contract: ProofContractDto,
  measurements: { component?: unknown; integrity?: ComponentIntegrityMeasurement },
): string[] {
  const errors: string[] = [];
  const components = activeComponents(plan);
  if (components.length !== 1) {
    errors.push(`the accepted Proven Single Part plan must have exactly one active component, found ${components.length}`);
    return errors;
  }
  const planComponentId = components[0]!.id;
  const contractComponentId = contract.derivation.component.id;
  if (contractComponentId !== planComponentId) {
    errors.push(`proof contract component ${JSON.stringify(contractComponentId)} does not match accepted plan component ${JSON.stringify(planComponentId)}`);
  }
  const declared = runComponentIds(measurements);
  if (declared.length !== 1 || declared[0] !== planComponentId) {
    errors.push(`CAD component declaration must identify only ${JSON.stringify(planComponentId)}, found ${JSON.stringify(declared)}`);
  }
  const integrity = measurements.integrity;
  if (!integrity) {
    errors.push(`kernel integrity evidence is missing for component ${JSON.stringify(planComponentId)}`);
    return errors;
  }
  if (integrity.componentId !== planComponentId || integrity.resultLabel !== planComponentId) {
    errors.push(
      `kernel component identity must match ${JSON.stringify(planComponentId)}; declaration=${JSON.stringify(integrity.componentId)}, result label=${JSON.stringify(integrity.resultLabel)}`,
    );
  }
  if (integrity.status !== "conforming") {
    errors.push(...integrity.issues.map((issue) => issue.detail));
  }
  return errors;
}

export function proofFinalizationPreflightError(
  plan: Plan | undefined,
  contracts: readonly ProofContractDto[],
  operations: readonly {
    kind?: unknown;
    component_id?: unknown;
    status?: unknown;
    component?: { id?: unknown };
  }[],
  registrations: readonly ReferenceRegistrationDto[] = [],
  messages: readonly unknown[] = [],
  activeReferenceIds: readonly string[] = [],
): string | undefined {
  if (!isDomainPlan(plan) || !operations.some((operation) => operation.kind === "set_component_status" && operation.status === "done")) {
    return undefined;
  }
  const contractLineage = contracts.filter((contract) => contract.derivation.planId === plan.domain.plan_id);
  if (contractLineage.length === 0) return undefined;

  const activeIds = new Set(activeComponents(plan).map((component) => component.id));
  for (const operation of operations) {
    if (operation.kind === "retire_component" && typeof operation.component_id === "string") {
      activeIds.delete(operation.component_id);
    }
    if (operation.kind === "add_component" && typeof operation.component?.id === "string") {
      activeIds.add(operation.component.id);
    }
  }
  if (activeIds.size !== 1) {
    return `Proven Single Part completion is blocked because the accepted plan has ${activeIds.size} active deliverable components; exactly one is required.`;
  }
  const contract = currentProofContract(contracts, plan, registrations);
  if (!contract) {
    return "Proven Single Part completion is blocked because the accepted plan has no current proof contract.";
  }
  const componentId = [...activeIds][0]!;
  if (contract.derivation.component.id !== componentId) {
    return `Proven Single Part completion is blocked because proof contract component ${JSON.stringify(contract.derivation.component.id)} does not match accepted plan component ${JSON.stringify(componentId)}.`;
  }
  if (contract.derivation.shapeProof.status === "required") {
    const latestRun = [...messages].reverse().find((message) => {
      const candidate = message as {
        role?: unknown;
        toolName?: unknown;
        details?: {
          measurements?: { component?: unknown };
          code?: { artifactId?: unknown; artifactVersion?: unknown };
        };
      };
      return candidate.role === "toolResult" && candidate.toolName === "run_build123d" &&
        runComponentIds(candidate.details?.measurements).includes(componentId);
    }) as {
      details?: {
        shapeProof?: ShapeProofRecord;
        code?: { artifactId?: unknown; artifactVersion?: unknown };
      };
    } | undefined;
    const proof = latestRun?.details?.shapeProof;
    if (!proof) {
      return "Proven Single Part completion is blocked because the latest CAD artifact has no current independent shape-proof record.";
    }
    const code = latestRun?.details?.code;
    if (typeof code?.artifactId !== "string" || typeof code.artifactVersion !== "number") {
      return "Proven Single Part completion is blocked because the latest CAD artifact identity is unavailable.";
    }
    const coverageErrors = shapeProofCoverageErrors(
      proof,
      contract,
      registrations,
      { id: code.artifactId, version: code.artifactVersion },
      activeReferenceIds,
    );
    if (coverageErrors.length > 0) {
      return `Proven Single Part completion is blocked because independent shape proof coverage is invalid: ${coverageErrors.join("; ")}`;
    }
  }
  return undefined;
}

function activeChecks(plan: Plan): ProofContractPlannedCheckDto[] {
  return activeComponents(plan).flatMap((component) =>
    (component.checks ?? []).flatMap((check) => {
      const retired = (check as { retired_revision?: number }).retired_revision !== undefined || check.removed === true;
      if (retired) return [];
      return [{
        id: check.id,
        componentId: component.id,
        kind: check.kind,
        criterion: harnessCheckForm(check),
      }];
    }),
  );
}

function sourceCriteria(specifications: readonly SourceSpecificationDto[]): ProofContractCriterionDto[] {
  return specifications.map((specification) => ({
    id: `specification:${specification.id}`,
    category: "messageId" in specification.source
      ? "explicit-requirement" as const
      : "source-derived-requirement" as const,
    statement: specification.requirement,
    sourceSpecificationId: specification.id,
  }));
}

function deriveBase(
  plan: Plan,
  activeSpecifications: readonly SourceSpecificationDto[],
  proofPolicy: ProofContractDto["derivation"]["proofPolicy"],
  shapeProof: ProofContractDto["derivation"]["shapeProof"],
): CreateProofContractInput | undefined {
  const components = activeComponents(plan);
  if (components.length !== 1 || !isDomainPlan(plan)) return undefined;
  const component = components[0]!;
  const assumptions: ProofContractCriterionDto[] = [{
    id: `assumption:${component.id}:description`,
    category: "agent-assumption",
    statement: `The accepted plan interprets the requested part as ${component.description}.`,
  }];
  if (component.bbox_mm) {
    assumptions.push({
      id: `assumption:${component.id}:envelope`,
      category: "agent-assumption",
      statement: `The accepted plan uses a ${component.bbox_mm.join(" x ")} mm target envelope.`,
    });
  }
  const currentHistory = plan.domain.history.at(-1);
  return {
    derivation: {
      planId: plan.domain.plan_id,
      planRevision: plan.domain.revision,
      criteriaRevision: plan.domain.criteria_revision,
      sourceSpecificationIds: [...plan.domain.source_specification_ids],
      component: {
        id: component.id,
        description: component.description,
        ...(component.bbox_mm ? { bboxMm: [...component.bbox_mm] } : {}),
      },
      criteria: [
        ...sourceCriteria(activeSpecifications),
        {
          id: "policy:single-connected-solid",
          category: "conservative-default",
          statement: "The deliverable must be exactly one connected, valid solid.",
        },
        {
          id: "policy:current-verification",
          category: "conservative-default",
          statement: "Current verification-gate and plan-conformance evidence are required.",
        },
        ...assumptions,
      ],
      plannedChecks: activeChecks(plan),
      unavailableEvidence: (plan.spec_sheet ?? []).flatMap((row) => row.unverifiable_reason?.trim()
        ? [{ id: row.id, requirement: row.text, reason: row.unverifiable_reason.trim() }]
        : []),
      invalidatedEvidenceIds: [...(currentHistory?.invalidated_evidence_ids ?? [])],
      proofPolicy,
      shapeProof,
    },
  };
}

/**
 * Returns the immutable target projection for an eligible text-only single part.
 * Reference-backed parts use deriveReferenceProofContract; multi-component plans remain out of scope.
 */
export function deriveTextProofContract(
  plan: Plan | undefined,
  specifications: readonly SourceSpecificationDto[],
): CreateProofContractInput | undefined {
  if (!isDomainPlan(plan)) return undefined;
  const activeSpecifications = specifications.filter((specification) => specification.status === "active");
  if (activeSpecifications.length === 0 || activeSpecifications.some((specification) => !("messageId" in specification.source))) {
    return undefined;
  }
  return deriveBase(plan, activeSpecifications, TEXT_PROOF_POLICY, {
    status: "not-applicable",
    reason: "No eligible reference image was supplied for this text-only part.",
  });
}

export function deriveReferenceProofContract(
  plan: Plan | undefined,
  specifications: readonly SourceSpecificationDto[],
  registrations: readonly ReferenceRegistrationDto[],
): CreateProofContractInput | undefined {
  if (!isDomainPlan(plan)) return undefined;
  const activeSpecifications = specifications.filter((specification) => specification.status === "active");
  const current = registrations.filter((registration) => registration.status === "current");
  const sourceReferenceIds = [...new Set(activeSpecifications.flatMap((specification) =>
    "attachmentId" in specification.source ? [specification.source.attachmentId] : [],
  ))];
  const referenceIds = sourceReferenceIds.length > 0
    ? sourceReferenceIds
    : [...new Set(current.map((registration) => registration.referenceId))];
  if (referenceIds.length === 0) return undefined;
  const governing = referenceIds.map((referenceId) => current.find((registration) => registration.referenceId === referenceId));
  if (governing.some((registration) => !registration)) return undefined;
  const registrationBindings = governing.map((registration) => ({
    registrationId: registration!.registrationId,
    referenceId: registration!.referenceId,
    revision: registration!.revision,
    eligibility: registration!.eligibility.status,
  }));
  const advisory = governing.filter((registration) => registration!.eligibility.status === "advisory");
  return deriveBase(plan, activeSpecifications, REFERENCE_PROOF_POLICY, advisory.length === 0
    ? {
        status: "required",
        registrations: registrationBindings,
        reason: "Every governing reference is eligible for independent shape proof.",
      }
    : {
        status: "unavailable",
        registrations: registrationBindings,
        reason: `Independent shape proof is unavailable because ${advisory.length} governing reference registration${advisory.length === 1 ? " is" : "s are"} advisory.`,
      });
}

export function deriveProofContract(
  plan: Plan | undefined,
  specifications: readonly SourceSpecificationDto[],
  registrations: readonly ReferenceRegistrationDto[],
): CreateProofContractInput | undefined {
  return deriveReferenceProofContract(plan, specifications, registrations) ?? deriveTextProofContract(plan, specifications);
}

export function currentProofContract(
  contracts: readonly ProofContractDto[],
  plan: Plan | undefined,
  registrations: readonly ReferenceRegistrationDto[] = [],
): ProofContractDto | undefined {
  if (!isDomainPlan(plan)) return undefined;
  const currentRegistrations = new Map(registrations
    .filter((registration) => registration.status === "current")
    .map((registration) => [registration.registrationId, registration]));
  return contracts.find((contract) =>
    contract.status === "current" &&
    contract.derivation.planId === plan.domain.plan_id &&
    contract.derivation.criteriaRevision === plan.domain.criteria_revision &&
    ((contract.derivation.proofPolicy.id === TEXT_PROOF_POLICY.id &&
      contract.derivation.proofPolicy.version === TEXT_PROOF_POLICY.version) ||
     (contract.derivation.proofPolicy.id === REFERENCE_PROOF_POLICY.id &&
      contract.derivation.proofPolicy.version === REFERENCE_PROOF_POLICY.version &&
      contract.derivation.shapeProof.status !== "not-applicable" &&
      contract.derivation.shapeProof.registrations.every((binding) =>
        currentRegistrations.get(binding.registrationId)?.revision === binding.revision))),
  );
}

export function isProbeCadCode(code: string): boolean {
  const declaration = parseComponentDeclaration(code);
  return declaration?.length === 1 && declaration[0] === PROBE_COMPONENT;
}

export function proofContractPreflightError(
  plan: Plan | undefined,
  specifications: readonly SourceSpecificationDto[],
  contracts: readonly ProofContractDto[],
  code: string,
  registrations: readonly ReferenceRegistrationDto[] = [],
): string | undefined {
  if (!deriveProofContract(plan, specifications, registrations) || isProbeCadCode(code)) return undefined;
  if (currentProofContract(contracts, plan, registrations)) return undefined;
  return "run_build123d is blocked because this single part has no current frozen proof contract. Chamfer must derive and freeze the contract from the active source requirements, accepted plan, current reference registrations, and product proof policy before retrying the deliverable run.";
}
