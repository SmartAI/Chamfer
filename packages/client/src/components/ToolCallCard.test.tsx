import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCallCard } from "./ToolCallCard";

const call = {
  id: "tc-1",
  name: "run_build123d",
  arguments: { code: "result = Box(1, 1, 1)" },
};

describe("ToolCallCard status", () => {
  it("shows Running while there is no result yet", () => {
    render(<ToolCallCard call={call} />);

    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText("Complete")).toBeNull();
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("shows Complete for a successful result", () => {
    render(
      <ToolCallCard
        call={call}
        result={{ content: [{ type: "text", text: "Measurements: {}" }], isError: false }}
      />,
    );

    expect(screen.getByText("Complete")).toBeTruthy();
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("renders a passed verification receipt with every check and its diagnostic", () => {
    render(
      <ToolCallCard
        call={call}
        result={{
          content: [],
          isError: false,
          details: {
            gate: {
              status: "passed",
              checks: [
                { name: "valid", passed: true, detail: "B-rep validity" },
                { name: "bbox", passed: true, detail: "expected [10, 20, 30] ±0.5, measured [10, 20, 30]" },
              ],
            },
          },
        }}
      />,
    );

    const gate = screen.getByTestId("tool-gate");
    expect(gate.dataset.status).toBe("passed");
    // Showing the work: passing checks are listed too, with their diagnostics.
    expect(gate.textContent).toContain("valid");
    expect(gate.textContent).toContain("B-rep validity");
    expect(gate.textContent).toContain("measured [10, 20, 30]");
    expect(gate.textContent).toContain("GATE PASSED");
    expect(gate.textContent).toContain("2 checks");
    expect(gate.textContent?.toLowerCase()).not.toContain("correct");
  });

  it("renders a failed receipt with the fail tally and all checks visible", () => {
    render(
      <ToolCallCard
        call={call}
        result={{
          content: [],
          isError: false,
          details: {
            gate: {
              status: "failed",
              checks: [
                { name: "valid", passed: true, detail: "B-rep validity" },
                { name: "bodies", passed: false, detail: "bodies: expected 1, found 2" },
              ],
            },
          },
        }}
      />,
    );

    const gate = screen.getByTestId("tool-gate");
    expect(gate.dataset.status).toBe("failed");
    expect(gate.textContent).toContain("bodies: expected 1, found 2");
    expect(gate.textContent).toContain("B-rep validity");
    expect(gate.textContent).toContain("GATE FAILED — 1 of 2 checks failed");
  });

  it("renders an errored gate as unavailable with the evaluator detail", () => {
    render(
      <ToolCallCard
        call={call}
        result={{
          content: [],
          isError: false,
          details: {
            gate: {
              status: "error",
              checks: [{ name: "gate", passed: false, detail: "gate evaluator failed: boom" }],
            },
          },
        }}
      />,
    );

    const gate = screen.getByTestId("tool-gate");
    expect(gate.dataset.status).toBe("error");
    expect(gate.textContent).toContain("Verification unavailable");
    expect(gate.textContent).toContain("boom");
  });

  it("omits the gate row when the result carries no gate", () => {
    render(
      <ToolCallCard
        call={call}
        result={{ content: [{ type: "text", text: "Measurements: {}" }], isError: false }}
      />,
    );

    expect(screen.queryByTestId("tool-gate")).toBeNull();
  });

  it("shows Failed plus the error text when the result is an error", () => {
    render(
      <ToolCallCard
        call={call}
        result={{ content: [{ type: "text", text: "Traceback: boom" }], isError: true }}
      />,
    );

    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("Complete")).toBeNull();
    expect(screen.getByText("Traceback: boom")).toBeTruthy();
  });
});
