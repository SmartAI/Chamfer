import type { DatabaseSync } from "node:sqlite";
import { EvidenceEventDraftSchema, type EvidenceEventDraft } from "@chamfer/shared";
import { Value } from "typebox/value";
import { appendEvidenceEvent, listEvidenceEvents } from "./evidenceStore";
import { listLegacySourceSpecifications } from "./sourceSpecifications";
import { listLegacyReferenceRecords } from "./referenceClassification";
import { listLegacyReferenceRegistrations } from "./referenceRegistrations";
import { listLegacyInspectionLeases } from "./inspectionLeases";
import { listLegacyVisualVerificationBatches, listLegacyVisualVerifications } from "./visualVerification";
import { listLegacyDesignEscalations } from "./designEscalations";
import { listLegacyProofContracts } from "./routes/proofContracts";
import { listLegacyProofReports } from "./proofReports";
import { withImmediateTransaction } from "./dbTransaction";

interface LegacyMessageRow {
  id: string;
  content_json: string;
  created_at: number;
}

function planDraft(
  conversationId: string,
  row: LegacyMessageRow,
): Extract<EvidenceEventDraft, { type: "plan.recorded" }> | undefined {
  try {
    const message = JSON.parse(row.content_json) as {
      role?: unknown;
      toolName?: unknown;
      details?: { plan?: unknown; deduped?: unknown };
    };
    if (message.role !== "toolResult" || message.details?.plan === undefined || message.details.deduped === true) return undefined;
    const operation = message.toolName === "create_plan"
      ? "created"
      : message.toolName === "revise_plan"
        ? "revised"
        : message.toolName === "update_plan"
          ? "legacy-snapshot"
          : undefined;
    if (!operation) return undefined;
    return {
      id: `${conversationId}:migration:plan:${row.id}`,
      type: "plan.recorded",
      data: { operation, plan: message.details.plan },
      recordedAt: row.created_at,
    };
  } catch {
    return undefined;
  }
}

function visualComparisonDraft(
  conversationId: string,
  row: LegacyMessageRow,
): Extract<EvidenceEventDraft, { type: "visual-comparison.recorded" }> | undefined {
  try {
    const message = JSON.parse(row.content_json) as {
      role?: unknown;
      details?: { visualComparison?: { evidenceId?: unknown; candidate?: {
        artifactId?: unknown;
        artifactVersion?: unknown;
        inspectionSheetId?: unknown;
      } } };
    };
    const comparison = message.details?.visualComparison;
    if (message.role !== "toolResult" || typeof comparison?.evidenceId !== "string" ||
        typeof comparison.candidate?.artifactId !== "string" ||
        typeof comparison.candidate.artifactVersion !== "number" ||
        typeof comparison.candidate.inspectionSheetId !== "string") return undefined;
    return {
      id: `${conversationId}:migration:visual-comparison:${comparison.evidenceId}`,
      type: "visual-comparison.recorded",
      data: { comparison: comparison as Extract<EvidenceEventDraft, {
        type: "visual-comparison.recorded";
      }>["data"]["comparison"] },
      recordedAt: row.created_at,
    };
  } catch {
    return undefined;
  }
}

