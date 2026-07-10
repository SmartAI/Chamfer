import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactDto } from "@chamfer/shared";
import { conversationExists } from "../conversationStore";

interface ArtifactRow {
  id: string;
  conversation_id: string;
  version: number;
  py_source: string;
  params_json: string | null;
  created_at: number;
}

function toDto(row: ArtifactRow): ArtifactDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    version: row.version,
    pySource: row.py_source,
    paramsJson: row.params_json,
    createdAt: row.created_at,
  };
}

export function artifactsRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  app.post("/api/conversations/:id/artifacts", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      pySource?: unknown;
      paramsJson?: string | null;
    } | null;
    if (!body || typeof body.pySource !== "string") {
      return c.json({ error: "pySource required" }, 400);
    }
    const artifact: ArtifactRow = {
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      version: 0,
      py_source: body.pySource,
      params_json: body.paramsJson ?? null,
      created_at: Date.now(),
    };

    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM artifacts WHERE conversation_id = ?")
        .get(conversationId) as { version: number };
      artifact.version = row.version;
      db.prepare(
        "INSERT INTO artifacts (id, conversation_id, version, py_source, params_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        artifact.id,
        artifact.conversation_id,
        artifact.version,
        artifact.py_source,
        artifact.params_json,
        artifact.created_at,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return c.json(toDto(artifact));
  });

  app.get("/api/conversations/:id/artifacts", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const rows = db
      .prepare("SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY version ASC")
      .all(conversationId) as unknown as ArtifactRow[];
    return c.json(rows.map(toDto));
  });

  return app;
}
