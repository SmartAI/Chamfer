import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SourceSpecificationDto } from "@chamfer/shared";

export const SOURCE_SPECIFICATIONS_CONTEXT_MARKER = "[Current source specifications]";

function projectionText(specifications: readonly SourceSpecificationDto[]): string {
  const rows = specifications.map((specification) => {
    const source = "messageId" in specification.source
      ? `source message ${specification.source.messageId}, exact text ${JSON.stringify(specification.source.text)}, characters ${specification.source.start}-${specification.source.end}`
      : `source attachment ${specification.source.attachmentId}, observation ${JSON.stringify(specification.source.observation)}${specification.source.region ? `, normalized region ${JSON.stringify(specification.source.region)}` : ""}`;
    const replacement = specification.supersededBySpecificationId
      ? `; supersededBy=${specification.supersededBySpecificationId}`
      : specification.supersedesSpecificationIds?.length
        ? `; supersedes=${specification.supersedesSpecificationIds.join(",")}`
        : specification.supersedesSpecificationId
          ? `; supersedes=${specification.supersedesSpecificationId}`
        : "";
    const conflicts = specification.conflictsWithSpecificationIds?.length
      ? `; conflictsWith=${specification.conflictsWithSpecificationIds.join(",")}`
      : "";
    return `- ${specification.id}: ${specification.requirement} (${source}; actor=${specification.actor}; status=${specification.status}${replacement}${conflicts}; timestamp=${specification.timestamp})`;
  });
  return `${SOURCE_SPECIFICATIONS_CONTEXT_MARKER}\nActive requirements are authoritative and separate from the design plan. Superseded rows are immutable provenance history, not current requirements.\n${rows.join("\n")}`;
}

/** Pins the authoritative source requirements into every normal and compacted model view. */
export function projectSourceSpecifications(
  messages: AgentMessage[],
  specifications: readonly SourceSpecificationDto[],
): AgentMessage[] {
  if (specifications.length === 0) return messages;
  const withoutPriorProjection = messages.filter((message) => {
    const content = (message as { content?: unknown }).content;
    return !Array.isArray(content) || !content.some((block) =>
      typeof block === "object" && block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.startsWith(SOURCE_SPECIFICATIONS_CONTEXT_MARKER),
    );
  });
  return [
    {
      role: "user",
      content: [{ type: "text", text: projectionText(specifications) }],
      timestamp: specifications[0]!.timestamp,
    } as AgentMessage,
    ...withoutPriorProjection,
  ];
}
