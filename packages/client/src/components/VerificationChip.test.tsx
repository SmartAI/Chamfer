import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerificationChip } from "./VerificationChip";

describe("VerificationChip", () => {
  it("renders nothing without a summary when idle", () => {
    const { container } = render(<VerificationChip streaming={false} summary={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the verifying state while streaming, regardless of past verdicts", () => {
    render(
      <VerificationChip streaming={true} summary={{ status: "failed", passedChecks: 0, totalChecks: 5 }} />,
    );
    const chip = screen.getByTestId("verify-chip");
    expect(chip.dataset.status).toBe("verifying");
    expect(chip.textContent).toContain("Verifying");
  });

  it("shows declared-check counts on a pass, never the word 'correct'", () => {
    render(<VerificationChip streaming={false} summary={{ status: "passed", passedChecks: 5, totalChecks: 5 }} />);
    const chip = screen.getByTestId("verify-chip");
    expect(chip.dataset.status).toBe("passed");
    expect(chip.textContent).toContain("Verified");
    expect(chip.textContent).toContain("5/5");
    expect(chip.textContent?.toLowerCase()).not.toContain("correct");
  });

  it("shows a failed gate", () => {
    render(<VerificationChip streaming={false} summary={{ status: "failed", passedChecks: 3, totalChecks: 5 }} />);
    const chip = screen.getByTestId("verify-chip");
    expect(chip.dataset.status).toBe("failed");
    expect(chip.textContent).toContain("Gate failed");
  });

  it("shows an errored gate as unverified, not failed", () => {
    render(<VerificationChip streaming={false} summary={{ status: "error", passedChecks: 0, totalChecks: 0 }} />);
    const chip = screen.getByTestId("verify-chip");
    expect(chip.dataset.status).toBe("error");
    expect(chip.textContent).toContain("Unverified");
    expect(chip.textContent).not.toContain("failed");
  });
});
