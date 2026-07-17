import type { DatabaseSync } from "node:sqlite";
import type {
  FusionCheckInput,
  FusionDocumentBindingDto,
  FusionInspectionDto,
  FusionReadinessDto,
  FusionReconciliationPollDto,
} from "@chamfer/shared";
import { fusionReadinessAllowsInspection } from "@chamfer/shared";
import { getConversation } from "../conversationStore";
import { withImmediateTransaction } from "../dbTransaction";
import type { FusionReadinessProvider } from "./readiness";
import {
  demoteFusionOwner,
  fusionDocumentMatches,
  getFusionBinding,
  getManagedFusionBinding,
  insertFusionBinding,
  refreshFusionBinding,
  releaseDeadFusionBindings,
  transferFusionOwnership,
} from "./ownershipStore";
import { evaluateFusionChecks } from "./inspection";
import { ensureFusionVisualArtifact, recordFusionInspection } from "./inspectionStore";
import { latestChamferProducedFusionAction, latestCompletedFusionOperationalContext, listFusionActionLedger } from "./actionLedger";
import { getFusionReconciliation, recordFusionReconciliation } from "./reconciliationStore";
import { refreshFusionChecksForManualState } from "./reconciliation";
import { currentFusionRecovery } from "./recoveryStore";

export class FusionOwnershipError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 503) {
    super(message);
  }
}

const OVERRIDES = {
  "wrong-document": {
    label: "Wrong document",
    diagnosis: "The active Fusion design is not the conversation's bound document.",
    mutationAllowed: false,
  },
  "read-only": {
    label: "Read only",
    diagnosis: "Another conversation owns this Fusion document. Transfer ownership to make changes here.",
    mutationAllowed: false,
  },
} as const;

function requireFusionConversation(db: DatabaseSync, conversationId: string): void {
  const conversation = getConversation(db, conversationId);
  if (!conversation) throw new FusionOwnershipError("Conversation not found.", 404);
  if (conversation.cadEnvironment !== "fusion") {
    throw new FusionOwnershipError("Only Autodesk Fusion conversations can bind Fusion documents.", 409);
  }
}

export class FusionOwnership {
  constructor(private readonly db: DatabaseSync, private readonly readiness: FusionReadinessProvider) {}

  async current(conversationId?: string): Promise<FusionReadinessDto> {
    const inspected = await this.readiness.current();
    const recovery = currentFusionRecovery(this.db, inspected.endpoint);
    const withRecovery = recovery ? {
      ...inspected,
      state: recovery.state === "diagnosing" ? "busy" as const : "degraded" as const,
      label: recovery.state === "diagnosing" ? "Recovering" : "Recovery required",
      diagnosis: recovery.diagnosis,
      mutationAllowed: false,
      recovery,
    } : inspected;
    if (!conversationId) return withRecovery;
    requireFusionConversation(this.db, conversationId);
    const existing = getFusionBinding(this.db, conversationId);
    if (!existing) return withRecovery;
    if (withRecovery.state === "unavailable" || withRecovery.state === "incompatible") {
      return { ...withRecovery, binding: existing };
    }
    if (existing.endpoint !== withRecovery.endpoint) {
      return { ...withRecovery, ...OVERRIDES["wrong-document"], state: "wrong-document", binding: existing };
    }
    const provisionalDocumentOpen = existing.identityKind === "provisional"
      ? this.readiness.documentIsOpen?.(existing.document.id)
      : undefined;
    const binding = refreshFusionBinding(this.db, existing, withRecovery.document, provisionalDocumentOpen);
    if (withRecovery.state === "no-document") return { ...withRecovery, binding };
    if (!fusionDocumentMatches(binding, withRecovery.endpoint, withRecovery.document)) {
      return { ...withRecovery, ...OVERRIDES["wrong-document"], state: "wrong-document", binding };
    }
    if (binding.role === "read-only") {
      return { ...withRecovery, ...OVERRIDES["read-only"], state: "read-only", binding };
    }
    return { ...withRecovery, binding };
  }

