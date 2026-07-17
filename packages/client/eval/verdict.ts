import { parseEvaluationResult, type EvaluationResult } from "./result";
import type { PrivacyScan } from "./privacy";

export type TaskOutcome = EvaluationResult["outcome"]["kind"];
export type ProductOutcome = "completed" | "escalated" | "blocked";
export type ExecutionState = EvaluationResult["execution"]["state"];

export function classifyOutcome(execution: ExecutionState, product: ProductOutcome): TaskOutcome {
  if (execution === "failed") return "infrastructure-failure";
  if (execution === "interrupted") return "interrupted";
  if (execution === "incomplete") return "incomplete";
  return product;
}

export type VerdictLayerStatus =
  | "passed"
  | "failed"
  | "incomplete"
  | "not-applicable"
  | "not-evaluated";

export type IntegrityViolationKind =
  | "privacy-failure"
  | "missing-evaluation-identity"
  | "identity-conflict"
  | "missing-attempt"
  | "incomplete-execution"
  | "required-score-missing"
  | "required-evaluator-unavailable"
  | "false-success"
  | "known-negative-success"
  | "requirement-weakening"
  | "stale-evidence-success"
  | "evaluator-fail-open";

export interface IntegrityViolation {
  kind: IntegrityViolationKind;
  attempt?: string;
  detail: string;
}

export interface CohortVerdict {
  schemaVersion: 1;
  requiredAttempts: RequiredAttempt[];
  status: "passed" | "failed" | "incomplete";
  passes: boolean;
  decidingLayer: "integrity" | "proficiency" | "reliability" | "efficiency" | "none";
  layers: {
    integrity: { status: VerdictLayerStatus; violations: IntegrityViolation[] };
    proficiency: {
      status: VerdictLayerStatus;
      matched: number;
      evaluated: number;
    };
    reliability: {
      status: VerdictLayerStatus;
      successful: number;
      attempted: number;
      required: number;
    };
    efficiency: {
      status: VerdictLayerStatus;
      attemptedCost: number;
      successfulCost: number;
    };
    diagnostics: {
      infrastructureFailures: number;
      toolErrors: number;
    };
  };
}

export interface RequiredAttempt {
  caseId: string;
  caseVersion: number;
  repetition: number;
}

function attemptKey(value: RequiredAttempt): string {
  return `${value.caseId}@${value.caseVersion}#${value.repetition}`;
}

function resultKey(result: EvaluationResult): string {
  return attemptKey({
    caseId: result.identities.case.id,
    caseVersion: result.identities.case.version,
    repetition: result.identities.repetition.index,
  });
}

const incompleteViolations = new Set<IntegrityViolationKind>([
  "missing-evaluation-identity",
  "missing-attempt",
  "incomplete-execution",
  "required-score-missing",
  "required-evaluator-unavailable",
]);

