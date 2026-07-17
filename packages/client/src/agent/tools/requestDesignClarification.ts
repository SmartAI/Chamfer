import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { DesignEscalationDto, OpenDesignEscalationInput } from "@chamfer/shared";

const parameters = Type.Object({
  escalationId: Type.String({ description: "Stable lowercase identity for this unresolved design decision." }),
  kind: StringEnum([
    "conflicting-specifications",
    "missing-physical-scale",
    "materially-different-interpretations",
    "explicit-requirement-change",
  ]),
  question: Type.String({
    description: "Exactly one focused user question, on one line, ending in one question mark.",
  }),
  affectedSpecificationIds: Type.Array(Type.String(), {
    description: "Active source requirement identities affected by the unresolved decision.",
  }),
  basis: Type.String({ description: "Concise evidence explaining why no defensible autonomous choice exists." }),
});

export function createRequestDesignClarificationTool(deps: {
  persistPending: () => Promise<void>;
  open: (input: OpenDesignEscalationInput, idempotencyKey: string) => Promise<DesignEscalationDto>;
  validate: (input: OpenDesignEscalationInput) => string | undefined;
  onAccepted: (escalation: DesignEscalationDto) => void;
}): AgentTool<typeof parameters, { escalation: DesignEscalationDto }> {
  return {
    name: "request_design_clarification",
    label: "Request design clarification",
    description:
      "Ask one focused question only when unresolved evidence makes a material choice arbitrary or changing an explicit requirement would be necessary. Never use this for construction choices, documented conservative defaults, or routine approval.",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, args) => {
      const input = args as OpenDesignEscalationInput;
      const invalid = deps.validate(input);
      if (invalid) throw new Error(invalid);
      await deps.persistPending();
      const escalation = await deps.open(input, toolCallId);
      deps.onAccepted(escalation);
      return {
        content: [{
          type: "text",
          text: `Design work is blocked pending one user answer: ${escalation.question}`,
        }],
        details: { escalation },
      };
    },
  };
}
