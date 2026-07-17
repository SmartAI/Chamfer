import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  FusionCheckResultDto, FusionDocumentIdentityDto, FusionSaveEvidenceDto,
} from "@chamfer/shared";
import type { CapturedFusionInspection } from "./inspection";

export function recordFusionSaveEvidence(
  db: DatabaseSync,
  conversationId: string,
  precedingDocument: FusionDocumentIdentityDto,
  resultingDocument: FusionDocumentIdentityDto,
  captured: CapturedFusionInspection,
  checks: FusionCheckResultDto[],
  now = Date.now(),
): FusionSaveEvidenceDto {
  const inspection = {
    id: randomUUID(),
    revision: captured.revision,
    capturedAt: now,
    stale: false,
    snapshot: captured.snapshot,
    checks,
    screenshots: captured.screenshots,
    cameraRestored: captured.cameraRestored,
  };
  const evidence: FusionSaveEvidenceDto = {
    id: randomUUID(), conversationId, capturedAt: now, precedingDocument, resultingDocument,
    revision: captured.revision, inspection,
  };
  db.prepare(`INSERT INTO fusion_save_evidence
    (id, conversation_id, captured_at, preceding_document_json, resulting_document_json, revision, inspection_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(evidence.id, conversationId, now, JSON.stringify(precedingDocument), JSON.stringify(resultingDocument),
      captured.revision, JSON.stringify(inspection));
  return evidence;
}
