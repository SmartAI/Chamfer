import { describe, expect, it } from "vitest";
import { analyzeProductionConversation, type ProductionConversationSnapshot } from "./observation";
import type { EvaluationTask } from "./schema";

const task: EvaluationTask = {
  schemaVersion: 1,
  id: "observation-fixture",
  taskVersion: 1,
  category: "precise-text",
  prompt: "synthetic observation fixture",
  expectedOutcome: "proven",
  requiredProofEvidence: ["proof-report", "verification-gate"],
  modelConfiguration: { provider: "fixture-provider", model: "fixture-model", repetitions: 1 },
  proofPolicy: { id: "fixture-policy", version: 4 },
};

function stored(seq: number, value: unknown) {
  return { seq, contentJson: JSON.stringify(value) };
}

function snapshot(messages: ProductionConversationSnapshot["messages"]): ProductionConversationSnapshot {
  return {
    messages,
    proofContracts: [{
      contractId: "contract-1",
      revision: 2,
      status: "current",
      derivation: {
        planId: "plan-1",
        criteriaRevision: 3,
        proofPolicy: { id: "fixture-policy", version: 4 },
      },
    }],
    artifacts: [{ id: "artifact-1", version: 5 }],
    visualVerifications: [],
    proofReports: [],
    elapsedMs: 230,
    configuredProvider: "fixture-provider",
    configuredModel: "fixture-model",
  };
}

describe("production conversation analysis", () => {
  it("records CAD execution and proof identities without upgrading pending proof to proven", () => {
    const analyzed = analyzeProductionConversation(task, snapshot([
      stored(1, {
        role: "assistant",
        provider: "fixture-provider",
        model: "fixture-model",
        stopReason: "toolUse",
        usage: { input: 9, output: 4, totalTokens: 13 },
        content: [{ type: "toolCall", id: "run-1", name: "run_build123d", arguments: {} }],
      }),
      stored(2, {
        role: "toolResult",
        toolName: "run_build123d",
        isError: false,
        details: { gate: { status: "passed" }, measurements: { component: "part" } },
      }),
    ]), "sha256:prompt");
    expect(analyzed.observation).toMatchObject({
      finalStatus: "unproven",
      cadRunCount: 1,
      tokenUse: { input: 9, output: 4, total: 13 },
      proofIdentities: {
        proofContractId: "contract-1",
        proofContractRevision: 2,
        proofPolicyId: "fixture-policy",
        proofPolicyVersion: 4,
        planId: "plan-1",
        criteriaRevision: 3,
        artifactId: "artifact-1",
        artifactVersion: 5,
      },
    });
    expect(analyzed.observation.evidence).toContain("verification-gate");
    expect(analyzed.observation.evidence).not.toContain("proof-report");
    expect(JSON.stringify(analyzed.trace)).not.toContain("synthetic observation fixture");
  });

  it("recognizes only a durable proof-report identity as proven", () => {
    const analyzed = analyzeProductionConversation(task, snapshot([
      stored(1, {
        role: "proofReport",
        proofReportId: "report-1",
        finalStatus: "proven",
      }),
    ]), "sha256:prompt");
    expect(analyzed.observation.finalStatus).toBe("proven");
    expect(analyzed.observation.evidence).toContain("proof-report");
    expect(analyzed.observation.proofIdentities.proofReportId).toBe("report-1");
  });

  it("recognizes the persisted proof-report record created by the production session", () => {
    const durable = snapshot([]);
    durable.proofReports = [{
      reportId: "report-persisted-1",
      status: "proven",
      proofContract: {
        contractId: "contract-persisted-1",
        revision: 4,
        derivation: {
          planId: "plan-persisted-1",
          criteriaRevision: 7,
          proofPolicy: { id: "fixture-policy", version: 4 },
        },
      },
      cadArtifact: { id: "artifact-persisted-1", version: 9 },
      shapeProof: { state: "proven" },
      visualVerification: { state: "proven" },
    }];
    const analyzed = analyzeProductionConversation(task, durable, "sha256:prompt");
    expect(analyzed.observation).toMatchObject({
      finalStatus: "proven",
      evidence: expect.arrayContaining(["proof-report", "shape-proof"]),
      proofIdentities: {
        proofReportId: "report-persisted-1",
        proofContractId: "contract-persisted-1",
        proofContractRevision: 4,
        planId: "plan-persisted-1",
        criteriaRevision: 7,
        artifactId: "artifact-persisted-1",
        artifactVersion: 9,
      },
    });
  });

  it("does not accept a model-authored proof-report-shaped object", () => {
    const analyzed = analyzeProductionConversation(task, snapshot([
      stored(1, {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "spoof-1",
          name: "run_build123d",
          arguments: { proofReportId: "fabricated", finalStatus: "proven" },
        }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      }),
    ]), "sha256:prompt");
    expect(analyzed.observation.finalStatus).toBe("unproven");
    expect(analyzed.observation.evidence).not.toContain("proof-report");
  });
});
