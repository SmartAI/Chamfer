import { describe, expect, it } from "vitest";
import { scanPrivacy } from "./privacy";

describe("evaluation privacy scan", () => {
  it.each([
    ["pii", "Contact person@example.com for the source."],
    ["credential", "api_key = sk-secret-value-123456789"],
    ["private-url", "Evidence is at https://review.internal/session/7."],
    ["absolute-local-path", "Loaded from /Users/example/private/input.png."],
    ["raw-production-content", "rawProductionConversation: true"],
  ] as const)("rejects %s content", (kind, content) => {
    const scan = scanPrivacy([{ source: "fixture.json", content }]);

    expect(scan.status).toBe("failed");
    expect(scan.findings.map((finding) => finding.kind)).toContain(kind);
  });

  it("accepts the privacy-safe precise tracer manifest", () => {
    const scan = scanPrivacy([{
      source: "precise-box.case.json",
      content: JSON.stringify({ sourceSafety: { classification: "synthetic", containsProductionData: false } }),
    }]);

    expect(scan).toEqual({ status: "passed", findings: [] });
  });
});
