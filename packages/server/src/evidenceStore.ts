import type { DatabaseSync } from "node:sqlite";
import {
  advanceEvidenceProjection,
  evidenceProjection,
  evidencePlanIdentity,
  EvidenceEventDraftSchema,
  type EvidenceEvent,
  type EvidenceEventDraft,
  type EvidenceProjection,
} from "@chamfer/shared";
import { Value } from "typebox/value";
import { conversationExists } from "./conversationStore";
import { ConversationEventStore } from "./conversationEventStore";
import { withImmediateTransaction } from "./dbTransaction";
import { IncrementalProjectionCache } from "./incrementalProjectionCache";

interface EvidenceEventRow {
  id: string;
  conversation_id: string;
  sequence: number;
  type: EvidenceEvent["type"];
  data_json: string;
  recorded_at: number;
}

const projectionsByDatabase = new WeakMap<object, IncrementalProjectionCache<EvidenceEvent, EvidenceProjection>>();

function databaseProjections(db: DatabaseSync): IncrementalProjectionCache<EvidenceEvent, EvidenceProjection> {
  const existing = projectionsByDatabase.get(db as object);
  if (existing) return existing;
  const created = new IncrementalProjectionCache(
    (projection: EvidenceProjection) => projection.events.at(-1)?.sequence ?? 0,
    advanceEvidenceProjection,
  );
  projectionsByDatabase.set(db as object, created);
  return created;
}

export function invalidateEvidenceProjection(db: DatabaseSync, conversationId: string): void {
  projectionsByDatabase.get(db as object)?.invalidate(conversationId);
}

export class EvidenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceIntegrityError";
  }
}

function eventFromRow(row: EvidenceEventRow): EvidenceEvent {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    type: row.type,
    data: JSON.parse(row.data_json),
    recordedAt: row.recorded_at,
  } as EvidenceEvent;
}

export function listEvidenceEvents(db: DatabaseSync, conversationId: string, after = 0): EvidenceEvent[] {
  const rows = db.prepare(
    "SELECT * FROM evidence_events WHERE conversation_id = ? AND sequence > ? ORDER BY sequence ASC",
  ).all(conversationId, after) as unknown as EvidenceEventRow[];
  return rows.map(eventFromRow);
}

export function projectEvidence(db: DatabaseSync, conversationId: string): EvidenceProjection {
  if (db.isTransaction) return evidenceProjection(listEvidenceEvents(db, conversationId));
  return databaseProjections(db).project(
    conversationId,
    (after) => listEvidenceEvents(db, conversationId, after),
  );
}

function attachmentBelongsToConversation(db: DatabaseSync, conversationId: string, attachmentId: string): boolean {
  return db.prepare(`SELECT 1 FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE a.id = ? AND m.conversation_id = ?`).get(attachmentId, conversationId) !== undefined;
}

function artifactBelongsToConversation(
  db: DatabaseSync,
  conversationId: string,
  artifactId: string,
  version?: number,
): boolean {
  return db.prepare(`SELECT 1 FROM artifacts
    WHERE id = ? AND conversation_id = ? AND (? IS NULL OR version = ?)`)
    .get(artifactId, conversationId, version ?? null, version ?? null) !== undefined;
}

function assertPayloadConversation(conversationId: string, actual: string, label: string): void {
  if (actual !== conversationId) {
    throw new EvidenceIntegrityError(`${label} belongs to conversation ${actual}, not ${conversationId}`);
  }
}

