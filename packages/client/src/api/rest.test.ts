import { afterEach, expect, it, vi } from "vitest";
import {
  classifyReference,
  openInspectionLease,
  recordInspectionObservation,
  recordVisualVerification,
  recordVisualVerificationBatch,
  recordSourceSpecifications,
  createProofReport,
} from "./rest";

afterEach(() => vi.unstubAllGlobals());

it("sends the agent tool call ID as Idempotency-Key on mutation requests", async () => {
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const classify = { referenceId: "ref", status: "active" as const, purpose: "p", relationships: [], rationale: "r", specificationLinks: ["s"] };
  const observation = { relevantViews: ["front"], facts: ["f"], affectedSpecifications: ["s"], affectedComponents: [] };
  const visual = { artifactId: "a", artifactVersion: 1, inspectionSheetId: "sheet", coveredReferenceIds: [], verdict: "match" as const, observations: [] };
  const batch = { artifactId: "a", artifactVersion: 1, inspectionSheetId: "sheet", imageLimit: 2, activeReferenceIds: ["ref"], batchIndex: 0, batchCount: 1, coveredReferenceIds: ["ref"], observations: [], finalVerdict: "match" as const, synthesis: "s" };
  const specifications = { specifications: [{ id: "size", requirement: "Honor size.", source: { messageId: "m", text: "size", start: 0, end: 4 } }] };

  await classifyReference("c", classify, "classify-key");
  await openInspectionLease("c", { evidenceIds: ["ref"], purpose: "p" }, "lease-key");
  await recordInspectionObservation("c", "lease", observation, "observation-key");
  await recordVisualVerification("c", visual, "visual-key");
  await recordVisualVerificationBatch("c", batch, "batch-key");
  await recordSourceSpecifications("c", specifications, "specification-key");
  await createProofReport("c", {
    proofContractId: "contract",
    proofContractRevision: 1,
    planId: "plan",
    planRevision: 1,
    criteriaRevision: 1,
    artifactId: "artifact",
    artifactVersion: 1,
    engineeringEvidenceId: "run",
  }, "report-key");

  expect(fetch.mock.calls.map((call) => (call[1]?.headers as Record<string, string>)["Idempotency-Key"]))
    .toEqual(["classify-key", "lease-key", "observation-key", "visual-key", "batch-key", "specification-key", "report-key"]);
});
