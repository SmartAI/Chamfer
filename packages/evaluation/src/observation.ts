import type { EvaluationTask, RequiredProofEvidence } from "./schema";
import type {
  EvaluationObservation,
  ObservedFinalStatus,
  SanitizedTraceEntry,
} from "./scoring";

interface StoredMessage {
  seq: number;
  contentJson: string;
}

interface ProofContractLike {
  contractId?: unknown;
  revision?: unknown;
  status?: unknown;
  derivation?: {
    planId?: unknown;
    criteriaRevision?: unknown;
    proofPolicy?: { id?: unknown; version?: unknown };
  };
}

interface ArtifactLike {
  id?: unknown;
  version?: unknown;
}

interface VisualVerificationLike {
  verdict?: unknown;
}

interface ProofReportLike {
  reportId?: unknown;
  status?: unknown;
  proofContract?: {
    contractId?: unknown;
    revision?: unknown;
    derivation?: {
      planId?: unknown;
      criteriaRevision?: unknown;
      proofPolicy?: { id?: unknown; version?: unknown };
    };
  };
  cadArtifact?: { id?: unknown; version?: unknown };
  shapeProof?: { state?: unknown };
  visualVerification?: { state?: unknown };
}

export interface ProductionConversationSnapshot {
  messages: StoredMessage[];
  proofContracts: ProofContractLike[];
  artifacts: ArtifactLike[];
  visualVerifications: VisualVerificationLike[];
  proofReports: ProofReportLike[];
  elapsedMs: number;
  configuredProvider: string;
  configuredModel: string;
}

export interface AnalyzedRun {
  observation: EvaluationObservation;
  trace: SanitizedTraceEntry[];
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentText(message: RecordValue | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

function toolCalls(message: RecordValue): RecordValue[] {
  return Array.isArray(message.content)
    ? message.content.map(record).filter((item): item is RecordValue => item?.type === "toolCall")
    : [];
}

function currentPlan(messages: RecordValue[]): RecordValue | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "toolResult" || message.isError === true) continue;
    if (message.toolName !== "create_plan" && message.toolName !== "revise_plan" && message.toolName !== "update_plan") continue;
    const plan = record(record(message.details)?.plan);
    if (plan) return plan;
  }
  return undefined;
}

function activeComponents(plan: RecordValue | undefined): RecordValue[] {
  if (!Array.isArray(plan?.components)) return [];
  return plan.components
    .map(record)
    .filter((component): component is RecordValue =>
      component !== undefined && component.status !== "abandoned" && component.retired_revision === undefined,
    );
}

function durableProofReport(message: RecordValue): RecordValue | undefined {
  if (
    message.role === "proofReport" &&
    message.finalStatus === "proven" &&
    typeof message.proofReportId === "string"
  ) {
    return message;
  }
  return undefined;
}

function assistantQuestion(messages: RecordValue[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const text = contentText(message).trim();
    if (!text) continue;
    return (text.match(/\?/g) ?? []).length === 1;
  }
  return false;
}

function finalStatus(
  messages: RecordValue[],
  plan: RecordValue | undefined,
  proofReports: ProofReportLike[],
): ObservedFinalStatus {
  if (messages.some((message) => message.role === "assistant" && (message.stopReason === "error" || message.errorMessage))) {
    return "error";
  }
  if (proofReports.some((report) => report.status === "proven") || messages.some((message) => durableProofReport(message))) {
    return "proven";
  }
  if (activeComponents(plan).some((component) => component.status === "blocked" && stringValue(component.blocked_reason))) {
    return "blocked";
  }
  if (assistantQuestion(messages)) return "escalated";
  return "unproven";
}

function evidenceFor(
  messages: RecordValue[],
  plan: RecordValue | undefined,
  contracts: ProofContractLike[],
  artifacts: ArtifactLike[],
  visualVerifications: VisualVerificationLike[],
  proofReports: ProofReportLike[],
): RequiredProofEvidence[] {
  const evidence = new Set<RequiredProofEvidence>();
  if (proofReports.some((report) => report.status === "proven") || messages.some((message) => durableProofReport(message))) {
    evidence.add("proof-report");
  }
  if (contracts.some((contract) => contract.status === "current")) evidence.add("proof-contract");
  const gatePassed = messages.some((message) => {
    if (message.role !== "toolResult" || (message.toolName !== "run_build123d" && message.toolName !== "execute_cad_change") || message.isError === true) return false;
    const details = record(message.details);
    const measurements = record(details?.measurements);
    if (measurements?.component === "probe") return false;
    return record(details?.gate)?.status === "passed";
  });
  if (gatePassed) evidence.add("verification-gate");
  const components = activeComponents(plan);
  if (components.length > 0 && components.every((component) => component.status === "done")) evidence.add("plan-completion");
  if (artifacts.some((artifact) => stringValue(artifact.id) && numberValue(artifact.version))) evidence.add("artifact-identity");
  if (visualVerifications.some((verification) => verification.verdict === "match")) evidence.add("visual-verification");
  if (proofReports.some((report) => report.status === "proven" && report.shapeProof?.state === "proven")) {
    evidence.add("shape-proof");
  }
  if (assistantQuestion(messages)) evidence.add("focused-question");
  if (components.some((component) => component.status === "blocked" && stringValue(component.blocked_reason))) {
    evidence.add("blocked-reason");
  }
  if (messages.some((message) =>
    message.role === "toolResult" && message.toolName === "update_plan" && message.isError === true,
  )) {
    evidence.add("rejected-weakening");
  }
  return [...evidence].sort();
}

