import type {
  AgentRunLifecycleEvent,
  ArtifactDto,
  AttachmentDto,
  CadEnvironment,
  ConversationDto,
  HeadlessRunEvent,
  MessageDto,
} from "./index";

export type ConversationArtifactRecord = Omit<ArtifactDto, "gate" | "measurements">;

export const CONVERSATION_EVENT_SCHEMA_VERSION = 1 as const;

export interface ConversationAttachmentRecord extends AttachmentDto {
  /** Content-addressed blob reference. Bytes remain in the attachment store. */
  blobPath: string;
}

interface ConversationEventBase<TType extends string, TData> {
  schemaVersion: typeof CONVERSATION_EVENT_SCHEMA_VERSION;
  id: string;
  conversationId: string;
  sequence: number;
  recordedAt: number;
  type: TType;
  data: TData;
}

/**
 * The conversation log owns interaction flow and presentation state.
 *
 * Verification facts belong only to the separate evidence ledger.
 * A conversation event can link an evidence identity, but it must never copy
 * the corresponding evidence payload. Attachment bytes follow the same rule:
 * events contain content-addressed references, while blob stores own bytes.
 */
export type ConversationEvent =
  | ConversationEventBase<"conversation.created", {
      title: string;
      cadEnvironment: CadEnvironment;
      designId: string | null;
      sourceSpecificationsRequired: boolean;
    }>
  | ConversationEventBase<"conversation.title-updated", { title: string }>
  | ConversationEventBase<"conversation.design-detached", { designId: string }>
  | ConversationEventBase<"message.appended", {
      message: MessageDto;
      attachments: ConversationAttachmentRecord[];
    }>
  | ConversationEventBase<"attachment.appended", { attachment: ConversationAttachmentRecord }>
  | ConversationEventBase<"artifact.stored", {
      artifact: ConversationArtifactRecord;
      evidenceIds: string[];
    }>
  | ConversationEventBase<"evidence.linked", {
      evidenceId: string;
      relationship: "plan" | "artifact" | "verification" | "other";
    }>
  | ConversationEventBase<"ui.state-updated", { key: string; value: unknown }>
  | ConversationEventBase<"agent-run.lifecycle-recorded", { event: AgentRunLifecycleEvent; release: string }>
  | ConversationEventBase<"headless-run.recorded", { runId: string; event: HeadlessRunEvent }>;

export type ConversationEventDraft = ConversationEvent extends infer TEvent
  ? TEvent extends ConversationEvent
    ? Pick<TEvent, "type" | "data"> & { id?: string; recordedAt?: number }
    : never
  : never;

export interface ConversationEvidenceLink {
  evidenceId: string;
  relationship: Extract<ConversationEvent, { type: "evidence.linked" }>["data"]["relationship"];
}

export interface ConversationProjection {
  conversationId: string;
  lastSequence: number;
  conversation?: ConversationDto;
  messages: MessageDto[];
  attachments: ConversationAttachmentRecord[];
  artifacts: ConversationArtifactRecord[];
  evidenceLinks: ConversationEvidenceLink[];
  uiState: Record<string, unknown>;
  agentRunEvents: AgentRunLifecycleEvent[];
  headlessRunEvents: Array<{ runId: string; event: HeadlessRunEvent }>;
}

export function emptyConversationProjection(conversationId: string): ConversationProjection {
  return {
    conversationId,
    lastSequence: 0,
    messages: [],
    attachments: [],
    artifacts: [],
    evidenceLinks: [],
    uiState: {},
    agentRunEvents: [],
    headlessRunEvents: [],
  };
}

function replaceById<T extends { id: string }>(values: T[], value: T): void {
  const existing = values.findIndex((candidate) => candidate.id === value.id);
  if (existing < 0) values.push(value);
  else values[existing] = value;
}

