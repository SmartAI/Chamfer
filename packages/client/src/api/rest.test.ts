import { afterEach, expect, it, vi } from "vitest";
import {
  classifyReference,
  startHeadlessRun,
  openInspectionLease,
  recordInspectionObservation,
  recordVisualVerification,
  recordVisualVerificationBatch,
  recordSourceSpecifications,
  createProofReport,
} from "./rest";

afterEach(() => vi.unstubAllGlobals());

it("sends evidence mutations with the agent tool call ID", async () => {
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const classify = { referenceId: "ref", status: "active" as const, purpose: "p", relationships: [], rationale: "r", specificationLinks: ["s"] };
  const observation = { relevantViews: ["front"], facts: ["f"], affectedSpecifications: ["s"], affectedComponents: [] };
  const visual = { artifactId: "a", artifactVersion: 1, inspectionSheetId: "sheet", visualComparisonEvidenceId: "comparison-a", coveredReferenceIds: [], verdict: "match" as const, observations: [] };
  const batch = { artifactId: "a", artifactVersion: 1, inspectionSheetId: "sheet", visualComparisonEvidenceId: "comparison-a", imageLimit: 2, activeReferenceIds: ["ref"], batchIndex: 0, batchCount: 1, coveredReferenceIds: ["ref"], observations: [], finalVerdict: "match" as const, synthesis: "s" };
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

  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    ...Array(4).fill("/api/conversations/c/evidence"),
    "/api/conversations/c/visual-verification-batches",
    "/api/conversations/c/evidence",
    ...Array(2).fill("/api/conversations/c/evidence"),
  ]);
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => {
    const headers = call[1]?.headers as Record<string, string> | undefined;
    return headers?.["Idempotency-Key"] ?? JSON.parse(String(call[1]?.body)).idempotencyKey;
  })).toEqual(["classify-key", "lease-key", "observation-key", "visual-key", "batch-key", "specification-key", "report-key"]);
});

it("preserves the HTTP status on a failed headless-run start", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ error: "no model configured" }),
    { status: 400, headers: { "content-type": "application/json" } },
  )));

  await expect(startHeadlessRun("conversation-1", { text: "Build a box" })).rejects.toMatchObject({
    name: "HttpError",
    status: 400,
    message: "no model configured",
  });
});
