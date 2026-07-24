import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { CadEnvironment } from "@chamfer/shared";
import {
  appendArtifactRevision,
  createDesign,
  deleteDesign,
  designConversationReferences,
  forkDesign,
  getDesign,
  getDesignRevision,
  listDesignRevisions,
  listDesigns,
  updateDesign,
  restoreDesignRevision,
  appendFusionDesignRevision,
} from "../designStore";

const CAD_ENVIRONMENTS = new Set<CadEnvironment>(["build123d", "fusion"]);

export function designsRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  app.get("/api/designs", (c) => c.json(listDesigns(db)));

  app.post("/api/designs", async (c) => {
    const body = await c.req.json<{ name?: unknown; description?: unknown; cadEnvironment?: unknown }>()
      .catch(() => ({} as { name?: unknown; description?: unknown; cadEnvironment?: unknown }));
    if (typeof body.name !== "string" || body.name.trim().length === 0 ||
        typeof body.cadEnvironment !== "string" || !CAD_ENVIRONMENTS.has(body.cadEnvironment as CadEnvironment) ||
        (body.description !== undefined && typeof body.description !== "string")) {
      return c.json({ error: "name and a valid cadEnvironment are required" }, 400);
    }
    return c.json(createDesign(
      db,
      body.name.trim(),
      body.cadEnvironment as CadEnvironment,
      body.description?.trim() ?? "",
    ));
  });

  app.get("/api/designs/:id", (c) => {
    const design = getDesign(db, c.req.param("id"));
    return design ? c.json(design) : c.json({ error: "not found" }, 404);
  });

  app.patch("/api/designs/:id", async (c) => {
    const body = await c.req.json<{ name?: unknown; description?: unknown }>()
      .catch(() => ({} as { name?: unknown; description?: unknown }));
    if ((body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length === 0)) ||
        (body.description !== undefined && typeof body.description !== "string") ||
        (body.name === undefined && body.description === undefined)) {
      return c.json({ error: "a non-empty name or description is required" }, 400);
    }
    const design = updateDesign(db, c.req.param("id"), {
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
      ...(typeof body.description === "string" ? { description: body.description.trim() } : {}),
    });
    return design ? c.json(design) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/designs/:id/revisions", (c) => {
    if (!getDesign(db, c.req.param("id"))) return c.json({ error: "not found" }, 404);
    return c.json(listDesignRevisions(db, c.req.param("id")));
  });

  app.get("/api/designs/:id/revisions/:revision", (c) => {
    const revision = Number(c.req.param("revision"));
    const found = Number.isInteger(revision) && revision > 0
      ? getDesignRevision(db, c.req.param("id"), revision)
      : undefined;
    return found ? c.json(found) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/designs/:id/revisions", async (c) => {
    if (!getDesign(db, c.req.param("id"))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ conversationId?: unknown; artifactId?: unknown; userParameterEdit?: unknown }>()
      .catch(() => ({} as { conversationId?: unknown; artifactId?: unknown; userParameterEdit?: unknown }));
    if (typeof body.conversationId !== "string" || typeof body.artifactId !== "string") {
      return c.json({ error: "conversationId and artifactId are required" }, 400);
    }
    const result = appendArtifactRevision(db, c.req.param("id"), body.conversationId, body.artifactId, {
      userParameterEdit: body.userParameterEdit === true,
    });
    if (result.ok) return c.json(result.revision);
    if (result.reason === "not-found") return c.json({ error: "artifact not found" }, 404);
    if (result.reason === "wrong-design") return c.json({ error: "artifact does not belong to this design" }, 409);
    return c.json({ error: "only a passing CAD result can become a design revision" }, 409);
  });

  app.post("/api/designs/:id/fusion-revisions", async (c) => {
    const design = getDesign(db, c.req.param("id"));
    if (!design) return c.json({ error: "not found" }, 404);
    if (design.cadEnvironment !== "fusion") return c.json({ error: "design is not Fusion-backed" }, 409);
    const body = await c.req.json<{ conversationId?: unknown; actionId?: unknown }>()
      .catch(() => ({} as { conversationId?: unknown; actionId?: unknown }));
    if (typeof body.conversationId !== "string" || typeof body.actionId !== "string") {
      return c.json({ error: "conversationId and actionId are required" }, 400);
    }
    const revision = appendFusionDesignRevision(db, design.id, body.conversationId, body.actionId);
    return revision
      ? c.json(revision)
      : c.json({ error: "a completed passing Fusion action is required" }, 409);
  });

  app.post("/api/designs/:id/restores", async (c) => {
    const design = getDesign(db, c.req.param("id"));
    if (!design) return c.json({ error: "not found" }, 404);
    if (design.cadEnvironment !== "build123d") {
      return c.json({ error: "Fusion revisions must be restored in the authoritative Fusion document" }, 409);
    }
    const body = await c.req.json<{ revision?: unknown }>()
      .catch(() => ({} as { revision?: unknown }));
    if (!Number.isInteger(body.revision) || (body.revision as number) <= 0) {
      return c.json({ error: "revision is required" }, 400);
    }
    const restored = restoreDesignRevision(db, design.id, body.revision as number);
    return restored ? c.json(restored) : c.json({ error: "revision not found" }, 404);
  });

  app.post("/api/designs/:id/forks", async (c) => {
    const source = getDesign(db, c.req.param("id"));
    if (!source) return c.json({ error: "not found" }, 404);
    if (source.cadEnvironment === "fusion") {
      return c.json({ error: "Forking a Fusion design requires a native Save As workflow" }, 409);
    }
    const body = await c.req.json<{ revision?: unknown; name?: unknown }>()
      .catch(() => ({} as { revision?: unknown; name?: unknown }));
    const revision = body.revision ?? source.currentRevision;
    if (!Number.isInteger(revision) || (revision as number) <= 0 ||
        (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length === 0))) {
      return c.json({ error: "an accepted revision and optional non-empty name are required" }, 400);
    }
    const forked = forkDesign(
      db,
      source.id,
      revision as number,
      typeof body.name === "string" ? body.name.trim() : `${source.name} fork`,
    );
    return forked ? c.json(forked) : c.json({ error: "revision not found" }, 404);
  });

  app.delete("/api/designs/:id", (c) => {
    const design = getDesign(db, c.req.param("id"));
    if (!design) return c.json({ error: "not found" }, 404);
    const conversationReferences = designConversationReferences(db, design.id);
    if (conversationReferences.length > 0 && c.req.query("confirm") !== "true") {
      return c.json({ error: "design is referenced by conversations", conversationReferences }, 409);
    }
    deleteDesign(db, design.id);
    return c.json({ ok: true });
  });

  return app;
}