/** Advances an owned projection in place so hot server paths allocate only for new events. */
export function advanceConversationProjection(
  events: readonly ConversationEvent[],
  initial?: ConversationProjection,
): ConversationProjection {
  if (events.length === 0 && !initial) throw new Error("conversation projection requires an identity");
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const conversationId = initial?.conversationId ?? ordered[0]!.conversationId;
  const projection = initial ?? emptyConversationProjection(conversationId);

  for (const event of ordered) {
    if (event.conversationId !== conversationId) throw new Error("conversation event identity mismatch");
    if (event.schemaVersion !== CONVERSATION_EVENT_SCHEMA_VERSION) {
      throw new Error(`unsupported conversation event schema version ${String(event.schemaVersion)}`);
    }
    if (event.sequence <= projection.lastSequence) continue;
    if (event.sequence !== projection.lastSequence + 1) throw new Error("conversation event sequence is not contiguous");
    projection.lastSequence = event.sequence;
    switch (event.type) {
      case "conversation.created":
        projection.conversation = {
          id: conversationId,
          title: event.data.title,
          designId: event.data.designId,
          cadEnvironment: event.data.cadEnvironment,
          createdAt: event.recordedAt,
          updatedAt: event.recordedAt,
          sourceSpecificationsRequired: event.data.sourceSpecificationsRequired,
        };
        break;
      case "conversation.title-updated":
        if (projection.conversation) {
          projection.conversation = { ...projection.conversation, title: event.data.title, updatedAt: event.recordedAt };
        }
        break;
      case "conversation.design-detached":
        if (projection.conversation?.designId === event.data.designId) {
          projection.conversation = { ...projection.conversation, designId: null, updatedAt: event.recordedAt };
        }
        break;
      case "message.appended":
        replaceById(projection.messages, event.data.message);
        for (const attachment of event.data.attachments) replaceById(projection.attachments, attachment);
        if (projection.conversation) {
          projection.conversation = { ...projection.conversation, updatedAt: event.recordedAt };
        }
        break;
      case "attachment.appended":
        replaceById(projection.attachments, event.data.attachment);
        break;
      case "artifact.stored":
        replaceById(projection.artifacts, event.data.artifact);
        break;
      case "evidence.linked":
        if (!projection.evidenceLinks.some((link) =>
          link.evidenceId === event.data.evidenceId && link.relationship === event.data.relationship)) {
          projection.evidenceLinks.push(event.data);
        }
        break;
      case "ui.state-updated":
        projection.uiState[event.data.key] = event.data.value;
        break;
      case "agent-run.lifecycle-recorded":
        projection.agentRunEvents.push(event.data.event);
        break;
      case "headless-run.recorded":
        projection.headlessRunEvents.push(event.data);
        break;
    }
  }
  return projection;
}

/** Pure, order-stable projection used identically by local SQLite and Durable Object SQLite. */
export function projectConversationEvents(
  events: readonly ConversationEvent[],
  initial?: ConversationProjection,
): ConversationProjection {
  const owned = initial
    ? {
        ...initial,
        messages: [...initial.messages],
        attachments: [...initial.attachments],
        artifacts: [...initial.artifacts],
        evidenceLinks: [...initial.evidenceLinks],
        uiState: { ...initial.uiState },
        agentRunEvents: [...initial.agentRunEvents],
        headlessRunEvents: [...initial.headlessRunEvents],
      }
    : undefined;
  return advanceConversationProjection(events, owned);
}

/** Versioned upcast boundary. Future schemas add cases here and keep old logs replayable. */
export function upcastConversationEvent(value: unknown): ConversationEvent {
  if (!value || typeof value !== "object") throw new Error("conversation event must be an object");
  const event = value as Partial<ConversationEvent>;
  if (event.schemaVersion !== CONVERSATION_EVENT_SCHEMA_VERSION) {
    throw new Error(`unsupported conversation event schema version ${String(event.schemaVersion)}`);
  }
  return event as ConversationEvent;
}
