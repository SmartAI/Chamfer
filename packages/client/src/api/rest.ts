import { captureError } from "../telemetry";
import { isLlmProvider } from "@chamfer/shared";
import type {
  ArtifactDto,
  AttachmentDto,
  CadEnvironment,
  ConversationDto,
  GenerateTitleDto,
  MessageDto,
  ModelInfoDto,
  SettingsPatchDto,
  SettingsResponseDto,
  FusionReadinessDto,
  FusionDocumentBindingDto,
  FusionDocumentationQueryDto,
  FusionDocumentationResultDto,
  FusionCheckInput,
  FusionInspectionDto,
  FusionReconciliationPollDto,
  FusionActionRequestDto,
  FusionActionResultDto,
  FusionActionLedgerRecordDto,
  FusionSaveResultDto,
  ClassifyReferenceInput,
  ReferenceClassificationDto,
  ReferenceRecordDto,
  InspectEvidenceInput,
  InspectionLeaseDto,
  InspectionObservationInput,
  RecordVisualVerificationInput,
  RecordSourceSpecificationsInput,
  SourceSpecificationDto,
  RecordVisualVerificationBatchInput,
  VisualVerificationBatchRecordDto,
  VisualVerificationRecordDto,
  CreateProofContractInput,
  ProofContractDto,
  DesignEscalationDto,
  DurableNoteDto,
  Gate,
  Measurements,
  MeasuredVisualComparisonEvidence,
  OpenDesignEscalationInput,
  CreateReferenceRegistrationInput,
  ReferenceRegistrationDto,
  CreateProofReportInput,
  ProofReportDto,
  AgentRunLifecycleBatch,
  AgentRunLifecycleDto,
  AgentRunFeedbackDto,
  AgentRunFeedbackRating,
  HeadlessRunDto,
  HeadlessRuntimeCapabilitiesDto,
  OnlineBudgetDto,
  StartHeadlessRunInput,
  SteerHeadlessRunInput,
  EvidenceCommand,
  EvidenceEvent,
  EvidenceEventDraft,
  EvidenceProjection,
  ConversationEvent,
  ConversationProjection,
} from "@chamfer/shared";
import type { ImageContent } from "@earendil-works/pi-ai";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.clone().json()) as { error?: string };
    if (body && typeof body.error === "string" && body.error.length > 0) {
      message = body.error;
    }
  } catch {
    // response wasn't JSON; fall back to status text
  }
  const error = new HttpError(message, res.status);
  // Only server errors are unambiguously "something is broken". A 404 is often a
  // legitimately deleted resource; route-surface 404s are caught by the online
  // health probe and the CI route-parity test instead, not by noisy client reports.
  if (res.status >= 500) captureError(error, { url: res.url, status: res.status });
  throw error;
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  await throwOnError(res);
  return (await res.json()) as T;
}

async function requestVoid(input: string, init?: RequestInit): Promise<void> {
  const res = await fetch(input, init);
  await throwOnError(res);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function idempotentJsonInit(method: string, body: unknown, idempotencyKey?: string): RequestInit {
  const init = jsonInit(method, body);
  if (idempotencyKey) (init.headers as Record<string, string>)["Idempotency-Key"] = idempotencyKey;
  return init;
}

function evidenceCommand<T>(conversationId: string, command: EvidenceCommand): Promise<T> {
  return requestJson<{ result: T; projection: EvidenceProjection }>(
    `/api/conversations/${conversationId}/evidence`,
    jsonInit("POST", command),
  ).then(({ result, projection }) => {
    publishEvidenceProjection(conversationId, projection);
    return result;
  });
}

const evidenceProjectionListeners = new Map<string, Set<(projection: EvidenceProjection) => void>>();

function publishEvidenceProjection(conversationId: string, projection: EvidenceProjection): void {
  for (const listener of evidenceProjectionListeners.get(conversationId) ?? []) listener(projection);
}

export function subscribeEvidenceProjection(
  conversationId: string,
  listener: (projection: EvidenceProjection) => void,
): () => void {
  const listeners = evidenceProjectionListeners.get(conversationId) ?? new Set();
  listeners.add(listener);
  evidenceProjectionListeners.set(conversationId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) evidenceProjectionListeners.delete(conversationId);
  };
}

// ---------- Settings ----------

export function getSettings(): Promise<SettingsResponseDto> {
  return requestJson<SettingsResponseDto>("/api/settings");
}

export function putSettings(patch: SettingsPatchDto): Promise<void> {
  return requestVoid("/api/settings", jsonInit("PUT", patch));
}