  async bind(conversationId: string): Promise<FusionDocumentBindingDto> {
    requireFusionConversation(this.db, conversationId);
    const inspected = await this.readiness.current();
    if (!inspected.document) throw new FusionOwnershipError("No active Fusion document is available to bind.", 503);
    const document = inspected.document;

    return withImmediateTransaction(this.db, () => {
      const existing = getFusionBinding(this.db, conversationId);
      if (existing) {
        if (existing.endpoint !== inspected.endpoint ||
            !fusionDocumentMatches(existing, inspected.endpoint, document)) {
          throw new FusionOwnershipError("The active Fusion document is not this conversation's bound document.", 409);
        }
        return refreshFusionBinding(this.db, existing, document);
      }
      let managed = getManagedFusionBinding(this.db, inspected.endpoint);
      if (managed && !fusionDocumentMatches(managed, inspected.endpoint, document)) {
        // The user moved on to a different document - created a new design or
        // switched tabs - and that choice is authoritative. The stale managed
        // conversation cannot mutate anyway (every inspection and action checks
        // bound-document identity), so hard-blocking here only dead-ended new
        // conversations. Demote the stale owner to historical read-only and let
        // this conversation manage the currently active document. Never rebind
        // while the endpoint has unresolved recovery or an action in flight.
        if (currentFusionRecovery(this.db, inspected.endpoint) || this.readiness.mutationInProgress?.()) {
          throw new FusionOwnershipError("This Fusion endpoint manages another document and cannot rebind while an action lease or recovery is unresolved.", 409);
        }
        demoteFusionOwner(this.db, inspected.endpoint);
        managed = undefined;
      }
      // No live owner manages the endpoint: clear any dead (non-resumable) binding
      // still holding the owner slot so the fresh owner INSERT cannot collide with
      // it on the partial unique index.
      if (!managed) releaseDeadFusionBindings(this.db, inspected.endpoint);
      return insertFusionBinding(
        this.db,
        conversationId,
        inspected.endpoint,
        document,
        managed ? "read-only" : "owner",
      );
    });
  }

  async transfer(conversationId: string): Promise<FusionDocumentBindingDto> {
    requireFusionConversation(this.db, conversationId);
    const existing = getFusionBinding(this.db, conversationId);
    if ((existing && currentFusionRecovery(this.db, existing.endpoint)) || this.readiness.mutationInProgress?.()) {
      throw new FusionOwnershipError("Fusion ownership cannot transfer while an action lease or recovery is unresolved.", 409);
    }
    const inspected = await this.readiness.current();
    if (currentFusionRecovery(this.db, inspected.endpoint)) {
      throw new FusionOwnershipError("Fusion ownership cannot transfer while action recovery is unresolved.", 409);
    }
    if (this.readiness.mutationInProgress?.()) {
      throw new FusionOwnershipError("Fusion ownership cannot transfer while an action lease is unresolved.", 409);
    }
    if (!inspected.document) throw new FusionOwnershipError("No active Fusion document is available to inspect.", 503);
    const document = inspected.document;

    return withImmediateTransaction(this.db, () => {
      if (this.readiness.mutationInProgress?.()) {
        throw new FusionOwnershipError("Fusion ownership cannot transfer while an action lease is unresolved.", 409);
      }
      const managed = getManagedFusionBinding(this.db, inspected.endpoint);
      if (!managed || !fusionDocumentMatches(managed, inspected.endpoint, document)) {
        throw new FusionOwnershipError("The active Fusion document is not the managed document.", 409);
      }
      let receiver = getFusionBinding(this.db, conversationId);
      if (!receiver) {
        receiver = insertFusionBinding(this.db, conversationId, inspected.endpoint, document, "read-only");
      }
      if (receiver.endpoint !== inspected.endpoint ||
          !fusionDocumentMatches(receiver, inspected.endpoint, document)) {
        throw new FusionOwnershipError("The receiving conversation is bound to another Fusion document.", 409);
      }
      return transferFusionOwnership(this.db, inspected.endpoint, conversationId);
    });
  }

