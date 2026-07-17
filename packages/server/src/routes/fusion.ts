import { Hono } from "hono";
import { isFusionExpectedEffect, type FusionActionRequestDto, type FusionCheckInput } from "@chamfer/shared";
import { FusionOwnership, FusionOwnershipError } from "../fusion/ownership";
import type { FusionDocumentationProvider } from "../fusion/documentation";
import { FusionActionError, FusionActions } from "../fusion/action";
import { FusionLifecycle, FusionLifecycleError } from "../fusion/lifecycle";

const CATEGORIES = new Set(["class", "member"]);
const NAMESPACES = new Set(["adsk.core", "adsk.fusion"]);
const OWNER_PATTERN = /^adsk\.(core|fusion)\.[A-Za-z][A-Za-z0-9_]*$/;
const REFERENCE_KINDS = new Set(["parameter", "sketch", "feature", "body", "component"]);
function validReferences(value: unknown): boolean {
  return Array.isArray(value) && value.every((reference) => {
    if (typeof reference !== "object" || reference === null) return false;
    const item = reference as Record<string, unknown>;
    return typeof item.id === "string" && item.id.length > 0 && typeof item.kind === "string" && REFERENCE_KINDS.has(item.kind);
  });
}
function validActionRequest(value: unknown): value is FusionActionRequestDto {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  const document = body.document as Record<string, unknown> | undefined;
  const model = body.model as Record<string, unknown> | undefined;
  const skills = body.skills as Record<string, unknown> | undefined;
  return typeof body.actionId === "string" && body.actionId.length > 0 && body.actionId.length <= 160
    && typeof body.expectedEvidenceId === "string" && body.expectedEvidenceId.length > 0
    && typeof body.expectedRevision === "string" && body.expectedRevision.length > 0
    && typeof body.intent === "string" && body.intent.trim().length > 0 && body.intent.length <= 2000
    && (body.strategy === "targeted" || body.strategy === "destructive-rebuild")
    && (body.destructiveApproval === undefined || (typeof body.destructiveApproval === "object" && body.destructiveApproval !== null
      && ["original-replacement-request", "explicit-approval"].includes(String((body.destructiveApproval as Record<string, unknown>).basis))
      && typeof (body.destructiveApproval as Record<string, unknown>).evidenceMessageId === "string"
      && typeof (body.destructiveApproval as Record<string, unknown>).expectedRevision === "string"
      && typeof (body.destructiveApproval as Record<string, unknown>).intent === "string"
      && typeof (body.destructiveApproval as Record<string, unknown>).statement === "string"
      && String((body.destructiveApproval as Record<string, unknown>).statement).trim().length > 0))
    && (body.reconciliationResolution === undefined || (typeof body.reconciliationResolution === "object" && body.reconciliationResolution !== null
      && typeof (body.reconciliationResolution as Record<string, unknown>).reconciliationId === "string"
      && typeof (body.reconciliationResolution as Record<string, unknown>).evidenceMessageId === "string"
      && typeof (body.reconciliationResolution as Record<string, unknown>).expectedRevision === "string"
      && typeof (body.reconciliationResolution as Record<string, unknown>).intent === "string"
      && typeof (body.reconciliationResolution as Record<string, unknown>).statement === "string"
      && validReferences((body.reconciliationResolution as Record<string, unknown>).affectedReferences)))
    && typeof body.body === "string" && body.body.length > 0
    && validReferences(body.affectedReferences)
    && (body.expectedEffects === undefined
      || (Array.isArray(body.expectedEffects) && body.expectedEffects.every(isFusionExpectedEffect)))
    && Boolean(document && typeof document.id === "string" && typeof document.name === "string")
    && Boolean(model && typeof model.provider === "string" && typeof model.model === "string")
    && Boolean(skills && typeof skills.foundation === "object" && Array.isArray(skills.loaded));
}

