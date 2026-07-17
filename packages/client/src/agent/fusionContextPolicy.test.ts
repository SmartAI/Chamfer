import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { projectFusionModelContext } from "./fusionContextPolicy";

describe("Fusion model evidence policy", () => {
  it("keeps normalized Chamfer evidence while removing private details and raw MCP traffic", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Create a bracket" }], timestamp: 1 },
      { role: "assistant", content: [
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", id: "raw", name: "fusion_mcp_read", arguments: { authorization: "Bearer secret" } },
        { type: "toolCall", id: "safe", name: "inspect_fusion", arguments: { checks: [] } },
      ], timestamp: 2 },
      { role: "toolResult", toolCallId: "raw", toolName: "fusion_mcp_read", isError: false,
        content: [{ type: "text", text: "unrelated-project.f3d" }], details: { credential: "secret" }, timestamp: 3 },
      { role: "toolResult", toolCallId: "safe", toolName: "inspect_fusion", isError: false,
        content: [{ type: "text", text: "Revision: rev-1" }],
        details: { endpoint: "http://127.0.0.1:27182/mcp", rawMcp: { credential: "secret" } }, timestamp: 4 },
      { role: "toolResult", toolCallId: "docs-error", toolName: "search_fusion_docs", isError: true,
        content: [{ type: "text", text: "Bearer connector-secret unrelated-project.f3d" }], timestamp: 5 },
      { role: "toolResult", toolCallId: "plan", toolName: "update_plan", isError: false,
        content: [{ type: "text", text: "Plan accepted: one component." }], timestamp: 6 },
    ] as unknown as AgentMessage[];

    const projected = projectFusionModelContext(messages);
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain("Create a bracket");
    expect(serialized).toContain("Revision: rev-1");
    expect(serialized).toContain("inspect_fusion");
    expect(serialized).toContain("Plan accepted: one component.");
    expect(serialized).not.toContain("fusion_mcp_read");
    expect(serialized).not.toContain("unrelated-project.f3d");
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain('"details":');
    expect(serialized).toContain("Installed Fusion API lookup failed without provider-visible connector details");
  });

  it("surfaces update_plan and run_fusion_action validation errors so the model can self-correct", () => {
    const planReason = 'component "housing": checks must include a volume check targeting it, e.g. {"id":"volume","kind":"volume","range_mm3":[lo,hi],"target":"housing"}';
    const actionReason = "run_fusion_action expectedEffects must exactly match every active fusion_effect check in the accepted plan";
    const bodyPolicyReason = "Fusion action policy rejected the body: Ambient capability adsk is not in the supplied object-capability allowlist.";
    const messages = [
      { role: "toolResult", toolCallId: "plan-err", toolName: "update_plan", isError: true,
        content: [{ type: "text", text: planReason }], timestamp: 1 },
      { role: "toolResult", toolCallId: "action-gate", toolName: "run_fusion_action", isError: true,
        content: [{ type: "text", text: actionReason }], timestamp: 2 },
      { role: "toolResult", toolCallId: "action-policy", toolName: "run_fusion_action", isError: true,
        content: [{ type: "text", text: bodyPolicyReason }], timestamp: 3 },
      { role: "toolResult", toolCallId: "inspect-err", toolName: "inspect_fusion", isError: true,
        content: [{ type: "text", text: "http://127.0.0.1:27182/mcp native-token-secret" }], timestamp: 4 },
    ] as unknown as AgentMessage[];

    const serialized = JSON.stringify(projectFusionModelContext(messages));
    // Plan and action validation errors are provider-safe schema/policy guidance: surface them verbatim.
    expect(serialized).toContain("checks must include a volume check targeting it");
    expect(serialized).toContain("expectedEffects must exactly match every active fusion_effect check");
    expect(serialized).toContain("Ambient capability adsk is not in the supplied object-capability allowlist");
    // Connector-traffic errors stay normalized (no endpoint or token leakage).
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("native-token-secret");
    expect(serialized).toContain("Trusted Fusion inspection failed without provider-visible connector details");
  });
});
