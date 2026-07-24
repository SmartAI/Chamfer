import type { DatabaseSync } from "node:sqlite";
import { deriveDurableNotes, type DurableNoteDto } from "@chamfer/shared";
import { projectEvidence } from "./evidenceStore";

/**
 * Compatibility projection for #18's durable-notes resource.
 *
 * Source specifications and design escalations are authoritative typed events in
 * the unified evidence ledger. Notes are derived here instead of being mirrored
 * into a parallel table, so the assembly model has one durable source of truth.
 */
export function listDurableNotes(db: DatabaseSync, conversationId: string): DurableNoteDto[] {
  const projection = projectEvidence(db, conversationId);
  return deriveDurableNotes(projection.sourceSpecifications, projection.designEscalations)
    .map((note): DurableNoteDto => ({ ...note, conversationId }));
}