export function getFusionReadiness(conversationId?: string): Promise<FusionReadinessDto> {
  const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  return requestJson<FusionReadinessDto>(`/api/fusion/readiness${query}`);
}

export function bindFusionDocument(conversationId: string): Promise<FusionDocumentBindingDto> {
  return requestJson<FusionDocumentBindingDto>(`/api/conversations/${conversationId}/fusion-binding`, {
    method: "POST",
  });
}

export function transferFusionOwnership(conversationId: string): Promise<FusionDocumentBindingDto> {
  return requestJson<FusionDocumentBindingDto>(`/api/conversations/${conversationId}/fusion-ownership`, {
    method: "POST",
  });
}

export function saveFusionDocument(
  conversationId: string,
  document: FusionDocumentBindingDto["document"],
): Promise<FusionSaveResultDto> {
  return requestJson<FusionSaveResultDto>(`/api/conversations/${conversationId}/fusion-save`,
    jsonInit("POST", { document }));
}

export function searchFusionDocumentation(input: FusionDocumentationQueryDto): Promise<FusionDocumentationResultDto> {
  return requestJson<FusionDocumentationResultDto>("/api/fusion/documentation", jsonInit("POST", input));
}

export function inspectFusionDocument(
  conversationId: string,
  checks: FusionCheckInput[] = [],
): Promise<FusionInspectionDto> {
  return requestJson<FusionInspectionDto>(`/api/conversations/${conversationId}/fusion-inspections`,
    jsonInit("POST", { checks }));
}

export function reconcileFusionDocument(conversationId: string): Promise<FusionReconciliationPollDto> {
  return requestJson<FusionReconciliationPollDto>(`/api/conversations/${conversationId}/fusion-reconciliation`, { method: "POST" });
}

export async function executeFusionAction(conversationId: string, input: FusionActionRequestDto, signal?: AbortSignal): Promise<FusionActionResultDto> {
  const timeout = AbortSignal.timeout(120_000);
  const actionSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const notifyInterruption = () => {
    const reason = actionSignal.reason instanceof DOMException && actionSignal.reason.name === "TimeoutError" ? "timeout" : "canceled";
    void fetch(`/api/conversations/${conversationId}/fusion-actions/${encodeURIComponent(input.actionId)}/interrupt`, {
      ...jsonInit("POST", { reason }), keepalive: true,
    }).catch(() => undefined);
  };
  actionSignal.addEventListener("abort", notifyInterruption, { once: true });
  if (actionSignal.aborted) notifyInterruption();
  try {
    return await requestJson<FusionActionResultDto>(`/api/conversations/${conversationId}/fusion-actions`, {
      ...jsonInit("POST", input), signal: actionSignal,
    });
  } finally {
    actionSignal.removeEventListener("abort", notifyInterruption);
  }
}

export function listFusionActions(conversationId: string): Promise<FusionActionLedgerRecordDto[]> {
  return requestJson<FusionActionLedgerRecordDto[]>(`/api/conversations/${conversationId}/fusion-actions`);
}

// ---------- Models ----------

export function getModels(): Promise<ModelInfoDto[]> {
  return requestJson<ModelInfoDto[]>("/api/models");
}

// ---------- Conversations ----------

export function listConversations(): Promise<ConversationDto[]> {
  return requestJson<ConversationDto[]>("/api/conversations");
}

export function createConversation(
  title: string,
  cadEnvironment: CadEnvironment,
): Promise<ConversationDto> {
  return requestJson<ConversationDto>("/api/conversations", jsonInit("POST", { title, cadEnvironment }));
}

export function getConversation(id: string): Promise<ConversationDto> {
  return requestJson<ConversationDto>(`/api/conversations/${id}`);
}

export function generateTitle(conversationId: string): Promise<GenerateTitleDto> {
  return requestJson<GenerateTitleDto>(`/api/conversations/${conversationId}/generate-title`, {
    method: "POST",
  });
}

export function deleteConversation(id: string): Promise<void> {
  return requestVoid(`/api/conversations/${id}`, { method: "DELETE" });
}

// ---------- Headless runtime ----------

