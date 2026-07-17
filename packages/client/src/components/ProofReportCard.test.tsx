import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProofReportDto } from "@chamfer/shared";
import { ProofReportCard } from "./ProofReportCard";

const report = {
  reportId: "report-1",
  conversationId: "conversation-1",
  createdAt: 1,
  status: "proven",
  proofContract: { contractId: "contract-1", revision: 1 },
  acceptedPlan: { planId: "plan-1", revision: 2, criteriaRevision: 1 },
  sourceSpecifications: [{ id: "plate-size" }],
  cadArtifact: { id: "artifact-1", version: 3, createdAt: 1 },
  engineering: {
    state: "proven",
    verificationGate: { state: "proven", checks: [{ name: "bbox", passed: true, detail: "ok" }] },
    planConformance: { state: "proven" },
  },
  bodyIntegrity: { state: "proven", verdict: { solidCount: 1, valid: true } },
  shapeProof: { state: "not-applicable", reason: "text only" },
  visualVerification: { state: "not-applicable", reason: "text only" },
  assumptions: [],
  unavailableEvidence: [],
} as unknown as ProofReportDto;

afterEach(() => vi.unstubAllGlobals());

it("shows the current proof states, expands exact identities, and downloads structured JSON", () => {
  const createObjectURL = vi.fn(() => "blob:report");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  render(<ProofReportCard report={report} />);
  expect(screen.getByTestId("proof-report-card").dataset.proofReportStatus).toBe("proven");
  expect(screen.getByText("CAD artifact 3")).toBeTruthy();
  expect(screen.getAllByText(/Shape proof Not applicable/).length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { expanded: false }));
  expect(screen.getByTestId("proof-report-contents").textContent).toContain("Contract contract-1 r1");
  expect(screen.getByTestId("proof-report-contents").textContent).toContain("1 connected solid");

  fireEvent.click(screen.getByTestId("proof-report-download"));
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
  click.mockRestore();
});

it.each(["failed", "unavailable", "stale"] as const)("surfaces the %s report state beside the current model", (status) => {
  render(<ProofReportCard report={{ ...report, status }} />);

  expect(screen.getByTestId("proof-report-card").dataset.proofReportStatus).toBe(status);
  expect(screen.getByText(status, { exact: false })).toBeTruthy();
});
