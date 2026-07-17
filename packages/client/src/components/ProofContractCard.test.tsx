import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProofContractDto } from "@chamfer/shared";
import { TEXT_PROOF_POLICY } from "@chamfer/shared";
import { ProofContractCard } from "./ProofContractCard";

const contract: ProofContractDto = {
  contractId: "contract-1",
  conversationId: "conversation-1",
  revision: 1,
  status: "current",
  proofStatus: "pending",
  frozenAt: 100,
  derivation: {
    planId: "plan-1",
    planRevision: 1,
    criteriaRevision: 1,
    sourceSpecificationIds: ["size"],
    component: { id: "plate", description: "mounting plate", bboxMm: [30, 20, 4] },
    criteria: [
      { id: "spec:size", category: "explicit-requirement", statement: "The plate must be 30 x 20 x 4 mm." },
      { id: "assumption:shape", category: "agent-assumption", statement: "The plate is rectangular." },
    ],
    plannedChecks: [{ id: "envelope", componentId: "plate", kind: "bbox", criterion: {} }],
    unavailableEvidence: [],
    invalidatedEvidenceIds: [],
    proofPolicy: TEXT_PROOF_POLICY,
    shapeProof: { status: "not-applicable", reason: "Text-only request." },
  },
};

describe("ProofContractCard", () => {
  it("exposes frozen identity, categorized assumptions, checks, and not-applicable shape proof", () => {
    render(<ProofContractCard contract={contract} />);
    expect(screen.getByTestId("proof-contract-card").getAttribute("data-contract-status")).toBe("current");
    fireEvent.click(screen.getByTestId("proof-contract-toggle"));
    expect(screen.getByTestId("proof-contract-agent-assumption").textContent).toContain("The plate is rectangular.");
    expect(screen.getByTestId("proof-contract-source-derived-requirement").textContent).toContain("None");
    expect(screen.getByTestId("proof-contract-planned-checks").textContent).toContain("plate.envelope: bbox");
    expect(screen.getByTestId("proof-contract-shape-proof").textContent).toContain("Shape proof: not applicable");
  });
});
