import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationDto, FusionReadinessDto } from "@chamfer/shared";
import { createApp } from "../app";
import { openDb } from "../db";
import { appendFusionRecovery } from "../fusion/recoveryStore";

const endpoint = "http://127.0.0.1:27182/mcp";
const tempDirs: string[] = [];

function inspected(document?: { id: string; name: string; dataFileId?: string }): FusionReadinessDto {
  return {
    state: document ? "ready" : "no-document",
    label: document ? "Ready" : "No document",
    diagnosis: document ? "Fusion is ready." : "Open a Fusion design to continue.",
    endpoint,
    checkedAt: "2026-07-14T12:00:00.000Z",
    document,
    mutationAllowed: false,
  };
}

async function createFusionConversation(app: ReturnType<typeof createApp>, title: string) {
  const response = await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, cadEnvironment: "fusion" }),
  });
  return await response.json() as ConversationDto;
}

async function bind(app: ReturnType<typeof createApp>, conversationId: string) {
  return app.request(`/api/conversations/${conversationId}/fusion-binding`, { method: "POST" });
}

function persistentApp(current: ReturnType<typeof vi.fn>, path?: string) {
  const dataDir = path ?? mkdtempSync(join(tmpdir(), "chamfer-fusion-owner-"));
  if (!path) tempDirs.push(dataDir);
  const db = openDb(join(dataDir, "chamfer.db"));
  return { app: createApp(db, undefined, { dataDir, fusionReadiness: { current } }), db, dataDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Fusion document ownership routes", () => {
  it("persists an unsaved document's creation identity across a server reload", async () => {
    const current = vi.fn().mockResolvedValue(inspected({ id: "creation-1", name: "Unsaved" }));
    const first = persistentApp(current);
    const conversation = await createFusionConversation(first.app, "Owner");

    const response = await bind(first.app, conversation.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversationId: conversation.id,
      role: "owner",
      identityKind: "provisional",
      resumable: true,
      document: { id: "creation-1", name: "Unsaved" },
    });
    first.db.close();

    const reloaded = persistentApp(current, first.dataDir);
    const got = await reloaded.app.request(`/api/fusion/readiness?conversationId=${conversation.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      state: "ready",
      binding: { role: "owner", document: { id: "creation-1" } },
    });
    reloaded.db.close();
  });

  it("upgrades a provisional binding to durable data identity without rebinding", async () => {
    const current = vi.fn()
      .mockResolvedValueOnce(inspected({ id: "creation-1", name: "Unsaved" }))
      .mockResolvedValue(inspected({ id: "creation-1", name: "Saved", dataFileId: "data-1" }));
    const { app } = persistentApp(current);
    const conversation = await createFusionConversation(app, "Owner");
    await bind(app, conversation.id);

    const readiness = await app.request(`/api/fusion/readiness?conversationId=${conversation.id}`);
    expect(await readiness.json()).toMatchObject({
      state: "ready",
      binding: {
        role: "owner",
        identityKind: "durable",
        document: { id: "creation-1", dataFileId: "data-1", name: "Saved" },
      },
    });
  });

  it("keeps a competing conversation read-only until explicit freshly inspected transfer", async () => {
    const current = vi.fn().mockResolvedValue(inspected({ id: "creation-1", name: "Part", dataFileId: "data-1" }));
    const { app } = persistentApp(current);
    const owner = await createFusionConversation(app, "Owner");
    const receiver = await createFusionConversation(app, "Receiver");

    expect((await bind(app, owner.id)).status).toBe(200);
    const second = await bind(app, receiver.id);
    expect(await second.json()).toMatchObject({ role: "read-only", resumable: true });
    expect(await (await app.request(`/api/fusion/readiness?conversationId=${receiver.id}`)).json())
      .toMatchObject({ state: "read-only", binding: { role: "read-only" } });

    const transfer = await app.request(`/api/conversations/${receiver.id}/fusion-ownership`, { method: "POST" });
    expect(transfer.status).toBe(200);
    expect(await transfer.json()).toMatchObject({ role: "owner" });
    // The transfer performs its own inspection; it never trusts the receiver's
    // earlier read-only snapshot.
    expect(current).toHaveBeenCalledTimes(4);

    expect(await (await app.request(`/api/fusion/readiness?conversationId=${owner.id}`)).json())
      .toMatchObject({ state: "read-only", binding: { role: "read-only" } });
  });

  it("rechecks the endpoint lease after fresh readiness before transferring ownership", async () => {
    const document = { id: "creation-1", name: "Part", dataFileId: "data-1" };
    let leaseActive = false;
    const current = vi.fn().mockImplementation(async () => inspected(document));
    const dataDir = mkdtempSync(join(tmpdir(), "chamfer-fusion-owner-"));
    tempDirs.push(dataDir);
    const db = openDb(join(dataDir, "chamfer.db"));
    const readiness = { current, mutationInProgress: vi.fn(() => leaseActive) };
    const app = createApp(db, undefined, { dataDir, fusionReadiness: readiness });
    const owner = await createFusionConversation(app, "Owner");
    const receiver = await createFusionConversation(app, "Receiver");
    await bind(app, owner.id);
    await bind(app, receiver.id);
    current.mockImplementationOnce(async () => {
      leaseActive = true;
      return inspected(document);
    });

    const transfer = await app.request(`/api/conversations/${receiver.id}/fusion-ownership`, { method: "POST" });

    expect(transfer.status).toBe(409);
    expect(await transfer.json()).toEqual({ error: "Fusion ownership cannot transfer while an action lease is unresolved." });
  });

  it("detects another active tab locally and refuses transfer", async () => {
    const current = vi.fn()
      .mockResolvedValueOnce(inspected({ id: "creation-1", name: "Managed", dataFileId: "data-1" }))
      .mockResolvedValue(inspected({ id: "creation-2", name: "Other", dataFileId: "data-2" }));
    const { app } = persistentApp(current);
    const owner = await createFusionConversation(app, "Owner");
    const receiver = await createFusionConversation(app, "Receiver");
    await bind(app, owner.id);

    const readiness = await app.request(`/api/fusion/readiness?conversationId=${owner.id}`);
    expect(await readiness.json()).toMatchObject({ state: "wrong-document", binding: { role: "owner" } });

    const transfer = await app.request(`/api/conversations/${receiver.id}/fusion-ownership`, { method: "POST" });
    expect(transfer.status).toBe(409);
    expect(await transfer.json()).toEqual({ error: "The active Fusion document is not the managed document." });
  });

  it("marks a closed provisional document non-resumable instead of following another tab", async () => {
    const current = vi.fn()
      .mockResolvedValueOnce(inspected({ id: "creation-1", name: "Unsaved" }))
      .mockResolvedValue(inspected());
    const { app } = persistentApp(current);
    const owner = await createFusionConversation(app, "Owner");
    await bind(app, owner.id);

    const readiness = await app.request(`/api/fusion/readiness?conversationId=${owner.id}`);
    expect(await readiness.json()).toMatchObject({
      state: "no-document",
      binding: { identityKind: "provisional", resumable: false, document: { id: "creation-1" } },
    });
  });

  it("marks a provisional document closed behind another active tab non-resumable", async () => {
    const current = vi.fn()
      .mockResolvedValueOnce(inspected({ id: "creation-1", name: "Unsaved" }))
      .mockResolvedValue(inspected({ id: "creation-2", name: "Other" }));
    const documentIsOpen = vi.fn().mockReturnValue(false);
    const dataDir = mkdtempSync(join(tmpdir(), "chamfer-fusion-owner-"));
    tempDirs.push(dataDir);
    const db = openDb(join(dataDir, "chamfer.db"));
    const app = createApp(db, undefined, { dataDir, fusionReadiness: { current, documentIsOpen } });
    const owner = await createFusionConversation(app, "Owner");
    await bind(app, owner.id);

    expect(await (await app.request(`/api/fusion/readiness?conversationId=${owner.id}`)).json())
      .toMatchObject({ state: "wrong-document", binding: { resumable: false } });
    expect(documentIsOpen).toHaveBeenCalledWith("creation-1");
  });

  it("includes the configured endpoint in exact binding identity", async () => {
    const sameDocument = { id: "creation-1", name: "Part", dataFileId: "data-1" };
    const current = vi.fn()
      .mockResolvedValueOnce(inspected(sameDocument))
      .mockResolvedValue({ ...inspected(sameDocument), endpoint: "http://127.0.0.1:29999/mcp" });
    const { app } = persistentApp(current);
    const owner = await createFusionConversation(app, "Owner");
    await bind(app, owner.id);

    expect(await (await app.request(`/api/fusion/readiness?conversationId=${owner.id}`)).json())
      .toMatchObject({ state: "wrong-document", binding: { endpoint } });
    expect((await bind(app, owner.id)).status).toBe(409);
  });

  it("does not treat a connector outage as proof that a provisional document was closed", async () => {
    const offline: FusionReadinessDto = {
      ...inspected(),
      state: "unavailable",
      label: "Unavailable",
      diagnosis: "Fusion disconnected.",
    };
    const current = vi.fn()
      .mockResolvedValueOnce(inspected({ id: "creation-1", name: "Unsaved" }))
      .mockResolvedValue(offline);
    const { app } = persistentApp(current);
    const owner = await createFusionConversation(app, "Owner");
    await bind(app, owner.id);

    expect(await (await app.request(`/api/fusion/readiness?conversationId=${owner.id}`)).json())
      .toMatchObject({ state: "unavailable", binding: { resumable: true } });
  });

  it("follows the user's document switch: rebinding the endpoint demotes the stale owner to read-only", async () => {
    const current = vi.fn()
      .mockResolvedValueOnce(inspected({ id: "creation-1", name: "Managed", dataFileId: "data-1" }))
      .mockResolvedValue(inspected({ id: "creation-2", name: "Other", dataFileId: "data-2" }));
    const { app } = persistentApp(current);
    const owner = await createFusionConversation(app, "Owner");
    await bind(app, owner.id);

    // The user moved to a different document; a new conversation manages it and
    // the stale owner becomes historical read-only rather than dead-ending the
    // endpoint with a conflict.
    const contender = await createFusionConversation(app, "Contender");
    const rebound = await bind(app, contender.id);
    expect(rebound.status).toBe(200);
    expect(await rebound.json()).toMatchObject({
      conversationId: contender.id, role: "owner", document: { id: "creation-2" },
    });
    const demoted = await app.request(`/api/fusion/readiness?conversationId=${owner.id}`);
    expect(await demoted.json()).toMatchObject({ binding: { role: "read-only" } });

    const localResponse = await app.request("/api/conversations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Local", cadEnvironment: "build123d" }),
    });
    const local = await localResponse.json() as ConversationDto;
    expect((await bind(app, local.id)).status).toBe(409);
  });

  it("refuses to rebind a switched document while endpoint recovery is unresolved", async () => {
    const current = vi.fn()
      .mockResolvedValueOnce(inspected({ id: "creation-1", name: "Managed", dataFileId: "data-1" }))
      .mockResolvedValue(inspected({ id: "creation-2", name: "Other", dataFileId: "data-2" }));
    const { app, db } = persistentApp(current);
    const owner = await createFusionConversation(app, "Owner");
    await bind(app, owner.id);
    appendFusionRecovery(db, {
      conversationId: owner.id, endpoint, actionId: "action-1", state: "hard-recovery",
      failureClass: "revision-uncertain", diagnosis: "Undo could not be verified.",
      allowedOperation: "inspect-resulting-state", precedingRevision: "rev-1", evidenceIds: [],
    });
    const contender = await createFusionConversation(app, "Contender");
    const blocked = await bind(app, contender.id);
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("recovery");
  });
});
