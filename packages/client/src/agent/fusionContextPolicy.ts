import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** One owned manifest for every reviewed Fusion tool boundary. Adding a tool
 * requires an explicit decision about browser injection and provider exposure. */
export const FUSION_TOOL_POLICY = {
  classify_reference: { injectable: false, providerVisible: true,
    errorText: "Reference classification failed without provider-visible storage details." },
  inspect_fusion: { injectable: true, providerVisible: true,
    errorText: "Trusted Fusion inspection failed without provider-visible connector details." },
  update_plan: { injectable: false, providerVisible: true, surfaceErrorDetail: true,
    errorText: "Fusion plan update failed without provider-visible local details." },
  load_skill: { injectable: false, providerVisible: true,
    errorText: "Reviewed Fusion skill loading failed without provider-visible local details." },
  run_fusion_action: { injectable: false, providerVisible: true, surfaceErrorDetail: true,
    errorText: "Fusion action failed with a normalized policy or recovery result." },
  search_fusion_docs: { injectable: true, providerVisible: true,
    errorText: "Installed Fusion API lookup failed without provider-visible connector details." },
  inspect_evidence: { injectable: false, providerVisible: true,
    errorText: "Selected evidence could not be inspected." },
  record_inspection_observation: { injectable: false, providerVisible: true,
    errorText: "Inspection observations could not be recorded." },
  // Batch rejections are locally computed evidence-freshness verdicts
  // (artifact/sheet identities, batch positions) with no endpoint, token, or
  // screenshot data. The model must see them verbatim: "verification must
  // target latest artifact" is the only signal that the evidence went stale
  // and the batch protocol must restart from a fresh inspection.
  record_visual_verification_batch: { injectable: false, providerVisible: true, surfaceErrorDetail: true,
    errorText: "Visual verification could not be recorded." },
} as const;

export function fusionToolMayBeInjected(name: string): boolean {
  return name in FUSION_TOOL_POLICY
    && FUSION_TOOL_POLICY[name as keyof typeof FUSION_TOOL_POLICY].injectable;
}

function fusionToolMayEnterModelContext(name: string): boolean {
  return name in FUSION_TOOL_POLICY
    && FUSION_TOOL_POLICY[name as keyof typeof FUSION_TOOL_POLICY].providerVisible;
}

/** Some reviewed tools fail with locally-computed, provider-safe guidance rather
 * than connector traffic - notably update_plan, whose rejection text is pure
 * plan-schema validation (no endpoint, token, or screenshot data). Those errors
 * must reach the model verbatim; otherwise it cannot see what to correct and
 * resubmits the same rejected plan indefinitely. */
function fusionToolSurfacesErrorDetail(name: string): boolean {
  const policy = name in FUSION_TOOL_POLICY ? FUSION_TOOL_POLICY[name as keyof typeof FUSION_TOOL_POLICY] : undefined;
  return Boolean(policy && "surfaceErrorDetail" in policy && policy.surfaceErrorDetail);
}

function normalizedToolError(toolName: string): string {
  return toolName in FUSION_TOOL_POLICY
    ? FUSION_TOOL_POLICY[toolName as keyof typeof FUSION_TOOL_POLICY].errorText
    : "Reviewed Fusion tool failed without provider-visible local details.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewedAssistantContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter((block) => {
    if (!isRecord(block) || block.type !== "toolCall") return true;
    return typeof block.name === "string" && fusionToolMayEnterModelContext(block.name);
  });
}

/**
 * Builds the provider projection independently from the durable transcript.
 * UI/audit-only `details` (including endpoint, screenshots, native tokens, and
 * full action inspection DTOs) stay local. Unknown/raw Fusion tool traffic is
 * omitted even if a hostile or legacy transcript contains it.
 */
export function projectFusionModelContext(messages: AgentMessage[]): AgentMessage[] {
  return messages.flatMap((message) => {
    if (message.role === "assistant") {
      return [{ ...message, content: reviewedAssistantContent(message.content) } as AgentMessage];
    }
    if (message.role !== "toolResult") return [message];
    if (!fusionToolMayEnterModelContext(message.toolName)) return [];
    return [{
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.isError && !fusionToolSurfacesErrorDetail(message.toolName)
        ? [{ type: "text", text: normalizedToolError(message.toolName) }]
        : message.content,
      isError: message.isError,
      timestamp: message.timestamp,
    } as AgentMessage];
  });
}
