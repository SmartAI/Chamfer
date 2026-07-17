import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  applySheetStubs,
  compactionBoundary,
  isCompactionMessage,
  isSheetResult,
  SHEET_STUB_TEXT,
  skillReinjectionMessage,
  transformLlmContext,
  type CompactionMessage,
} from "./contextPolicy";

function renderedCadDetails(id: number): object {
  return {
    code: {
      toolCallId: `call-${id}`,
      artifactId: `artifact-${id}`,
      artifactVersion: id,
    },
    measurements: {
      bboxMm: [id + 1, id + 2, id + 3],
      volumeMm3: id + 4,
      areaMm2: id + 5,
      children: [],
    },
  };
}

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
    details: renderedCadDetails(id),
    timestamp: id,
  } as unknown as AgentMessage;
}

function referencedSheet(id: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${id}`,
    toolName: "run_build123d",
    content: [
      { type: "text", text: `Measurements: {} run ${id}` },
      {
        type: "attachment-reference",
        attachmentId: `sheet-${id}`,
        kind: "view-sheet",
        mimeType: "image/png",
      },
    ],
    isError: false,
    details: renderedCadDetails(id),
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
  it("keeps only the newest successful inspection sheet pixel-bearing", () => {
    const messages = Array.from({ length: 3 }, (_, i) => sheet(i));
    const result = applySheetStubs(messages);
    expect(stubCount(result)).toBe(2);
    expect(imageOf(result[2])).toBe("png-2");
    const first = result[0] as { content: { type: string; text?: string }[] };
    expect(first.content[0]?.text).toContain("Measurements");
    expect(first.content.some((b) => b.type === "image")).toBe(false);
  });

  it("is byte-stable for an unchanged transcript", () => {
    const messages = Array.from({ length: 9 }, (_, i) => sheet(i));
    expect(JSON.stringify(applySheetStubs(messages))).toBe(JSON.stringify(applySheetStubs(messages)));
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
    expect(stubCount(result)).toBe(11);
  });

  it("stubs durable view-sheet references before model materialization", () => {
    const messages = Array.from({ length: 9 }, (_, index) => referencedSheet(index));
    const result = applySheetStubs(messages);

    expect(stubCount(result)).toBe(8);
    expect((result[0] as unknown as { content: Array<{ type: string }> }).content).not.toContainEqual(
      expect.objectContaining({ type: "attachment-reference" }),
    );
    expect((result[8] as unknown as { content: Array<{ attachmentId?: string }> }).content).toContainEqual(
      expect.objectContaining({ attachmentId: "sheet-8" }),
    );
  });
});

describe("failed tool results", () => {
  it("sends only text content to the LLM without rewriting the persisted result", () => {
    const failedSheet = { ...sheet(1), isError: true } as AgentMessage;

    const context = transformLlmContext([failedSheet]);
    const visible = context[0] as { content: Array<{ type: string }> };

    expect(visible.content.every((block) => block.type === "text")).toBe(true);
    expect(imageOf(failedSheet)).toBe("png-1");
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

  it("pins an active current sheet across compaction without duplicating a visible sheet", () => {
    const current = referencedSheet(7);
    const intermediate = {
      role: "assistant",
      content: [{ type: "toolCall", id: "docs-1", name: "lookup_docs", arguments: { query: "fillet" } }],
      stopReason: "toolUse",
      timestamp: 8,
    } as unknown as AgentMessage;
    const compactedAway = [
      user("build the part"),
      current,
      intermediate,
      { ...row, keptTail: 1 } as unknown as AgentMessage,
      user("continue the repair"),
    ];

    const pinned = transformLlmContext(compactedAway);
    expect(pinned[1]).toBe(current);
    expect(pinned.filter((message) => message === current)).toHaveLength(1);
    expect(JSON.stringify(pinned)).toContain("sheet-7");
    expect(JSON.stringify(transformLlmContext(compactedAway))).toBe(JSON.stringify(pinned));

    const alreadyVisible = [
      user("build the part"),
      current,
      intermediate,
      { ...row, keptTail: 2 } as unknown as AgentMessage,
      user("continue the repair"),
    ];
    const unpinned = transformLlmContext(alreadyVisible);
    expect(unpinned.filter((message) => message === current)).toHaveLength(1);

    const finalized = [
      user("build the part"),
      current,
      assistant("Finished"),
      { ...row, keptTail: 1 } as unknown as AgentMessage,
      user("start a new request"),
    ];
    expect(JSON.stringify(transformLlmContext(finalized))).not.toContain("sheet-7");
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

describe("skill pinning across compaction", () => {
  function skillLoad(details: object): AgentMessage {
    return {
      role: "toolResult",
      toolCallId: "skill-1",
      toolName: "load_skill",
      content: [{ type: "text", text: "payload" }],
      isError: false,
      details,
      timestamp: 0,
    } as unknown as AgentMessage;
  }

  const row: CompactionMessage = {
    role: "compaction",
    summary: "summary",
    keptTail: 1,
    tokensBefore: 90_000,
    timestamp: 42,
  };

  it("re-injects compacted-away skill loads right after the summary, deduped, with stable bytes", () => {
    const messages = [
      user("build a handle"),
      skillLoad({ skill: "sweep-and-loft", loaded: true }),
      skillLoad({ skill: "sweep-and-loft", deduped: true, loaded: true }),
      skillLoad({ skill: "sweep-and-loft", resource: "snippets/sweep_diagnose.py", loaded: true }),
      user("keep going"),
      row as unknown as AgentMessage,
      user("newest"),
    ];

    const context = transformLlmContext(messages);
    const reinjected = context[1] as { role: string; content: { text: string }[] };
    expect(reinjected.role).toBe("user");
    const text = reinjected.content[0]?.text ?? "";
    expect(text).toContain("loaded earlier in this conversation");
    // The body once (dedupe collapsed the notice) plus the one loaded resource.
    expect(text.match(/<skill name="sweep-and-loft"/g)).toHaveLength(1);
    expect(text.match(/<skill-resource skill="sweep-and-loft" path="snippets\/sweep_diagnose\.py"/g)).toHaveLength(1);
    // The kept tail follows unchanged after the re-injection.
    expect(context[2]).toBe(messages[4]);
    expect(context[3]).toBe(messages[6]);

    expect(JSON.stringify(transformLlmContext(messages))).toBe(JSON.stringify(transformLlmContext(messages)));
  });

  it("re-injects nothing when loads are inside the visible window or absent", () => {
    const inWindow = [
      user("old"),
      user("recent"),
      skillLoad({ skill: "sweep-and-loft", loaded: true }),
      { ...row, keptTail: 2 } as unknown as AgentMessage,
    ];
    // keptTail keeps the load visible; a duplicate would double the payload.
    const context = transformLlmContext(inWindow);
    expect(JSON.stringify(context).match(/sweep-and-loft/g)?.length).toBe(1);

    expect(skillReinjectionMessage([user("no loads")], 1, 0)).toBeUndefined();
    // Unknown skills (renamed between releases) are skipped, not fabricated.
    expect(skillReinjectionMessage([skillLoad({ skill: "gone", loaded: true })], 1, 0)).toBeUndefined();
  });
});