function validateAntecedents(
  db: DatabaseSync,
  conversationId: string,
  projection: EvidenceProjection,
  draft: EvidenceEventDraft,
): void {
  switch (draft.type) {
    case "artifact.verified":
      if (!artifactBelongsToConversation(db, conversationId, draft.data.artifactId, draft.data.artifactVersion)) {
        throw new EvidenceIntegrityError(`artifact ${draft.data.artifactId} is not stored for this conversation`);
      }
      if ((projection.artifactVerifications ?? []).some((event) =>
        event.data.artifactId === draft.data.artifactId &&
        event.data.artifactVersion === draft.data.artifactVersion)) {
        throw new EvidenceIntegrityError(`artifact ${draft.data.artifactId} is already verified`);
      }
      break;
    case "environment-verification.recorded": {
      const verification = draft.data;
      if (verification.artifact && !artifactBelongsToConversation(
        db,
        conversationId,
        verification.artifact.id,
        verification.artifact.version,
      )) {
        throw new EvidenceIntegrityError(
          `environment verification references missing artifact ${verification.artifact.id} version ${verification.artifact.version}`,
        );
      }
      if (verification.environment === "fusion" && (!verification.revision || !verification.inspectionId)) {
        throw new EvidenceIntegrityError("Fusion environment verification requires an exact inspection and revision identity");
      }
      if (verification.environment === "fusion" &&
        db.prepare("SELECT 1 FROM fusion_inspections WHERE id = ? AND conversation_id = ? AND revision = ?")
          .get(verification.inspectionId!, conversationId, verification.revision!) === undefined) {
        throw new EvidenceIntegrityError(
          `environment verification references missing Fusion inspection ${verification.inspectionId} at revision ${verification.revision}`,
        );
      }
      if (verification.status === "passed" && verification.environment === "build123d" && !verification.artifact) {
        throw new EvidenceIntegrityError("passing build123d verification requires an immutable artifact identity");
      }
      if (verification.status === "passed" && verification.environment === "fusion" &&
        (verification.scope !== "design" || !verification.revision)) {
        throw new EvidenceIntegrityError("passing Fusion verification requires a revision-bound design inspection");
      }
      break;
    }
    case "proof-reports.invalidated":
      if (!Number.isInteger(draft.data.latestArtifactVersion) || draft.data.latestArtifactVersion < 1) {
        throw new EvidenceIntegrityError("proof-report invalidation requires a positive artifact version");
      }
      if (db.prepare("SELECT 1 FROM artifacts WHERE conversation_id = ? AND version = ?")
        .get(conversationId, draft.data.latestArtifactVersion) === undefined) {
        throw new EvidenceIntegrityError(
          `artifact version ${draft.data.latestArtifactVersion} is not stored for this conversation`,
        );
      }
      break;
    case "plan.recorded": {
      const identity = evidencePlanIdentity(draft.data.plan);
      if (identity && projection.planHistory.some((event) => {
        const existing = evidencePlanIdentity(event.data.plan);
        return existing?.id === identity.id && existing.revision === identity.revision;
      })) {
        throw new EvidenceIntegrityError(`plan ${identity.id} revision ${identity.revision} is already recorded`);
      }
      const plan = draft.data.plan as {
        components?: Array<{ id?: unknown; checks?: Array<{ id?: unknown }> }>;
        spec_sheet?: Array<{ id?: unknown; check_refs?: Array<{ component_id?: unknown; check_id?: unknown }> }>;
      };
      const checks = new Set((plan.components ?? []).flatMap((component) =>
        (component.checks ?? []).map((check) => `${String(component.id)}\0${String(check.id)}`)));
      for (const row of plan.spec_sheet ?? []) {
        for (const reference of row.check_refs ?? []) {
          const key = `${String(reference.component_id)}\0${String(reference.check_id)}`;
          if (!checks.has(key)) {
            throw new EvidenceIntegrityError(
              `plan specification ${String(row.id)} references missing check ${String(reference.component_id)}/${String(reference.check_id)}`,
            );
          }
        }
      }
      break;
    }
    case "proof-contract.frozen": {
      assertPayloadConversation(conversationId, draft.data.contract.conversationId, `proof contract ${draft.data.contract.contractId}`);
      if (projection.proofContracts.some((contract) =>
        contract.contractId === draft.data.contract.contractId && contract.revision === draft.data.contract.revision)) {
        throw new EvidenceIntegrityError(
          `proof contract ${draft.data.contract.contractId} revision ${draft.data.contract.revision} is already recorded`,
        );
      }
      const derivation = draft.data.contract.derivation;
      const planExists = projection.planHistory.some((event) => {
        const identity = evidencePlanIdentity(event.data.plan);
        return identity?.id === derivation.planId && identity.revision === derivation.planRevision;
      });
      if (!planExists) {
        throw new EvidenceIntegrityError(
          `proof contract ${draft.data.contract.contractId} references missing plan ${derivation.planId} revision ${derivation.planRevision}`,
        );
      }
      for (const specificationId of derivation.sourceSpecificationIds) {
        if (!projection.sourceSpecifications.some((specification) => specification.id === specificationId)) {
          throw new EvidenceIntegrityError(
            `proof contract ${draft.data.contract.contractId} references missing source specification ${specificationId}`,
          );
        }
      }
      for (const registration of derivation.shapeProof.status === "not-applicable"
        ? []
        : derivation.shapeProof.registrations) {
        if (!projection.referenceRegistrations.some((candidate) =>
          candidate.registrationId === registration.registrationId && candidate.revision === registration.revision)) {
          throw new EvidenceIntegrityError(
            `proof contract ${draft.data.contract.contractId} references missing registration ${registration.registrationId} revision ${registration.revision}`,
          );
        }
      }
      break;
    }
    case "reference.classified":
      assertPayloadConversation(
        conversationId,
        draft.data.classification.conversationId,
        `reference classification ${draft.data.classification.id}`,
      );
      if (!attachmentBelongsToConversation(db, conversationId, draft.data.classification.referenceId)) {
        throw new EvidenceIntegrityError(
          `reference classification ${draft.data.classification.id} references missing image ${draft.data.classification.referenceId}`,
        );
      }
      if (projection.referenceRecords.some((record) =>
        record.history.some((classification) => classification.id === draft.data.classification.id))) {
        throw new EvidenceIntegrityError(`reference classification ${draft.data.classification.id} is already recorded`);
      }
      for (const specificationId of draft.data.classification.specificationIds) {
        const planRows = (projection.activePlan as { spec_sheet?: Array<{ id?: unknown }> } | undefined)?.spec_sheet ?? [];
        const planRowId = specificationId.startsWith("plan.spec_sheet.")
          ? specificationId.slice("plan.spec_sheet.".length)
          : undefined;
        const exists = projection.sourceSpecifications.some((specification) => specification.id === specificationId) ||
          (planRowId !== undefined && planRows.some((row) => row.id === planRowId));
        if (!exists) {
          throw new EvidenceIntegrityError(
            `specification ${specificationId} does not exist`,
          );
        }
      }
      break;
    case "reference.registered": {
      const registration = draft.data.registration;
      assertPayloadConversation(conversationId, registration.conversationId, `reference registration ${registration.registrationId}`);
      if (projection.referenceRegistrations.some((candidate) =>
        candidate.registrationId === registration.registrationId && candidate.revision === registration.revision)) {
        throw new EvidenceIntegrityError(
          `reference registration ${registration.registrationId} revision ${registration.revision} is already recorded`,
        );
      }
      if (!projection.referenceRecords.some((record) => record.referenceId === registration.referenceId)) {
        throw new EvidenceIntegrityError(
          `reference registration ${registration.registrationId} references unclassified image ${registration.referenceId}`,
        );
      }
      if (registration.scaleAnchor && !projection.sourceSpecifications.some((specification) =>
        specification.id === registration.scaleAnchor?.specificationId)) {
        throw new EvidenceIntegrityError(
          `reference registration ${registration.registrationId} references missing scale specification ${registration.scaleAnchor.specificationId}`,
        );
      }
      break;
    }
    case "source-specifications.recorded": {
      const draftIds = new Set<string>();
      for (const specification of draft.data.specifications) {
        if (draftIds.has(specification.id) || projection.sourceSpecifications.some((candidate) => candidate.id === specification.id)) {
          throw new EvidenceIntegrityError(`source specification ${specification.id} is already recorded`);
        }
        draftIds.add(specification.id);
        assertPayloadConversation(conversationId, specification.conversationId, `source specification ${specification.id}`);
        if ("messageId" in specification.source) {
          const message = db.prepare("SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?")
            .get(specification.source.messageId, conversationId);
          if (!message) throw new EvidenceIntegrityError(
            `source specification ${specification.id} references missing source message ${specification.source.messageId}`,
          );
        } else if (!attachmentBelongsToConversation(db, conversationId, specification.source.attachmentId)) {
          throw new EvidenceIntegrityError(
            `source specification ${specification.id} references missing source image ${specification.source.attachmentId}`,
          );
        }
        const supersededIds = specification.supersedesSpecificationIds ??
          (specification.supersedesSpecificationId ? [specification.supersedesSpecificationId] : []);
        for (const supersededId of supersededIds) {
          if (!projection.sourceSpecifications.some((candidate) => candidate.id === supersededId)) {
            throw new EvidenceIntegrityError(
              `source specification ${specification.id} supersedes missing source specification ${supersededId}`,
            );
          }
        }
      }
      break;
    }
    case "inspection-lease.opened":
    case "inspection-lease.closed":
      assertPayloadConversation(conversationId, draft.data.lease.conversationId, `inspection lease ${draft.data.lease.id}`);
      if (draft.type === "inspection-lease.opened" && projection.inspectionLeases.some((lease) => lease.id === draft.data.lease.id)) {
        throw new EvidenceIntegrityError(`inspection lease ${draft.data.lease.id} is already recorded`);
      }
      for (const evidence of draft.data.lease.evidence) {
        if (!attachmentBelongsToConversation(db, conversationId, evidence.attachmentId)) {
          throw new EvidenceIntegrityError(
            `inspection lease ${draft.data.lease.id} references missing evidence image ${evidence.attachmentId}`,
          );
        }
      }
      if (draft.type === "inspection-lease.closed" && !projection.inspectionLeases.some((lease) =>
        lease.id === draft.data.lease.id && lease.status === "open")) {
        throw new EvidenceIntegrityError(`inspection lease ${draft.data.lease.id} was not open`);
      }
      break;
    case "visual-comparison.recorded": {
      const comparison = draft.data.comparison;
      if (projection.visualComparisons.some((candidate) => candidate.evidenceId === comparison.evidenceId)) {
        throw new EvidenceIntegrityError(`visual comparison ${comparison.evidenceId} is already recorded`);
      }
      if (!artifactBelongsToConversation(
        db,
        conversationId,
        comparison.candidate.artifactId,
        comparison.candidate.artifactVersion,
      )) {
        throw new EvidenceIntegrityError(
          `visual comparison ${comparison.evidenceId} references missing artifact ${comparison.candidate.artifactId}`,
        );
      }
      if (!attachmentBelongsToConversation(db, conversationId, comparison.candidate.inspectionSheetId)) {
        throw new EvidenceIntegrityError(
          `visual comparison ${comparison.evidenceId} references missing inspection sheet ${comparison.candidate.inspectionSheetId}`,
        );
      }
      for (const target of comparison.comparisons.map((item) => item.target)) {
        if (target.kind === "prior-accepted-artifact" &&
            (typeof target.artifactId !== "string" || typeof target.artifactVersion !== "number" ||
              !artifactBelongsToConversation(db, conversationId, target.artifactId, target.artifactVersion))) {
          throw new EvidenceIntegrityError(
            `visual comparison ${comparison.evidenceId} references missing prior artifact ${target.id}`,
          );
        }
        if (target.inspectionSheetId &&
            !attachmentBelongsToConversation(db, conversationId, target.inspectionSheetId)) {
          throw new EvidenceIntegrityError(
            `visual comparison ${comparison.evidenceId} references missing prior inspection sheet ${target.inspectionSheetId}`,
          );
        }
        if (target.kind === "registered-render" &&
            (typeof target.referenceId !== "string" || !projection.referenceRecords.some((record) =>
              record.referenceId === target.referenceId))) {
          throw new EvidenceIntegrityError(
            `visual comparison ${comparison.evidenceId} references missing registered render ${target.id}`,
          );
        }
      }
      break;
    }
    case "visual-verification.recorded": {
      const verification = draft.data.verification;
      assertPayloadConversation(conversationId, verification.conversationId, `visual verification ${verification.id}`);
      if (projection.visualVerifications.some((candidate) => candidate.id === verification.id)) {
        throw new EvidenceIntegrityError(`visual verification ${verification.id} is already recorded`);
      }
      if (!artifactBelongsToConversation(db, conversationId, verification.artifactId, verification.artifactVersion)) {
        throw new EvidenceIntegrityError(
          `visual verification ${verification.id} references missing artifact ${verification.artifactId}`,
        );
      }
      if (!attachmentBelongsToConversation(db, conversationId, verification.inspectionSheetId)) {
        throw new EvidenceIntegrityError(
          `visual verification ${verification.id} references missing inspection sheet ${verification.inspectionSheetId}`,
        );
      }
      if (!projection.visualComparisons.some((comparison) =>
        comparison.evidenceId === verification.visualComparisonEvidenceId &&
        comparison.candidate.artifactId === verification.artifactId &&
        comparison.candidate.artifactVersion === verification.artifactVersion &&
        comparison.candidate.inspectionSheetId === verification.inspectionSheetId)) {
        throw new EvidenceIntegrityError(
          `visual verification ${verification.id} references missing or stale measured comparison ${verification.visualComparisonEvidenceId}`,
        );
      }
      for (const referenceId of verification.coveredReferenceIds) {
        if (!projection.referenceRecords.some((record) => record.referenceId === referenceId)) {
          throw new EvidenceIntegrityError(
            `visual verification ${verification.id} references missing reference image ${referenceId}`,
          );
        }
      }
      break;
    }
    case "visual-verification-batch.recorded": {
      const batch = draft.data.batch;
      assertPayloadConversation(conversationId, batch.conversationId, `visual verification batch ${batch.id}`);
      if (projection.visualVerificationBatches.some((candidate) => candidate.id === batch.id ||
        (candidate.artifactId === batch.artifactId && candidate.artifactVersion === batch.artifactVersion &&
          candidate.inspectionSheetId === batch.inspectionSheetId && candidate.batchIndex === batch.batchIndex))) {
        throw new EvidenceIntegrityError(`visual verification batch ${batch.id} is already recorded`);
      }
      if (!artifactBelongsToConversation(db, conversationId, batch.artifactId, batch.artifactVersion)) {
        throw new EvidenceIntegrityError(
          `visual verification batch ${batch.id} references missing artifact ${batch.artifactId}`,
        );
      }
      if (!attachmentBelongsToConversation(db, conversationId, batch.inspectionSheetId)) {
        throw new EvidenceIntegrityError(
          `visual verification batch ${batch.id} references missing inspection sheet ${batch.inspectionSheetId}`,
        );
      }
      if (!projection.visualComparisons.some((comparison) =>
        comparison.evidenceId === batch.visualComparisonEvidenceId &&
        comparison.candidate.artifactId === batch.artifactId &&
        comparison.candidate.artifactVersion === batch.artifactVersion &&
        comparison.candidate.inspectionSheetId === batch.inspectionSheetId)) {
        throw new EvidenceIntegrityError(
          `visual verification batch ${batch.id} references missing or stale measured comparison ${batch.visualComparisonEvidenceId}`,
        );
      }
      for (const referenceId of batch.activeReferenceIds) {
        if (!projection.referenceRecords.some((record) => record.referenceId === referenceId)) {
          throw new EvidenceIntegrityError(
            `visual verification batch ${batch.id} references missing reference image ${referenceId}`,
          );
        }
      }
      break;
    }
    case "design-escalation.opened":
    case "design-escalation.resolved":
      assertPayloadConversation(
        conversationId,
        draft.data.escalation.conversationId,
        `design escalation ${draft.data.escalation.escalationId}`,
      );
      if (draft.type === "design-escalation.opened" && projection.designEscalations.some((escalation) =>
        escalation.escalationId === draft.data.escalation.escalationId)) {
        throw new EvidenceIntegrityError(`design escalation ${draft.data.escalation.escalationId} is already recorded`);
      }
      for (const specificationId of draft.data.escalation.affectedSpecificationIds) {
        if (!projection.sourceSpecifications.some((specification) => specification.id === specificationId)) {
          throw new EvidenceIntegrityError(
            `design escalation ${draft.data.escalation.escalationId} references missing source specification ${specificationId}`,
          );
        }
      }
      if (draft.type === "design-escalation.resolved" && !projection.designEscalations.some((escalation) =>
        escalation.escalationId === draft.data.escalation.escalationId && escalation.status === "pending")) {
        throw new EvidenceIntegrityError(
          `design escalation ${draft.data.escalation.escalationId} was not pending`,
        );
      }
      break;
    case "proof-report.recorded": {
      const report = draft.data.report;
      assertPayloadConversation(conversationId, report.conversationId, `proof report ${report.reportId}`);
      if (projection.proofReports.some((candidate) => candidate.reportId === report.reportId ||
        (candidate.cadArtifact.id === report.cadArtifact.id && candidate.cadArtifact.version === report.cadArtifact.version))) {
        throw new EvidenceIntegrityError(`proof report ${report.reportId} is already recorded`);
      }
      if (!projection.proofContracts.some((contract) =>
        contract.contractId === report.proofContract.contractId &&
        contract.revision === report.proofContract.revision)) {
        throw new EvidenceIntegrityError(
          `proof report ${report.reportId} references missing proof contract ${report.proofContract.contractId} revision ${report.proofContract.revision}`,
        );
      }
      if (!artifactBelongsToConversation(db, conversationId, report.cadArtifact.id, report.cadArtifact.version)) {
        throw new EvidenceIntegrityError(
          `proof report ${report.reportId} references missing artifact ${report.cadArtifact.id}`,
        );
      }
      break;
    }
  }
}

