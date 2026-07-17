import { useEffect, useMemo } from "react";
import { LoaderCircle } from "lucide-react";
import { Viewer } from "@/viewer/Viewer";
import { meshToGeometry } from "@/viewer/meshToGeometry";
import { useAppState } from "@/state/appState";
import { useChatState } from "@/state/chatState";
import { latestPlan } from "@/agent/plan";
import { currentProofContract } from "@/agent/proofContract";
import { effectiveProofReport } from "@/agent/proofReport";
import { currentVisualVerification } from "@/agent/visualVerification";
import { DraggableOverlay } from "./DraggableOverlay";
import { ExportButtons } from "./ExportButtons";
import { ConnectedParamsPanel } from "./ParamsPanel";
import { ScriptPanel } from "./ScriptPanel";

export function RightPanel() {
  const { bootStatus, mesh, params, isRendering, currentArtifact } = useAppState();
  const { sessionState } = useChatState();
  const geometry = useMemo(() => (mesh ? meshToGeometry(mesh) : null), [mesh]);

  const plan = latestPlan(sessionState.messages);
  const contract = currentProofContract(
    sessionState.proofContracts ?? [],
    plan,
    sessionState.referenceRegistrations ?? [],
  );
  const visualVerification = currentVisualVerification(
    sessionState.messages,
    sessionState.referenceRecords ?? [],
  );
  const proofReport = effectiveProofReport(sessionState.proofReports ?? [], {
    plan,
    contract,
    sourceSpecifications: sessionState.sourceSpecifications ?? [],
    referenceRegistrations: sessionState.referenceRegistrations ?? [],
    activeReferenceIds: (sessionState.referenceRecords ?? [])
      .filter((record) => record.status === "active" || record.status === "complementary")
      .map((record) => record.referenceId),
    visualVerification,
    artifact: currentArtifact,
  });

  // BufferGeometry allocates GPU-side buffers that are not garbage collected;
  // dispose the outgoing geometry whenever a new mesh replaces it and on unmount.
  useEffect(() => {
    if (!geometry) return;
    return () => geometry.dispose();
  }, [geometry]);

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <Viewer geometry={geometry} />
        {(bootStatus.phase === "downloading" || bootStatus.phase === "installing") && (
          <div
            data-testid="viewer-booting"
            role="status"
            className="absolute inset-0 z-20 flex items-center justify-center bg-[#f4f5f7]/80"
          >
            <div className="flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm font-medium shadow-sm backdrop-blur-sm">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Preparing environment, please wait...
            </div>
          </div>
        )}
        {isRendering && (
          <div
            data-testid="viewer-rendering"
            className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-xs font-medium shadow-sm backdrop-blur-sm"
          >
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Rendering 3D
          </div>
        )}
        {params.length > 0 && (
          <DraggableOverlay
            storageKey="chamfer.params-panel-pos.v1"
            defaultPositionClassName="right-3 top-3"
            className="z-10 w-[min(360px,calc(100%-24px))] overflow-hidden rounded-md border bg-background/95 shadow-lg backdrop-blur-sm"
          >
            <ConnectedParamsPanel />
          </DraggableOverlay>
        )}
      </div>
      <ExportButtons proofState={proofReport?.status} />
      <ScriptPanel />
    </div>
  );
}
