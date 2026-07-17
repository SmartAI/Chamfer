import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  CadBootStatus,
  ExportFormat,
  Gate,
  Measurements,
  MeshPayload,
  ParamSpec,
} from "@chamfer/shared";
import { CadClient } from "@/cad/cadClient";

// First script run can include installing build123d + OCP.wasm wheels into
// the Pyodide filesystem, which is slow on a cold cache. Give it generous
// headroom so the run does not time out mid-install.
const RUN_TIMEOUT_MS = 600_000;

function parameterResponsivenessFailure(gate: Gate | undefined): string | undefined {
  return gate?.checks.find(
    (check) => check.name.startsWith("parameter_") && !check.passed,
  )?.detail;
}

export interface AppState {
  bootStatus: CadBootStatus;
  cad: CadClient | null;
  mesh: MeshPayload | null;
  measurements: Measurements | null;
  /** Durable identity of the model currently shown, or null for unpersisted CAD. */
  currentArtifact: { id: string; version: number } | null;
  setCurrentArtifact: (artifact: { id: string; version: number } | null) => void;
  /** Runs developer CAD code and reports whether this invocation remained current long enough to publish. */
  runScript: (code: string) => Promise<boolean>;
  publishCadResult: (result: { mesh: MeshPayload; measurements: Measurements }) => void;
  runError: string | null;
  isRendering: boolean;
  /** Source of the last successfully run script; null before the first run. */
  currentScript: string | null;
  /**
   * Sets currentScript without running it. Used when a script becomes current
   * through a path other than runScript: an agent tool run (the tool already
   * ran the code) or a conversation load restoring the latest artifact.
   * Passing null clears the script (and with it the params panel).
   */
  restoreScript: (code: string | null) => void;
  /** Clears all conversation-scoped CAD state and invalidates an in-flight render. */
  clearWorkspace: () => void;
  /** Params parsed from currentScript; empty when there is no params block. */
  params: ParamSpec[];
  /**
   * Splices new param values into currentScript and verifies the result. The
   * optional persistence hook runs before mesh, measurements, and code are
   * published, so a durable-write failure leaves the last valid version intact.
   * Without a hook, verified edits publish directly (the no-conversation flow).
   */
  applyParams: (
    values: Record<string, number>,
    persistBeforePublish?: (code: string) => Promise<{ id: string; version: number } | void>,
  ) => Promise<string>;
  exportModel: (format: ExportFormat) => Promise<{ data: Uint8Array; filename: string }>;
}

const AppStateContext = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [bootStatus, setBootStatus] = useState<CadBootStatus>({
    phase: "downloading",
    detail: "Pyodide runtime",
  });
  // The CadClient is created inside an effect (not a useState initializer)
  // so the create/dispose pair stays balanced under React StrictMode's
  // dev-only double mount. With an initializer, StrictMode's simulated
  // unmount would dispose the state-held client's worker while the state
  // survives the remount, leaving the app talking to a terminated worker.
  const [client, setClient] = useState<CadClient | null>(null);
  const [mesh, setMesh] = useState<MeshPayload | null>(null);
  const [measurements, setMeasurements] = useState<Measurements | null>(null);
  const [currentArtifact, setCurrentArtifact] = useState<{ id: string; version: number } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [currentScript, setCurrentScript] = useState<string | null>(null);
  const [params, setParams] = useState<ParamSpec[]>([]);
  const renderGenerationRef = useRef(0);

  useEffect(() => {
    const c = new CadClient(setBootStatus);
    setClient(c);
    return () => {
      c.dispose();
    };
  }, []);

  // Single hook point for the params panel: whenever a script becomes current
  // (script panel run, agent tool run, conversation load), re-parse its params
  // block. The stale-result guard matters because parseParams queues behind
  // Pyodide boot and a newer script can become current in the meantime.
  useEffect(() => {
    if (!client || currentScript === null) {
      setParams([]);
      return;
    }
    let cancelled = false;
    client
      .parseParams(currentScript)
      .then((specs) => {
        if (!cancelled) setParams(specs);
      })
      .catch(() => {
        // A script that runs but does not parse (should not happen) simply
        // has no adjustable params.
        if (!cancelled) setParams([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, currentScript]);

  async function runScript(code: string): Promise<boolean> {
    if (!client) {
      setRunError("CAD worker is not initialized yet");
      return false;
    }
    const generation = ++renderGenerationRef.current;
    setCurrentArtifact(null);
    setIsRendering(true);
    try {
      const result = await client.run(code, RUN_TIMEOUT_MS);
      if (renderGenerationRef.current !== generation) return false;
      setMesh(result.mesh);
      setMeasurements(result.measurements);
      setCurrentScript(code);
      setRunError(null);
      return true;
    } catch (err) {
      if (renderGenerationRef.current !== generation) return false;
      // Keep the prior mesh/measurements so the viewer does not blank out;
      // just surface the error.
      setRunError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (renderGenerationRef.current === generation) setIsRendering(false);
    }
  }

  async function applyParams(
    values: Record<string, number>,
    persistBeforePublish?: (code: string) => Promise<{ id: string; version: number } | void>,
  ): Promise<string> {
    if (!client) throw new Error("CAD worker is not initialized yet");
    if (currentScript === null) throw new Error("No script has been run yet");
    const newCode = await client.setParams(currentScript, values);
    const result = await client.run(newCode, RUN_TIMEOUT_MS);
    const responsivenessFailure = parameterResponsivenessFailure(result.gate);
    if (responsivenessFailure) throw new Error(responsivenessFailure);
    const artifact = await persistBeforePublish?.(newCode);
    setMesh(result.mesh);
    setMeasurements(result.measurements);
    setCurrentScript(newCode);
    setCurrentArtifact(artifact ?? null);
    setRunError(null);
    return newCode;
  }

  async function exportModel(format: ExportFormat): Promise<{ data: Uint8Array; filename: string }> {
    if (!client) throw new Error("CAD worker is not initialized yet");
    if (currentScript === null) throw new Error("No script has been run yet");
    // The runtime is warm by the time a script exists, but exporting still
    // re-runs the script, so keep the generous run timeout.
    return client.export(currentScript, format, RUN_TIMEOUT_MS);
  }

  const publishCadResult = useCallback((result: { mesh: MeshPayload; measurements: Measurements }): void => {
    setMesh(result.mesh);
    setMeasurements(result.measurements);
    setRunError(null);
    setCurrentArtifact(null);
  }, []);

  const restoreScript = useCallback((code: string | null): void => {
    setCurrentScript(code);
  }, []);

  const clearWorkspace = useCallback((): void => {
    renderGenerationRef.current += 1;
    setMesh(null);
    setMeasurements(null);
    setCurrentArtifact(null);
    setCurrentScript(null);
    setParams([]);
    setRunError(null);
    setIsRendering(false);
  }, []);

  const value: AppState = {
    bootStatus,
    cad: client,
    mesh,
    measurements,
    currentArtifact,
    setCurrentArtifact,
    runScript,
    publishCadResult,
    runError,
    isRendering,
    currentScript,
    restoreScript,
    clearWorkspace,
    params,
    applyParams,
    exportModel,
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
