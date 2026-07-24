import { expect, it } from "vitest";
import type { ConversationDto, EvidenceProjection } from "@chamfer/shared";
import { createApp } from "../app";
import { openDb } from "../db";

it("serves every evidence kind through one conversation ledger route", async () => {
  const db = openDb(":memory:");
  const app = createApp(db);
  const conversation = await (await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Ledger route", cadEnvironment: "build123d" }),
  })).json() as ConversationDto;

  const append = await app.request(`/api/conversations/${conversation.id}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "record-plan",
      event: {
        id: "plan-event",
        type: "plan.recorded",
        data: { operation: "created", plan: { id: "plan-1", revision: 1 } },
      },
    }),
  });
  expect(append.status).toBe(200);
  expect(await append.json()).toMatchObject({ result: { sequence: 1, type: "plan.recorded" } });

  db.prepare("INSERT INTO artifacts (id, conversation_id, version, py_source, created_at) VALUES (?, ?, 1, 'result = Box(1, 1, 1)', 1)")
    .run("artifact-1", conversation.id);

  const verification = await app.request(`/api/conversations/${conversation.id}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "record-environment-verification",
      event: {
        id: "environment-verification-1",
        type: "environment-verification.recorded",
        data: {
          environment: "build123d",
          scope: "design",
          candidateId: "artifact-1:1",
          status: "passed",
          artifact: { id: "artifact-1", version: 1 },
          measurements: { bodyCount: 1, boundingBoxMm: [10, 20, 30], volumeMm3: 6000 },
          views: ["isometric", "front"],
          checks: [{ name: "bbox", status: "passed", detail: "matched" }],
        },
      },
    }),
  });
  expect(verification.status).toBe(200);
  expect(await verification.json()).toMatchObject({
    result: { sequence: 2, type: "environment-verification.recorded" },
  });

  const projection = await (await app.request(
    `/api/conversations/${conversation.id}/evidence`,
  )).json() as EvidenceProjection;
  expect(projection.activePlan).toEqual({ id: "plan-1", revision: 1 });
  expect(projection.events).toHaveLength(2);
  expect(projection.environmentVerifications).toEqual([
    expect.objectContaining({ environment: "build123d", status: "passed" }),
  ]);

  const missing = await app.request("/api/conversations/missing/evidence");
  expect(missing.status).toBe(404);
});

it("rejects unknown evidence command types without appending", async () => {
  const app = createApp(openDb(":memory:"));
  const conversation = await (await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Ledger route", cadEnvironment: "build123d" }),
  })).json() as ConversationDto;

  const response = await app.request(`/api/conversations/${conversation.id}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "not-an-evidence-command" }),
  });
  expect(response.status).toBe(400);
  const projection = await (await app.request(
    `/api/conversations/${conversation.id}/evidence`,
  )).json() as EvidenceProjection;
  expect(projection.events).toEqual([]);
});

it("rejects raw evidence events so callers cannot bypass command validation", async () => {
  const app = createApp(openDb(":memory:"));
  const conversation = await (await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Ledger route", cadEnvironment: "build123d" }),
  })).json() as ConversationDto;

  const response = await app.request(`/api/conversations/${conversation.id}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "raw-proof-report",
      type: "proof-report.recorded",
      data: { report: {} },
    }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "a valid evidence command is required" });
  const projection = await (await app.request(
    `/api/conversations/${conversation.id}/evidence`,
  )).json() as EvidenceProjection;
  expect(projection.events).toEqual([]);
});

it("rolls back command state when its ledger append fails", async () => {
  const db = openDb(":memory:");
  const app = createApp(db);
  const conversation = await (await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Ledger route", cadEnvironment: "build123d" }),
  })).json() as ConversationDto;
  await app.request(`/api/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "source-message",
      seq: 0,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: "Width is 20 mm.", timestamp: 1 }),
    }),
  });
  db.exec(`CREATE TRIGGER reject_fixture_evidence
    BEFORE INSERT ON evidence_events
    BEGIN SELECT RAISE(ABORT, 'fixture append failure'); END`);

  const response = await app.request(`/api/conversations/${conversation.id}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "record-source-specifications",
      idempotencyKey: "source-command",
      input: { specifications: [{
        id: "width",
        requirement: "Width is 20 mm.",
        source: { messageId: "source-message", text: "Width is 20 mm.", start: 0, end: 15 },
      }] },
    }),
  });

  expect(response.status).toBe(400);
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_specifications'").get()).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_events").get()).toEqual({ count: 0 });
});
