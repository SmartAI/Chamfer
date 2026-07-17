import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type {
  RecordSourceSpecificationsInput,
  SourceSpecificationDto,
} from "@chamfer/shared";

const parameters = Type.Object({
  resolvesEscalationId: Type.Optional(Type.String({
    description: "Pending focused design clarification answered by this user message.",
  })),
  specifications: Type.Array(Type.Object({
    id: Type.String({
      description: "Stable lowercase requirement slug. Never rename or reuse it for different source text.",
    }),
    requirement: Type.String({
      description: "What the design must honor. Do not include a plan check, CAD operation, or implementation choice.",
    }),
    sourceQuote: Type.String({
      description: "Exact, unique, verbatim text from the current user request that establishes this requirement.",
    }),
    supersedesSpecificationIds: Type.Optional(Type.Array(Type.String(), {
      minItems: 1,
      description: "Active source requirement identities jointly replaced by this clarifying answer.",
    })),
    conflictsWithSpecificationIds: Type.Optional(Type.Array(Type.String(), {
      minItems: 1,
      description: "Other active source identities that cannot be honored together with this requirement.",
    })),
  }), { minItems: 1 }),
});

export interface SourceMessageForSpecifications {
  id: string;
  text: string;
}

export function createRecordSourceSpecificationsTool(deps: {
  persistPending: () => Promise<void>;
  sourceMessage: () => SourceMessageForSpecifications | undefined;
  record: (input: RecordSourceSpecificationsInput, idempotencyKey: string) => Promise<SourceSpecificationDto[]>;
  onAccepted: (specifications: SourceSpecificationDto[], resolvesEscalationId?: string) => void;
}): AgentTool<typeof parameters, { specifications: SourceSpecificationDto[] }> {
  return {
    name: "record_source_specifications",
    label: "Record source specifications",
    description:
      "Record every explicit requirement from the current text design request as immutable, source-linked specifications. Call this before create_plan for a new text design. Requirements state what the design must honor, not how to build or check it.",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, args) => {
      await deps.persistPending();
      const sourceMessage = deps.sourceMessage();
      if (!sourceMessage) throw new Error("No persisted user text is available as source provenance.");
      const specifications = args.specifications.map((specification) => {
        const start = sourceMessage.text.indexOf(specification.sourceQuote);
        if (start < 0) {
          throw new Error(`Source quote for ${specification.id} is not exact text from the current user request.`);
        }
        if (start !== sourceMessage.text.lastIndexOf(specification.sourceQuote)) {
          throw new Error(`Source quote for ${specification.id} is ambiguous; submit a longer unique verbatim quote.`);
        }
        return {
          id: specification.id,
          requirement: specification.requirement,
          source: {
            messageId: sourceMessage.id,
            text: specification.sourceQuote,
            start,
            end: start + specification.sourceQuote.length,
          },
          ...(specification.supersedesSpecificationIds
            ? { supersedesSpecificationIds: specification.supersedesSpecificationIds }
            : {}),
          ...(specification.conflictsWithSpecificationIds
            ? { conflictsWithSpecificationIds: specification.conflictsWithSpecificationIds }
            : {}),
        };
      });
      const accepted = await deps.record({
        specifications,
        ...(args.resolvesEscalationId ? { resolvesEscalationId: args.resolvesEscalationId } : {}),
      }, toolCallId);
      if (args.resolvesEscalationId) deps.onAccepted(accepted, args.resolvesEscalationId);
      else deps.onAccepted(accepted);
      return {
        content: [{
          type: "text",
          text: `Recorded ${accepted.length} immutable source specification${accepted.length === 1 ? "" : "s"}: ${accepted.map((specification) => specification.id).join(", ")}.`,
        }],
        details: { specifications: accepted },
      };
    },
  };
}

export function sourceTextOf(message: AgentMessage): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("\n");
}
