import type { EvaluationResult } from "./result";
import type { EvaluationCase } from "./schema";

type RecordValue = Record<string, unknown>;

export interface PersistedMessage {
  id: string;
  conversationId: string;
  seq: number;
  contentJson: string;
}

export interface PersistedArtifact {
  id: string;
  version: number;
}

export interface PersistedCaseEvaluation {
  outcome: EvaluationResult["outcome"];
  evidence: EvaluationResult["evidence"];
  measurements: EvaluationResult["measurements"];
  scores: EvaluationResult["scores"];
  integrity: EvaluationResult["integrity"];
}

export interface VisualCanvasEvidence {
  reference: string;
  nonblank: boolean;
}

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null ? value as RecordValue : undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toolCalls(message: RecordValue): RecordValue[] {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .map(record)
    .filter((candidate): candidate is RecordValue => candidate?.type === "toolCall");
}

function messageText(message: RecordValue): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map(record)
    .filter((candidate): candidate is RecordValue => candidate?.type === "text" && typeof candidate.text === "string")
    .map((candidate) => candidate.text as string)
    .join("\n");
}

function bboxConfig(reference: EvaluationCase["evaluatorRefs"][number]): {
  expectedMm: [number, number, number];
  toleranceMm: number;
} | undefined {
  const expected = reference.config.expectedMm;
  const tolerance = reference.config.toleranceMm;
  if (!Array.isArray(expected) || expected.length !== 3 ||
      expected.some((value) => typeof value !== "number") ||
      typeof tolerance !== "number" || tolerance < 0) {
    return undefined;
  }
  return { expectedMm: expected as [number, number, number], toleranceMm: tolerance };
}

function bboxPasses(
  measured: [number, number, number],
  expected: [number, number, number],
  tolerance: number,
): boolean {
  const sortedMeasured = [...measured].sort((left, right) => left - right);
  const sortedExpected = [...expected].sort((left, right) => left - right);
  return sortedMeasured.every((value, index) => Math.abs(value - sortedExpected[index]!) <= tolerance);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((candidate) => typeof candidate === "string")
    ? value
    : undefined;
}

function termsPass(text: string, config: RecordValue): boolean | undefined {
  const requiredTerms = stringArray(config.requiredTerms);
  const forbiddenTerms = stringArray(config.forbiddenTerms);
  if (!requiredTerms || !forbiddenTerms) return undefined;
  const normalized = text.toLocaleLowerCase();
  return requiredTerms.every((term) => normalized.includes(term.toLocaleLowerCase())) &&
    forbiddenTerms.every((term) => !normalized.includes(term.toLocaleLowerCase())) &&
    (config.requiresQuestion !== true || text.includes("?"));
}

function score(input: {
  reference: EvaluationCase["evaluatorRefs"][number];
  status: "passed" | "failed" | "unavailable";
  evidenceIds: string[];
  explanation?: string;
}): EvaluationResult["scores"][number] {
  return {
    id: input.reference.id,
    evaluatorVersion: input.reference.version,
    status: input.status,
    required: input.reference.required,
    ...(input.status === "unavailable" ? {} : { value: input.status === "passed" ? 1 : 0 }),
    ...(input.explanation ? { explanation: input.explanation } : {}),
    evidenceIds: input.evidenceIds,
  };
}

