import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AttachmentReferenceBlock, InspectionLeaseDto } from "@chamfer/shared";

export const INSPECTION_LEASE_STUB_TEXT =
  "[Inspected evidence pixels evicted. Durable structured observations and stable evidence identities remain available.]";

function referenceId(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const candidate = block as { type?: unknown; attachmentId?: unknown };
  return candidate.type === "attachment-reference" && typeof candidate.attachmentId === "string"
    ? candidate.attachmentId
    : undefined;
}

function stripLeasedPixels(message: AgentMessage, selected: ReadonlySet<string>): AgentMessage {
  const rawContent = (message as { content?: unknown }).content;
  if (!Array.isArray(rawContent)) return message;
  const contentBlocks = rawContent as Array<{ type?: string; [key: string]: unknown }>;
  const inspectionResult = message.role === "toolResult" && message.toolName === "inspect_evidence";
  let changed = false;
  const content = contentBlocks.map((block) => {
    const id = referenceId(block);
    if ((inspectionResult && (block.type === "image" || id)) || (id && selected.has(id))) {
      changed = true;
      return { type: "text" as const, text: INSPECTION_LEASE_STUB_TEXT };
    }
    return block;
  });
  return changed ? { ...message, content } as unknown as AgentMessage : message;
}

/** Reconstruct exactly the evidence selected by durable open leases. */
export function projectInspectionLeases(
  messages: AgentMessage[],
  leases: readonly InspectionLeaseDto[],
): AgentMessage[] {
  const open = leases.filter((lease) => lease.status === "open");
  const selected = new Set(open.flatMap((lease) => lease.evidence.map((evidence) => evidence.attachmentId)));
  const projected = messages.map((message) => stripLeasedPixels(message, selected));
  const recoveryMessages = open.map((lease) => ({
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: `[Open inspection lease ${lease.id}; purpose=${JSON.stringify(lease.purpose)}; selectedEvidence=${JSON.stringify(lease.evidence.map((item) => item.attachmentId))}. Record structured observations with record_inspection_observation before moving on.]`,
      },
      ...lease.evidence.map((evidence): AttachmentReferenceBlock => ({
        type: "attachment-reference",
        attachmentId: evidence.attachmentId,
        kind: evidence.kind,
        mimeType: evidence.mime,
      })),
    ],
    timestamp: lease.openedAt,
  })) as AgentMessage[];
  return [...projected, ...recoveryMessages];
}
