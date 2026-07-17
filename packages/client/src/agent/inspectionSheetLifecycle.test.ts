import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  INSPECTION_SHEET_STUB_TEXT,
  currentInspectionSheet,
  isInspectionSheetResult,
  isRenderedCadResult,
  projectCurrentInspectionSheet,
  projectStaleFusionInspectionText,
  stubStaleFusionInspectionText,
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
      measurements: { bboxMm: [id, id, id], volumeMm3: id, areaMm2: id, children: [] },
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

function nonconformingSheet(id: number): AgentMessage {
  return {
    ...sheet(id),
    content: [
      { type: "text", text: "Plan conformance: FAILED\n- planned check is missing" },
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ],
    isError: true,
  } as AgentMessage;
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
  it("recognizes a complete rendered CAD result independently from proof eligibility", () => {
    const conforming = sheet(1);
    const nonconforming = nonconformingSheet(2);

    expect(isRenderedCadResult(conforming)).toBe(true);
    expect(isRenderedCadResult(nonconforming)).toBe(true);
    expect(isInspectionSheetResult(conforming)).toBe(true);
    expect(isInspectionSheetResult(nonconforming)).toBe(false);
    expect(isRenderedCadResult(failedRun())).toBe(false);
    expect(isRenderedCadResult({ ...nonconforming, details: { measurements: { volumeMm3: 2 } } })).toBe(false);
    const measurements = { bboxMm: [2, 2, 2], volumeMm3: 2, areaMm2: 2, children: [] };
    const code = { toolCallId: "run-2", artifactId: "artifact-2", artifactVersion: 2 };
    expect(isRenderedCadResult({ ...nonconforming, details: { code: {}, measurements } })).toBe(false);
    expect(isRenderedCadResult({
      ...nonconforming,
      details: { code, measurements: { volumeMm3: 2 } },
    })).toBe(false);
  });

  it("links the attachment to code, measurements, and verification verdict", () => {
    const message = withInspectionSheetEvidence(sheet(1), "sheet-1");
    expect((message as unknown as { details: object }).details).toMatchObject({
      inspectionSheet: {
        attachmentId: "sheet-1",
        code: { toolCallId: "run-1", artifactId: "artifact-1", artifactVersion: 1 },
        measurements: { bboxMm: [1, 1, 1], volumeMm3: 1, areaMm2: 1, children: [] },
        gate: { status: "passed" },
      },
    });
  });

  it("links a Fusion inspection sheet to its revision-bound visual artifact", () => {
    const message = {
      role: "toolResult",
      toolCallId: "fusion-run-1",
      toolName: "run_fusion_action",
      content: [{ type: "image", data: "png", mimeType: "image/png" }],
      details: {
        status: "completed",
        visualArtifact: { artifactId: "inspection-1", artifactVersion: 1, revision: "revision-1", inspectionSheet: {} },
      },
      isError: false,
    } as unknown as AgentMessage;

    expect((withInspectionSheetEvidence(message, "fusion-sheet-1") as unknown as { details: object }).details).toMatchObject({
      visualArtifact: {
        artifactId: "inspection-1",
        artifactVersion: 1,
        revision: "revision-1",
        inspectionSheet: { attachmentId: "fusion-sheet-1" },
      },
    });
  });
  it("links rendered diagnostic evidence without making it the current proof sheet", () => {
    const message = withInspectionSheetEvidence(nonconformingSheet(2), "sheet-2");

    expect((message as unknown as { details: object }).details).toMatchObject({
      inspectionSheet: {
        attachmentId: "sheet-2",
        code: { toolCallId: "run-2", artifactId: "artifact-2", artifactVersion: 2 },
        measurements: { bboxMm: [2, 2, 2], volumeMm3: 2, areaMm2: 2, children: [] },
        gate: { status: "passed" },
      },
    });
    expect(currentInspectionSheet([message])).toBeUndefined();
  });
});

describe("stale fusion inspection text projection", () => {
  function fusionInspection(id: number, options: { failed?: boolean; isError?: boolean } = {}): AgentMessage {
    const checks = [
      { kind: "body-count", status: "passed", detail: "Found exactly 1 solid body." },
      { kind: "volume", status: options.failed ? "failed" : "passed", detail: "Measured 1450078 mm³; required range 1300000-1900000 mm³." },
    ];
    return {
      role: "toolResult",
      toolCallId: `inspect-${id}`,
      toolName: "inspect_fusion",
      content: [
        {
          type: "text",
          text: [
            "# Bound Fusion inspection",
            "Document: Untitled (doc-1)",
            `Revision: revision-${id}`,
            `Snapshot: ${JSON.stringify({ parameters: Array.from({ length: 50 }, (_, i) => ({ name: `d${i}`, valueMm: i })) })}`,
            `Checks: ${JSON.stringify(checks)}`,
          ].join("\n"),
        },
      ],
      details: { mutated: false, revision: `revision-${id}`, inspectionId: `inspection-${id}`, viewSheet: false },
      isError: options.isError ?? false,
      timestamp: id,
    } as unknown as AgentMessage;
  }

  function textOf(message: AgentMessage | undefined): string {
    const content = (message as unknown as { content: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
    return content.find((block) => block.type === "text")?.text ?? "";
  }

  it("keeps only the newest successful inspection's snapshot verbatim", () => {
    const messages = [fusionInspection(1), fusionInspection(2, { failed: true }), fusionInspection(3)];
    const projected = projectStaleFusionInspectionText(messages);

    expect(textOf(projected[0])).not.toContain("Snapshot: {");
    expect(textOf(projected[0])).toContain("Revision: revision-1");
    expect(textOf(projected[0])).toContain("2 checks passed, 0 failed");
    expect(textOf(projected[1])).toContain("1 checks passed, 1 failed: volume (Measured 1450078 mm³; required range 1300000-1900000 mm³.)");
    expect(textOf(projected[2])).toBe(textOf(messages[2]));
    // The durable transcript is untouched.
    expect(textOf(messages[0])).toContain("Snapshot: {");
  });

  it("does not treat failed inspections as superseding evidence", () => {
    const messages = [fusionInspection(1), fusionInspection(2, { isError: true })];
    const projected = projectStaleFusionInspectionText(messages);

    expect(textOf(projected[0])).toContain("Snapshot: {");
    expect(textOf(projected[1])).toBe(textOf(messages[1]));
  });

  it("leaves non-inspection messages and unrecognized text untouched", () => {
    const messages = [fusionInspection(1), sheet(2), fusionInspection(3)];
    const projected = projectStaleFusionInspectionText(messages);

    expect(projected[1]).toBe(messages[1]);
    expect(stubStaleFusionInspectionText("plain tool output")).toBe("plain tool output");
  });
});