/** Idempotent lossless transformation for evidence that predates the ledger. */
export function migrateLegacyEvidence(db: DatabaseSync): void {
  const hasLegacyTable = (name: string): boolean => db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) !== undefined;
  const conversations = db.prepare("SELECT id FROM conversations ORDER BY created_at ASC").all() as Array<{ id: string }>;
  for (const { id: conversationId } of conversations) {
    withImmediateTransaction(db, () => {
      const drafts: EvidenceEventDraft[] = [];
      const append = (draft: EvidenceEventDraft) => drafts.push(draft);
      const alreadyVerified = new Set(listEvidenceEvents(db, conversationId)
        .filter((event) => event.type === "artifact.verified")
        .map((event) => `${event.data.artifactId}\0${event.data.artifactVersion}`));

    const messages = db.prepare(
      "SELECT id, content_json, created_at FROM messages WHERE conversation_id = ? ORDER BY seq ASC",
    ).all(conversationId) as unknown as LegacyMessageRow[];
    for (const row of messages) {
      const draft = planDraft(conversationId, row);
      if (draft) append(draft);
    }
    const verifiedArtifacts = db.prepare(`SELECT a.id, a.version,
        COALESCE(a.gate_json, g.gate_json) AS gateJson,
        COALESCE(a.measurements_json, g.measurements_json) AS measurementsJson,
        COALESCE(g.witnessed_at, a.created_at) AS recordedAt
      FROM artifacts a LEFT JOIN cad_gate_evidence g ON g.artifact_id = a.id
      WHERE a.conversation_id = ? AND COALESCE(a.gate_json, g.gate_json) IS NOT NULL
        AND COALESCE(a.measurements_json, g.measurements_json) IS NOT NULL
      ORDER BY a.version`).all(conversationId) as Array<{
        id: string;
        version: number;
        gateJson: string;
        measurementsJson: string;
        recordedAt: number;
      }>;
    for (const artifact of verifiedArtifacts) {
      if (alreadyVerified.has(`${artifact.id}\0${artifact.version}`)) continue;
      try {
        const draft: EvidenceEventDraft = {
          id: `${conversationId}:migration:artifact-verification:${artifact.id}`,
          type: "artifact.verified",
          data: {
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            gate: JSON.parse(artifact.gateJson),
            measurements: JSON.parse(artifact.measurementsJson),
          },
          recordedAt: artifact.recordedAt,
        };
        if (Value.Check(EvidenceEventDraftSchema, draft)) append(draft);
      } catch {
        // Malformed historical verification remains readable in its legacy
        // projection but cannot be promoted into the typed evidence ledger.
      }
    }

    const legacySpecifications = hasLegacyTable("source_specifications")
      ? listLegacySourceSpecifications(db, conversationId)
      : [];
    for (const specification of legacySpecifications
      .slice().sort((left, right) => left.timestamp - right.timestamp)) {
      append({
        id: `${conversationId}:migration:source-specification:${specification.id}`,
        type: "source-specifications.recorded",
        data: { specifications: [specification] },
        recordedAt: specification.timestamp,
      });
    }
    const legacyReferenceRecords = hasLegacyTable("reference_classifications")
      ? listLegacyReferenceRecords(db, conversationId)
      : [];
    for (const record of legacyReferenceRecords) {
      for (const classification of record.history) append({
        id: `${conversationId}:migration:reference-classification:${classification.id}`,
        type: "reference.classified",
        data: { classification, attachmentAvailable: record.attachmentAvailable },
        recordedAt: classification.timestamp,
      });
    }
    const legacyRegistrations = hasLegacyTable("reference_registrations")
      ? listLegacyReferenceRegistrations(db, conversationId)
      : [];
    for (const registration of legacyRegistrations) append({
      id: `${conversationId}:migration:reference-registration:${registration.registrationId}:${registration.revision}`,
      type: "reference.registered",
      data: { registration },
      recordedAt: registration.timestamp,
    });
    const legacyLeases = hasLegacyTable("inspection_leases")
      ? listLegacyInspectionLeases(db, conversationId)
      : [];
    for (const lease of legacyLeases) {
      append({
        id: `${conversationId}:migration:inspection-lease:${lease.id}:opened`,
        type: "inspection-lease.opened",
        data: { lease: lease.status === "open" ? lease : {
          ...lease,
          status: "open",
          closedAt: undefined,
          observation: undefined,
        } },
        recordedAt: lease.openedAt,
      });
      if (lease.status === "closed") append({
        id: `${conversationId}:migration:inspection-lease:${lease.id}:closed`,
        type: "inspection-lease.closed",
        data: { lease },
        recordedAt: lease.closedAt,
      });
    }
    const recordedComparisonIds = new Set<string>();
    for (const row of messages) {
      const draft = visualComparisonDraft(conversationId, row);
      if (draft && !recordedComparisonIds.has(draft.data.comparison.evidenceId)) {
        append(draft);
        recordedComparisonIds.add(draft.data.comparison.evidenceId);
      }
    }
    const legacyBatches = hasLegacyTable("visual_verification_batches")
      ? listLegacyVisualVerificationBatches(db, conversationId)
      : [];
    const legacyVerifications = hasLegacyTable("visual_verifications")
      ? listLegacyVisualVerifications(db, conversationId)
      : [];
    for (const record of [...legacyBatches, ...legacyVerifications]) {
      if (recordedComparisonIds.has(record.visualComparisonEvidenceId)) continue;
      append({
        id: `${conversationId}:migration:visual-comparison:${record.visualComparisonEvidenceId}`,
        type: "visual-comparison.recorded",
        data: { comparison: {
          evidenceId: record.visualComparisonEvidenceId,
          status: "unavailable",
          policy: { id: "legacy-unmeasured", version: 1 },
          algorithm: { id: "legacy-unmeasured", version: 1 },
          thresholds: { silhouetteOverlapMin: 0, edgeAlignmentMin: 0, edgeTolerancePx: 0 },
          candidate: {
            artifactId: record.artifactId,
            artifactVersion: record.artifactVersion,
            inspectionSheetId: record.inspectionSheetId,
          },
          comparisons: [],
          reason: "Migrated verdict predates deterministic measured visual comparison.",
        } },
        recordedAt: record.recordedAt,
      });
      recordedComparisonIds.add(record.visualComparisonEvidenceId);
    }
    for (const batch of legacyBatches) append({
      id: `${conversationId}:migration:visual-verification-batch:${batch.id}`,
      type: "visual-verification-batch.recorded",
      data: { batch },
      recordedAt: batch.recordedAt,
    });
    const batchVerificationIds = new Set(legacyBatches
      .flatMap((batch) => batch.finalVerification ? [batch.finalVerification.id] : []));
    for (const verification of legacyVerifications) {
      if (batchVerificationIds.has(verification.id)) continue;
      append({
        id: `${conversationId}:migration:visual-verification:${verification.id}`,
        type: "visual-verification.recorded",
        data: { verification },
        recordedAt: verification.recordedAt,
      });
    }
    const legacyEscalations = hasLegacyTable("design_escalations")
      ? listLegacyDesignEscalations(db, conversationId)
      : [];
    for (const escalation of legacyEscalations) {
      const legacy = db.prepare(`SELECT opened_after_message_seq AS openedAfterMessageSeq
        FROM design_escalations WHERE conversation_id = ? AND escalation_id = ?`)
        .get(conversationId, escalation.escalationId) as { openedAfterMessageSeq: number };
      append({
        id: `${conversationId}:migration:design-escalation:${escalation.escalationId}`,
        type: "design-escalation.opened",
        data: {
          escalation: { ...escalation, status: "pending", resolvedAt: undefined, resolutionSpecificationIds: [] },
          openedAfterMessageSeq: legacy.openedAfterMessageSeq,
        },
        recordedAt: escalation.openedAt,
      });
      if (escalation.status === "resolved") append({
        id: `${conversationId}:migration:design-escalation-resolution:${escalation.escalationId}`,
        type: "design-escalation.resolved",
        data: { escalation, openedAfterMessageSeq: legacy.openedAfterMessageSeq },
        recordedAt: escalation.resolvedAt,
      });
    }
    const legacyContracts = hasLegacyTable("proof_contracts")
      ? listLegacyProofContracts(db, conversationId)
      : [];
    for (const contract of legacyContracts) append({
      id: `${conversationId}:migration:proof-contract:${contract.contractId}:${contract.revision}`,
      type: "proof-contract.frozen",
      data: { contract },
      recordedAt: contract.frozenAt,
    });
      const legacyReports = hasLegacyTable("proof_reports")
        ? listLegacyProofReports(db, conversationId)
        : [];
      for (const report of legacyReports) append({
        id: `${conversationId}:migration:proof-report:${report.reportId}`,
        type: "proof-report.recorded",
        data: { report },
        recordedAt: report.createdAt,
      });
      drafts
        .map((draft, sourceOrder) => ({ draft, sourceOrder }))
        .sort((left, right) =>
          (left.draft.recordedAt ?? 0) - (right.draft.recordedAt ?? 0) ||
          left.sourceOrder - right.sourceOrder)
        .forEach(({ draft }) => appendEvidenceEvent(db, conversationId, draft));
    });
  }
}
