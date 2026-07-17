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
  OpenDesignEscalationInput,
  CreateReferenceRegistrationInput,
  ReferenceRegistrationDto,
  CreateProofReportInput,
  ProofReportDto,
  AgentRunLifecycleBatch,
  AgentRunLifecycleDto,
  AgentRunFeedbackDto,
  AgentRunFeedbackRating,
} from "@chamfer/shared";
import type { ImageContent } from "@earendil-works/pi-ai";

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
  throw new Error(message);
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

export function createConversation(title: string, cadEnvironment: CadEnvironment): Promise<ConversationDto> {
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

export function listSourceSpecifications(conversationId: string): Promise<SourceSpecificationDto[]> {
  return requestJson<SourceSpecificationDto[]>(`/api/conversations/${conversationId}/source-specifications`);
}

export function recordSourceSpecifications(
  conversationId: string,
  input: RecordSourceSpecificationsInput,
  idempotencyKey?: string,
): Promise<SourceSpecificationDto[]> {
  return requestJson<SourceSpecificationDto[]>(
    `/api/conversations/${conversationId}/source-specifications`,
    idempotentJsonInit("POST", input, idempotencyKey),
  );
}

export function listProofContracts(conversationId: string): Promise<ProofContractDto[]> {
  return requestJson<ProofContractDto[]>(`/api/conversations/${conversationId}/proof-contracts`);
}

export function freezeProofContract(
  conversationId: string,
  input: CreateProofContractInput,
): Promise<ProofContractDto> {
  return requestJson<ProofContractDto>(
    `/api/conversations/${conversationId}/proof-contracts`,
    jsonInit("POST", input),
  );
}

export function listProofReports(conversationId: string): Promise<ProofReportDto[]> {
  return requestJson<ProofReportDto[]>(`/api/conversations/${conversationId}/proof-reports`);
}

export function createProofReport(
  conversationId: string,
  input: CreateProofReportInput,
  idempotencyKey: string,
): Promise<ProofReportDto> {
  return requestJson<ProofReportDto>(
    `/api/conversations/${conversationId}/proof-reports`,
    idempotentJsonInit("POST", input, idempotencyKey),
  );
}

export function listDesignEscalations(conversationId: string): Promise<DesignEscalationDto[]> {
  return requestJson<DesignEscalationDto[]>(`/api/conversations/${conversationId}/design-escalations`);
}

export function openDesignEscalation(
  conversationId: string,
  input: OpenDesignEscalationInput,
  idempotencyKey: string,
): Promise<DesignEscalationDto> {
  return requestJson<DesignEscalationDto>(
    `/api/conversations/${conversationId}/design-escalations`,
    idempotentJsonInit("POST", input, idempotencyKey),
  );
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
  artifact: { pySource: string; paramsJson?: string | null },
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
  return requestJson<ReferenceRecordDto[]>(`/api/conversations/${conversationId}/references`);
}

export function classifyReference(
  conversationId: string,
  input: ClassifyReferenceInput,
  idempotencyKey?: string,
): Promise<ReferenceClassificationDto> {
  return requestJson<ReferenceClassificationDto>(
    `/api/conversations/${conversationId}/reference-classifications`,
    idempotentJsonInit("POST", input, idempotencyKey),
  );
}

export function listReferenceRegistrations(conversationId: string): Promise<ReferenceRegistrationDto[]> {
  return requestJson<ReferenceRegistrationDto[]>(`/api/conversations/${conversationId}/reference-registrations`);
}

export function registerReference(
  conversationId: string,
  input: CreateReferenceRegistrationInput,
  idempotencyKey?: string,
): Promise<ReferenceRegistrationDto> {
  return requestJson<ReferenceRegistrationDto>(
    `/api/conversations/${conversationId}/reference-registrations`,
    idempotentJsonInit("POST", input, idempotencyKey),
  );
}

export function listOpenInspectionLeases(conversationId: string): Promise<InspectionLeaseDto[]> {
  return requestJson<InspectionLeaseDto[]>(`/api/conversations/${conversationId}/inspection-leases?status=open`);
}

export function openInspectionLease(
  conversationId: string,
  input: InspectEvidenceInput,
  idempotencyKey?: string,
): Promise<InspectionLeaseDto> {
  return requestJson<InspectionLeaseDto>(
    `/api/conversations/${conversationId}/inspection-leases`,
    idempotentJsonInit("POST", input, idempotencyKey),
  );
}

export function recordInspectionObservation(
  conversationId: string,
  leaseId: string,
  input: InspectionObservationInput,
  idempotencyKey?: string,
): Promise<InspectionLeaseDto> {
  return requestJson<InspectionLeaseDto>(
    `/api/conversations/${conversationId}/inspection-leases/${leaseId}/observations`,
    idempotentJsonInit("POST", input, idempotencyKey),
  );
}

export function listVisualVerifications(conversationId: string): Promise<VisualVerificationRecordDto[]> {
  return requestJson<VisualVerificationRecordDto[]>(`/api/conversations/${conversationId}/visual-verifications`);
}

export function recordVisualVerification(
  conversationId: string,
  input: RecordVisualVerificationInput,
  idempotencyKey?: string,
): Promise<VisualVerificationRecordDto> {
  return requestJson<VisualVerificationRecordDto>(
    `/api/conversations/${conversationId}/visual-verifications`,
    idempotentJsonInit("POST", input, idempotencyKey),
  );
}

export function listVisualVerificationBatches(conversationId: string): Promise<VisualVerificationBatchRecordDto[]> {
  return requestJson<VisualVerificationBatchRecordDto[]>(`/api/conversations/${conversationId}/visual-verification-batches`);
}

export function recordVisualVerificationBatch(
  conversationId: string,
  input: RecordVisualVerificationBatchInput,
  idempotencyKey?: string,
): Promise<VisualVerificationBatchRecordDto> {
  return requestJson<VisualVerificationBatchRecordDto>(
    `/api/conversations/${conversationId}/visual-verification-batches`,
    idempotentJsonInit("POST", input, idempotencyKey),
  );
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