export function fusionRoutes(
  ownership: FusionOwnership,
  documentation: FusionDocumentationProvider,
  actions: FusionActions,
  lifecycle: FusionLifecycle,
): Hono {
  const app = new Hono();
  const actionInterruptions = new Map<string, AbortController>();
  const interruptionKey = (conversationId: string, actionId: string) => `${conversationId}\u0000${actionId}`;
  app.onError((error, c) => {
    if (error instanceof FusionOwnershipError || error instanceof FusionActionError || error instanceof FusionLifecycleError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  });
  app.get("/api/fusion/readiness", async (c) =>
    c.json(await ownership.current(c.req.query("conversationId"))));
  app.post("/api/conversations/:id/fusion-binding", async (c) =>
    c.json(await ownership.bind(c.req.param("id"))));
  app.post("/api/conversations/:id/fusion-ownership", async (c) =>
    c.json(await ownership.transfer(c.req.param("id"))));
  app.post("/api/conversations/:id/fusion-save", async (c) => {
    const body: { document?: unknown } = await c.req.json<{ document?: unknown }>().catch(() => ({}));
    const document = body.document as Record<string, unknown> | undefined;
    if (!document || typeof document.id !== "string" || typeof document.name !== "string") {
      return c.json({ error: "The exact bound Fusion document identity is required for Save." }, 400);
    }
    return c.json(await lifecycle.save(c.req.param("id"), {
      id: document.id,
      name: document.name,
      ...(typeof document.dataFileId === "string" ? { dataFileId: document.dataFileId } : {}),
    }));
  });
  app.post("/api/fusion/documentation", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "A JSON documentation query is required" }, 400);
    }
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const category = String(body.category);
    const namespace = String(body.namespace);
    const owner = typeof body.owner === "string" ? body.owner.trim() : undefined;
    const validOwner = category === "member"
      ? Boolean(owner && OWNER_PATTERN.test(owner) && owner.startsWith(`${namespace}.`))
      : owner === undefined;
    if (query.length < 2 || query.length > 120 || !CATEGORIES.has(category) || !NAMESPACES.has(namespace) || !validOwner) {
      return c.json({ error: "query, category, namespace, and a class-qualified owner for member lookups are required" }, 400);
    }
    try {
      return c.json(await documentation.search({
        query,
        category: body.category as "class" | "member",
        namespace: body.namespace as "adsk.core" | "adsk.fusion",
        ...(owner ? { owner } : {}),
      }));
    } catch {
      return c.json({ error: "Installed Fusion API lookup failed." }, 503);
    }
  });
  app.post("/api/conversations/:id/fusion-inspections", async (c) => {
    const body: { checks?: unknown } = await c.req.json<{ checks?: unknown }>().catch(() => ({}));
    const checks: FusionCheckInput[] = Array.isArray(body.checks)
      ? body.checks.filter((check): check is FusionCheckInput =>
          typeof check === "object" && check !== null && typeof (check as { kind?: unknown }).kind === "string")
      : [];
    return c.json(await ownership.inspect(c.req.param("id"), checks));
  });
  app.post("/api/conversations/:id/fusion-reconciliation", async (c) =>
    c.json(await ownership.reconcileIfChanged(c.req.param("id"))));
  app.get("/api/conversations/:id/fusion-actions", (c) => c.json(actions.history(c.req.param("id"))));
  app.post("/api/conversations/:id/fusion-actions/:actionId/interrupt", async (c) => {
    const body: { reason?: unknown } = await c.req.json<{ reason?: unknown }>().catch(() => ({}));
    const controller = actionInterruptions.get(interruptionKey(c.req.param("id"), c.req.param("actionId")));
    if (!controller) return c.json({ interrupted: false }, 404);
    const timedOut = body.reason === "timeout";
    controller.abort(new DOMException(timedOut ? "The Fusion action timed out" : "The user canceled the Fusion action",
      timedOut ? "TimeoutError" : "AbortError"));
    return c.json({ interrupted: true }, 202);
  });
  app.post("/api/conversations/:id/fusion-actions", async (c) => {
    const body = await c.req.json<unknown>().catch(() => undefined);
    if (!validActionRequest(body)) return c.json({ error: "A complete bounded Fusion action contract is required" }, 400);
    // Client cancellation may close the HTTP request, but it must not cancel a
    // Fusion command blindly. The action service observes either interruption
    // and keeps working under its endpoint lease until trusted diagnosis ends.
    const controller = new AbortController();
    const key = interruptionKey(c.req.param("id"), body.actionId);
    if (!actionInterruptions.has(key)) actionInterruptions.set(key, controller);
    const interruption = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120_000), controller.signal]);
    try {
      return c.json(await actions.execute(c.req.param("id"), body, interruption));
    } finally {
      if (actionInterruptions.get(key) === controller) actionInterruptions.delete(key);
    }
  });
  return app;
}