export function appendEvidenceEvent(
  db: DatabaseSync,
  conversationId: string,
  draft: EvidenceEventDraft,
): EvidenceEvent {
  if (!Value.Check(EvidenceEventDraftSchema, draft)) {
    throw new EvidenceIntegrityError("evidence event does not match its typed payload schema");
  }
  if (!conversationExists(db, conversationId)) {
    throw new EvidenceIntegrityError(`conversation ${conversationId} does not exist`);
  }
  const existing = db.prepare("SELECT * FROM evidence_events WHERE id = ?").get(draft.id) as unknown as
    | EvidenceEventRow
    | undefined;
  if (existing) {
    const event = eventFromRow(existing);
    if (event.conversationId === conversationId && event.type === draft.type &&
        JSON.stringify(event.data) === JSON.stringify(draft.data)) return event;
    throw new EvidenceIntegrityError(`evidence event ID ${draft.id} is already used by different evidence`);
  }

  const projection = projectEvidence(db, conversationId);
  validateAntecedents(db, conversationId, projection, draft);
  const sequence = (projection.events.at(-1)?.sequence ?? 0) + 1;
  const recordedAt = draft.recordedAt ?? Date.now();
  withImmediateTransaction(db, () => {
    db.prepare(`INSERT INTO evidence_events
      (id, conversation_id, sequence, type, data_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(draft.id, conversationId, sequence, draft.type, JSON.stringify(draft.data), recordedAt);
    if (draft.type === "artifact.verified") {
      db.prepare(`UPDATE artifacts SET gate_json = ?, measurements_json = ?
        WHERE id = ? AND conversation_id = ? AND version = ?`)
        .run(
          JSON.stringify(draft.data.gate),
          JSON.stringify(draft.data.measurements),
          draft.data.artifactId,
          conversationId,
          draft.data.artifactVersion,
        );
    }
    new ConversationEventStore(db).append(conversationId, {
      id: `evidence-link:${draft.id}`,
      recordedAt,
      type: "evidence.linked",
      data: {
        evidenceId: draft.id,
        relationship: draft.type === "plan.recorded"
          ? "plan"
          : draft.type === "artifact.verified"
            ? "artifact"
            : "verification",
      },
    });
  });
  return {
    id: draft.id,
    conversationId,
    sequence,
    type: draft.type,
    data: draft.data,
    recordedAt,
  } as EvidenceEvent;
}
