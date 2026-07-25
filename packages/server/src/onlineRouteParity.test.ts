import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { openDb } from "./db";
import { fakeLlm } from "./fakeLlm";
import { createApp } from "./app";
import { createOnlineApp, REQUIRED_ONLINE_ROUTES } from "../../online/src/onlineApp";
import { stubBlobStore as blobStore, stubOnlineHosting } from "./onlineTestSupport";

// The cloud Worker (createOnlineApp) hand-assembles the same route modules as
// this local server (createApp). When a new feature adds a route to createApp
// and forgets createOnlineApp, the origin keeps answering 200 on "/" while the
// feature 404s in production - which is exactly how /api/designs broke online.
// This test fails at PR time if that drift ever recurs. It lives in the server
// package (not online) because createApp needs DOM+node types the Workers-typed
// online tsconfig deliberately omits.

// The only routes the cloud is allowed to omit, each for a documented reason in
// onlineApp.ts. Anything server-only that does NOT match one of these is an
// accidental gap and fails the test. The parity diff runs against a
// hosting-configured online app: since issue #51 the container-backed
// deployment mounts the full /api/agent/* surface, so those routes are no
// longer an omission - only the unconfigured deployment may omit them, and a
// dedicated test below pins that omission to agentHosting: false.
const DELIBERATE_ONLINE_OMISSIONS: RegExp[] = [
  /^\/api\/fusion\//, // loopback Fusion MCP is unreachable from a Worker
  /^\/api\/conversations\/:id\/fusion-/, // per-conversation Fusion connector routes
  /^\/api\/test\//, // fake-LLM test controls (never in a real deployment)
];

// Route mounting only needs the seams' shapes, not a live container; the shared
// stub reports no artifacts, which is all the parity checks need.
const stubAgent = stubOnlineHosting();

function mountedPaths(app: Hono): Set<string> {
  return new Set(app.routes.map((route) => route.path));
}

describe("online route parity", () => {
  it("serves every server route the client depends on, minus documented omissions", () => {
    const server = mountedPaths(createApp(openDb(":memory:"), fakeLlm()));
    const online = mountedPaths(
      createOnlineApp(openDb(":memory:"), fakeLlm(), blobStore, { agent: stubAgent }),
    );

    const serverOnly = [...server].filter((path) => !online.has(path));
    const accidentalGaps = serverOnly.filter(
      (path) => !DELIBERATE_ONLINE_OMISSIONS.some((allowed) => allowed.test(path)),
    );

    expect(
      accidentalGaps,
      `createOnlineApp is missing server routes the client calls (add them to onlineApp.ts, `
        + `or to DELIBERATE_ONLINE_OMISSIONS if the omission is intentional): ${accidentalGaps.join(", ")}`,
    ).toEqual([]);
  });

  it("mounts the designs routes online (regression guard for the /api/designs 404)", async () => {
    const online = createOnlineApp(openDb(":memory:"), fakeLlm(), blobStore);
    expect((await online.request("/api/designs")).status).toBe(200);
  });

  it("reports healthy with no degradation when agent hosting is configured", async () => {
    const online = createOnlineApp(openDb(":memory:"), fakeLlm(), blobStore, { agent: stubAgent });
    const response = await online.request("/api/online/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "chamfer-online",
      missing: [],
      degraded: [],
    });
  });

  it("keeps every required route in the health contract mounted", () => {
    const online = mountedPaths(createOnlineApp(openDb(":memory:"), fakeLlm(), blobStore));
    for (const path of REQUIRED_ONLINE_ROUTES) {
      expect(online.has(path), `required route ${path} is not mounted online`).toBe(true);
    }
  });

  // Deliberate record (issue #48): the container-facing LLM proxy
  // (/api/llm/*, packages/online/src/llmProxy.ts) lives OUTSIDE createOnlineApp
  // by design. It is token-authenticated and consumed by the agent container,
  // not the browser client whose route surface this parity guard accounts
  // for; the Worker mounts the gate and the user DO mounts the proxy
  // directly. This assertion makes the placement a conscious decision: anyone
  // moving /api/llm into createOnlineApp trips it and must update this record
  // (and DELIBERATE_ONLINE_OMISSIONS, since createApp has no /api/llm either).
  it("keeps the container-facing LLM proxy out of the client route surface", () => {
    const online = mountedPaths(
      createOnlineApp(openDb(":memory:"), fakeLlm(), blobStore, { agent: stubAgent }),
    );
    for (const path of online) {
      expect(path, "/api/llm/* is container-facing and must not mount in createOnlineApp").not.toMatch(
        /^\/api\/llm\//,
      );
    }
  });

  // Capability honesty, both postures (issue #51). Configured (container
  // binding + token secret, which userDo.ts translates into options.agent):
  // the full /api/agent/* surface mounts and agentHosting flips true.
  // Unconfigured: the routes stay unmounted AND the deployment says so -
  // a silent omission is how the post-pivot deploy broke app.chamferonline.com
  // (user prompts turned into 404s under an enabled composer).
  it("mounts the agent surface and declares agentHosting when configured", async () => {
    const online = createOnlineApp(openDb(":memory:"), fakeLlm(), blobStore, { agent: stubAgent });
    const paths = mountedPaths(online);
    for (const path of [
      "/api/agent/:conversationId/messages",
      "/api/agent/:conversationId/events",
      "/api/agent/:conversationId/abort",
      "/api/agent/:conversationId/artifact",
    ]) {
      expect(paths.has(path), `agent route ${path} is not mounted on the configured deployment`).toBe(true);
    }
    expect(await (await online.request("/api/runtime/capabilities")).json()).toMatchObject({
      agentHosting: true,
    });
  });

  it("keeps the degraded posture, honestly declared, when hosting is not configured", async () => {
    const online = createOnlineApp(openDb(":memory:"), fakeLlm(), blobStore);
    for (const path of mountedPaths(online)) {
      expect(path, "an unconfigured deployment must not mount /api/agent/*").not.toMatch(/^\/api\/agent\//);
    }
    expect(await (await online.request("/api/runtime/capabilities")).json()).toMatchObject({
      agentHosting: false,
    });
    expect(await (await online.request("/api/online/health")).json()).toMatchObject({
      degraded: ["agent-hosting"],
    });
    const server = createApp(openDb(":memory:"), fakeLlm());
    expect(await (await server.request("/api/runtime/capabilities")).json()).toMatchObject({
      agentHosting: true,
    });
  });
});
