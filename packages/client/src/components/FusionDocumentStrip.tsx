import { useCallback, useEffect, useRef, useState } from "react";
import {
  fusionCompletionEvidencePassed,
  fusionReadinessAllowsInspection,
  type ConversationDto,
  type FusionActionLedgerRecordDto,
  type FusionDocumentBindingDto,
  type FusionInspectionDto,
  type FusionReadinessDto,
  type FusionReconciliationRecordDto,
} from "@chamfer/shared";
import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import { useChatState } from "@/state/chatState";
import { useOptionalFusionReadiness } from "@/state/fusionReadiness";
import { inspectFusionDocument, listFusionActions, reconcileFusionDocument, saveFusionDocument, transferFusionOwnership } from "@/api/rest";
import { FusionReadinessBadge } from "./FusionReadinessBadge";

export interface FusionDocumentStripProps {
  readiness?: FusionReadinessDto;
  binding?: FusionDocumentBindingDto;
  /** Latest trusted engineering revision known to this conversation. */
  revision?: string;
  latestAction?: FusionActionLedgerRecordDto;
  reconciliation?: FusionReconciliationRecordDto;
  inspecting?: boolean;
  transferring?: boolean;
  transferError?: string;
  saving?: boolean;
  saveError?: string;
  onInspect?: () => void;
  onTransfer?: () => void;
  onSave?: () => void;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/**
 * The one Fusion surface in a chat-only conversation: a thin status row with
 * the bound document's identity, plus contextual Save / Transfer / recovery
 * affordances. The native Fusion canvas remains the authoritative interactive
 * 3D view; Chamfer deliberately shows no mirrored viewer, captured views, or
 * action history here — the action ledger stays available over the API.
 */
export function FusionDocumentStrip({
  readiness,
  binding,
  revision,
  latestAction,
  reconciliation,
  inspecting = false,
  transferring = false,
  transferError,
  saving = false,
  saveError,
  onInspect,
  onTransfer,
  onSave,
}: FusionDocumentStripProps) {
  const hasUnpersistedChanges = binding?.identityKind === "provisional" || readiness?.documentModified === true;
  const verifiedUnsaved = Boolean(binding?.role === "owner" && binding.resumable && revision && hasUnpersistedChanges &&
    !readiness?.recovery && fusionCompletionEvidencePassed(latestAction, revision));
  const recoveryOperation = readiness?.recovery?.allowedOperation === "inspect-resulting-state"
    ? "Inspect the resulting engineering state; mutation, Save, and ownership transfer remain blocked."
    : readiness?.recovery?.allowedOperation === "wait-for-trusted-inspection"
      ? "Wait for Chamfer's trusted read-only diagnosis to finish."
      : undefined;
  const canInspect = Boolean(binding?.resumable) && fusionReadinessAllowsInspection(readiness?.state);
  const inspectButton = onInspect && (
    <button
      type="button"
      aria-label="Inspect Fusion document"
      disabled={inspecting || !canInspect}
      onClick={onInspect}
      className="flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
    >
      {inspecting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      {inspecting ? "Inspecting…" : "Inspect"}
    </button>
  );

  return (
    <div data-testid="fusion-document-strip" className="shrink-0 border-b bg-muted/20 px-4 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FusionReadinessBadge readiness={readiness} />
        {binding && (
          <>
            <span data-testid="fusion-bound-document" className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium" title={binding.document.dataFileId ?? binding.document.id}>
                {binding.document.name}
              </span>
              <span data-testid="fusion-ownership-role" className="rounded-full border px-2 py-0.5 text-[11px]">
                {binding.role === "owner" ? "Owner" : "Read only"}
              </span>
            </span>
            <span data-testid="fusion-identity-kind" className="text-muted-foreground">
              {binding.identityKind === "durable" ? "Saved Fusion document" : "Unsaved document"}
            </span>
            <span data-testid="fusion-resumability" className="text-muted-foreground">
              {binding.resumable ? "Resumable" : "Cannot resume"}
            </span>
            {binding.identityKind === "durable" &&
              (binding.document.versionNumber !== undefined || binding.document.versionId) && (
                <span data-testid="fusion-saved-version" className="text-muted-foreground">
                  {binding.document.versionNumber !== undefined ? `Fusion version ${binding.document.versionNumber}` : "Saved Fusion version"}
                  {binding.document.versionId ? ` · ${binding.document.versionId}` : ""}
                </span>
              )}
            {revision && (
              <span data-testid="fusion-revision" className="font-mono text-muted-foreground" title={revision}>
                Revision {revision.slice(0, 12)}
              </span>
            )}
            {binding.role === "read-only" && binding.resumable && onTransfer && !readiness?.recovery && (
              <button
                type="button"
                disabled={transferring || readiness?.state === "wrong-document"}
                onClick={onTransfer}
                className="rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
              >
                {transferring ? "Transferring…" : "Transfer ownership to this conversation"}
              </button>
            )}
          </>
        )}
      </div>
      {verifiedUnsaved && onSave && (
        <div role="status" aria-label="Verified unsaved Fusion work"
          className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <span>
            <span className="font-semibold">Verified, not saved</span>
            <span className="ml-2">Completion checks passed for this revision, but Fusion has not persisted it.</span>
          </span>
          <button type="button" aria-label="Save verified Fusion document" disabled={saving}
            onClick={onSave}
            className="flex items-center gap-1.5 rounded-md border border-amber-500 bg-background px-3 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50">
            {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
      {(transferError || saveError) && <p role="alert" className="mt-2 text-xs text-destructive">{transferError ?? saveError}</p>}
      {readiness?.recovery && (
        <div data-testid="fusion-recovery" data-state={readiness.recovery.state}
          className="mt-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-950 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100">
          <p className="font-semibold">{readiness.recovery.state === "diagnosing" ? "Recovery in progress" : "Recovery required"}</p>
          <p className="mt-1">{readiness.recovery.diagnosis}</p>
          {recoveryOperation && <p className="mt-1 font-medium">Allowed operation: {recoveryOperation}</p>}
          <p className="mt-1 font-mono opacity-75">Failure: {readiness.recovery.failureClass}</p>
          {readiness.recovery.allowedOperation === "inspect-resulting-state" && inspectButton && (
            <div className="mt-2">{inspectButton}</div>
          )}
        </div>
      )}
      {!readiness?.recovery && readiness?.cameraRestored === false && (
        <div data-testid="fusion-camera-recovery"
          className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-semibold">Fusion camera needs attention</p>
          <p className="mt-1">Engineering state is unchanged, but Chamfer could not restore the exact prior camera.</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="font-medium">Allowed operation: restore the camera in Fusion, then inspect again.</p>
            {inspectButton}
          </div>
        </div>
      )}
      {reconciliation && (
        <div
          data-testid="fusion-reconciliation"
          data-status={reconciliation.status}
          className={`mt-2 rounded-md border p-3 text-xs ${reconciliation.status === "needs-user"
            ? "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
            : "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"}`}
        >
          <p className="font-semibold">{reconciliation.status === "needs-user" ? "User direction required" : "Manual edit reconciled"}</p>
          <p className="mt-1">{reconciliation.summary}</p>
          <p className="mt-1 opacity-80">
            {plural(reconciliation.refreshedReferences.length, "reference")} refreshed · {plural(reconciliation.refreshedChecks.length, "check")} refreshed
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Owns the conversation's Fusion document lifecycle now that no evidence panel
 * exists: scopes readiness polling, watches the action ledger tail, reconciles
 * manual Fusion edits (resuming or stopping a streaming agent turn), and wires
 * Save / Transfer / contextual Inspect. Never captures native views on its own
 * cadence — inspections run only when the user explicitly asks for one from a
 * recovery notice.
 */
export function ConnectedFusionDocumentStrip({ conversation }: { conversation: ConversationDto }) {
  const fusion = useOptionalFusionReadiness();
  const { sessionState, stopAgent, resumeAfterFusionReconciliation } = useChatState();
  const [revision, setRevision] = useState<string>();
  const [latestAction, setLatestAction] = useState<FusionActionLedgerRecordDto>();
  const [reconciliation, setReconciliation] = useState<FusionReconciliationRecordDto>();
  const [inspecting, setInspecting] = useState(false);
  const [transferError, setTransferError] = useState<string>();
  const [transferring, setTransferring] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const actionHistoryTail = useRef<string | undefined>(undefined);
  const handledReconciliationId = useRef<string | undefined>(undefined);
  const streamingRef = useRef(sessionState.streaming);
  streamingRef.current = sessionState.streaming;
  const scopeToConversation = fusion?.scopeToConversation;
  const readiness = fusion?.readiness;
  const refresh = fusion?.refresh;

  const handleReconciliation = useCallback((record: FusionReconciliationRecordDto | undefined) => {
    if (!record || record.id === handledReconciliationId.current) return;
    handledReconciliationId.current = record.id;
    if (!streamingRef.current) return;
    if (record.status === "reconciled") resumeAfterFusionReconciliation(record.summary);
    else stopAgent();
  }, [resumeAfterFusionReconciliation, stopAgent]);

  const consumeInspection = useCallback((inspection: FusionInspectionDto) => {
    setRevision(inspection.current.revision);
    setReconciliation(inspection.reconciliation);
    handleReconciliation(inspection.reconciliation);
  }, [handleReconciliation]);

  useEffect(() => {
    scopeToConversation?.(conversation.id);
    setRevision(undefined);
    setLatestAction(undefined);
    setReconciliation(undefined);
    setTransferError(undefined);
    setSaveError(undefined);
    actionHistoryTail.current = undefined;
    handledReconciliationId.current = undefined;
    return () => scopeToConversation?.(undefined);
  }, [conversation.id, scopeToConversation]);

  // Readiness already polls continuously. That inexpensive cadence discovers a
  // new ledger tail and reconciles manual Fusion edits; unlike the retired
  // evidence panel it never triggers a native seven-view capture by itself.
  // Turn boundaries re-run the probe immediately: a completed action's ledger
  // record decides Save-worthiness, and waiting a full readiness tick for it
  // leaves the strip visibly behind the conversation.
  const streaming = sessionState.streaming;
  useEffect(() => {
    if (!readiness?.checkedAt) return;
    let cancelled = false;
    void Promise.all([listFusionActions(conversation.id), reconcileFusionDocument(conversation.id)]).then(([history, poll]) => {
      if (cancelled) return;
      if (poll.changed) consumeInspection(poll.inspection);
      else {
        // An agent-tool inspection may have consumed the revision change first;
        // the persisted record must still cancel or resume the streaming turn.
        if (poll.revision) setRevision(poll.revision);
        setReconciliation(poll.reconciliation);
        handleReconciliation(poll.reconciliation);
      }
      const latest = history.at(-1);
      if (!latest || latest.id === actionHistoryTail.current) return;
      actionHistoryTail.current = latest.id;
      setLatestAction(latest);
      if (latest.event === "completed" && latest.finalRevision) setRevision(latest.finalRevision);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [consumeInspection, conversation.id, handleReconciliation, readiness?.checkedAt, streaming]);

  if (!fusion) return null;

  const inspect = async () => {
    setInspecting(true);
    try {
      consumeInspection(await inspectFusionDocument(conversation.id));
      await refresh?.();
    } catch {
      // The readiness badge already surfaces why inspection is unavailable.
    } finally {
      setInspecting(false);
    }
  };
  const transfer = async () => {
    setTransferring(true);
    setTransferError(undefined);
    try {
      await transferFusionOwnership(conversation.id);
      await refresh?.();
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : String(error));
    } finally {
      setTransferring(false);
    }
  };
  const save = async () => {
    const binding = readiness?.binding;
    if (!binding) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await saveFusionDocument(conversation.id, binding.document);
      consumeInspection(result.inspection);
      await refresh?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return <FusionDocumentStrip
    readiness={readiness}
    binding={readiness?.binding}
    revision={revision}
    latestAction={latestAction}
    reconciliation={reconciliation}
    inspecting={inspecting}
    transferring={transferring}
    transferError={transferError}
    saving={saving}
    saveError={saveError}
    onInspect={() => void inspect()}
    onTransfer={() => void transfer()}
    onSave={() => void save()}
  />;
}