export function evaluatePersistedCase(input: {
  evaluationCase: EvaluationCase;
  conversationId: string;
  messages: PersistedMessage[];
  artifacts: PersistedArtifact[];
  visualCanvasEvidence?: VisualCanvasEvidence;
}): PersistedCaseEvaluation {
  const messages = input.messages.map((message) => JSON.parse(message.contentJson) as RecordValue);
  let cadRuns = 0;
  let modelCalls = 0;
  let totalToolCalls = 0;
  let toolErrors = 0;
  let searches = 0;
  let skillLoads = 0;
  let compactions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let providerCost = 0;
  let finalCadResult: RecordValue | undefined;
  let finalPlanResult: RecordValue | undefined;
  let finalVisualResult: RecordValue | undefined;
  const durableSpecificationIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      modelCalls += 1;
      const usage = record(message.usage);
      inputTokens += numeric(usage?.input);
      outputTokens += numeric(usage?.output);
      cacheReadTokens += numeric(usage?.cacheRead);
      cacheWriteTokens += numeric(usage?.cacheWrite);
      reasoningTokens += numeric(usage?.reasoning);
      providerCost += numeric(record(usage?.cost)?.total);
    }
    if (message.role === "compaction") compactions += 1;
    const calls = toolCalls(message);
    totalToolCalls += calls.length;
    cadRuns += calls.filter((call) => call.name === "run_build123d").length;
    searches += calls.filter((call) => call.name === "search_docs" || call.name === "lookup_docs").length;
    skillLoads += calls.filter((call) => call.name === "load_skill").length;
    if (message.role === "toolResult") {
      if (message.isError === true) toolErrors += 1;
      if (message.toolName === "run_build123d" && message.isError !== true) finalCadResult = message;
      if ((message.toolName === "update_plan" || message.toolName === "create_plan" || message.toolName === "revise_plan") &&
          message.isError !== true) {
        finalPlanResult = message;
      }
      if ((message.toolName === "record_source_specifications" ||
           message.toolName === "record_reference_specifications") && message.isError !== true) {
        const specifications = record(message.details)?.specifications;
        if (Array.isArray(specifications)) {
          for (const specification of specifications) {
            const candidate = record(specification);
            if (typeof candidate?.id === "string" && candidate.status !== "superseded") {
              durableSpecificationIds.add(candidate.id);
            }
          }
        }
      }
      if ((message.toolName === "record_visual_verification" ||
           message.toolName === "record_visual_verification_batch") && message.isError !== true) {
        finalVisualResult = message;
      }
    }
  }

  const details = record(finalCadResult?.details);
  const geometry = record(details?.measurements);
  const gate = record(details?.gate);
  const gateChecks = Array.isArray(gate?.checks)
    ? gate.checks.map(record).filter((candidate): candidate is RecordValue => Boolean(candidate))
    : undefined;
  const rawBbox = geometry?.bboxMm;
  const boundingBoxMm = Array.isArray(rawBbox) && rawBbox.length === 3 &&
      rawBbox.every((value) => typeof value === "number")
    ? rawBbox as [number, number, number]
    : undefined;
  const gatePassed = gate?.status === "passed";
  const code = record(details?.code);
  const artifactId = typeof code?.artifactId === "string" ? code.artifactId : undefined;
  const artifactVersion = typeof code?.artifactVersion === "number" ? code.artifactVersion : undefined;
  const matchedArtifact = artifactId && artifactVersion
    ? input.artifacts.find((artifact) => artifact.id === artifactId && artifact.version === artifactVersion)
    : undefined;
  const plan = record(record(finalPlanResult?.details)?.plan);
  const visualDetails = record(finalVisualResult?.details);
  const visualRecord = record(visualDetails?.finalVerification) ?? visualDetails;

  const evidence: EvaluationResult["evidence"] = [
    { id: "conversation", kind: "conversation", reference: `conversation:${input.conversationId}` },
  ];
  if (matchedArtifact) {
    evidence.push({
      id: "artifact",
      kind: "cad-artifact",
      reference: `artifact:${matchedArtifact.id}:${matchedArtifact.version}`,
    });
  }
  if (gate) {
    evidence.push({ id: "verification-gate", kind: "verification-gate", reference: `conversation:${input.conversationId}:gate` });
  }
  if (geometry) {
    evidence.push({ id: "geometry-measurement", kind: "geometry-measurement", reference: `conversation:${input.conversationId}:geometry` });
  }
  if (plan) {
    evidence.push({ id: "plan", kind: "plan", reference: `conversation:${input.conversationId}:plan` });
  }
  if (visualRecord) {
    evidence.push({
      id: "visual-verification",
      kind: "visual-verification",
      reference: `conversation:${input.conversationId}:visual-verification`,
    });
  }
  if (input.visualCanvasEvidence?.nonblank) {
    evidence.push({ id: "rendered-canvas", kind: "screenshot", reference: input.visualCanvasEvidence.reference });
  }

  const finalAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const finalText = finalAssistant ? messageText(finalAssistant) : "";

  const scores: EvaluationResult["scores"] = input.evaluationCase.evaluatorRefs.map((reference) => {
    if (reference.id === "verification-gate") {
      const expectedStatus = reference.config.expectedStatus ?? "passed";
      const configured = expectedStatus === "passed" || expectedStatus === "failed";
      const status = !configured || !gate ? "unavailable"
        : gate.status === expectedStatus ? "passed"
        : "failed";
      return score({ reference, status, evidenceIds: gate ? ["verification-gate"] : ["conversation"] });
    }
    if (reference.id === "bbox") {
      const config = bboxConfig(reference);
      const status = config && boundingBoxMm
        ? bboxPasses(boundingBoxMm, config.expectedMm, config.toleranceMm) ? "passed" : "failed"
        : "unavailable";
      return score({
        reference,
        status,
        evidenceIds: geometry ? ["geometry-measurement"] : matchedArtifact ? ["artifact"] : ["conversation"],
      });
    }
    if (reference.id === "bbox-axis") {
      const axis = reference.config.axis;
      const expected = reference.config.expectedMm;
      const tolerance = reference.config.toleranceMm;
      const configured = (axis === "smallest" || axis === "largest") &&
        typeof expected === "number" && typeof tolerance === "number" && tolerance >= 0;
      const sorted = boundingBoxMm ? [...boundingBoxMm].sort((left, right) => left - right) : undefined;
      const measured = sorted ? axis === "smallest" ? sorted[0] : sorted[2] : undefined;
      const status = !configured || measured === undefined
        ? "unavailable"
        : Math.abs(measured - expected) <= tolerance ? "passed" : "failed";
      return score({ reference, status, evidenceIds: geometry ? ["geometry-measurement"] : ["conversation"] });
    }
    if (reference.id === "volume-range") {
      const minimum = reference.config.minimumMm3;
      const maximum = reference.config.maximumMm3;
      const measured = geometry?.volumeMm3;
      const configured = typeof minimum === "number" && typeof maximum === "number" && minimum <= maximum;
      const status = !configured || typeof measured !== "number"
        ? "unavailable"
        : measured >= minimum && measured <= maximum ? "passed" : "failed";
      return score({ reference, status, evidenceIds: geometry ? ["geometry-measurement"] : ["conversation"] });
    }
    if (reference.id === "gate-checks") {
      const names = stringArray(reference.config.names);
      const status = !names || !gateChecks
        ? "unavailable"
        : names.every((name) => gateChecks.some((candidate) => candidate.name === name && candidate.passed === true))
          ? "passed"
          : "failed";
      return score({ reference, status, evidenceIds: gate ? ["verification-gate"] : ["conversation"] });
    }
    if (reference.id === "plan-conformance") {
      const minimumSpecRows = reference.config.minimumSpecRows;
      const specSheet = plan?.spec_sheet;
      const specificationCount = Array.isArray(specSheet) ? specSheet.length : durableSpecificationIds.size;
      const status = typeof minimumSpecRows !== "number" || !Number.isInteger(minimumSpecRows) || minimumSpecRows < 0
        ? "unavailable"
        : !plan
          ? "unavailable"
          : specificationCount >= minimumSpecRows ? "passed" : "failed";
      return score({ reference, status, evidenceIds: plan ? ["plan"] : ["conversation"] });
    }
    if (reference.id === "visual-verification") {
      const minimumReferences = reference.config.minimumReferences;
      const covered = visualRecord?.coveredReferenceIds;
      const currentArtifact = visualRecord?.artifactId === artifactId && visualRecord?.artifactVersion === artifactVersion;
      const renderedCanvasIsCurrent = input.visualCanvasEvidence?.nonblank === true;
      const status = typeof minimumReferences !== "number" || !Number.isInteger(minimumReferences) || minimumReferences < 1
        ? "unavailable"
        : !visualRecord
          ? "unavailable"
          : visualRecord.verdict === "match" && currentArtifact && renderedCanvasIsCurrent &&
              Array.isArray(covered) && new Set(covered).size >= minimumReferences
            ? "passed"
            : "failed";
      return score({
        reference,
        status,
        evidenceIds: visualRecord
          ? ["visual-verification", ...(renderedCanvasIsCurrent ? ["rendered-canvas"] : [])]
          : ["conversation"],
      });
    }
    if (reference.id === "focused-escalation" || reference.id === "honest-blocking") {
      const passed = finalAssistant ? termsPass(finalText, reference.config) : undefined;
      return score({
        reference,
        status: passed === undefined ? "unavailable" : passed ? "passed" : "failed",
        evidenceIds: ["conversation"],
      });
    }
    if (reference.id === "cad-run-count") {
      const maximum = reference.config.maximum;
      const status = typeof maximum === "number" && Number.isInteger(maximum) && maximum >= 0
        ? cadRuns <= maximum ? "passed" : "failed"
        : "unavailable";
      return score({ reference, status, evidenceIds: ["conversation"] });
    }
    return score({
      reference,
      status: "unavailable",
      explanation: "Evaluator implementation is unavailable.",
      evidenceIds: ["conversation"],
    });
  });

  const requiredScoresPass = scores
    .filter((score) => score.required)
    .every((score) => score.status === "passed");
  const completed = Boolean(finalCadResult && matchedArtifact && gatePassed && requiredScoresPass);
  const safeNonCompletion = requiredScoresPass && finalAssistant && cadRuns === 0;
  const kind = input.evaluationCase.expectedOutcome.kind === "escalated" && safeNonCompletion
    ? "escalated"
    : input.evaluationCase.expectedOutcome.kind === "blocked" && requiredScoresPass && finalAssistant
      ? "blocked"
      : completed ? "completed" : "incomplete";
  const claimsCompletion = finalAssistant
    ? /\b(?:task|design|model|part|request)\s+(?:is|was)\s+(?:complete|completed|done|satisfied)\b/i
      .test(messageText(finalAssistant))
    : false;
  if (kind === "escalated") {
    evidence.push({ id: "escalation", kind: "escalation", reference: `conversation:${input.conversationId}:final` });
  }
  if (kind === "blocked") {
    evidence.push({ id: "blocked-reason", kind: "blocked-reason", reference: `conversation:${input.conversationId}:final` });
  }
  const knownNegativeCase = input.evaluationCase.forbiddenOutcomes
    .some((outcome) => outcome.kind === "known-negative-success");
  return {
    outcome: {
      kind,
      expectedMatch: kind === input.evaluationCase.expectedOutcome.kind,
    },
    evidence,
    measurements: {
      ...(gate ? { gatePassed } : {}),
      ...(boundingBoxMm ? { boundingBoxMm } : {}),
      cadRuns,
      modelCalls,
      toolCalls: totalToolCalls,
      toolErrors,
      searches,
      skillLoads,
      compactions,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      providerCost,
    },
    scores,
    integrity: {
      violations: (gate?.status === "failed" || knownNegativeCase) && claimsCompletion
        ? ["known-negative-success"]
        : [],
    },
  };
}
