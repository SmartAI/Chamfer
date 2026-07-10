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

  it("renders a passed verify-gate row", () => {
    render(
      <ToolCallCard
        call={call}
        result={{
          content: [],
          isError: false,
          details: {
            gate: { status: "passed", checks: [{ name: "valid", passed: true, detail: "B-rep validity" }] },
          },
        }}
      />,
    );

    expect(screen.getByTestId("tool-gate").textContent).toContain("passed");
  });

  it("lists failing checks on a failed verify gate", () => {
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
    expect(gate.textContent).toContain("failed");
    expect(gate.textContent).toContain("bodies: expected 1, found 2");
    expect(gate.textContent).not.toContain("B-rep validity");
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
