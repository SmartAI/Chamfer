import type { DatabaseSync } from "node:sqlite";
import type {
  FusionCheckResultDto,
  FusionEngineeringSnapshotDto,
  FusionInspectionRecordDto,
  FusionScreenshotDto,
} from "@chamfer/shared";
import type { CapturedFusionInspection } from "./inspection";
import { withImmediateTransaction } from "../dbTransaction";

interface InspectionRow {
  id: string;
  revision: string;
  snapshot_json: string;
  checks_json: string;
  screenshots_json: string;
  camera_restored: number;
  captured_at: number;
  stale_at: number | null;
}

function toDto(row: InspectionRow): FusionInspectionRecordDto {
  return {
    id: row.id,
    revision: row.revision,
    capturedAt: row.captured_at,
    stale: row.stale_at !== null,
    ...(row.stale_at !== null ? { staleAt: row.stale_at } : {}),
    snapshot: JSON.parse(row.snapshot_json) as FusionEngineeringSnapshotDto,
    checks: JSON.parse(row.checks_json) as FusionCheckResultDto[],
    screenshots: JSON.parse(row.screenshots_json) as FusionScreenshotDto[],
    cameraRestored: row.camera_restored === 1,
  };
}

export interface RecordedFusionInspection {
  current: FusionInspectionRecordDto;
  history: FusionInspectionRecordDto[];
}

export function listFusionInspectionHistory(db: DatabaseSync, conversationId: string): FusionInspectionRecordDto[] {
  return (db.prepare(`SELECT * FROM fusion_inspections WHERE conversation_id = ?
    ORDER BY stale_at IS NULL DESC, captured_at DESC`).all(conversationId) as unknown as InspectionRow[]).map(toDto);
}

export function recordFusionInspection(
  db: DatabaseSync,
  conversationId: string,
  captured: CapturedFusionInspection,
  checks: FusionCheckResultDto[],
  now = Date.now(),
): RecordedFusionInspection {
  const prior = db.prepare(`
    SELECT * FROM fusion_inspections
    WHERE conversation_id = ? AND stale_at IS NULL
    ORDER BY captured_at DESC LIMIT 1
  `).get(conversationId) as unknown as InspectionRow | undefined;
  const engineeringChanged = Boolean(prior && prior.revision !== captured.revision);

  withImmediateTransaction(db, () => {
    if (engineeringChanged) {
      db.prepare("UPDATE fusion_inspections SET stale_at = ? WHERE conversation_id = ? AND stale_at IS NULL")
        .run(now, conversationId);
    }
    db.prepare(`
      INSERT INTO fusion_inspections
        (id, conversation_id, revision, snapshot_json, checks_json, screenshots_json, camera_restored, captured_at, stale_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(conversation_id, revision) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        checks_json = excluded.checks_json,
        screenshots_json = excluded.screenshots_json,
        camera_restored = excluded.camera_restored,
        captured_at = excluded.captured_at,
        stale_at = NULL
    `).run(
      crypto.randomUUID(),
      conversationId,
      captured.revision,
      JSON.stringify(captured.snapshot),
      JSON.stringify(checks),
      JSON.stringify(captured.screenshots),
      captured.cameraRestored ? 1 : 0,
      now,
    );
  });

  const history = listFusionInspectionHistory(db, conversationId);
  const current = history.find((record) => !record.stale && record.revision === captured.revision);
  if (!current) throw new Error("Fusion inspection persistence lost the current revision");
  return {
    current,
    history,
  };
}

/**
 * Registers a recorded Fusion inspection as this conversation's visual artifact,
 * reusing the existing row when the inspection id was already registered (a
 * same-revision re-inspection keeps its inspection id, and repeated visual reads
 * of a finished design are the normal endgame pattern). Returns the identity the
 * visual-verification protocol validates against.
 */
export function ensureFusionVisualArtifact(
  db: DatabaseSync,
  conversationId: string,
  inspectionId: string,
  revision: string,
): { artifactId: string; artifactVersion: number } {
  const existing = db.prepare("SELECT version FROM artifacts WHERE id = ? AND conversation_id = ?")
    .get(inspectionId, conversationId) as { version: number } | undefined;
  if (existing) return { artifactId: inspectionId, artifactVersion: existing.version };
  const versionRow = db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM artifacts WHERE conversation_id = ?")
    .get(conversationId) as { version: number };
  db.prepare("INSERT INTO artifacts (id, conversation_id, version, py_source, params_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(inspectionId, conversationId, versionRow.version, `fusion-revision:${revision}`,
      JSON.stringify({ cadEnvironment: "fusion", inspectionId }), Date.now());
  return { artifactId: inspectionId, artifactVersion: versionRow.version };
}
