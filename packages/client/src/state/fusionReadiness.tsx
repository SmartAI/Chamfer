import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { FusionReadinessDto, SettingsResponseDto } from "@chamfer/shared";
import * as rest from "@/api/rest";

// Each readiness poll runs a Fusion MCP script execute. The installed adapter
// leaks interpreter state per execution, so an aggressive interval both burdens
// the native app and shortens the window before that leak forces a restart.
// A calmer cadence still reads as live while cutting the execute rate ~5x.
const POLL_INTERVAL_MS = 8_000;
const DEFAULT_ENDPOINT = "http://127.0.0.1:27182/mcp";

export interface FusionReadinessContextValue {
  enabled: boolean;
  integrity?: SettingsResponseDto["fusionIntegrity"];
  /** Endpoint-wide readiness for creation and settings surfaces. */
  endpointReadiness?: FusionReadinessDto;
  /** Active conversation readiness, or endpoint readiness when unscoped. */
  readiness?: FusionReadinessDto;
  refresh: () => Promise<void>;
  refreshConfiguration: () => Promise<void>;
  scopeToConversation: (conversationId?: string) => void;
}

export const FusionReadinessContext = createContext<FusionReadinessContextValue | undefined>(undefined);

function unavailableAfterApiFailure(previous?: FusionReadinessDto): FusionReadinessDto {
  return {
    state: "unavailable",
    label: "Unavailable",
    diagnosis: "Chamfer cannot refresh Fusion readiness. Modeling remains blocked.",
    endpoint: previous?.endpoint ?? DEFAULT_ENDPOINT,
    checkedAt: new Date().toISOString(),
    mutationAllowed: false,
  };
}

async function readSnapshot(conversationId?: string): Promise<Pick<FusionReadinessContextValue, "enabled" | "integrity" | "endpointReadiness" | "readiness">> {
  const settings = await rest.getSettings();
  if (!settings.fusionEnabled) return { enabled: false, integrity: settings.fusionIntegrity };
  const endpointReadiness = await rest.getFusionReadiness();
  return {
    enabled: true,
    integrity: settings.fusionIntegrity,
    endpointReadiness,
    readiness: conversationId ? await rest.getFusionReadiness(conversationId) : endpointReadiness,
  };
}

export function FusionReadinessProvider({ children, __pollIntervalMs = POLL_INTERVAL_MS }: { children: ReactNode; __pollIntervalMs?: number }) {
  const [enabled, setEnabled] = useState(false);
  const [integrity, setIntegrity] = useState<SettingsResponseDto["fusionIntegrity"]>();
  const [endpointReadiness, setEndpointReadiness] = useState<FusionReadinessDto>();
  const [readiness, setReadiness] = useState<FusionReadinessDto>();
  const [conversationId, setConversationId] = useState<string>();

  const refresh = useCallback(async () => setReadiness(await rest.getFusionReadiness(conversationId)), [conversationId]);
  const refreshConfiguration = useCallback(async () => {
    const snapshot = await readSnapshot(conversationId);
    setEnabled(snapshot.enabled);
    setIntegrity(snapshot.integrity);
    setEndpointReadiness(snapshot.endpointReadiness);
    setReadiness(snapshot.readiness);
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const snapshot = await readSnapshot(conversationId);
        if (cancelled) return;
        setEnabled(snapshot.enabled);
        setIntegrity(snapshot.integrity);
        setEndpointReadiness(snapshot.endpointReadiness);
        setReadiness(snapshot.readiness);
      } catch {
        if (!cancelled) {
          setEndpointReadiness((previous) => unavailableAfterApiFailure(previous));
          setReadiness((previous) => unavailableAfterApiFailure(previous));
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, __pollIntervalMs);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [__pollIntervalMs, conversationId]);

  const value = useMemo(() => ({
    enabled,
    integrity,
    endpointReadiness,
    readiness,
    refresh,
    refreshConfiguration,
    scopeToConversation: setConversationId,
  }), [enabled, integrity, endpointReadiness, readiness, refresh, refreshConfiguration]);
  return <FusionReadinessContext.Provider value={value}>{children}</FusionReadinessContext.Provider>;
}

export function useFusionReadiness(): FusionReadinessContextValue {
  const value = useContext(FusionReadinessContext);
  if (!value) throw new Error("useFusionReadiness must be used within FusionReadinessProvider");
  return value;
}

export function useOptionalFusionReadiness(): FusionReadinessContextValue | undefined {
  return useContext(FusionReadinessContext);
}
