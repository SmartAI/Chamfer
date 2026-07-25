/** The cron health probe (#73): a budget-capped scheduled Worker that watches
 * the hosted deployment from the outside so a regression there alerts instead
 * of only surfacing when a user hits it. The scheduled handler in worker.ts
 * wires the real inputs (the deep-health DO, the shared demo budget, Sentry +
 * Workers Logs) into runCronProbe; the decision logic lives here, injectable,
 * so it is unit-testable without a live Worker.
 *
 * What it keys alerts on:
 * - /api/online/health being unreachable, not-ok, missing a client-critical
 *   route, or reporting a degraded capability (agentContainer / demo). Healthy
 *   is a no-op - the probe is quiet unless something is wrong.
 * - the shared monthly demo budget approaching its cap (the same 80%/100% lines
 *   globalDemoBudget logs on the write path), read at level rather than edge so
 *   a probe that missed the crossing tick still catches a draining month.
 *
 * Image-version skew (#56): NOT re-checked here, deliberately. #56 shipped the
 * handshake - the container bakes its image version and reports it on
 * /api/health, the Worker knows the version it expects
 * (CHAMFER_EXPECTED_CONTAINER_VERSION), the turn host refuses a turn on skew
 * (containerVersion.ts), and the per-user wake probe
 * (/api/online/agent-container/health) already surfaces the same comparison for
 * monitoring. A system-level cron re-check would need to wake a container
 * outside any user context and would only duplicate coverage that already fails
 * closed on the turn path, so this probe leaves image skew to #56. The seam
 * below marks where a system-level re-check would slot in if one is ever
 * wanted. */

import type { FunnelSummary } from "./funnelCounter";
import { DEMO_BUDGET_ALERT_FRACTIONS } from "./globalDemoBudget";

/** The DO name /api/online/health forwards to (worker.ts) - a single fixed
 * instance whose route table stands in for every user's. Shared so the live
 * route and this probe always target the same object. */
export const HEALTH_DO_NAME = "__system_health__";

/** The deep-health body /api/online/health returns (onlineApp.ts). All fields
 * optional here: the probe treats a malformed body as unreachable. */
export interface OnlineHealthReport {
  ok?: boolean;
  service?: string;
  missing?: string[];
  degraded?: string[];
  funnel?: FunnelSummary;
}

/** A health fetch outcome: the HTTP status and the parsed body (null when the
 * endpoint was unreachable or its body did not parse). */
export interface HealthProbeResult {
  status: number;
  body: OnlineHealthReport | null;
}

/** This UTC month's demo spend against the monthly cap, micro-USD. */
export interface DemoBudgetReading {
  spentMicroUsd: number;
  capMicroUsd: number;
}

/** One condition worth surfacing. `error` is a functional outage (paged);
 * `warning` is a heads-up (draining budget, degraded capability). */
export interface ProbeAlert {
  severity: "warning" | "error";
  message: string;
}

export interface CronProbeDeps {
  /** Fetch and parse /api/online/health. Never throws - transport failure is a
   * { status: 0, body: null } reading. */
  fetchHealth(): Promise<HealthProbeResult>;
  /** Read the shared monthly demo spend vs its cap. Omit on deployments with no
   * demo funding; a cap of 0 also skips the budget check. */
  readDemoBudget?: () => Promise<DemoBudgetReading | null>;
  /** Deliver an alert (Sentry capture + console.error in production). */
  alert(alert: ProbeAlert): void;
}

function usd(microUsd: number): string {
  return `$${(microUsd / 1e6).toFixed(2)}`;
}

/** Runs one probe pass and returns every alert it raised (also delivered
 * through deps.alert). Self-contained and side-effect-free beyond deps.alert,
 * so the scheduled handler can log/monitor the returned set. */
export async function runCronProbe(deps: CronProbeDeps): Promise<ProbeAlert[]> {
  const alerts: ProbeAlert[] = [];
  const raise = (alert: ProbeAlert): void => {
    alerts.push(alert);
    deps.alert(alert);
  };

  const health = await deps.fetchHealth();
  // A missing body is a transport failure; a body without a boolean `ok` is a
  // malformed one (an error page rendered as JSON, a partial rollout). Both are
  // "unreachable" - reading a garbage-but-valid-JSON response as healthy would
  // mask an outage, so the well-formedness check is part of the liveness check.
  if (!health.body || typeof health.body.ok !== "boolean") {
    raise({
      severity: "error",
      message: `/api/online/health is unreachable or malformed (HTTP ${health.status || "no response"})`,
    });
  } else {
    const missing = health.body.missing ?? [];
    const degraded = health.body.degraded ?? [];
    if (health.body.ok === false || missing.length > 0) {
      raise({
        severity: "error",
        message: `/api/online/health reports not-ok (HTTP ${health.status})`
          + (missing.length > 0 ? `; missing routes: ${missing.join(", ")}` : ""),
      });
    }
    if (degraded.length > 0) {
      raise({
        severity: "warning",
        message: `/api/online/health reports degraded capabilities: ${degraded.join(", ")}`,
      });
    }

    // #56 image-version seam: #56 already compares the expected vs reported
    // container version at turn time (fails closed) and surfaces it in the
    // per-user wake probe. A system-level re-check would slot in here, but it
    // would only duplicate that coverage, so it is intentionally left unwired -
    // see the module header.
  }

  const budget = deps.readDemoBudget ? await deps.readDemoBudget() : null;
  if (budget && budget.capMicroUsd > 0) {
    const fraction = budget.spentMicroUsd / budget.capMicroUsd;
    const [warnAt, fullAt] = DEMO_BUDGET_ALERT_FRACTIONS;
    const detail = `(${usd(budget.spentMicroUsd)} of ${usd(budget.capMicroUsd)} this month)`;
    if (fraction >= fullAt) {
      raise({ severity: "error", message: `demo budget exhausted ${detail}` });
    } else if (fraction >= warnAt) {
      raise({
        severity: "warning",
        message: `demo budget at ${Math.round(fraction * 100)}% of the monthly cap ${detail}`,
      });
    }
  }

  return alerts;
}

/** Fetches /api/online/health through the system-health Durable Object, the
 * same instance the live route forwards to. Fail-safe: a DO fetch that throws
 * or a body that will not parse is an unreachable reading, so the probe alerts
 * rather than crashing the scheduled invocation. */
export async function fetchOnlineHealth(userDo: DurableObjectNamespace): Promise<HealthProbeResult> {
  try {
    const stub = userDo.get(userDo.idFromName(HEALTH_DO_NAME));
    // The host is routing-irrelevant; the DO matches on the path only.
    const response = await stub.fetch("https://chamfer-cron-probe/api/online/health");
    const body = (await response.json().catch(() => null)) as OnlineHealthReport | null;
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}
