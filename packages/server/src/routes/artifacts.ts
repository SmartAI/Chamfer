import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { isMeasurements, type ArtifactDto, type Gate, type Measurements } from "@chamfer/shared";
import { conversationExists } from "../conversationStore";
import { appendEvidenceEvent, projectEvidence } from "../evidenceStore";
import { ConversationEventStore } from "../conversationEventStore";
import { withImmediateTransaction } from "../dbTransaction";

interface ArtifactRow {
  id: string;
  conversation_id: string;
  version: number;
  py_source: string;
  params_json: string | null;
  gate_json: string | null;
  measurements_json: string | null;
  created_at: number;
}

function validGate(value: unknown): value is Gate {
  if (typeof value !== "object" || value === null) return false;
  const gate = value as Partial<Gate>;
  if (!["passed", "failed", "error"].includes(gate.status ?? "") || !Array.isArray(gate.checks) ||
      gate.checks.length === 0) return false;
  const checksValid = gate.checks.every((check) =>
    typeof check?.name === "string" && check.name.length > 0 && typeof check.passed === "boolean" &&
    typeof check.detail === "string");
  return checksValid && (gate.status !== "passed" || gate.checks.every((check) => check.passed));
}

function validParametersJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((parameter) => {
      if (typeof parameter !== "object" || parameter === null) return false;
      const item = parameter as Record<string, unknown>;
      return typeof item.name === "string" && item.name.length > 0 &&
        typeof item.value === "number" && Number.isFinite(item.value) &&
        typeof item.min === "number" && Number.isFinite(item.min) &&
        typeof item.max === "number" && Number.isFinite(item.max) &&
        item.min <= item.value && item.value <= item.max &&
        typeof item.description === "string";
    });
  } catch {
    return false;
  }
}

function toDto(row: ArtifactRow): ArtifactDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    version: row.version,
    pySource: row.py_source,
    paramsJson: row.params_json,
    ...(row.gate_json ? { gate: JSON.parse(row.gate_json) as Gate } : {}),
    ...(row.measurements_json ? { measurements: JSON.parse(row.measurements_json) } : {}),
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
      gate?: unknown;
      measurements?: unknown;
    } | null;
    if (!body || typeof body.pySource !== "string") {
      return c.json({ error: "pySource required" }, 400);
    }
    if (body.gate !== undefined && !validGate(body.gate)) {
      return c.json({ error: "invalid gate evidence" }, 400);
    }
    if (body.measurements !== undefined && !isMeasurements(body.measurements)) {
      return c.json({ error: "invalid measurements evidence" }, 400);
    }
    if (body.paramsJson !== undefined && body.paramsJson !== null && !validParametersJson(body.paramsJson)) {
      return c.json({ error: "paramsJson must contain a valid parameter schema" }, 400);
    }
    if ((body.gate === undefined) !== (body.measurements === undefined)) {
      return c.json({ error: "gate and measurements evidence must be stored together" }, 400);
    }
    const artifact: ArtifactRow = {
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      version: 0,
      py_source: body.pySource,
      params_json: body.paramsJson ?? null,
      gate_json: body.gate === undefined ? null : JSON.stringify(body.gate),
      measurements_json: body.measurements === undefined ? null : JSON.stringify(body.measurements),
      created_at: Date.now(),
    };

    withImmediateTransaction(db, () => {
      const row = db
        .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM artifacts WHERE conversation_id = ?")
        .get(conversationId) as { version: number };
      artifact.version = row.version;
      new ConversationEventStore(db).append(conversationId, {
        recordedAt: artifact.created_at,
        type: "artifact.stored",
        data: {
          artifact: {
            id: artifact.id,
            conversationId,
            version: artifact.version,
            pySource: artifact.py_source,
            paramsJson: artifact.params_json,
            createdAt: artifact.created_at,
          },
          evidenceIds: [],
        },
      });
      if (body.gate !== undefined && body.measurements !== undefined) {
        appendEvidenceEvent(db, conversationId, {
          id: `${conversationId}:artifact:${artifact.id}:verified`,
          type: "artifact.verified",
          data: {
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            gate: body.gate as Gate,
            measurements: body.measurements as Measurements,
          },
          recordedAt: artifact.created_at,
        });
      }
      const dto = toDto(artifact);
      if (projectEvidence(db, conversationId).proofReports.some((report) => report.status !== "stale")) {
        appendEvidenceEvent(db, conversationId, {
          id: `${conversationId}:proof-report-invalidation:${dto.id}`,
          type: "proof-reports.invalidated",
          data: { latestArtifactVersion: dto.version },
          recordedAt: dto.createdAt,
        });
      }
    });
    const dto = toDto(artifact);
    return c.json(dto);
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