export function calculateCohortVerdict(input: {
  results: unknown[];
  requiredAttempts: RequiredAttempt[];
  privacy: PrivacyScan;
}): CohortVerdict {
  const violations: IntegrityViolation[] = [];
  const results: EvaluationResult[] = [];
  for (const candidate of input.results) {
    try {
      results.push(parseEvaluationResult(candidate));
    } catch {
      violations.push({
        kind: "missing-evaluation-identity",
        detail: "A result did not satisfy the complete evaluation identity and result contract.",
      });
    }
  }

  if (input.privacy.status === "failed") {
    violations.push({
      kind: "privacy-failure",
      detail: `Privacy scan reported ${input.privacy.findings.length} finding(s).`,
    });
  }

  const byAttempt = new Map<string, EvaluationResult>();
  for (const result of results) {
    const key = resultKey(result);
    if (byAttempt.has(key)) {
      violations.push({ kind: "identity-conflict", attempt: key, detail: "Attempt identity is duplicated." });
    } else {
      byAttempt.set(key, result);
    }
  }
  for (const required of input.requiredAttempts) {
    const key = attemptKey(required);
    if (!byAttempt.has(key)) {
      violations.push({ kind: "missing-attempt", attempt: key, detail: "Required attempt is absent." });
    }
  }

  for (const result of results) {
    const key = resultKey(result);
    if (result.execution.state !== "completed") {
      violations.push({
        kind: "incomplete-execution",
        attempt: key,
        detail: `Execution state is ${result.execution.state}.`,
      });
    }
    const scoringIdentities = new Set(
      [...result.identities.evaluators, ...result.identities.rubrics]
        .map((identity) => `${identity.id}@${identity.version}`),
    );
    for (const score of result.scores.filter((candidate) => candidate.required)) {
      if (!scoringIdentities.has(`${score.id}@${score.evaluatorVersion}`)) {
        violations.push({
          kind: "required-score-missing",
          attempt: key,
          detail: `Required score ${score.id} lacks matching evaluator or rubric identity.`,
        });
      }
      if (score.status === "unavailable") {
        violations.push({
          kind: "required-evaluator-unavailable",
          attempt: key,
          detail: `Required evaluator ${score.id} is unavailable.`,
        });
        if (result.outcome.kind === "completed") {
          violations.push({
            kind: "evaluator-fail-open",
            attempt: key,
            detail: `Completed outcome ignored unavailable evaluator ${score.id}.`,
          });
        }
      }
    }
    const requiredEvaluatorKeys = new Set(
      result.identities.evaluators.filter((identity) => identity.required).map((identity) => identity.id),
    );
    for (const evaluatorId of requiredEvaluatorKeys) {
      if (!result.scores.some((score) => score.id === evaluatorId && score.required)) {
        violations.push({
          kind: "required-score-missing",
          attempt: key,
          detail: `Required evaluator ${evaluatorId} has no score.`,
        });
      }
    }
    if (result.proficiency.included) {
      const requiredRubrics = result.identities.rubrics.filter((identity) => identity.required);
      for (const rubric of requiredRubrics) {
        if (!result.scores.some((score) =>
          score.id === rubric.id && score.evaluatorVersion === rubric.version && score.required
        )) {
          violations.push({
            kind: "required-score-missing",
            attempt: key,
            detail: `Required rubric ${rubric.id} has no score.`,
          });
        }
      }
    }
    if (result.outcome.kind === "completed" &&
        result.scores.some((score) => score.required && score.status !== "passed")) {
      violations.push({
        kind: "false-success",
        attempt: key,
        detail: "Completed outcome has failed or unavailable required evidence.",
      });
    }
    for (const explicit of result.integrity.violations) {
      violations.push({ kind: explicit, attempt: key, detail: `Attempt declared ${explicit}.` });
    }
  }

  const hasIntegrityFailure = violations.some((violation) => !incompleteViolations.has(violation.kind));
  const hasIntegrityIncomplete = violations.length > 0 && !hasIntegrityFailure;
  const integrityStatus: VerdictLayerStatus = hasIntegrityFailure ? "failed"
    : hasIntegrityIncomplete ? "incomplete"
    : "passed";
  const proficiencyResults = results.filter((result) => result.proficiency.included);
  const matched = proficiencyResults.filter((result) => result.outcome.expectedMatch &&
    result.scores.filter((score) => score.required).every((score) => score.status === "passed")
  ).length;
  const proficiencyStatus: VerdictLayerStatus = integrityStatus !== "passed" ? "not-evaluated"
    : proficiencyResults.length === 0 ? "not-applicable"
    : matched === proficiencyResults.length ? "passed"
    : "failed";
  const reliabilityStatus: VerdictLayerStatus = integrityStatus !== "passed" || proficiencyStatus === "failed"
    ? "not-evaluated"
    : proficiencyResults.length === 0 ? "not-applicable"
    : "passed";
  const efficiencyStatus: VerdictLayerStatus = integrityStatus !== "passed" || proficiencyStatus === "failed"
    ? "not-evaluated"
    : proficiencyResults.length === 0 ? "not-applicable"
    : "passed";

  const status = integrityStatus === "failed" ? "failed"
    : integrityStatus === "incomplete" ? "incomplete"
    : proficiencyStatus === "failed" ? "failed"
    : "passed";
  const decidingLayer = integrityStatus !== "passed" ? "integrity"
    : proficiencyStatus === "failed" ? "proficiency"
    : "none";
  const successfulResults = results.filter((result) => result.outcome.expectedMatch);
  return {
    schemaVersion: 1,
    requiredAttempts: [...input.requiredAttempts],
    status,
    passes: status === "passed",
    decidingLayer,
    layers: {
      integrity: { status: integrityStatus, violations },
      proficiency: { status: proficiencyStatus, matched, evaluated: proficiencyResults.length },
      reliability: {
        status: reliabilityStatus,
        successful: successfulResults.length,
        attempted: results.length,
        required: input.requiredAttempts.length,
      },
      efficiency: {
        status: efficiencyStatus,
        attemptedCost: results.reduce((sum, result) => sum + result.measurements.providerCost, 0),
        successfulCost: successfulResults.reduce((sum, result) => sum + result.measurements.providerCost, 0),
      },
      diagnostics: {
        infrastructureFailures: results.filter((result) => result.outcome.kind === "infrastructure-failure").length,
        toolErrors: results.reduce((sum, result) => sum + result.measurements.toolErrors, 0),
      },
    },
  };
}

export function renderCohortVerdict(verdict: CohortVerdict): string {
  const lines = [
    "# Agent Evaluation Verdict",
    "",
    `Verdict: ${verdict.status}.`,
    `Deciding layer: ${verdict.decidingLayer}.`,
    "",
    "| Layer | Status |",
    "| --- | --- |",
    `| Integrity | ${verdict.layers.integrity.status} |`,
    `| Proficiency | ${verdict.layers.proficiency.status} |`,
    `| Reliability | ${verdict.layers.reliability.status} |`,
    `| Efficiency | ${verdict.layers.efficiency.status} |`,
    "",
    "## Integrity findings",
    "",
  ];
  if (verdict.layers.integrity.violations.length === 0) {
    lines.push("No integrity violations were found.");
  } else {
    for (const violation of verdict.layers.integrity.violations) {
      lines.push(`- ${violation.kind}${violation.attempt ? ` (${violation.attempt})` : ""}: ${violation.detail}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
