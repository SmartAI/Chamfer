import { describe, expect, it } from "vitest";
import type {
  ArtifactDto,
  ConversationDto,
  CreateProofContractInput,
  CreateProofReportInput,
  ProofReportDto,
} from "@chamfer/shared";
import { TEXT_PROOF_POLICY } from "@chamfer/shared";
import { createApp } from "../app";
import { openDb } from "../db";

const PLAN = {
  goal: "Build one mounting plate",
  components: [{
    id: "plate",
    description: "30 x 20 x 4 mm mounting plate",
    bbox_mm: [30, 20, 4],
    status: "building",
    criteria_revision: 1,
    checks: [
      { id: "envelope", kind: "bbox", size_mm: [30, 20, 4], target: "plate" },
      { id: "volume", kind: "volume", range_mm3: [2300, 2500], target: "plate" },
    ],
  }],
  interfaces: [],
  domain: {
    format: "domain-operations-v1",
    plan_id: "plan-1",
    revision: 1,
    criteria_revision: 1,
    source_specification_ids: ["plate-size"],
    actor: "agent",
    created_at: 1,
    history: [],
  },
};

const CONTRACT: CreateProofContractInput = {
  derivation: {
    planId: "plan-1",
    planRevision: 1,
    criteriaRevision: 1,
    sourceSpecificationIds: ["plate-size"],
    component: { id: "plate", description: "30 x 20 x 4 mm mounting plate", bboxMm: [30, 20, 4] },
    criteria: [
      {
        id: "specification:plate-size",
        category: "explicit-requirement",
        statement: "The plate must be 30 x 20 x 4 mm.",
        sourceSpecificationId: "plate-size",
      },
      {
        id: "assumption:plate:description",
        category: "agent-assumption",
        statement: "The part is interpreted as a rectangular mounting plate.",
      },
    ],
    plannedChecks: [
      { id: "envelope", componentId: "plate", kind: "bbox", criterion: { kind: "bbox" } },
      { id: "volume", componentId: "plate", kind: "volume", criterion: { kind: "volume" } },
    ],
    unavailableEvidence: [],
    invalidatedEvidenceIds: [],
    proofPolicy: TEXT_PROOF_POLICY,
    shapeProof: { status: "not-applicable", reason: "No eligible reference image was supplied." },
  },
};