export async function getRuntimeCapabilities(): Promise<HeadlessRuntimeCapabilitiesDto> {
  // Deployments that never mounted the probe (older local servers) all host
  // the agent in-process, so absence or a malformed body means fully capable;
  // only an explicit agentHosting:false turns the composer off. demoQuota
  // defaults false: without an explicit demo capability, only a per-provider
  // key funds a turn.
  const fallback: HeadlessRuntimeCapabilitiesDto = { headlessRuns: false, agentHosting: true, demoQuota: false };
  const response = await fetch("/api/runtime/capabilities");
  if (response.status === 404) return fallback;
  await throwOnError(response);
  try {
    const body = await response.json() as Partial<HeadlessRuntimeCapabilitiesDto>;
    const demoModel =
      typeof body.demoModel === "object" && body.demoModel !== null &&
      typeof body.demoModel.id === "string" && typeof body.demoModel.name === "string" &&
      isLlmProvider(body.demoModel.provider)
        ? { id: body.demoModel.id, name: body.demoModel.name, provider: body.demoModel.provider }
        : undefined;
    return {
      headlessRuns: body.headlessRuns === true,
      agentHosting: body.agentHosting !== false,
      demoQuota: body.demoQuota === true && demoModel !== undefined,
      ...(body.demoQuota === true && demoModel ? { demoModel } : {}),
    };
  } catch {
    return fallback;
  }
}

/**
 * This account's free-demo dollar balance, or null when the deployment has no
 * demo quota (the local server never mounts the route -> 404). Best-effort: any
 * failure returns null so the meter simply hides rather than surfacing an error.
 */
export async function getOnlineBudget(): Promise<OnlineBudgetDto | null> {
  try {
    const response = await fetch("/api/online/budget");
    if (!response.ok) return null;
    const body = await response.json() as Partial<OnlineBudgetDto>;
    if (
      typeof body.spentUsd !== "number" || typeof body.capUsd !== "number" ||
      typeof body.spentMicroUsd !== "number" || typeof body.capMicroUsd !== "number"
    ) {
      return null;
    }
    return {
      spentUsd: body.spentUsd,
      capUsd: body.capUsd,
      spentMicroUsd: body.spentMicroUsd,
      capMicroUsd: body.capMicroUsd,
    };
  } catch {
    return null;
  }
}

export function getHeadlessRun(conversationId: string): Promise<HeadlessRunDto> {
  return requestJson<HeadlessRunDto>(`/api/conversations/${conversationId}/headless-run`);
}

export function startHeadlessRun(conversationId: string, input: StartHeadlessRunInput): Promise<HeadlessRunDto> {
  return requestJson<HeadlessRunDto>(
    `/api/conversations/${conversationId}/headless-runs`, jsonInit("POST", input),
  );
}

export function steerHeadlessRun(runId: string, input: SteerHeadlessRunInput): Promise<void> {
  return requestVoid(`/api/headless-runs/${runId}/steer`, jsonInit("POST", input));
}

export function stopHeadlessRun(runId: string): Promise<void> {
  return requestVoid(`/api/headless-runs/${runId}/stop`, { method: "POST" });
}

export function headlessRunEventsUrl(runId: string, after = 0): string {
  return `/api/headless-runs/${encodeURIComponent(runId)}/events?after=${after}`;
}

export function getEvidenceProjection(conversationId: string): Promise<EvidenceProjection> {
  return requestJson<EvidenceProjection>(`/api/conversations/${conversationId}/evidence`)
    .then((projection) => {
      publishEvidenceProjection(conversationId, projection);
      return projection;
    });
}

export function recordPlanEvidence(
  conversationId: string,
  event: Extract<EvidenceEventDraft, { type: "plan.recorded" }>,
): Promise<EvidenceEvent> {
  return evidenceCommand(conversationId, {
    type: "record-plan",
    event: {
      id: event.id,
      type: event.type,
      data: event.data,
      recordedAt: event.recordedAt,
    },
  });
}

export function recordEnvironmentVerificationEvidence(
  conversationId: string,
  event: Extract<EvidenceEventDraft, { type: "environment-verification.recorded" }>,
): Promise<EvidenceEvent> {
  return evidenceCommand(conversationId, { type: "record-environment-verification", event });
}

export function recordVerificationCheckRevisionAttempt(
  conversationId: string,
  event: Extract<EvidenceEventDraft, { type: "verification-checks.revision-attempted" }>,
): Promise<EvidenceEvent> {
  return evidenceCommand(conversationId, {
    type: "record-verification-check-revision-attempt",
    event,
  });
}

export function recordVisualComparisonEvidence(
  conversationId: string,
  input: MeasuredVisualComparisonEvidence,
): Promise<EvidenceEvent> {
  return evidenceCommand(conversationId, {
    type: "record-visual-comparison",
    input,
    idempotencyKey: input.evidenceId,
  });
}

export function listSourceSpecifications(conversationId: string): Promise<SourceSpecificationDto[]> {
  return getEvidenceProjection(conversationId).then((projection) => projection.sourceSpecifications);
}

export function recordSourceSpecifications(
  conversationId: string,
  input: RecordSourceSpecificationsInput,
  idempotencyKey?: string,
): Promise<SourceSpecificationDto[]> {
  return evidenceCommand(conversationId, {
    type: "record-source-specifications",
    input,
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
  });
}

