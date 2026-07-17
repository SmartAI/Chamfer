import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AttachmentReferenceBlock, ReferenceRecordDto } from "@chamfer/shared";

function isUserImageReference(block: unknown): block is AttachmentReferenceBlock {
  if (typeof block !== "object" || block === null) return false;
  const candidate = block as Partial<AttachmentReferenceBlock>;
  return candidate.type === "attachment-reference" &&
    candidate.kind === "user-image" &&
    typeof candidate.attachmentId === "string";
}

export function referenceRecordText(record: ReferenceRecordDto): string {
  const specificationIds = record.specificationIds ?? record.specificationLinks ?? [];
  return `[Reference ${record.referenceId}: status=${record.status}; purpose=${JSON.stringify(record.purpose ?? "")}; relationships=${JSON.stringify(record.relationships)}; specificationIds=${JSON.stringify(specificationIds)}${record.legacySpecificationLinks?.length ? `; migratedLegacyLinks=${JSON.stringify(record.legacySpecificationLinks)}` : ""}${record.noSpecificationReason ? `; noSpecificationReason=${JSON.stringify(record.noSpecificationReason)}` : ""}; attachmentAvailable=${record.attachmentAvailable}]`;
}

export function projectClassifiedReferences(
  messages: AgentMessage[],
  records: readonly ReferenceRecordDto[],
  imageReferenceId?: (image: object) => string | undefined,
): AgentMessage[] {
  const classified = new Map(records
    .filter((record) => record.status !== "unclassified")
    .map((record) => [record.referenceId, record]));
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const pendingIds: string[] = [];
    const content = message.content.map((block) => {
      const candidate = block as unknown;
      if (isUserImageReference(candidate)) {
        const record = classified.get(candidate.attachmentId);
        if (!record) {
          pendingIds.push(candidate.attachmentId);
          return block;
        }
        changed = true;
        messageChanged = true;
        return { type: "text" as const, text: referenceRecordText(record) };
      }
      if (typeof candidate === "object" && candidate !== null && (candidate as { type?: unknown }).type === "image") {
        const id = imageReferenceId?.(candidate);
        if (id) pendingIds.push(id);
      }
      return block;
    });
    if (pendingIds.length > 0) {
      changed = true;
      messageChanged = true;
      content.push({
        type: "text",
        text: `[Pending reference images: ${pendingIds.join(", ")}. Record extracted evidence with record_reference_specifications, then call classify_reference with active specificationIds or an explicit noSpecificationReason before CAD execution.]`,
      });
    }
    return messageChanged ? { ...message, content } as AgentMessage : message;
  });
  return changed ? result : messages;
}

export function pendingReferenceIds(
  messages: readonly AgentMessage[],
  records: readonly ReferenceRecordDto[],
): string[] {
  const classified = new Set(records
    .filter((record) => record.status !== "unclassified")
    .map((record) => record.referenceId));
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const candidate = block as unknown;
      if (isUserImageReference(candidate) && !classified.has(candidate.attachmentId)) {
        pending.add(candidate.attachmentId);
      }
    }
  }
  return [...pending];
}
