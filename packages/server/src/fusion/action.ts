import type { DatabaseSync } from "node:sqlite";
import type {
  FusionActionRequestDto, FusionActionResultDto, FusionCheckResultDto, FusionDocumentIdentityDto,
  FusionInspectionDto, FusionReadinessDto,
} from "@chamfer/shared";
import { getConversation, getMessage, listMessages } from "../conversationStore";
import { readEffectiveSettings } from "../settingsStore";
import { evaluateFusionChecks } from "./inspection";
import type { CapturedFusionInspection } from "./inspection";
import { ensureFusionVisualArtifact, recordFusionInspection } from "./inspectionStore";
import {
  appendFusionActionLedger, fusionLedgerActionIdentity, latestChamferProducedFusionAction,
  latestCompletedFusionOperationalContext, listFusionActionLedger, recordFusionActionOperationalContext,
} from "./actionLedger";
import { FUSION_ACTION_POLICY_VERSION, validateFusionActionBody } from "./actionPolicy";
import { fusionDocumentMatches, getFusionBinding } from "./ownershipStore";
import {
  getFusionReconciliation,
  getFusionReconciliationResolution,
  recordFusionReconciliation,
  recordFusionReconciliationResolution,
} from "./reconciliationStore";
import { fusionIntentPreservationViolations } from "./preservation";
import { refreshFusionChecksForManualState } from "./reconciliation";
import { appendFusionRecovery, currentFusionRecovery } from "./recoveryStore";

export class FusionActionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503, readonly reason: string) { super(message); }
}

export class FusionActionLeaseUnavailableError extends Error {}

export interface FusionActionExecution {
  commandId: string;
  undoEntries: number;
}

export interface FusionActionLeaseContext {
  current(): Promise<FusionReadinessDto>;
  captureInspection(document: FusionDocumentIdentityDto, captureViews?: boolean): Promise<CapturedFusionInspection>;
  /** Drops a possibly broken mutation session, reconnects, and performs only
   * trusted reads. It must never retry the action body. */
  diagnose?(document: FusionDocumentIdentityDto): Promise<CapturedFusionInspection>;
  execute(request: FusionActionRequestDto, resolvedReferences: Record<string, string>): Promise<FusionActionExecution>;
  undo(): Promise<void>;
  /** Undo repeatedly until the token-free fingerprint matches `target`, bounded
   * by `maxSteps`. Returns whether the baseline geometry was restored. Lets the
   * rollback succeed even when trusted inspection pushed its own Undo entries. */
  verifiedUndo?(document: FusionDocumentIdentityDto, target: string, maxSteps: number): Promise<boolean>;
  markRecoveryFailure(): void;
}

export interface FusionActionRuntime {
  runExclusive<T>(operation: (context: FusionActionLeaseContext) => Promise<T>): Promise<T>;
}

const DESTRUCTIVE_NEGATION = /\b(?:do not|don't|without|avoid|preserve)\b[^.\n]{0,40}\b(?:rebuild|replace|discard|delete)\b/i;

function executionFailureClass(error: unknown): "canceled" | "timeout" | "disconnect" | "transaction-failure" {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timeout|timed out|TimeoutError/i.test(message)) return "timeout";
  if (/cancel|abort|AbortError/i.test(message)) return "canceled";
  if (/disconnect|connection|socket|fetch failed|network/i.test(message)) return "disconnect";
  return "transaction-failure";
}

/** A bounded, provider-safe detail from a failed execution. The action body's
 * own runtime error - a Fusion API exception or Python traceback from code the
 * model itself wrote - carries no endpoint, credential, or native-token data,
 * so surfacing it lets the model fix the real fault instead of guessing blindly
 * at an opaque "did not complete" result. */
function executionFailureDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  const trimmed = message?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)} [...]` : trimmed;
}

function sameReferences(left: FusionActionRequestDto["affectedReferences"], right: FusionActionRequestDto["affectedReferences"]): boolean {
  const key = (reference: FusionActionRequestDto["affectedReferences"][number]) => `${reference.kind}:${reference.id}`;
  return left.length === right.length && left.map(key).sort().every((value, index) => value === right.map(key).sort()[index]);
}

function canonicalReferences(references: FusionActionRequestDto["affectedReferences"]): string {
  return references.map((reference) => `${reference.kind}:${reference.id}`).sort().join(",") || "none";
}

function persistedUserStatement(contentJson: string): string | undefined {
  try {
    const parsed = JSON.parse(contentJson) as { role?: unknown; content?: unknown };
    if (parsed.role !== "user" || !Array.isArray(parsed.content)) return undefined;
    return parsed.content
      .filter((block): block is { type: "text"; text: string } => (block as { type?: unknown })?.type === "text" && typeof (block as { text?: unknown }).text === "string")
      .map((block) => block.text).join("\n").trim();
  } catch {
    return undefined;
  }
}

function inspectDto(
  readiness: FusionReadinessDto,
  binding: NonNullable<FusionReadinessDto["binding"]>,
  recorded: ReturnType<typeof recordFusionInspection>,
): FusionInspectionDto {
  const stale = recorded.history.some((inspection) => inspection.stale);
  return { document: binding.document, readiness: { ...readiness, binding }, ...recorded,
    earlierActionPlansStale: stale, earlierCompletionEvidenceStale: stale };
}

function structuralChecks(capture: CapturedFusionInspection): FusionCheckResultDto[] {
  return [
    { kind: "parametric-design", status: capture.snapshot.designIntent.designType === "parametric" ? "passed" : "failed",
      detail: capture.snapshot.designIntent.designType === "parametric" ? "Design history is parametric." : "Design is not parametric." },
    { kind: "solid-integrity", status: capture.snapshot.bodies.length > 0 && capture.snapshot.bodies.every((body) => body.solid) ? "passed" : "failed",
      detail: capture.snapshot.bodies.length > 0 && capture.snapshot.bodies.every((body) => body.solid)
        ? "At least one resulting body exists and all resulting bodies are solid."
        : "The action did not produce a non-empty set of solid bodies." },
  ];
}

export class FusionActions {
  constructor(private readonly db: DatabaseSync, private readonly runtime: FusionActionRuntime) {}

  history(conversationId: string) { return listFusionActionLedger(this.db, conversationId); }

  async execute(conversationId: string, request: FusionActionRequestDto, requestSignal?: AbortSignal): Promise<FusionActionResultDto> {
    const priorHistory = this.history(conversationId);
    const priorAttempt = priorHistory.some((record) => record.actionId === fusionLedgerActionIdentity(request.actionId));
    const ledgerIds: string[] = [];
    const append = (event: Parameters<typeof appendFusionActionLedger>[4], details?: Parameters<typeof appendFusionActionLedger>[5]) => {
      const record = appendFusionActionLedger(this.db, conversationId, request, FUSION_ACTION_POLICY_VERSION, event, details);
      ledgerIds.push(record.id);
      return record;
    };
    append("attempt", { result: { strategy: request.strategy, ...(request.destructiveApproval ? { destructiveApproval: request.destructiveApproval } : {}) } });
    if (priorAttempt) { append("rejected", { result: { reason: "duplicate-action" } }); throw new FusionActionError("This Fusion action identity has already been attempted.", 409, "duplicate-action"); }
    const conversation = getConversation(this.db, conversationId);
    if (!conversation) { append("rejected", { result: { reason: "conversation-not-found" } }); throw new FusionActionError("Conversation not found.", 404, "conversation-not-found"); }
    if (conversation.cadEnvironment !== "fusion") { append("rejected", { result: { reason: "wrong-environment" } }); throw new FusionActionError("Only Fusion conversations can execute Fusion actions.", 409, "wrong-environment"); }
    const configuredModel = readEffectiveSettings(this.db).settings.modelJson;
    if (configuredModel) {
      try {
        const parsed = JSON.parse(configuredModel) as { provider?: unknown; id?: unknown };
        if ((typeof parsed.provider === "string" && parsed.provider !== request.model.provider)
          || (typeof parsed.id === "string" && parsed.id !== request.model.model)) {
          append("rejected", { result: { reason: "model-identity" } });
          throw new FusionActionError("The action model identity does not match Chamfer's configured model.", 409, "model-identity");
        }
      } catch (error) {
        if (error instanceof FusionActionError) throw error;
        append("rejected", { result: { reason: "model-configuration" } });
        throw new FusionActionError("Chamfer's configured model identity is invalid.", 503, "model-configuration");
      }
    }
    const binding = getFusionBinding(this.db, conversationId);
    if (!binding || binding.role !== "owner" || !binding.resumable) { append("rejected", { result: { reason: "not-owner" } }); throw new FusionActionError("The conversation does not own a resumable Fusion document.", 409, "not-owner"); }
    const unresolvedRecovery = currentFusionRecovery(this.db, binding.endpoint);
    if (unresolvedRecovery) {
      append("rejected", { result: { reason: "recovery-unresolved", failureClass: unresolvedRecovery.failureClass } });
      throw new FusionActionError(`Fusion mutation is blocked while recovery is unresolved. Allowed operation: ${unresolvedRecovery.allowedOperation}.`, 409, "recovery-unresolved");
    }
    if (!fusionDocumentMatches(binding, binding.endpoint, request.document)) { append("rejected", { result: { reason: "wrong-document" } }); throw new FusionActionError("The action declares the wrong bound Fusion document.", 409, "wrong-document"); }
    const expectedEvidence = this.db.prepare("SELECT revision FROM fusion_inspections WHERE id = ? AND conversation_id = ?")
      .get(request.expectedEvidenceId, conversationId) as { revision: string } | undefined;
    if (!expectedEvidence || expectedEvidence.revision !== request.expectedRevision) {
      append("rejected", { result: { reason: "evidence-identity" } });
      throw new FusionActionError("The action does not identify trusted evidence for its expected Fusion revision.", 409, "evidence-identity");
    }
    if (request.strategy === "destructive-rebuild") {
      const approval = request.destructiveApproval;
      const evidence = approval ? getMessage(this.db, approval.evidenceMessageId) : undefined;
      const statement = evidence ? persistedUserStatement(evidence.contentJson) : undefined;
      const latestUserMessage = [...listMessages(this.db, conversationId)].reverse().find((message) => {
        const text = message.role === "user" ? persistedUserStatement(message.contentJson) : undefined;
        return text && !text.startsWith("[Chamfer");
      });
      const alreadyUsed = approval ? priorHistory.some((record) => {
        const previous = record.result.destructiveApproval as { evidenceMessageId?: unknown } | undefined;
        return previous?.evidenceMessageId === approval.evidenceMessageId;
      }) : false;
      if (!approval || !evidence || evidence.conversationId !== conversationId || evidence.role !== "user" || latestUserMessage?.id !== evidence.id
        || approval.expectedRevision !== request.expectedRevision || approval.intent !== request.intent || alreadyUsed
        || statement !== approval.statement.trim() || statement.includes("?") || DESTRUCTIVE_NEGATION.test(statement)
        || (approval.basis === "original-replacement-request" ? statement !== `REQUEST FUSION REBUILD: ${request.intent}`
          : statement !== `CONFIRM FUSION REBUILD ${request.expectedRevision}: ${request.intent}`)) {
        append("rejected", { result: { reason: "destructive-approval-required" } });
        throw new FusionActionError("Destructive rebuilding requires a persisted user message that explicitly requests or approves replacement.", 409, "destructive-approval-required");
      }
    }
    const policy = validateFusionActionBody(request.body, { allowDestructive: request.strategy === "destructive-rebuild" });
    if (!policy.ok) { append("rejected", { result: { reason: "policy", violations: policy.violations } }); throw new FusionActionError(`Fusion action policy rejected the body: ${policy.violations.join(" ")}`, 400, "policy"); }
    recordFusionActionOperationalContext(this.db, conversationId, request);

    let mutationStarted = false;
    let interruptionRecorded = false;
    let recoveryStarted = false;
    let recoveryFailureClass: Parameters<typeof appendFusionRecovery>[1]["failureClass"] | undefined;
    const recovery = (state: "diagnosing" | "hard-recovery" | "resolved", failureClass: Parameters<typeof appendFusionRecovery>[1]["failureClass"],
      diagnosis: string, allowedOperation: Parameters<typeof appendFusionRecovery>[1]["allowedOperation"], precedingRevision: string,
      observedRevision?: string, evidenceIds: string[] = []) => appendFusionRecovery(this.db, {
        conversationId, endpoint: binding.endpoint, actionId: request.actionId, state, failureClass, diagnosis,
        allowedOperation, precedingRevision, ...(observedRevision ? { observedRevision } : {}), evidenceIds,
      });
    try {
      return await this.runtime.runExclusive(async (runtime) => {
        const readiness = await runtime.current();
        if (readiness.state !== "ready" || !readiness.document || !fusionDocumentMatches(binding, readiness.endpoint, readiness.document)) {
          append("rejected", { result: { reason: readiness.state === "ready" ? "wrong-document" : "non-ready", state: readiness.state } });
          throw new FusionActionError("Fusion is not ready on the bound document.", 409, readiness.state === "ready" ? "wrong-document" : "non-ready");
        }
        const before = await runtime.captureInspection(binding.document);
        const beforeRecorded = recordFusionInspection(this.db, conversationId, before, []);
        if (before.revision !== request.expectedRevision) {
          const preceding = beforeRecorded.history.find((inspection) => inspection.revision === request.expectedRevision);
          const operational = latestCompletedFusionOperationalContext(this.db, conversationId);
          const reconciliation = preceding
            ? recordFusionReconciliation(this.db, conversationId, binding.document, preceding, beforeRecorded.current,
                operational?.affectedReferences ?? [], operational ? refreshFusionChecksForManualState(before.snapshot, operational.expectedEffects ?? []) : [])
            : undefined;
          const reason = reconciliation?.status === "needs-user" ? "manual-edit-needs-user" : reconciliation ? "stale-revision-reconciled" : "stale-revision";
          append("rejected", { observedRevision: before.revision, result: { reason, ...(reconciliation ? { reconciliationId: reconciliation.id } : {}) }, evidenceIds: [beforeRecorded.current.id] });
          throw new FusionActionError(reconciliation?.status === "needs-user"
            ? "The Fusion revision changed ambiguously; user direction is required before mutation."
            : "The expected Fusion revision was reconciled; inspect the refreshed state before constructing another action.", 409, reason);
        }
        const currentReconciliation = getFusionReconciliation(this.db, conversationId, before.revision);
        const latestCompleted = latestChamferProducedFusionAction(priorHistory);
        const chamferProducedCurrentOccurrence = latestCompleted?.finalRevision === before.revision
          && (!currentReconciliation || latestCompleted.recordedAt >= currentReconciliation.recordedAt);
        const unresolved = chamferProducedCurrentOccurrence ? undefined : currentReconciliation;
        if (unresolved?.status === "needs-user") {
          const existingResolution = getFusionReconciliationResolution(this.db, unresolved.id);
          let resolution = existingResolution && existingResolution.expectedRevision === before.revision
            && existingResolution.intent === request.intent
            && sameReferences(existingResolution.affectedReferences ?? [], request.affectedReferences) ? existingResolution : undefined;
          if (!existingResolution) {
            const authority = request.reconciliationResolution;
            const evidence = authority ? getMessage(this.db, authority.evidenceMessageId) : undefined;
            const statement = evidence ? persistedUserStatement(evidence.contentJson) : undefined;
            const latestUserMessage = [...listMessages(this.db, conversationId)].reverse().find((message) => {
              const text = message.role === "user" ? persistedUserStatement(message.contentJson) : undefined;
              return text && !text.startsWith("[Chamfer");
            });
            const expectedStatement = `CONFIRM FUSION RECONCILIATION ${unresolved.id} AT ${before.revision} REFERENCES ${canonicalReferences(request.affectedReferences)}: ${request.intent}`;
            if (authority && evidence?.conversationId === conversationId && evidence.role === "user"
              && evidence.createdAt > unresolved.recordedAt && latestUserMessage?.id === evidence.id
              && authority.reconciliationId === unresolved.id && authority.expectedRevision === before.revision
              && authority.intent === request.intent && sameReferences(authority.affectedReferences, request.affectedReferences)
              && authority.statement.trim() === statement && statement === expectedStatement) {
              resolution = recordFusionReconciliationResolution(this.db, unresolved, evidence.id, before.revision, request.intent, request.affectedReferences);
            }
          }
          if (!resolution) {
            append("rejected", { observedRevision: before.revision, result: { reason: "manual-edit-needs-user", reconciliationId: unresolved.id }, evidenceIds: [beforeRecorded.current.id] });
            throw new FusionActionError(`The current manual Fusion edit needs explicit direction before mutation. Confirm exactly: CONFIRM FUSION RECONCILIATION ${unresolved.id} AT ${before.revision} REFERENCES ${canonicalReferences(request.affectedReferences)}: ${request.intent}`, 409, "manual-edit-needs-user");
          }
        }
        const resolvedReferences: Record<string, string> = {};
        for (const reference of request.affectedReferences) {
          const entity = before.snapshot.entities.find((candidate) => candidate.kind === reference.kind && candidate.id === reference.id);
          if (!entity?.nativeToken) {
            append("rejected", { observedRevision: before.revision, result: { reason: "unresolved-reference", reference }, evidenceIds: [beforeRecorded.current.id] });
            throw new FusionActionError(`Fusion reference ${reference.kind}:${reference.id} is unavailable at the expected revision.`, 409, "unresolved-reference");
          }
          resolvedReferences[reference.id] = entity.nativeToken;
        }

        // Token-free baseline computed inside the same trusted execution as the
        // before-inspection, so the rollback path can verify that Undo restored
        // the exact pre-action geometry even though trusted inspection pushed
        // its own Undo entries. Best-effort: when absent the rollback falls back
        // to a single blind Undo.
        const beforeFingerprint = before.fingerprint;
        if (requestSignal?.aborted) {
          const failureClass = executionFailureClass(requestSignal.reason);
          append("rejected", { observedRevision: before.revision, result: { reason: failureClass }, evidenceIds: [beforeRecorded.current.id] });
          throw new FusionActionError("Fusion action was interrupted before execution; the document was not changed.", 409, failureClass);
        }
        const onRequestAbort = () => {
          if (!mutationStarted || interruptionRecorded) return;
          interruptionRecorded = true;
          recoveryStarted = true;
          const failureClass = executionFailureClass(requestSignal?.reason);
          recoveryFailureClass = failureClass;
          recovery("diagnosing", failureClass,
            "The action request was interrupted after mutation began. Chamfer is retaining the action lease until trusted inspection establishes the document state.",
            "wait-for-trusted-inspection", before.revision, undefined, [beforeRecorded.current.id]);
        };
        requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
        try {
          mutationStarted = true;
          let execution: FusionActionExecution;
          try {
            execution = await runtime.execute(request, resolvedReferences);
          } catch (error) {
            requestSignal?.removeEventListener("abort", onRequestAbort);
            const failureClass = interruptionRecorded ? executionFailureClass(requestSignal?.reason) : executionFailureClass(error);
            recoveryFailureClass = failureClass;
            if (!recoveryStarted) recovery("diagnosing", failureClass,
              "The Fusion mutation ended without a trusted result. Chamfer is reconnecting for read-only diagnosis and will not retry the mutation.",
              "wait-for-trusted-inspection", before.revision, undefined, [beforeRecorded.current.id]);
            recoveryStarted = true;
            if (runtime.diagnose) {
              try {
                const diagnosed = await runtime.diagnose(binding.document);
                const diagnosedRecord = recordFusionInspection(this.db, conversationId, diagnosed, []);
                if (diagnosed.revision === before.revision) {
                  recovery("resolved", failureClass,
                    "Trusted inspection proved that the interrupted mutation did not change the authoritative engineering revision.",
                    "none", before.revision, diagnosed.revision, [diagnosedRecord.current.id]);
                  append("failed", { observedRevision: diagnosed.revision, finalRevision: diagnosed.revision,
                    result: { reason: `${failureClass}-no-change` }, evidenceIds: [beforeRecorded.current.id, diagnosedRecord.current.id] });
                  const detail = executionFailureDetail(error);
                  throw new FusionActionError(
                    `Fusion action made no change; the preceding revision is still authoritative.${detail ? ` The action body failed at runtime: ${detail}` : ""}`,
                    503, `${failureClass}-no-change`);
                }
                runtime.markRecoveryFailure();
                recovery("hard-recovery", "revision-uncertain",
                  "Trusted inspection found a different engineering revision after the interrupted mutation. Further mutation, Save, and ownership transfer remain blocked.",
                  "inspect-resulting-state", before.revision, diagnosed.revision, [diagnosedRecord.current.id]);
                append("failed", { observedRevision: diagnosed.revision, finalRevision: diagnosed.revision,
                  result: { reason: "revision-uncertain" }, evidenceIds: [beforeRecorded.current.id, diagnosedRecord.current.id] });
                throw new FusionActionError("Fusion changed during an interrupted action; the resulting revision requires explicit recovery.", 503, "revision-uncertain");
              } catch (diagnosisError) {
                if (diagnosisError instanceof FusionActionError) throw diagnosisError;
              }
            }
            runtime.markRecoveryFailure();
            recovery("hard-recovery", failureClass,
              "Chamfer could not establish the authoritative Fusion revision after the interrupted mutation. Further mutation, Save, and ownership transfer remain blocked.",
              "inspect-resulting-state", before.revision, undefined, [beforeRecorded.current.id]);
            append("failed", { observedRevision: before.revision, result: { reason: failureClass }, evidenceIds: [beforeRecorded.current.id] });
            throw new FusionActionError("Fusion action state is uncertain; mutation is blocked until trusted recovery inspection succeeds.", 503, failureClass);
          }
          if (execution.undoEntries !== 1) {
            runtime.markRecoveryFailure();
            recovery("hard-recovery", "revision-uncertain",
              "Fusion did not establish exactly one native Undo entry, so atomicity and the resulting revision are unresolved.",
              "inspect-resulting-state", before.revision, undefined, [beforeRecorded.current.id]);
            append("failed", { observedRevision: before.revision, result: { reason: "undo-entry-count", undoEntries: execution.undoEntries }, evidenceIds: [beforeRecorded.current.id] });
            throw new FusionActionError("Fusion did not establish exactly one native Undo entry; mutation is blocked for recovery.", 503, "undo-entry-count");
          }
          const rollback = async (checks: FusionCheckResultDto[], observedRevision: string | undefined, evidenceIds: string[]): Promise<FusionActionResultDto> => {
            append("rollback", { ...(observedRevision ? { observedRevision } : {}), result: { reason: "immediate-verification", checks }, evidenceIds });
            let verifiedRestore = false;
            try {
              if (runtime.verifiedUndo && beforeFingerprint) {
                const restoredToBaseline = await runtime.verifiedUndo(binding.document, beforeFingerprint, 8);
                if (!restoredToBaseline) {
                  runtime.markRecoveryFailure();
                  recovery("hard-recovery", "revision-uncertain",
                    "Verified Undo could not restore the preceding engineering fingerprint within the bounded step budget; the authoritative revision is unresolved.",
                    "inspect-resulting-state", before.revision, observedRevision, evidenceIds);
                  append("failed", { ...(observedRevision ? { observedRevision } : {}), finalRevision: before.revision, result: { reason: "rollback-revision-mismatch" }, evidenceIds });
                  throw new FusionActionError("Undo did not restore the preceding authoritative revision; mutation is blocked for recovery.", 503, "rollback-revision-mismatch");
                }
                verifiedRestore = true;
              } else {
                await runtime.undo();
              }
            } catch (error) {
              if (error instanceof FusionActionError) throw error;
              runtime.markRecoveryFailure();
              recovery("hard-recovery", "undo-failure", "Automatic Undo failed. The authoritative Fusion revision is unresolved and all mutation remains blocked.",
                "inspect-resulting-state", before.revision, observedRevision, evidenceIds);
              append("failed", { ...(observedRevision ? { observedRevision } : {}), result: { reason: "rollback-failure" }, evidenceIds });
              throw new FusionActionError("Automatic Undo failed; mutation is blocked for recovery.", 503, "rollback-failure");
            }
            let restored: CapturedFusionInspection;
            try {
              restored = await runtime.captureInspection(binding.document);
            } catch (error) {
              runtime.markRecoveryFailure();
              recovery("hard-recovery", "revision-uncertain", "Chamfer could not inspect the document after Undo; the authoritative revision remains unresolved.",
                "inspect-resulting-state", before.revision, observedRevision, evidenceIds);
              append("failed", { ...(observedRevision ? { observedRevision } : {}), result: { reason: "rollback-inspection-failure" }, evidenceIds });
              throw new FusionActionError("Chamfer could not verify the revision after Undo; mutation is blocked for recovery.", 503, "rollback-inspection-failure");
            }
            const restoredRecorded = recordFusionInspection(this.db, conversationId, restored, []);
            // A successful verifiedUndo has already proven, with the token-free
            // engineering fingerprint, that the geometry is restored. The full
            // revision can still differ in non-geometric fields, so only fall back
            // to strict full-revision equality when we could NOT verify restoration
            // that way - otherwise a correct rollback would spuriously hard-recover.
            if (!verifiedRestore && restored.revision !== before.revision) {
              runtime.markRecoveryFailure();
              recovery("hard-recovery", "revision-uncertain", "Undo completed but did not restore the preceding engineering revision.",
                "inspect-resulting-state", before.revision, restored.revision, [...evidenceIds, restoredRecorded.current.id]);
              append("failed", { ...(observedRevision ? { observedRevision } : {}), finalRevision: restored.revision,
                result: { reason: "rollback-revision-mismatch" }, evidenceIds: [...evidenceIds, restoredRecorded.current.id] });
              throw new FusionActionError("Undo did not restore the preceding authoritative revision; mutation is blocked for recovery.", 503, "rollback-revision-mismatch");
            }
            const finalReadiness = await runtime.current();
            append("completed", { ...(observedRevision ? { observedRevision } : {}), finalRevision: restored.revision,
              result: { status: "rolled-back", undoEntries: 0, checks,
                ...(recoveryFailureClass ? { reason: `${recoveryFailureClass}-resolved` } : {}) },
              evidenceIds: [...evidenceIds, restoredRecorded.current.id] });
            if (recoveryStarted) recovery("resolved", recoveryFailureClass ?? "transaction-failure", "Automatic Undo and trusted inspection restored the preceding authoritative revision.",
              "none", before.revision, restored.revision, [restoredRecorded.current.id]);
            return { actionId: request.actionId, status: "rolled-back", document: binding.document,
              precedingRevision: before.revision, finalRevision: restored.revision, checks,
              inspection: inspectDto(finalReadiness, binding, restoredRecorded), undoEntries: 0, ledgerRecordIds: ledgerIds };
          };
          // Render the post-action view sheet only when this action declares a
          // visual-evidence effect - that keeps the camera still (no flicker) and the
          // model context pixel-free for routine feature actions, and hands back the
          // multi-view sheet exactly when the agent wants to verify the layout.
          const wantsViews = (request.expectedEffects ?? []).some((effect) => (effect as { kind?: unknown }).kind === "visual-evidence");
          let after: CapturedFusionInspection;
          try {
            after = await runtime.captureInspection(binding.document, wantsViews);
          } catch (error) {
            return rollback([{ kind: "independent-inspection", status: "failed", detail: "Trusted post-action inspection failed." }], undefined, [beforeRecorded.current.id]);
          }
          const preservationViolations = request.strategy === "targeted"
            ? fusionIntentPreservationViolations(before.snapshot, after.snapshot, request.affectedReferences)
            : [];
          const structuralResults = [...structuralChecks(after), {
            kind: "intent-preservation",
            status: preservationViolations.length === 0 ? "passed" as const : "failed" as const,
            detail: preservationViolations.length === 0
              ? "Unaffected parameters, constraints, names, references, material, appearance, and manual intent were preserved."
              : preservationViolations.join("; "),
          }];
          const cameraResult: FusionCheckResultDto = {
            kind: "camera-restoration",
            status: after.cameraRestored ? "passed" : "failed",
            detail: after.cameraRestored
              ? "The exact prior Fusion camera was restored."
              : "Engineering state is unchanged, but the exact prior Fusion camera was not restored.",
          };
          // Declared effects are evaluated informationally only: measurements come
          // back with the result so the agent reads real values instead of trusting
          // its own arithmetic, and binding verification is deferred to the final
          // plan completion gate. Only a structurally broken document (non-parametric
          // history, no solid body, or violated manual intent) rolls back.
          const checks = [...structuralResults, ...evaluateFusionChecks(
            after.snapshot,
            request.expectedEffects ?? [],
            { views: after.screenshots.map((screenshot) => screenshot.view), cameraRestored: after.cameraRestored },
          ), cameraResult];
          const afterRecorded = recordFusionInspection(this.db, conversationId, after, checks);
          const structuralFailure = structuralResults.some((check) => check.status !== "passed");
          if (structuralFailure) {
            return rollback(checks, after.revision, [afterRecorded.current.id]);
          }
          const finalReadiness = await runtime.current();
          let visualArtifact: FusionActionResultDto["visualArtifact"];
          try {
            visualArtifact = ensureFusionVisualArtifact(this.db, conversationId, afterRecorded.current.id, after.revision);
          } catch {
            // The native mutation and inspection are already authoritative. Missing auxiliary visual persistence
            // blocks visual finalization but must never turn a completed Fusion mutation into a retryable failure.
          }
          append("completed", { observedRevision: after.revision, finalRevision: after.revision,
            result: { status: "completed", commandId: execution.commandId, undoEntries: 1, checks,
              ...(recoveryFailureClass ? { reason: `${recoveryFailureClass}-resolved` } : {}) }, evidenceIds: [afterRecorded.current.id] });
          if (recoveryStarted) recovery("resolved", recoveryFailureClass ?? "transaction-failure",
            "Trusted inspection established the completed resulting revision after the request interruption.", "none",
            before.revision, after.revision, [afterRecorded.current.id]);
          return { actionId: request.actionId, status: "completed", document: binding.document,
            precedingRevision: before.revision, finalRevision: after.revision, checks,
            inspection: inspectDto(finalReadiness, binding, afterRecorded), undoEntries: 1, ledgerRecordIds: ledgerIds,
            ...(visualArtifact ? { visualArtifact } : {}) };
        } finally {
          requestSignal?.removeEventListener("abort", onRequestAbort);
        }
      });
    } catch (error) {
      const actionError = error instanceof FusionActionError ? error
        : error instanceof FusionActionLeaseUnavailableError
          ? new FusionActionError(error.message, 409, "lease-unavailable")
          : new FusionActionError("Fusion action execution failed without a trusted normalized result.", 503, "execution-failure");
      const last = this.history(conversationId).at(-1);
      if (last?.actionId === fusionLedgerActionIdentity(request.actionId) && !["rejected", "failed"].includes(last.event)) {
        append(mutationStarted ? "failed" : "rejected", { result: { reason: actionError.reason, message: actionError.message } });
      }
      throw actionError;
    }
  }
}