export function listProofContracts(conversationId: string): Promise<ProofContractDto[]> {
  return getEvidenceProjection(conversationId).then((projection) => projection.proofContracts);
}

export function freezeProofContract(
  conversationId: string,
  input: CreateProofContractInput,
): Promise<ProofContractDto> {
  return evidenceCommand(conversationId, {
    type: "freeze-proof-contract",
    input,
    idempotencyKey: crypto.randomUUID(),
  });
}

export function listProofReports(conversationId: string): Promise<ProofReportDto[]> {
  return getEvidenceProjection(conversationId).then((projection) => projection.proofReports);
}

export function createProofReport(
  conversationId: string,
  input: CreateProofReportInput,
  idempotencyKey: string,
): Promise<ProofReportDto> {
  return evidenceCommand(conversationId, { type: "create-proof-report", input, idempotencyKey });
}

export function listDesignEscalations(conversationId: string): Promise<DesignEscalationDto[]> {
  return getEvidenceProjection(conversationId).then((projection) => projection.designEscalations);
}

export function listDurableNotes(conversationId: string): Promise<DurableNoteDto[]> {
  return requestJson<DurableNoteDto[]>(`/api/conversations/${conversationId}/durable-notes`);
}

export function openDesignEscalation(
  conversationId: string,
  input: OpenDesignEscalationInput,
  idempotencyKey: string,
): Promise<DesignEscalationDto> {
  return evidenceCommand(conversationId, { type: "open-design-escalation", input, idempotencyKey });
}

export function postAgentRunEvents(
  conversationId: string,
  runId: string,
  batch: AgentRunLifecycleBatch,
  signal?: AbortSignal,
): Promise<AgentRunLifecycleDto> {
  const init = jsonInit("POST", batch);
  if (signal) init.signal = signal;
  return requestJson<AgentRunLifecycleDto>(
    `/api/conversations/${conversationId}/agent-runs/${runId}/events`,
    init,
  );
}

export function getAgentRun(conversationId: string, runId: string): Promise<AgentRunLifecycleDto> {
  return requestJson<AgentRunLifecycleDto>(`/api/conversations/${conversationId}/agent-runs/${runId}`);
}

export function getLatestAgentRun(conversationId: string): Promise<AgentRunLifecycleDto> {
  return requestJson<AgentRunLifecycleDto>(`/api/conversations/${conversationId}/agent-runs/latest`);
}

export function postAgentRunFeedback(
  conversationId: string,
  runId: string,
  rating: AgentRunFeedbackRating,
): Promise<AgentRunFeedbackDto> {
  return requestJson<AgentRunFeedbackDto>(
    `/api/conversations/${conversationId}/agent-runs/${runId}/feedback`,
    jsonInit("POST", { rating }),
  );
}

// ---------- Messages ----------

export function listMessages(conversationId: string): Promise<MessageDto[]> {
  return requestJson<MessageDto[]>(`/api/conversations/${conversationId}/messages`);
}

export function getConversationState(conversationId: string): Promise<ConversationProjection> {
  return requestJson<ConversationProjection>(`/api/conversations/${conversationId}/conversation-state`);
}

export function observeConversationEvents(
  conversationId: string,
  after: number,
  onEvent: (event: ConversationEvent) => void,
): EventSource {
  const source = new EventSource(`/api/conversations/${conversationId}/events?after=${after}`);
  for (const type of [
    "conversation.created",
    "conversation.title-updated",
    "conversation.design-detached",
    "message.appended",
    "attachment.appended",
    "artifact.stored",
    "evidence.linked",
    "ui.state-updated",
    "agent-run.lifecycle-recorded",
    "headless-run.recorded",
  ] as const) {
    source.addEventListener(type, (message) => onEvent(JSON.parse(message.data) as ConversationEvent));
  }
  return source;
}

export interface PostMessageInput {
  id: string;
  seq: number;
  role: string;
  contentJson: string;
}

export function postMessage(conversationId: string, message: PostMessageInput): Promise<MessageDto> {
  return requestJson<MessageDto>(`/api/conversations/${conversationId}/messages`, jsonInit("POST", message));
}

export function postMessageWithAttachments(
  conversationId: string,
  message: PostMessageInput,
  attachments: Array<{ id: string; kind: AttachmentDto["kind"]; mime: string; data: string }>,
): Promise<MessageDto> {
  return requestJson<MessageDto>(
    `/api/conversations/${conversationId}/messages-with-attachments`,
    jsonInit("POST", { message, attachments }),
  );
}

