import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import {
  buildConversationImageDiagnostics,
  sanitizeModelRequest,
  summarizeImageExposure,
} from "./imageContextDiagnostics";

describe("image context diagnostics", () => {
  it("captures exact image exposure without retaining image bytes or private request text", () => {
    const pixelPayload = Buffer.from("private pixels").toString("base64");
    const diagnostic = sanitizeModelRequest(7, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "private request with sk-secret and /home/example/private.step" },
            { type: "image", data: pixelPayload, mimeType: "image/png" },
          ],
        },
      ],
    });

    expect(diagnostic).toMatchObject({ sequence: 7, imageCount: 1, messageCount: 1 });
    expect(diagnostic.images[0]).toMatchObject({ mimeType: "image/png", byteSize: 14 });
    expect(diagnostic.images[0]?.hashPrefix).toMatch(/^[0-9a-f]{12}$/);
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain(pixelPayload);
    expect(serialized).not.toContain("private request");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("/home/example/");
  });

  it("parses batch structure without retaining private purposes or findings", () => {
    const diagnostic = sanitizeModelRequest(1, {
      messages: [{ role: "user", content: [{
        type: "text",
        text: "[Visual verification batch 2/3; artifact=artifact-2@4; sheet=sheet-2; imageLimit=3; activeSet=ref-a{purpose=sk-secret /home/example/private}; batchReferences=ref-a,ref-b; priorObservations=private finding sk-secret /home/example/private || another secret.]",
      }] }],
    });
    expect(diagnostic.structuredRecords).toEqual([{
      batchIndex: 2,
      batchCount: 3,
      artifactId: "artifact-2",
      artifactVersion: 4,
      inspectionSheetId: "sheet-2",
      imageLimit: 3,
      referenceIds: ["ref-a", "ref-b"],
      priorObservationCount: 2,
    }]);
    expect(JSON.stringify(diagnostic)).not.toMatch(/sk-secret|\/home\/example\/|private finding|another secret/);
  });

  it("reports representative long-session reduction without billing assumptions", () => {
    const image = (hashPrefix: string) => ({ hashPrefix, byteSize: 1, mimeType: "image/png" });
    const report = summarizeImageExposure([
      { sequence: 1, messageCount: 20, imageCount: 1, images: [image("a")], structuredRecords: [] },
      { sequence: 2, messageCount: 21, imageCount: 1, images: [image("b")], structuredRecords: [] },
      { sequence: 3, messageCount: 22, imageCount: 3, images: [image("a"), image("c"), image("d")], structuredRecords: [{ batchIndex: 1 } as never] },
      { sequence: 4, messageCount: 23, imageCount: 2, images: [image("a"), image("e")], structuredRecords: [{ batchIndex: 2 } as never] },
    ]);

    expect(report).toEqual({
      requestCount: 4,
      totalImageExposures: 7,
      peakImagesPerRequest: 3,
      routineRequestCount: 2,
      routineImageExposures: 2,
      explicitBatchRequestCount: 2,
      explicitBatchImageExposures: 5,
      uniqueObservedImages: 5,
      repeatedPixelsBaselineExposures: 12,
      avoidedImageExposures: 5,
    });
    expect(JSON.stringify(report)).not.toMatch(/token|cost|billing/i);
  });

  it("derives deterministic privacy-safe attachment lifecycle metadata", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'private title', 1, 1)").run();
    db.prepare("INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at) VALUES ('m1', 'c1', 0, 'user', ?, 1)")
      .run(JSON.stringify({ role: "user", content: [{ type: "text", text: "private request" }] }));
    db.prepare(`INSERT INTO attachments
      (id, message_id, kind, mime, content_hash, byte_size, blob_path, display_order)
      VALUES ('a1', 'm1', 'user-image', 'image/png', ?, 321, ?, 0)`)
      .run("0123456789abcdef".repeat(4), "images/01/absolute-content-is-private");
    db.prepare(`INSERT INTO reference_classifications
      (id, conversation_id, reference_id, status, purpose, relationships_json, rationale,
       specification_links_json, no_specification_reason, actor, created_at)
      VALUES ('rc1', 'c1', 'a1', 'active', 'private purpose', '[]', 'private rationale', '[]', NULL, 'agent', 2)`)
      .run();

    const first = buildConversationImageDiagnostics(db, "c1");
    const second = buildConversationImageDiagnostics(db, "c1");
    expect(second).toEqual(first);
    expect(first.attachments).toEqual([{
      attachmentId: "a1",
      kind: "user-image",
      mimeType: "image/png",
      hashPrefix: "0123456789ab",
      byteSize: 321,
      lifecycle: "active-reference",
      metadataComplete: true,
    }]);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("blob_path");
    expect(serialized).not.toContain("images/");
    expect(serialized).not.toContain("content_json");
  });

  it("keeps the last passing sheet current across a failed run, then finalizes it", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'title', 1, 1)").run();
    const insertMessage = db.prepare("INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at) VALUES (?, 'c1', ?, ?, ?, 1)");
    const result = (id: string, sheet: string, status: string, isError: boolean) => JSON.stringify({
      role: "toolResult", toolName: "run_build123d", toolCallId: id, isError,
      content: [{ type: "attachment-reference", attachmentId: sheet, kind: "view-sheet", mimeType: "image/png" }],
      details: { inspectionSheet: { attachmentId: sheet, gate: { status } } },
    });
    insertMessage.run("m1", 0, "toolResult", result("run-1", "sheet-pass", "passed", false));
    insertMessage.run("m2", 1, "toolResult", result("run-2", "sheet-fail", "failed", true));
    for (const [id, messageId] of [["sheet-pass", "m1"], ["sheet-fail", "m2"]] as const) {
      db.prepare(`INSERT INTO attachments
        (id, message_id, kind, mime, content_hash, byte_size, blob_path, display_order)
        VALUES (?, ?, 'view-sheet', 'image/png', ?, 1, ?, 0)`)
        .run(id, messageId, "a".repeat(64), `images/aa/${id}`);
    }
    expect(buildConversationImageDiagnostics(db, "c1").attachments.map((item) => [item.attachmentId, item.lifecycle]))
      .toEqual([["sheet-pass", "current-sheet"], ["sheet-fail", "historical-sheet"]]);

    insertMessage.run("m3", 2, "assistant", JSON.stringify({
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Finished" }],
    }));
    expect(buildConversationImageDiagnostics(db, "c1").attachments.map((item) => item.lifecycle))
      .toEqual(["historical-sheet", "historical-sheet"]);
  });
});
