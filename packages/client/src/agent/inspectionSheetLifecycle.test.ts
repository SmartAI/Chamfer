import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  INSPECTION_SHEET_STUB_TEXT,
  currentInspectionSheet,
  projectCurrentInspectionSheet,
  withInspectionSheetEvidence,
} from "./inspectionSheetLifecycle";

function sheet(id: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `run-${id}`,
    toolName: "run_build123d",
    content: [
      { type: "text", text: `Measurements run ${id}` },
      { type: "attachment-reference", attachmentId: `sheet-${id}`, kind: "view-sheet", mimeType: "image/png" },
    ],
    details: {
      measurements: { volumeMm3: id },
      gate: { status: "passed", checks: [] },
      code: { toolCallId: `run-${id}`, artifactId: `artifact-${id}`, artifactVersion: id },
    },
    isError: false,
    timestamp: id,
  } as unknown as AgentMessage;
}

function assistant(content: object[], stopReason: "toolUse" | "stop" = "toolUse"): AgentMessage {
  return { role: "assistant", content, stopReason, timestamp: 10 } as unknown as AgentMessage;
}

function failedRun(): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "failed",
    toolName: "run_build123d",
    content: [{ type: "text", text: "Traceback" }],
    isError: true,
    timestamp: 9,
  } as unknown as AgentMessage;
}

function references(message: AgentMessage): string[] {
  const content = (message as unknown as { content?: Array<{ type?: string; attachmentId?: string }> }).content ?? [];
  return content.filter((block) => block.type === "attachment-reference").map((block) => block.attachmentId ?? "");
}

describe("current inspection sheet projection", () => {
  it("retains current pixels for a visual-finalization recovery continuation but evicts them after success", () => {
    const current = sheet(2);
    const terminal = { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: 3 } as AgentMessage;
    const recovery = { role: "user", content: [{ type: "text", text: "[Chamfer visual check] Missing ref-a." }], timestamp: 4 } as AgentMessage;

    expect(currentInspectionSheet([current, terminal, recovery])).toBe(current);
    expect(currentInspectionSheet([current, terminal])).toBeUndefined();
  });
  it("replays one stable current sheet across intermediate tool and repair calls", () => {
    const current = sheet(1);
    const messages = [
      current,
      assistant([{ type: "toolCall", id: "docs", name: "lookup_docs", arguments: {} }]),
      { role: "toolResult", toolCallId: "docs", toolName: "lookup_docs", content: [{ type: "text", text: "docs" }] },
      assistant([{ type: "toolCall", id: "repair", name: "run_build123d", arguments: { code: "bad" } }]),
      failedRun(),
    ] as AgentMessage[];

    const first = projectCurrentInspectionSheet(messages);
    const second = projectCurrentInspectionSheet(messages);
    expect(first).toBe(messages);
    expect(second).toBe(messages);
    expect(references(first[0]!)).toEqual(["sheet-1"]);
  });

  it("replaces the prior sheet and leaves it as compact evidence", () => {
    const projected = projectCurrentInspectionSheet([sheet(1), sheet(2)]);

    expect(references(projected[0]!)).toEqual([]);
    expect(JSON.stringify(projected[0])).toContain(INSPECTION_SHEET_STUB_TEXT);
    expect(references(projected[1]!)).toEqual(["sheet-2"]);
  });

  it("preserves the current sheet when a newer CAD execution renders nothing", () => {
    const projected = projectCurrentInspectionSheet([sheet(1), failedRun()]);
    expect(references(projected[0]!)).toEqual(["sheet-1"]);
  });

  it("evicts current pixels after a terminal answer while retaining evidence", () => {
    const projected = projectCurrentInspectionSheet([
      sheet(1),
      assistant([{ type: "text", text: "Finished" }], "stop"),
      { role: "user", content: [{ type: "text", text: "new request" }], timestamp: 11 } as AgentMessage,
    ]);

    expect(references(projected[0]!)).toEqual([]);
    expect(JSON.stringify(projected[0])).toContain(INSPECTION_SHEET_STUB_TEXT);
  });

  it("keeps current pixels for Chamfer's internal finalization checks", () => {
    const projected = projectCurrentInspectionSheet([
      sheet(1),
      assistant([{ type: "text", text: "Finished" }], "stop"),
      {
        role: "user",
        content: [{ type: "text", text: "[Chamfer self-check] inspect all views" }],
        timestamp: 11,
      } as AgentMessage,
    ]);

    expect(references(projected[0]!)).toEqual(["sheet-1"]);
  });
});

describe("inspection sheet evidence", () => {
  it("links the attachment to code, measurements, and verification verdict", () => {
    const message = withInspectionSheetEvidence(sheet(1), "sheet-1");
    expect((message as unknown as { details: object }).details).toMatchObject({
      inspectionSheet: {
        attachmentId: "sheet-1",
        code: { toolCallId: "run-1", artifactId: "artifact-1", artifactVersion: 1 },
        measurements: { volumeMm3: 1 },
        gate: { status: "passed" },
      },
    });
  });
});