function sanitizedTrace(messages: Array<{ seq: number; value: RecordValue }>): SanitizedTraceEntry[] {
  return messages.map(({ seq, value }) => {
    const details = record(value.details);
    return {
      seq,
      role: stringValue(value.role) ?? "unknown",
      ...(stringValue(value.toolName) ? { toolName: stringValue(value.toolName) } : {}),
      ...(stringValue(value.stopReason) ? { stopReason: stringValue(value.stopReason) } : {}),
      ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
      ...(stringValue(record(details?.gate)?.status) ? { gateStatus: stringValue(record(details?.gate)?.status) } : {}),
    };
  });
}

export function analyzeProductionConversation(
  task: EvaluationTask,
  snapshot: ProductionConversationSnapshot,
  promptVersion: string,
): AnalyzedRun {
  const parsed = snapshot.messages.map((message) => ({
    seq: message.seq,
    value: record(JSON.parse(message.contentJson)) ?? {},
  }));
  const messages = parsed.map((message) => message.value);
  const assistants = messages.filter((message) => message.role === "assistant");
  const usage = assistants.reduce<{ input: number; output: number; total: number }>((total, message) => {
    const candidate = record(message.usage);
    total.input += numberValue(candidate?.input) ?? 0;
    total.output += numberValue(candidate?.output) ?? 0;
    total.total += numberValue(candidate?.totalTokens) ?? 0;
    return total;
  }, { input: 0, output: 0, total: 0 });
  const provider = assistants.map((message) => stringValue(message.provider)).find(Boolean) ?? snapshot.configuredProvider;
  const model = assistants.map((message) => stringValue(message.model)).find(Boolean) ?? snapshot.configuredModel;
  const cadRunCount = messages.reduce((count, message) =>
    count + toolCalls(message).filter((call) => call.name === "run_build123d").length, 0);
  const plan = currentPlan(messages);
  const contract = [...snapshot.proofContracts].reverse().find((candidate) => candidate.status === "current")
    ?? snapshot.proofContracts.at(-1);
  const artifact = snapshot.artifacts.at(-1);
  const persistedReport = [...snapshot.proofReports].reverse().find((candidate) => candidate.status === "proven");
  const messageReport = messages.map(durableProofReport).find(Boolean);
  const reportContract = persistedReport?.proofContract;
  const reportArtifact = persistedReport?.cadArtifact;
  return {
    observation: {
      provider,
      model,
      promptVersion,
      latencyMs: snapshot.elapsedMs,
      tokenUse: usage,
      cadRunCount,
      finalStatus: finalStatus(messages, plan, snapshot.proofReports),
      evidence: evidenceFor(
        messages,
        plan,
        snapshot.proofContracts,
        snapshot.artifacts,
        snapshot.visualVerifications,
        snapshot.proofReports,
      ),
      proofIdentities: {
        ...(stringValue(persistedReport?.reportId ?? messageReport?.proofReportId)
          ? { proofReportId: stringValue(persistedReport?.reportId ?? messageReport?.proofReportId) }
          : {}),
        ...(stringValue(reportContract?.contractId ?? contract?.contractId)
          ? { proofContractId: stringValue(reportContract?.contractId ?? contract?.contractId) }
          : {}),
        ...(numberValue(reportContract?.revision ?? contract?.revision)
          ? { proofContractRevision: numberValue(reportContract?.revision ?? contract?.revision) }
          : {}),
        proofPolicyId: stringValue(reportContract?.derivation?.proofPolicy?.id ?? contract?.derivation?.proofPolicy?.id)
          ?? task.proofPolicy.id,
        proofPolicyVersion: numberValue(
          reportContract?.derivation?.proofPolicy?.version ?? contract?.derivation?.proofPolicy?.version,
        ) ?? task.proofPolicy.version,
        ...(stringValue(reportContract?.derivation?.planId ?? contract?.derivation?.planId)
          ? { planId: stringValue(reportContract?.derivation?.planId ?? contract?.derivation?.planId) }
          : {}),
        ...(numberValue(reportContract?.derivation?.criteriaRevision ?? contract?.derivation?.criteriaRevision)
          ? {
              criteriaRevision: numberValue(
                reportContract?.derivation?.criteriaRevision ?? contract?.derivation?.criteriaRevision,
              ),
            }
          : {}),
        ...(stringValue(reportArtifact?.id ?? artifact?.id)
          ? { artifactId: stringValue(reportArtifact?.id ?? artifact?.id) }
          : {}),
        ...(numberValue(reportArtifact?.version ?? artifact?.version)
          ? { artifactVersion: numberValue(reportArtifact?.version ?? artifact?.version) }
          : {}),
      },
    },
    trace: sanitizedTrace(parsed),
  };
}