// ---------- Artifacts ----------

export function listArtifacts(conversationId: string): Promise<ArtifactDto[]> {
  return requestJson<ArtifactDto[]>(`/api/conversations/${conversationId}/artifacts`);
}

export function postArtifact(
  conversationId: string,
  artifact: {
    pySource: string;
    paramsJson?: string | null;
    gate?: Gate;
    measurements?: Measurements;
  },
): Promise<ArtifactDto> {
  return requestJson<ArtifactDto>(
    `/api/conversations/${conversationId}/artifacts`,
    jsonInit("POST", artifact),
  );
}

// ---------- Attachments ----------

export function uploadAttachment(
  messageId: string,
  kind: AttachmentDto["kind"],
  mime: string,
  bytes: BodyInit,
  id?: string,
): Promise<AttachmentDto> {
  const params = new URLSearchParams({ kind, mime });
  if (id) params.set("id", id);
  return requestJson<AttachmentDto>(`/api/messages/${messageId}/attachments?${params.toString()}`, {
    method: "POST",
    headers: { "content-type": mime },
    body: bytes,
  });
}

export function listAttachments(messageId: string): Promise<AttachmentDto[]> {
  return requestJson<AttachmentDto[]>(`/api/messages/${messageId}/attachments`);
}

export function listReferenceRecords(conversationId: string): Promise<ReferenceRecordDto[]> {
  return getEvidenceProjection(conversationId).then((projection) => projection.referenceRecords);
}

export function classifyReference(
  conversationId: string,
  input: ClassifyReferenceInput,
  idempotencyKey?: string,
): Promise<ReferenceClassificationDto> {
  return evidenceCommand(conversationId, {
    type: "classify-reference",
    input,
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
  });
}

export function listReferenceRegistrations(conversationId: string): Promise<ReferenceRegistrationDto[]> {
  return getEvidenceProjection(conversationId).then((projection) => projection.referenceRegistrations);
}

export function registerReference(
  conversationId: string,
  input: CreateReferenceRegistrationInput,
  idempotencyKey?: string,
): Promise<ReferenceRegistrationDto> {
  return evidenceCommand(conversationId, {
    type: "register-reference",
    input,
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
  });
}

export function listOpenInspectionLeases(conversationId: string): Promise<InspectionLeaseDto[]> {
  return getEvidenceProjection(conversationId).then((projection) =>
    projection.inspectionLeases.filter((lease) => lease.status === "open"));
}

export function openInspectionLease(
  conversationId: string,
  input: InspectEvidenceInput,
  idempotencyKey?: string,
): Promise<InspectionLeaseDto> {
  return evidenceCommand(conversationId, {
    type: "open-inspection-lease",
    input,
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
  });
}

export function recordInspectionObservation(
  conversationId: string,
  leaseId: string,
  input: InspectionObservationInput,
  idempotencyKey?: string,
): Promise<InspectionLeaseDto> {
  return evidenceCommand(conversationId, {
    type: "record-inspection-observation",
    leaseId,
    input,
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
  });
}

export function listVisualVerifications(conversationId: string): Promise<VisualVerificationRecordDto[]> {
  return getEvidenceProjection(conversationId).then((projection) => projection.visualVerifications);
}

export function recordVisualVerification(
  conversationId: string,
  input: RecordVisualVerificationInput,
  idempotencyKey?: string,
): Promise<VisualVerificationRecordDto> {
  return evidenceCommand(conversationId, {
    type: "record-visual-verification",
    input,
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
  });
}

export function listVisualVerificationBatches(conversationId: string): Promise<VisualVerificationBatchRecordDto[]> {
  return getEvidenceProjection(conversationId).then((projection) => projection.visualVerificationBatches);
}

export function recordVisualVerificationBatch(
  conversationId: string,
  input: RecordVisualVerificationBatchInput,
  idempotencyKey?: string,
): Promise<VisualVerificationBatchRecordDto> {
  return requestJson<VisualVerificationBatchRecordDto>(
    `/api/conversations/${conversationId}/visual-verification-batches`,
    idempotentJsonInit("POST", input, idempotencyKey ?? crypto.randomUUID()),
  ).then(async (record) => {
    await getEvidenceProjection(conversationId);
    return record;
  });
}

export function attachmentUrl(id: string): string {
  return `/api/attachments/${id}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Materializes one durable attachment for the pi model-context boundary. */
export async function downloadAttachment(id: string, expectedMimeType: string): Promise<ImageContent> {
  const response = await fetch(attachmentUrl(id));
  await throwOnError(response);
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || expectedMimeType;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { type: "image", data: bytesToBase64(bytes), mimeType };
}
