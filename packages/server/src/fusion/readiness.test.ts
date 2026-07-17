import { describe, expect, it } from "vitest";
import { deriveFusionReadiness, integrityReportProvesAtomicity, type FusionLiveCapabilities } from "./readiness";

function capable(overrides: Partial<FusionLiveCapabilities> = {}): FusionLiveCapabilities {
  return {
    document: { id: "doc-1", name: "Bracket v3", dataFileId: "file-1" },
    documentMatchesBinding: true,
    writable: true,
    busy: false,
    supported: true,
    inspectorHealthy: true,
    cameraRestored: true,
    atomicityProven: true,
    ...overrides,
  };
}

describe("deriveFusionReadiness", () => {
  it.each([
    ["no-document", capable({ document: undefined })],
    ["wrong-document", capable({ documentMatchesBinding: false })],
    ["read-only", capable({ writable: false })],
    ["busy", capable({ busy: true })],
    ["unsupported", capable({ supported: false })],
    ["degraded", capable({ cameraRestored: false })],
    ["degraded", capable({ inspectorHealthy: false })],
    ["degraded", capable({ atomicityProven: false })],
    ["ready", capable()],
  ] as const)("derives %s from the negotiated live profile", (state, profile) => {
    expect(deriveFusionReadiness(profile).state).toBe(state);
    expect(deriveFusionReadiness(profile).mutationAllowed).toBe(state === "ready");
  });
});

describe("integrityReportProvesAtomicity", () => {
  const endpoint = "http://127.0.0.1:27182/mcp";
  const requiredChecks = [
    "mcp-session", "raw-tool-schemas", "installed-api-documentation", "disposable-document",
    "coherent-mutation", "single-undo-atomicity", "deliberate-immediate-verification",
    "deterministic-rollback", "recompute-stability", "exact-camera-restoration",
    "document-identity-stability", "unrelated-document-isolation",
  ];
  const report = {
    probeVersion: 1,
    startedAt: "2026-07-14T12:00:00.000Z",
    finishedAt: "2026-07-14T12:00:01.000Z",
    endpoint,
    verdict: "go",
    safeForBroaderMutation: true,
    versions: { fusion: "2704", mcpProtocol: "2025-11-25", mcpServerName: "Adapter", mcpServer: "1" },
    disposableDocument: { probeToken: "probe", rootEntityToken: "root" },
    documentation: [{ query: "Camera", sha256: "hash" }],
    engineeringSnapshotHashes: ["before", "after"],
    screenshotSha256: "image-hash",
    identitySamples: [{ rootEntityToken: "root" }],
    checks: requiredChecks.map((id) => ({ id, passed: true })),
  };

  it("accepts a complete successful Ticket 01 report for any loopback endpoint but nothing else", () => {
    expect(integrityReportProvesAtomicity(report, endpoint)).toBe(true);
    expect(integrityReportProvesAtomicity({ ...report, verdict: "no-go" }, endpoint)).toBe(false);
    // Fusion's MCP port drifts between launches; the proof certifies the local
    // adapter, so a report generated for one loopback port validates another.
    expect(integrityReportProvesAtomicity(report, "http://127.0.0.1:27183/mcp")).toBe(true);
    expect(integrityReportProvesAtomicity({ ...report, endpoint: "http://127.0.0.1:59921/mcp" }, endpoint)).toBe(true);
    // A non-loopback or malformed endpoint on either side stays fail-closed.
    expect(integrityReportProvesAtomicity(report, "http://10.0.0.5:27182/mcp")).toBe(false);
    expect(integrityReportProvesAtomicity({ ...report, endpoint: "http://evil.example/mcp" }, endpoint)).toBe(false);
  });

  it("rejects a synthetic summary that only claims the two atomicity checks", () => {
    expect(integrityReportProvesAtomicity({
      endpoint,
      safeForBroaderMutation: true,
      checks: [
        { id: "single-undo-atomicity", passed: true },
        { id: "deterministic-rollback", passed: true },
      ],
    }, endpoint)).toBe(false);
  });
});
