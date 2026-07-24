import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { fetchAgentArtifact } from "@/api/agentTransport";

/** Viewer-side workspace state: the latest exported agent artifact (STL) parsed
 * into a three.js geometry. CAD execution itself is fully server-side. */
export interface AppState {
  geometry: THREE.BufferGeometry | null;
  /** Raw bytes of the loaded artifact (STL); kept alongside the parsed
   * geometry so the export UI can hand out the kernel's file unmodified. */
  artifactData: ArrayBuffer | null;
  /** Revision of the loaded artifact; null when nothing is loaded. */
  artifactRevision: number | null;
  isLoadingArtifact: boolean;
  /** Fetches the conversation's latest artifact and shows it (no-op on 404). */
  loadArtifact: (conversationId: string) => Promise<void>;
  /** Clears all conversation-scoped viewer state. */
  clearWorkspace: () => void;
}

const AppStateContext = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [artifactData, setArtifactData] = useState<ArrayBuffer | null>(null);
  const [artifactRevision, setArtifactRevision] = useState<number | null>(null);
  const [isLoadingArtifact, setIsLoadingArtifact] = useState(false);
  // Invalidates in-flight loads on conversation switch or newer request.
  const loadGenerationRef = useRef(0);

  const loadArtifact = useCallback(async (conversationId: string): Promise<void> => {
    const generation = ++loadGenerationRef.current;
    setIsLoadingArtifact(true);
    try {
      const artifact = await fetchAgentArtifact(conversationId);
      if (loadGenerationRef.current !== generation) return;
      if (!artifact) return;
      const parsed = new STLLoader().parse(artifact.data);
      parsed.computeVertexNormals();
      setGeometry(parsed);
      setArtifactData(artifact.data);
      setArtifactRevision(artifact.revision);
    } catch {
      // A transient artifact fetch failure keeps the previous geometry visible.
    } finally {
      if (loadGenerationRef.current === generation) setIsLoadingArtifact(false);
    }
  }, []);

  const clearWorkspace = useCallback((): void => {
    loadGenerationRef.current += 1;
    setGeometry(null);
    setArtifactData(null);
    setArtifactRevision(null);
    setIsLoadingArtifact(false);
  }, []);

  const value: AppState = {
    geometry,
    artifactData,
    artifactRevision,
    isLoadingArtifact,
    loadArtifact,
    clearWorkspace,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within an AppStateProvider");
  return ctx;
}

export function useOptionalAppState(): AppState | null {
  return useContext(AppStateContext);
}
