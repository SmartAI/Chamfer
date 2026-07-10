import type {
  ArtifactDto,
  AttachmentDto,
  ConversationDto,
  GenerateTitleDto,
  MessageDto,
  ModelInfoDto,
  SettingsDto,
} from "@chamfer/shared";

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

// ---------- Settings ----------

export function getSettings(): Promise<SettingsDto> {
  return requestJson<SettingsDto>("/api/settings");
}

export function putSettings(patch: SettingsDto): Promise<void> {
  return requestVoid("/api/settings", jsonInit("PUT", patch));
}

// ---------- Models ----------

export function getModels(): Promise<ModelInfoDto[]> {
  return requestJson<ModelInfoDto[]>("/api/models");
}

// ---------- Conversations ----------

export function listConversations(): Promise<ConversationDto[]> {
  return requestJson<ConversationDto[]>("/api/conversations");
}

export function createConversation(title: string): Promise<ConversationDto> {
  return requestJson<ConversationDto>("/api/conversations", jsonInit("POST", { title }));
}

export function generateTitle(conversationId: string): Promise<GenerateTitleDto> {
  return requestJson<GenerateTitleDto>(`/api/conversations/${conversationId}/generate-title`, {
    method: "POST",
  });
}

export function deleteConversation(id: string): Promise<void> {
  return requestVoid(`/api/conversations/${id}`, { method: "DELETE" });
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
): Promise<AttachmentDto> {
  const params = new URLSearchParams({ kind, mime });
  return requestJson<AttachmentDto>(`/api/messages/${messageId}/attachments?${params.toString()}`, {
    method: "POST",
    headers: { "content-type": mime },
    body: bytes,
  });
}

export function listAttachments(messageId: string): Promise<AttachmentDto[]> {
  return requestJson<AttachmentDto[]>(`/api/messages/${messageId}/attachments`);
}

export function attachmentUrl(id: string): string {
  return `/api/attachments/${id}`;
}
