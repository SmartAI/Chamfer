import { describe, expect, it } from "vitest";
import type { ConversationDto, DesignDto, DesignRevisionDto } from "@chamfer/shared";
import { createApp } from "../app";
import { openDb } from "../db";

function makeApp() {
  return createApp(openDb(":memory:"));
}

async function postJson(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createConversation(app: ReturnType<typeof createApp>, body: Record<string, unknown> = {}) {
  const response = await postJson(app, "/api/conversations", {
    title: "Design session",
    cadEnvironment: "build123d",
    ...body,
  });
  expect(response.status).toBe(200);
  return await response.json() as ConversationDto;
}

async function createPassedArtifact(app: ReturnType<typeof createApp>, conversationId: string, suffix = "one") {
  const response = await postJson(app, `/api/conversations/${conversationId}/artifacts`, {
    pySource: `WIDTH = 10\nresult = Box(WIDTH, 20, 3) # ${suffix}`,
    paramsJson: JSON.stringify([
      { name: "WIDTH", value: 10, min: 5, max: 20, description: "Plate width" },
    ]),
    gate: {
      status: "passed",
      checks: [{ name: "valid", passed: true, detail: "B-rep is valid" }],
    },
    measurements: { bboxMm: [10, 20, 3], volumeMm3: 600, areaMm2: 580, children: [] },
  });
  expect(response.status).toBe(200);
  return await response.json() as { id: string; version: number };
}

describe("design routes", () => {
  it("creates a first-class design with every new conversation and can bind a fresh conversation to it", async () => {
    const app = makeApp();
    const first = await createConversation(app, { designName: "Mounting plate" });
    expect(first.designId).toBeTruthy();

    const design = await (await app.request(`/api/designs/${first.designId}`)).json() as DesignDto;
    expect(design).toMatchObject({
      id: first.designId,
      name: "Mounting plate",
      description: "",
      cadEnvironment: "build123d",
      currentRevision: null,
      referencedConversationCount: 1,
    });

    const second = await createConversation(app, {
      title: "Refinement session",
      designId: design.id,
    });
    expect(second.designId).toBe(design.id);
    expect((await (await app.request(`/api/designs/${design.id}`)).json() as DesignDto)
      .referencedConversationCount).toBe(2);

    const mismatch = await postJson(app, "/api/conversations", {
      title: "Wrong environment",
      cadEnvironment: "fusion",
      designId: design.id,
    });
    expect(mismatch.status).toBe(409);
  });

  it("lets a user parameter edit supersede dimensional pins but never structural checks", async () => {
    const app = makeApp();
    const conversation = await createConversation(app, { designName: "Plate" });
    const designId = conversation.designId!;

    const dimensionalOnly = await postJson(app, `/api/conversations/${conversation.id}/artifacts`, {
      pySource: "result = Box(100, 20, 30)",
      gate: {
        status: "failed",
        checks: [
          { name: "valid", passed: true, detail: "B-rep validity" },
          { name: "parameter_width", passed: true, detail: "responsive" },
          { name: "bbox", passed: false, detail: "expected [10,20,30], measured [100,20,30]" },
          { name: "check:bbox[0]", passed: false, detail: "frozen envelope superseded" },
        ],
      },
      measurements: { bboxMm: [100, 20, 30], volumeMm3: 60000, areaMm2: 11200, children: [] },
    });
    const dimensionalId = (await dimensionalOnly.json() as { id: string }).id;

    const withoutFlag = await postJson(app, `/api/designs/${designId}/revisions`, {
      conversationId: conversation.id,
      artifactId: dimensionalId,
    });
    expect(withoutFlag.status).toBe(409);

    const promoted = await postJson(app, `/api/designs/${designId}/revisions`, {
      conversationId: conversation.id,
      artifactId: dimensionalId,
      userParameterEdit: true,
    });
    expect(promoted.status).toBe(200);

    const structural = await postJson(app, `/api/conversations/${conversation.id}/artifacts`, {
      pySource: "result = Box(100, 20, 30)",
      gate: {
        status: "failed",
        checks: [
          { name: "valid", passed: false, detail: "self-intersecting" },
          { name: "bbox", passed: false, detail: "off" },
        ],
      },
      measurements: { bboxMm: [100, 20, 30], volumeMm3: 60000, areaMm2: 11200, children: [] },
    });
    const structuralId = (await structural.json() as { id: string }).id;
    const rejected = await postJson(app, `/api/designs/${designId}/revisions`, {
      conversationId: conversation.id,
      artifactId: structuralId,
      userParameterEdit: true,
    });
    expect(rejected.status).toBe(409);
  });

  it("promotes only passing run candidates and keeps the current revision stable until promotion", async () => {
    const app = makeApp();
    const conversation = await createConversation(app, { designName: "Plate" });
    const designId = conversation.designId!;

    const failedArtifact = await postJson(app, `/api/conversations/${conversation.id}/artifacts`, {
      pySource: "result = Box(1, 1, 1)",
      gate: { status: "failed", checks: [{ name: "size", passed: false, detail: "too small" }] },
      measurements: { bboxMm: [1, 1, 1], volumeMm3: 1, areaMm2: 6, children: [] },
    });
    const failedId = (await failedArtifact.json() as { id: string }).id;
    const rejected = await postJson(app, `/api/designs/${designId}/revisions`, {
      conversationId: conversation.id,
      artifactId: failedId,
    });
    expect(rejected.status).toBe(409);
    expect((await (await app.request(`/api/designs/${designId}`)).json() as DesignDto).currentRevision).toBeNull();

    const artifact = await createPassedArtifact(app, conversation.id);
    expect((await (await app.request(`/api/designs/${designId}`)).json() as DesignDto).currentRevision).toBeNull();

    const promoted = await postJson(app, `/api/designs/${designId}/revisions`, {
      conversationId: conversation.id,
      artifactId: artifact.id,
    });
    expect(promoted.status).toBe(200);
    const revision = await promoted.json() as DesignRevisionDto;
    expect(revision).toMatchObject({
      designId,
      revision: 1,
      sourceConversationId: conversation.id,
      sourceArtifactId: artifact.id,
      pySource: expect.stringContaining("WIDTH = 10"),
      parameters: [{ name: "WIDTH", value: 10, min: 5, max: 20, description: "Plate width" }],
      gate: { status: "passed" },
    });

    const retry = await postJson(app, `/api/designs/${designId}/revisions`, {
      conversationId: conversation.id,
      artifactId: artifact.id,
    });
    expect(await retry.json()).toEqual(revision);
    expect((await (await app.request(`/api/designs/${designId}/revisions`)).json() as DesignRevisionDto[]))
      .toEqual([revision]);
    expect((await (await app.request(`/api/designs/${designId}`)).json() as DesignDto).currentRevision).toBe(1);
  });

  it("renames, describes, lists, and forks a design from any accepted revision", async () => {
    const app = makeApp();
    const conversation = await createConversation(app, { designName: "Original" });
    const artifact = await createPassedArtifact(app, conversation.id);
    const originalRevision = await (await postJson(app, `/api/designs/${conversation.designId}/revisions`, {
      conversationId: conversation.id,
      artifactId: artifact.id,
    })).json() as DesignRevisionDto;

    const patched = await app.request(`/api/designs/${conversation.designId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bracket", description: "Wall-mounted sensor bracket" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ name: "Bracket", description: "Wall-mounted sensor bracket" });

    const forkedResponse = await postJson(app, `/api/designs/${conversation.designId}/forks`, {
      revision: originalRevision.revision,
      name: "Bracket variant",
    });
    expect(forkedResponse.status).toBe(200);
    const forked = await forkedResponse.json() as DesignDto;
    expect(forked).toMatchObject({ name: "Bracket variant", currentRevision: 1, referencedConversationCount: 0 });
    const forkRevision = (await (await app.request(`/api/designs/${forked.id}/revisions`)).json() as DesignRevisionDto[])[0]!;
    expect(forkRevision.pySource).toBe(originalRevision.pySource);
    expect(forkRevision.provenance).toEqual({ designId: conversation.designId, revision: 1 });

    const secondArtifact = await createPassedArtifact(app, conversation.id, "two");
    await postJson(app, `/api/designs/${conversation.designId}/revisions`, {
      conversationId: conversation.id,
      artifactId: secondArtifact.id,
    });
    const restoredResponse = await postJson(app, `/api/designs/${conversation.designId}/restores`, { revision: 1 });
    expect(restoredResponse.status).toBe(200);
    expect(await restoredResponse.json()).toMatchObject({
      revision: 3,
      pySource: originalRevision.pySource,
      provenance: { designId: conversation.designId, revision: 1 },
    });
    expect((await (await app.request(`/api/designs/${conversation.designId}`)).json() as DesignDto).currentRevision)
      .toBe(3);

    const designs = await (await app.request("/api/designs")).json() as DesignDto[];
    expect(designs.map((design) => design.id)).toEqual(expect.arrayContaining([conversation.designId, forked.id]));
  });

  it("deletes conversations and designs independently with explicit referential accounting", async () => {
    const app = makeApp();
    const conversation = await createConversation(app, { designName: "Keep me" });
    const designId = conversation.designId!;
    const artifact = await createPassedArtifact(app, conversation.id);
    await postJson(app, `/api/designs/${designId}/revisions`, {
      conversationId: conversation.id,
      artifactId: artifact.id,
    });

    expect((await app.request(`/api/conversations/${conversation.id}`, { method: "DELETE" })).status).toBe(200);
    const surviving = await app.request(`/api/designs/${designId}`);
    expect(surviving.status).toBe(200);
    expect((await surviving.json() as DesignDto).currentRevision).toBe(1);

    const reference = await createConversation(app, { designId, title: "New session" });
    const warned = await app.request(`/api/designs/${designId}`, { method: "DELETE" });
    expect(warned.status).toBe(409);
    expect(await warned.json()).toEqual({
      error: "design is referenced by conversations",
      conversationReferences: [{ id: reference.id, title: reference.title }],
    });

    const deleted = await app.request(`/api/designs/${designId}?confirm=true`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await (await app.request(`/api/conversations/${reference.id}`)).json() as ConversationDto).designId)
      .toBeNull();
    expect((await app.request(`/api/designs/${designId}`)).status).toBe(404);
  });
});
