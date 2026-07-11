import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  applySheetStubs,
  compactionBoundary,
  isCompactionMessage,
  isSheetResult,
  SHEET_STUB_TEXT,
  transformLlmContext,
  type CompactionMessage,
} from "./contextPolicy";

function sheet(id: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${id}`,
    toolName: "run_build123d",
    content: [
      { type: "text", text: `Measurements: {} run ${id}` },
      { type: "image", data: `png-${id}`, mimeType: "image/png" },
    ],
    isError: false,
    timestamp: id,
  } as unknown as AgentMessage;
}

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

function imageOf(message: unknown): string | undefined {
  const content = (message as { content: { type: string; data?: string }[] }).content;
  return content.find((b) => b.type === "image")?.data;
}

function stubCount(messages: AgentMessage[]): number {
  return messages.filter(
    (m) =>
      (m as { content?: { type?: string; text?: string }[] }).content?.some?.(
        (b) => b.type === "text" && b.text === SHEET_STUB_TEXT,
      ) ?? false,
  ).length;
}

describe("applySheetStubs", () => {
  it("keeps everything untouched at or below the threshold", () => {
    const messages = [user("go"), ...Array.from({ length: 8 }, (_, i) => sheet(i))];
    expect(applySheetStubs(messages)).toBe(messages);
  });

  it("stubs down to the newest keep-count in one batch when the threshold trips", () => {
    const messages = Array.from({ length: 9 }, (_, i) => sheet(i));
    const result = applySheetStubs(messages);
    expect(stubCount(result)).toBe(6);
    // Newest three sheets keep their images.
    expect(imageOf(result[6])).toBe("png-6");
    expect(imageOf(result[7])).toBe("png-7");
    expect(imageOf(result[8])).toBe("png-8");
    // Stubbed results keep their text content (measurements + gate verdict).
    const first = result[0] as { content: { type: string; text?: string }[] };
    expect(first.content[0]?.text).toContain("Measurements");
    expect(first.content.some((b) => b.type === "image")).toBe(false);
  });

  it("is sticky: decisions about a prefix never change as sheets append (batched cache breaks)", () => {
    const nine = Array.from({ length: 9 }, (_, i) => sheet(i));
    const after9 = applySheetStubs(nine);
    // Sheets 10..14 leave 4..8 live sheets (under the threshold); the second batch
    // fires at sheet 15, when the live count reaches 9 again.
    for (let n = 10; n <= 15; n += 1) {
      const messages = Array.from({ length: n }, (_, i) => sheet(i));
      const result = applySheetStubs(messages);
      if (n < 15) {
        // No new batch yet: the transformed prefix is identical to the 9-sheet run.
        for (let i = 0; i < 9; i += 1) {
          expect(JSON.stringify(result[i])).toBe(JSON.stringify(after9[i]));
        }
        expect(stubCount(result)).toBe(6);
      } else {
        // Second batch: everything but the newest three is stubbed.
        expect(stubCount(result)).toBe(12);
        expect(imageOf(result[14])).toBe("png-14");
      }
    }
  });

  it("never touches user-uploaded images", () => {
    const reference = {
      role: "user",
      content: [
        { type: "text", text: "match this part" },
        { type: "image", data: "user-photo", mimeType: "image/jpeg" },
      ],
      timestamp: 0,
    } as unknown as AgentMessage;
    const messages = [reference, ...Array.from({ length: 12 }, (_, i) => sheet(i))];
    const result = applySheetStubs(messages);
    expect(imageOf(result[0])).toBe("user-photo");
    expect(stubCount(result)).toBeGreaterThan(0);
  });
});

describe("compaction boundary", () => {
  const row: CompactionMessage = {
    role: "compaction",
    summary: "User wants an 80x60x30mm housing; steps 1-2 gate-passed.",
    keptTail: 2,
    tokensBefore: 90_000,
    timestamp: 42,
  };

  it("recognizes compaction rows", () => {
    expect(isCompactionMessage(row)).toBe(true);
    expect(isCompactionMessage(user("hi"))).toBe(false);
    expect(isSheetResult(sheet(1))).toBe(true);
  });

  it("windows the LLM context to summary + kept tail + everything after the row", () => {
    const messages = [
      user("old request"),
      assistant("old reply"),
      user("recent request"),
      assistant("recent reply"),
      row as unknown as AgentMessage,
      user("new message"),
    ];
    expect(compactionBoundary(messages)).toMatchObject({ index: 4, visibleStart: 2 });

    const context = transformLlmContext(messages);
    expect(context).toHaveLength(4);
    const first = context[0] as { role: string; content: { text: string }[] };
    expect(first.role).toBe("user");
    expect(first.content[0]?.text).toContain("80x60x30mm housing");
    expect(first.content[0]?.text).toContain("Summary of earlier work");
    expect(context[1]).toBe(messages[2]);
    expect(context[2]).toBe(messages[3]);
    expect(context[3]).toBe(messages[5]);
  });

  it("uses only the newest row and drops older rows from the context", () => {
    const older: CompactionMessage = { ...row, summary: "older summary", keptTail: 0, timestamp: 1 };
    const messages = [
      user("ancient"),
      older as unknown as AgentMessage,
      user("mid"),
      { ...row, keptTail: 1 } as unknown as AgentMessage,
      user("new"),
    ];
    const context = transformLlmContext(messages);
    expect(context.map((m) => (m as { role: string }).role)).toEqual(["user", "user", "user"]);
    expect(context.some((m) => isCompactionMessage(m))).toBe(false);
    expect(context[1]).toBe(messages[2]);
    expect(context[2]).toBe(messages[4]);
  });

  it("is byte-stable across calls for the same transcript (prompt-cache safety)", () => {
    const messages = [user("a"), row as unknown as AgentMessage, ...Array.from({ length: 10 }, (_, i) => sheet(i))];
    expect(JSON.stringify(transformLlmContext(messages))).toBe(JSON.stringify(transformLlmContext(messages)));
  });

  it("passes malformed shapes through untouched instead of throwing", () => {
    const malformed = [{ role: "toolResult", toolName: "run_build123d", content: null }] as unknown as AgentMessage[];
    const result = transformLlmContext(malformed);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(malformed[0]);
  });
});
