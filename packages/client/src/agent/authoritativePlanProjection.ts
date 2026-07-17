import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isDomainPlan } from "./domainPlan";
import { isPlanToolResult, latestPlan } from "./plan";

export const AUTHORITATIVE_PLAN_CONTEXT_MARKER = "[Authoritative design plan]";
const HISTORICAL_PLAN_RESULT_STUB = "Plan mutation accepted. The normalized authoritative plan is projected separately.";

function containsMarker(message: AgentMessage): boolean {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.some((block) =>
    typeof block === "object" && block !== null &&
    (block as { type?: unknown }).type === "text" &&
    (block as { text?: unknown }).text === AUTHORITATIVE_PLAN_CONTEXT_MARKER,
  );
}

/** Current entities are projected once; immutable reducer history remains audit-only context. */
export function normalizedAuthoritativePlan(plan: ReturnType<typeof latestPlan>): unknown {
  if (!isDomainPlan(plan)) return plan;
  return {
    format: plan.domain.format,
    plan_id: plan.domain.plan_id,
    revision: plan.domain.revision,
    criteria_revision: plan.domain.criteria_revision,
    source_specification_ids: plan.domain.source_specification_ids,
    requires_form_review: plan.domain.requires_form_review ?? false,
    current: {
      goal: plan.goal,
      components: plan.components
        .filter((component) => component.retired_revision === undefined && component.status !== "abandoned")
        .map((component) => ({
          ...component,
          checks: (component.checks ?? []).filter((check) =>
            (check as { retired_revision?: number }).retired_revision === undefined && check.removed !== true,
          ),
        })),
      interfaces: (plan.interfaces ?? []).filter((planInterface) => planInterface.retired_revision === undefined),
    },
    immutable_history: plan.domain.history,
  };
}

/**
 * Replaces every transcript plan snapshot with a compact acknowledgement and
 * injects the normalized plan of record exactly once. Legacy transcripts stay
 * byte-for-byte compatible until an explicit transition creates a domain plan.
 */
export function projectAuthoritativePlan(
  visibleMessages: AgentMessage[],
  transcript: readonly unknown[] = visibleMessages,
): AgentMessage[] {
  const plan = latestPlan(transcript);
  if (!isDomainPlan(plan)) return visibleMessages;
  const withoutPriorProjection = visibleMessages.filter((message) => !containsMarker(message));
  const stubbed = withoutPriorProjection.map((message) => {
    if (!isPlanToolResult(message)) return message;
    const details = (message as unknown as { details?: Record<string, unknown> }).details;
    return {
      ...(message as object),
      content: [{ type: "text", text: HISTORICAL_PLAN_RESULT_STUB }],
      details: details ? { ...details, plan: undefined } : details,
    } as AgentMessage;
  });
  return [{
    role: "user",
    content: [{ type: "text", text: AUTHORITATIVE_PLAN_CONTEXT_MARKER }, {
      type: "text",
      text: JSON.stringify(normalizedAuthoritativePlan(plan)),
    }],
    timestamp: plan.domain.created_at,
  } as AgentMessage, ...stubbed];
}
