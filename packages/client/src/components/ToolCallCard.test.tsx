import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolCallCard } from "./ToolCallCard";
import * as rest from "@/api/rest";

vi.mock("@/api/rest", () => ({
  downloadAttachment: vi.fn(),
  listAttachments: vi.fn(async () => []),
  attachmentUrl: (id: string) => `/api/attachments/${id}`,
}));

const call = {
  id: "tc-1",
  name: "run_build123d",
  arguments: { code: "result = Box(1, 1, 1)" },
};

describe("ToolCallCard status", () => {
  it("renders every ordered inspect_evidence reference regardless of attachment kind", async () => {
    vi.mocked(rest.downloadAttachment).mockImplementation(async (id) => ({
      type: "image",
      data: `pixels-${id}`,
      mimeType: "image/png",
    }));
    render(
      <ToolCallCard
        call={{ id: "inspect-1", name: "inspect_evidence", arguments: { evidenceIds: ["ref-1", "sheet-1"] } }}
        result={{
          content: [
            { type: "text", text: "Inspection opened" },
            { type: "attachment-reference", attachmentId: "ref-1", kind: "user-image", mimeType: "image/png" },
            { type: "attachment-reference", attachmentId: "sheet-1", kind: "view-sheet", mimeType: "image/png" },
          ],
          isError: false,
        }}
      />,
    );

    const images = await screen.findAllByTestId("inspection-evidence-image");
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "data:image/png;base64,pixels-ref-1",
      "data:image/png;base64,pixels-sheet-1",
    ]);
  });

  it("renders an explicit unavailable state for a missing inspected reference", async () => {
    vi.mocked(rest.downloadAttachment).mockRejectedValue(new Error("evidence ref-missing is missing"));
    render(
      <ToolCallCard
        call={{ id: "inspect-missing", name: "inspect_evidence", arguments: { evidenceIds: ["ref-missing"] } }}
        result={{
          content: [
            { type: "attachment-reference", attachmentId: "ref-missing", kind: "user-image", mimeType: "image/png" },
          ],
          isError: false,
        }}
      />,
    );

    expect(await screen.findByText("Attachment missing")).toBeTruthy();
  });

  it("keeps a long tool name on one truncated line while status remains nonshrinking", () => {
    render(
      <ToolCallCard
        call={{ id: "observe-1", name: "record_inspection_observation", arguments: {} }}
        result={{ content: [], isError: false }}
      />,
    );

    const label = screen.getByTitle("record_inspection_observation");
    expect(label.className).toContain("truncate");
    expect(label.className).toContain("whitespace-nowrap");
    expect(screen.getByText("Complete").className).toContain("shrink-0");
  });

  it("renders a reloaded inspection-sheet reference through attachment retrieval", async () => {
    vi.mocked(rest.downloadAttachment).mockResolvedValue({ type: "image", data: "sheet", mimeType: "image/png" });
    render(
      <ToolCallCard
        call={call}
        result={{
          content: [
            { type: "text", text: "Measurements: {}" },
            { type: "attachment-reference", attachmentId: "sheet-1", kind: "view-sheet", mimeType: "image/png" },
          ],
          isError: false,
        }}
      />,
    );

    expect((await screen.findByTestId("view-sheet-image")).getAttribute("src")).toBe(
      "data:image/png;base64,sheet",
    );
  });

  it("shows Running while there is no result yet", () => {
    render(<ToolCallCard call={call} />);

    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText("Complete")).toBeNull();
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("shows Failed when generation ended before the tool produced a result", () => {
    render(<ToolCallCard call={call} interrupted />);

    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
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

describe("ToolCallCard CAD code visibility", () => {
  it("hides the code body by default but keeps the label and actions", () => {
    render(<ToolCallCard call={call} />);

    expect(screen.queryByText("result = Box(1, 1, 1)")).toBeNull();
    expect(screen.getByText("CAD code")).toBeTruthy();
    expect(screen.getByText("Copy")).toBeTruthy();
    expect(screen.getByText("Render 3D")).toBeTruthy();
  });

  it("shows the code body when showCadCode is set", () => {
    render(<ToolCallCard call={call} showCadCode />);

    expect(screen.getByText("result = Box(1, 1, 1)")).toBeTruthy();
    expect(screen.getByText("CAD code")).toBeTruthy();
  });

  it("renders no code row at all for a call without code", () => {
    render(<ToolCallCard call={{ id: "tc-2", name: "lookup_docs", arguments: { query: "hole" } }} />);

    expect(screen.queryByText("CAD code")).toBeNull();
  });
});
