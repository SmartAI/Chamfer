import type { Gate } from "@chamfer/shared";
import { PROBE_COMPONENT, runComponentIds } from "./plan";

export interface GateSummary {
  status: Gate["status"];
  passedChecks: number;
  totalChecks: number;
}

const GATE_STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "error"]);

function gateOf(message: unknown): Gate | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as {
    role?: unknown;
    details?: { gate?: unknown; measurements?: { component?: unknown } };
  };
  if (m.role !== "toolResult") return undefined;
  // Probe runs are diagnostics, not deliverables: their verdicts must never
  // become the conversation's verification badge.
  const ids = runComponentIds(m.details?.measurements);
  if (ids.length === 1 && ids[0] === PROBE_COMPONENT) return undefined;
  const gate = m.details?.gate;
  if (typeof gate !== "object" || gate === null) return undefined;
  const status = (gate as { status?: unknown }).status;
  if (typeof status !== "string" || !GATE_STATUSES.has(status)) return undefined;
  return gate as Gate;
}

/** Verdict of the most recent verify-gate-bearing, non-probe tool result, or undefined.
 * Tolerates arbitrary message shapes: replayed history predating the gate,
 * lookup_docs results, and malformed content all simply yield no summary. */
export function latestGateSummary(messages: unknown[]): GateSummary | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const gate = gateOf(messages[index]);
    if (!gate) continue;
    const checks = Array.isArray(gate.checks) ? gate.checks : [];
    return {
      status: gate.status,
      passedChecks: checks.filter((check) => check.passed).length,
      totalChecks: checks.length,
    };
  }
  return undefined;
}