async function postJson(app: ReturnType<typeof createApp>, path: string, body: unknown, headers = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function seed(
  app: ReturnType<typeof createApp>,
  evidence: {
    gate?: "passed" | "failed" | "error";
    conformance?: "passed" | "failed" | "missing";
    integrity?: "conforming" | "nonconforming" | "missing";
  } = {},
) {
  const gateStatus = evidence.gate ?? "passed";
  const conformanceStatus = evidence.conformance ?? "passed";
  const integrityStatus = evidence.integrity ?? "conforming";
  const conversation = await (await postJson(app, "/api/conversations", { title: "Proof report", cadEnvironment: "build123d" })).json() as ConversationDto;
  const sourceText = "Build a 30 x 20 x 4 mm plate.";
  await postJson(app, `/api/conversations/${conversation.id}/messages`, {
    id: "source-message",
    seq: 0,
    role: "user",
    contentJson: JSON.stringify({ role: "user", content: sourceText, timestamp: 1 }),
  });
  await postJson(app, `/api/conversations/${conversation.id}/source-specifications`, {
    specifications: [{
      id: "plate-size",
      requirement: "The plate must be 30 x 20 x 4 mm.",
      source: { messageId: "source-message", text: "30 x 20 x 4 mm plate", start: 8, end: 28 },
    }],
  }, { "Idempotency-Key": "source-specifications" });
  await postJson(app, `/api/conversations/${conversation.id}/messages`, {
    id: "plan-message",
    seq: 1,
    role: "toolResult",
    contentJson: JSON.stringify({
      role: "toolResult",
      toolName: "create_plan",
      toolCallId: "create-plan",
      isError: false,
      content: [],
      details: { plan: PLAN },
      timestamp: 2,
    }),
  });
  const contract = await (await postJson(app, `/api/conversations/${conversation.id}/proof-contracts`, CONTRACT)).json() as {
    contractId: string;
    revision: number;
  };
  const artifact = await (await postJson(app, `/api/conversations/${conversation.id}/artifacts`, {
    pySource: "result = Box(30, 20, 4)",
    paramsJson: null,
  })).json() as ArtifactDto;
  await postJson(app, `/api/conversations/${conversation.id}/messages`, {
    id: "run-message",
    seq: 2,
    role: "toolResult",
    contentJson: JSON.stringify({
      role: "toolResult",
      toolName: "run_build123d",
      toolCallId: "run-plate",
      isError: false,
      content: [],
      details: {
        code: { toolCallId: "run-plate", artifactId: artifact.id, artifactVersion: artifact.version },
        gate: {
          status: gateStatus,
          checks: [
            { name: "check:bbox[0]", passed: true, detail: "bounding box matches" },
            { name: "single_component_integrity", passed: true, detail: "one valid solid" },
          ],
        },
        ...(conformanceStatus === "missing" ? {} : {
          planConformance: {
            status: conformanceStatus,
            planId: "plan-1",
            componentCriteriaRevisions: { plate: 1 },
          },
        }),
        measurements: {
          bboxMm: [30, 20, 4],
          volumeMm3: 2400,
          areaMm2: 1360,
          children: [{ label: "plate", bboxMm: [30, 20, 4], volumeMm3: 2400 }],
          component: "plate",
          checks: [],
          ...(integrityStatus === "missing" ? {} : { integrity: {
            status: integrityStatus,
            componentId: "plate",
            resultLabel: "plate",
            solidCount: 1,
            valid: true,
            issues: integrityStatus === "nonconforming"
              ? [{ code: "disconnected-solid", detail: "two connected solids were found" }]
              : [],
          } }),
        },
      },
      timestamp: 3,
    }),
  });
  const input: CreateProofReportInput = {
    proofContractId: contract.contractId,
    proofContractRevision: contract.revision,
    planId: "plan-1",
    planRevision: 1,
    criteriaRevision: 1,
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    engineeringEvidenceId: "run-plate",
  };
  return { conversation, artifact, input };
}

function createReport(app: ReturnType<typeof createApp>, conversationId: string, input: CreateProofReportInput, key: string) {
  return postJson(app, `/api/conversations/${conversationId}/proof-reports`, input, { "Idempotency-Key": key });
}

describe("proof report routes", () => {
  it("derives one structured report from authoritative records and replays exact retries", async () => {
    const db = openDb(":memory:");
    const app = createApp(db);
    const { conversation, artifact, input } = await seed(app);

    const firstResponse = await createReport(app, conversation.id, input, "report-run-plate");
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as ProofReportDto;
    expect(first).toMatchObject({
      conversationId: conversation.id,
      status: "proven",
      proofContract: { proofStatus: "pending" },
      acceptedPlan: { planId: "plan-1", revision: 1, criteriaRevision: 1, componentId: "plate" },
      cadArtifact: { id: artifact.id, version: 1 },
      engineering: {
        state: "proven",
        evidenceId: "run-plate",
        verificationGate: { state: "proven", verdict: "passed" },
        planConformance: { state: "proven", verdict: "passed" },
      },
      bodyIntegrity: { state: "proven", verdict: { status: "conforming", solidCount: 1 } },
      shapeProof: { state: "not-applicable" },
      visualVerification: { state: "not-applicable" },
    });
    expect(first.sourceSpecifications[0]).toMatchObject({
      id: "plate-size",
      source: { messageId: "source-message", text: "30 x 20 x 4 mm plate" },
    });
    expect(first.assumptions).toHaveLength(1);
    expect(await (await createReport(app, conversation.id, input, "report-run-plate")).json()).toEqual(first);
    expect(await (await createApp(db).request(`/api/conversations/${conversation.id}/proof-reports`)).json()).toEqual([first]);
  });

  it("rejects conflicting reuse, cross-conversation identities, and stale artifact identities", async () => {
    const app = createApp(openDb(":memory:"));
    const { conversation, input } = await seed(app);
    expect((await createReport(app, conversation.id, input, "report-key")).status).toBe(200);
    expect((await createReport(app, conversation.id, { ...input, engineeringEvidenceId: "changed" }, "report-key")).status).toBe(409);

    const other = await (await postJson(app, "/api/conversations", { title: "Other", cadEnvironment: "build123d" })).json() as ConversationDto;
    expect((await createReport(app, other.id, input, "other-report")).status).toBe(409);

    await postJson(app, `/api/conversations/${conversation.id}/artifacts`, {
      pySource: "result = Box(31, 20, 4)",
      paramsJson: null,
    });
    const list = await (await app.request(`/api/conversations/${conversation.id}/proof-reports`)).json() as ProofReportDto[];
    expect(list[0]?.status).toBe("stale");
    expect((await createReport(app, conversation.id, input, "stale-report")).status).toBe(409);
  });

  it.each([
    ["failed", { gate: "failed", conformance: "failed", integrity: "nonconforming" }, "failed"],
    ["unavailable", { gate: "error", conformance: "missing", integrity: "missing" }, "unavailable"],
  ] as const)("preserves %s evidence without presenting it as proven", async (_label, evidence, expected) => {
    const app = createApp(openDb(":memory:"));
    const { conversation, input } = await seed(app, evidence);
    const report = await (await createReport(app, conversation.id, input, `report-${expected}`)).json() as ProofReportDto;
    expect(report.status).toBe(expected);
    expect(report.engineering.verificationGate.state).toBe(expected);
    expect(report.bodyIntegrity.state).toBe(expected);
  });

  it("deletes report and request records with the owning conversation", async () => {
    const db = openDb(":memory:");
    const app = createApp(db);
    const { conversation, input } = await seed(app);
    expect((await createReport(app, conversation.id, input, "report-key")).status).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS count FROM proof_reports").get() as { count: number }).count).toBe(1);
    expect((await app.request(`/api/conversations/${conversation.id}`, { method: "DELETE" })).status).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS count FROM proof_reports").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM proof_report_requests").get() as { count: number }).count).toBe(0);
  });
});
