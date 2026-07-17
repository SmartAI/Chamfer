import { describe, expect, it } from "vitest";
import {
  REQUIRED_FAKE_INTEGRITY_TESTS,
  REQUIRED_LIVE_INTEGRITY_CHECKS,
  evaluateFusionIntegrityAccess,
  type FusionReleaseIntegrityReport,
} from "./integrityGate";

const HASH = "a".repeat(64);

function completeReport(overrides: Partial<FusionReleaseIntegrityReport> = {}): FusionReleaseIntegrityReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-14T12:00:00.000Z",
    artifact: { sha256: HASH, release: "chamfer@0.2.2", gitCommit: "1".repeat(40) },
    identities: {
      connector: { version: "1", sha256: HASH },
      policy: { version: "1", sha256: HASH },
      skills: { version: "1", sha256: HASH },
      fixtures: { version: "1", sha256: HASH },
    },
    fake: {
      status: "passed",
      runner: "playwright",
      startedAt: "2026-07-14T11:00:00.000Z",
      finishedAt: "2026-07-14T11:10:00.000Z",
      tests: REQUIRED_FAKE_INTEGRITY_TESTS.map((id) => ({ id, status: "passed" as const })),
      fixtures: ["FUS-TEXT-001", "FUS-IMAGE-001", "FUS-TEXT-002"],
    },
    live: {
      status: "passed",
      runner: "vitest",
      startedAt: "2026-07-14T11:10:00.000Z",
      finishedAt: "2026-07-14T11:20:00.000Z",
      endpoint: "http://127.0.0.1:27182/mcp",
      disposableDocumentAuthorized: true,
      versions: { fusion: "2.0.20981", mcpProtocol: "2025-11-25", mcpServer: "1.0.0" },
      checks: REQUIRED_LIVE_INTEGRITY_CHECKS.map((id) => ({ id, status: "passed" as const })),
      fixtures: ["FUS-TEXT-001", "FUS-IMAGE-001", "FUS-TEXT-002"],
    },
    integrityFailures: [],
    limitations: [],
    verdict: "go",
    ...overrides,
  };
}

describe("evaluateFusionIntegrityAccess", () => {
  it("promotes normal-user access only for the exact complete zero-failure artifact report", () => {
    expect(evaluateFusionIntegrityAccess(completeReport(), HASH, false)).toMatchObject({
      enabled: true,
      access: "released",
      verdict: "go",
      limitations: [],
    });
    expect(evaluateFusionIntegrityAccess(completeReport(), "b".repeat(64), false)).toMatchObject({
      enabled: false,
      access: "hidden",
      verdict: "no-go",
      limitations: expect.arrayContaining([expect.stringMatching(/current release artifact/i)]),
    });
  });

  it("invalidates missing, skipped, unsupported, stale, and internally inconsistent coverage", () => {
    const cases: FusionReleaseIntegrityReport[] = [
      completeReport({ fake: { ...completeReport().fake, tests: completeReport().fake.tests.slice(1) } }),
      completeReport({ fake: { ...completeReport().fake, tests: completeReport().fake.tests.map((test, index) => index === 0 ? { ...test, status: "skipped" } : test) } }),
      completeReport({ live: { ...completeReport().live, checks: completeReport().live.checks.map((check, index) => index === 0 ? { ...check, status: "unsupported" } : check) } }),
      completeReport({ generatedAt: "not-a-date" }),
      completeReport({ integrityFailures: [{ code: "false-ready", detail: "Observed a false-ready state" }] }),
      completeReport({ verdict: "no-go" }),
    ];

    for (const report of cases) {
      expect(evaluateFusionIntegrityAccess(report, HASH, false).enabled).toBe(false);
    }
    expect(evaluateFusionIntegrityAccess({} as FusionReleaseIntegrityReport, HASH, false)).toMatchObject({
      enabled: false,
      verdict: "no-go",
      limitations: [expect.stringMatching(/malformed/i)],
    });
  });

  it("keeps controlled testers opted in while exposing the current no-go verdict and limitations", () => {
    const access = evaluateFusionIntegrityAccess(undefined, HASH, true);
    expect(access).toMatchObject({ enabled: true, access: "experimental", verdict: "no-go" });
    expect(access.limitations.join(" ")).toMatch(/report/i);
  });
});
