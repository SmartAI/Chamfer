import type { DatabaseSync } from "node:sqlite";
import type {
  FusionCheckResultDto, FusionDocumentIdentityDto, FusionInspectionDto, FusionReadinessDto, FusionSaveResultDto,
} from "@chamfer/shared";
import { fusionCompletionEvidencePassed } from "@chamfer/shared";
import { withImmediateTransaction } from "../dbTransaction";
import type { CapturedFusionInspection } from "./inspection";
import { listFusionInspectionHistory } from "./inspectionStore";
import { fusionDocumentMatches, getFusionBinding, refreshFusionBinding } from "./ownershipStore";
import type { FusionReadinessProvider } from "./readiness";
import { recordFusionSaveEvidence } from "./saveEvidence";
import { currentFusionRecovery } from "./recoveryStore";

export class FusionLifecycleError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 503) { super(message); }
}

export class FusionLifecycleRuntimeError extends Error {
  constructor(message: string, readonly reason: "already-saved" | "busy" | "canceled" | "failed" | "stale-revision" | "wrong-document") {
    super(message);
  }
}

export interface FusionLifecycleRuntime {
  save(expectedDocument: FusionDocumentIdentityDto, expectedRevision: string): Promise<{
    document: FusionDocumentIdentityDto;
    captured: CapturedFusionInspection;
    readiness: FusionReadinessDto;
  }>;
}

interface CurrentInspectionRow { revision: string }
interface TerminalActionRow { event: "completed" | "rejected" | "failed"; final_revision: string | null; result_json: string }

function passingCompletion(db: DatabaseSync, conversationId: string): { revision: string; checks: FusionCheckResultDto[] } | undefined {
  const inspection = db.prepare(`SELECT revision FROM fusion_inspections
    WHERE conversation_id = ? AND stale_at IS NULL ORDER BY captured_at DESC, rowid DESC LIMIT 1`)
    .get(conversationId) as CurrentInspectionRow | undefined;
  const terminal = db.prepare(`SELECT event, final_revision, result_json FROM fusion_action_ledger
    WHERE conversation_id = ? AND event IN ('completed', 'rejected', 'failed') ORDER BY rowid DESC LIMIT 1`)
    .get(conversationId) as TerminalActionRow | undefined;
  if (!inspection || !terminal || terminal.final_revision !== inspection.revision) return undefined;
  const result = JSON.parse(terminal.result_json) as Record<string, unknown>;
  if (!fusionCompletionEvidencePassed({
    event: terminal.event,
    ...(terminal.final_revision ? { finalRevision: terminal.final_revision } : {}),
    result,
  }, inspection.revision)) return undefined;
  const checks = result.checks as FusionCheckResultDto[];
  return { revision: inspection.revision, checks };
}

export class FusionLifecycle {
  constructor(
    private readonly db: DatabaseSync,
    private readonly runtime: FusionLifecycleRuntime,
    private readonly readiness: FusionReadinessProvider,
  ) {}

  async save(conversationId: string, requestedDocument: FusionDocumentIdentityDto): Promise<FusionSaveResultDto> {
    const binding = getFusionBinding(this.db, conversationId);
    if (!binding) throw new FusionLifecycleError("The conversation has no bound Fusion document.", 404);
    if (binding.role !== "owner" || !binding.resumable) {
      throw new FusionLifecycleError("Only the owning conversation can save its resumable Fusion document.", 409);
    }
    if (!fusionDocumentMatches(binding, binding.endpoint, requestedDocument)) {
      throw new FusionLifecycleError("The requested Save target is not the bound Fusion document.", 409);
    }
    if (currentFusionRecovery(this.db, binding.endpoint)) {
      throw new FusionLifecycleError("Fusion Save is blocked while action recovery is unresolved.", 409);
    }
    if (this.readiness.mutationInProgress?.()) {
      throw new FusionLifecycleError("Fusion Save is blocked while an action lease is unresolved.", 409);
    }
    const completion = passingCompletion(this.db, conversationId);
    if (!completion) throw new FusionLifecycleError("Save requires current passing Fusion completion evidence.", 409);
    const live = await this.readiness.current();
    if (live.state !== "ready" || !fusionDocumentMatches(binding, live.endpoint, live.document)) {
      throw new FusionLifecycleError("Fusion is not ready on the exact bound Save target.", 409);
    }
    if (binding.identityKind === "durable" && live.documentModified !== true) {
      throw new FusionLifecycleError("The bound Fusion document has no unpersisted changes.", 409);
    }

    let saved: Awaited<ReturnType<FusionLifecycleRuntime["save"]>>;
    try {
      saved = await this.runtime.save(binding.document, completion.revision);
    } catch (error) {
      if (error instanceof FusionLifecycleRuntimeError) {
        throw new FusionLifecycleError(error.message, error.reason === "failed" ? 503 : 409);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new FusionLifecycleError(message, /cancel/i.test(message) ? 409 : 503);
    }
    if (saved.document.id !== binding.document.id || !saved.document.dataFileId) {
      throw new FusionLifecycleError("Fusion returned a different document identity after Save.", 409);
    }
    if (saved.captured.revision !== completion.revision) {
      throw new FusionLifecycleError("Fusion engineering state changed during Save; the previous binding was preserved.", 409);
    }
    if (saved.readiness.endpoint !== binding.endpoint || !saved.readiness.document ||
        saved.readiness.document.id !== saved.document.id ||
        saved.readiness.document.dataFileId !== saved.document.dataFileId) {
      throw new FusionLifecycleError("The active Fusion document changed after Save; the previous binding was preserved.", 409);
    }

    const { promoted, evidence } = withImmediateTransaction(this.db, () => {
      const nextBinding = refreshFusionBinding(this.db, binding, saved.document);
      const nextEvidence = recordFusionSaveEvidence(
        this.db, conversationId, binding.document, saved.document, saved.captured, completion.checks,
      );
      return { promoted: nextBinding, evidence: nextEvidence };
    });
    if (promoted.identityKind !== "durable") {
      throw new FusionLifecycleError("Fusion Save did not produce durable document identity.", 503);
    }
    const engineeringHistory = listFusionInspectionHistory(this.db, conversationId);
    const stale = engineeringHistory.some((record) => record.stale);
    const inspection: FusionInspectionDto = {
      document: promoted.document,
      readiness: { ...saved.readiness, binding: promoted },
      current: evidence.inspection,
      history: [evidence.inspection, ...engineeringHistory],
      earlierActionPlansStale: stale,
      earlierCompletionEvidenceStale: stale,
    };
    return { binding: promoted, inspection, evidence };
  }
}