  async inspect(conversationId: string, checks: FusionCheckInput[] = []): Promise<FusionInspectionDto> {
    const readiness = await this.current(conversationId);
    const binding = readiness.binding;
    if (!binding || !readiness.document || readiness.state === "wrong-document" || readiness.state === "no-document") {
      throw new FusionOwnershipError("The active Fusion document is not this conversation's bound document.", 409);
    }
    if (!fusionReadinessAllowsInspection(readiness.state)) {
      throw new FusionOwnershipError("Fusion is not available for trusted inspection.", 503);
    }
    if (!this.readiness.captureInspection) {
      throw new FusionOwnershipError("The Fusion connector does not provide trusted inspection.", 503);
    }
    // Render the multi-view sheet (and move the camera) only when the caller asks
    // for a visual read; a scalar inspection stays camera-still and pixel-free.
    const wantsViews = checks.some((check) => (check as { kind?: unknown }).kind === "visual-evidence");
    const captured = await this.readiness.captureInspection(readiness.document, wantsViews);
    this.readiness.markCameraRestoration?.(captured.cameraRestored);
    const results = evaluateFusionChecks(
      captured.snapshot,
      checks,
      { views: captured.screenshots.map((screenshot) => screenshot.view), cameraRestored: captured.cameraRestored },
    );
    const recorded = recordFusionInspection(this.db, conversationId, captured, results);
    const preceding = recorded.history.find((inspection) => inspection.stale && inspection.revision !== captured.revision);
    const operational = latestCompletedFusionOperationalContext(this.db, conversationId);
    const latestCompletedAction = latestChamferProducedFusionAction(listFusionActionLedger(this.db, conversationId));
    const reconciliationChecks = operational
      ? refreshFusionChecksForManualState(captured.snapshot, operational.expectedEffects ?? [])
      : results;
    const reconciliation = preceding && latestCompletedAction?.finalRevision !== captured.revision
      ? recordFusionReconciliation(this.db, conversationId, readiness.document, preceding, recorded.current,
          operational?.affectedReferences ?? [], reconciliationChecks)
      : getFusionReconciliation(this.db, conversationId, captured.revision);
    const hasSupersededEvidence = recorded.history.some((inspection) => inspection.stale);
    const finalReadiness = captured.cameraRestored
      ? { ...readiness, cameraRestored: true }
      : {
          ...readiness,
          state: "degraded" as const,
          label: "Degraded",
          diagnosis: "Fusion did not restore the exact prior camera; modeling remains blocked.",
          mutationAllowed: false as const,
          cameraRestored: false,
        };
    // A rendered visual read registers as this conversation's current visual
    // artifact: visual finalization of a finished design must be satisfiable
    // read-only, without mutating the document just to recapture evidence.
    let visualArtifact: { artifactId: string; artifactVersion: number } | undefined;
    if (captured.screenshots.length > 0) {
      try {
        visualArtifact = ensureFusionVisualArtifact(this.db, conversationId, recorded.current.id, captured.revision);
      } catch {
        // The inspection itself is authoritative; missing auxiliary visual
        // persistence only leaves visual finalization pending.
      }
    }
    return {
      document: readiness.document,
      readiness: finalReadiness,
      ...recorded,
      earlierActionPlansStale: hasSupersededEvidence,
      earlierCompletionEvidenceStale: hasSupersededEvidence,
      ...(reconciliation ? { reconciliation } : {}),
      ...(visualArtifact ? { visualArtifact } : {}),
    };
  }

  async reconcileIfChanged(conversationId: string): Promise<FusionReconciliationPollDto> {
    const readiness = await this.current(conversationId);
    const binding = readiness.binding;
    if (!binding || !readiness.document || !fusionReadinessAllowsInspection(readiness.state)) return { changed: false };
    if (!this.readiness.captureInspectionIfChanged) return { changed: false };
    const row = this.db.prepare(`SELECT revision FROM fusion_inspections
      WHERE conversation_id = ? AND stale_at IS NULL ORDER BY captured_at DESC LIMIT 1`).get(conversationId) as { revision: string } | undefined;
    if (!row) return { changed: false };
    const captured = await this.readiness.captureInspectionIfChanged(readiness.document, row.revision);
    if (!captured) {
      // An agent-tool inspection may already have consumed the revision change
      // and recorded the reconciliation. Return the authoritative revision and
      // that persisted record so the browser can still cancel stale streaming
      // work and resume from the refreshed evidence.
      const persisted = getFusionReconciliation(this.db, conversationId, row.revision);
      return { changed: false, revision: row.revision, ...(persisted ? { reconciliation: persisted } : {}) };
    }
    const operational = latestCompletedFusionOperationalContext(this.db, conversationId);
    const checks = operational
      ? refreshFusionChecksForManualState(captured.snapshot, operational.expectedEffects ?? [])
      : [];
    const recorded = recordFusionInspection(this.db, conversationId, captured, checks);
    const preceding = recorded.history.find((inspection) => inspection.stale && inspection.revision !== captured.revision);
    // A revision Chamfer itself just produced is not a manual edit; only
    // reconcile when the current revision was not the result of our own latest
    // completed action.
    const chamferProduced = latestChamferProducedFusionAction(listFusionActionLedger(this.db, conversationId));
    const reconciliation = preceding && chamferProduced?.finalRevision !== captured.revision
      ? recordFusionReconciliation(this.db, conversationId, readiness.document, preceding, recorded.current,
          operational?.affectedReferences ?? [], checks)
      : undefined;
    const inspection: FusionInspectionDto = {
      document: readiness.document,
      readiness,
      ...recorded,
      earlierActionPlansStale: true,
      earlierCompletionEvidenceStale: true,
      ...(reconciliation ? { reconciliation } : {}),
    };
    return { changed: true, inspection };
  }
}
