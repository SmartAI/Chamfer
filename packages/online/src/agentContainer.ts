import { Hono } from "hono";
import { DEMO_MODEL_ID } from "./onlineApp";
import type { Provider } from "@chamfer/shared";
import { llmProxyPrefix } from "./llmProxy";
import { containerVersionSkewMessage } from "./containerVersion";
import type { OnlineEnv } from "./env";

/** Per-user agent container attachment (issue #50, ADR 0003 increment 3a).
 *
 * This module holds the seams the container class and the user DO share -
 * boot environment assembly, instance naming, and the health probe route.
 * The ChamferAgentContainer class itself lives in agentContainerDo.ts:
 * @cloudflare/containers imports workerd's cloudflare:workers module at load
 * time, which plain-Node vitest cannot resolve, so everything unit-testable
 * stays here.
 */

/** The port the #47 image listens on (PORT default in container/Dockerfile). */
export const AGENT_CONTAINER_PORT = 8787;

/** Scale-to-zero idle timeout. Minutes, not hours: the hosted deployment is a
 * trial funnel, and an idle container is pure cost (ADR 0003). Long enough to
 * keep the pi session warm across one user's think-time between turns. */
export const AGENT_CONTAINER_SLEEP_AFTER = "5m";

/** Boot placeholder for CHAMFER_LLM_TOKEN: the container entry refuses to
 * boot without a token, but real per-turn conversation-scoped tokens are
 * increment 3b's job (#51). This value is not a credential - it is not a JWT
 * signed with CHAMFER_LLM_TOKEN_SECRET, so every proxy call carrying it gets
 * the uniform 401 until 3b injects minted tokens per turn. */
export const AGENT_CONTAINER_BOOT_TOKEN = "chamfer-boot-token-placeholder";

/** The boot environment for a user's agent container.
 *
 * The returned keys are an exact allowlist. The #40 custody rule is absolute:
 * no LLM provider key ever enters the machine that executes CAD code, so no
 * key from OnlineEnv (demo key, auth secrets, token secret) may ever be added
 * here. The container's only LLM egress is CHAMFER_LLM_BASE_URL - this
 * deployment's own origin, where the increment-2b proxy injects the real key.
 *
 * CHAMFER_CONTAINER_LLM_ORIGIN exists for wrangler dev: the Worker's
 * localhost origin is unreachable from inside Docker, so .dev.vars points it
 * at host.docker.internal instead (see .dev.vars.example). Production leaves
 * it unset and uses CHAMFER_APP_ORIGIN.
 */
export function agentContainerBootEnv(
  env: Pick<OnlineEnv, "CHAMFER_APP_ORIGIN" | "CHAMFER_CONTAINER_LLM_ORIGIN" | "CHAMFER_MAX_CAD_RUNS">,
): Record<string, string> {
  const origin = containerLlmOrigin(env);
  if (!origin) {
    throw new Error(
      "agent container boot needs CHAMFER_APP_ORIGIN (or CHAMFER_CONTAINER_LLM_ORIGIN in dev): "
        + "the container's only LLM egress is this deployment's proxy",
    );
  }
  return {
    CHAMFER_LLM_BASE_URL: origin,
    CHAMFER_LLM_TOKEN: AGENT_CONTAINER_BOOT_TOKEN,
    // Boot-time default only: every turn's seed delivers the model that turn
    // actually runs (issue #53), replacing this. The demo pin keeps a
    // pre-first-seed container aligned with what demo-funded traffic could run.
    CHAMFER_MODEL: DEMO_MODEL_ID,
    CHAMFER_PROVIDER: "anthropic",
    // The deployment's CAD-run cap must reach the container that enforces it:
    // the DO sizes turn-token TTLs from the same variable (agentTurns.ts).
    ...(env.CHAMFER_MAX_CAD_RUNS ? { CHAMFER_MAX_CAD_RUNS: env.CHAMFER_MAX_CAD_RUNS } : {}),
  };
}

/** Names the container instance for a user DO. Keyed by the DO's own id - the
 * same value that prefixes the user's R2 attachments - so compute isolation
 * follows state isolation: both derive from the authenticated user id and
 * nothing else (ADR 0003). */
export function agentContainerName(userDoId: string): string {
  return `user:${userDoId}`;
}

/** The container-reachable origin of this deployment's LLM proxy: the dev
 * override (wrangler dev's localhost is unreachable from inside Docker) or
 * the public app origin. Undefined means hosting cannot be configured. */
function containerLlmOrigin(
  env: Pick<OnlineEnv, "CHAMFER_APP_ORIGIN" | "CHAMFER_CONTAINER_LLM_ORIGIN">,
): string | undefined {
  return env.CHAMFER_CONTAINER_LLM_ORIGIN ?? env.CHAMFER_APP_ORIGIN;
}

/** One conversation's proxy base URL for a provider, as the container must
 * dial it (issue #53 per-turn delivery): origin + /api/llm/<provider>/
 * <conversationId>, bare of any version path - each provider's version
 * segment lives on exactly one side of the proxy (see llmProxy.ts). */
export function agentContainerProxyBaseUrl(
  env: Pick<OnlineEnv, "CHAMFER_APP_ORIGIN" | "CHAMFER_CONTAINER_LLM_ORIGIN">,
  provider: Provider,
  conversationId: string,
): string {
  const origin = containerLlmOrigin(env);
  if (!origin) {
    throw new Error("no container-reachable proxy origin (CHAMFER_APP_ORIGIN / CHAMFER_CONTAINER_LLM_ORIGIN)");
  }
  return `${origin.replace(/\/+$/, "")}${llmProxyPrefix(provider)}/${conversationId}`;
}

/** Whether this deployment can host agent turns (issue #51): it needs the
 * container binding, the token-minting secret, and a proxy origin the
 * container can reach. Anything less keeps agentHosting false and the
 * existing degraded UX - a partially configured deployment must never mount
 * /api/agent/* routes that would fail mid-turn. */
export function agentHostingConfigured(
  env: Pick<
    OnlineEnv,
    "AGENT_CONTAINER" | "CHAMFER_LLM_TOKEN_SECRET" | "CHAMFER_APP_ORIGIN" | "CHAMFER_CONTAINER_LLM_ORIGIN"
  >,
): boolean {
  return Boolean(env.AGENT_CONTAINER && env.CHAMFER_LLM_TOKEN_SECRET && containerLlmOrigin(env));
}

/** Routes mounted on the user DO app (session-authenticated upstream in
 * worker.ts, like every /api route the DO serves).
 *
 * GET /api/online/agent-container/health wakes this user's container and
 * reports its /api/health plus the observed wake latency; increment 4's cron
 * probe hooks in here. It also surfaces the issue #56 version handshake: the
 * container's reported image version, the version this deployment expects, and
 * whether they are skewed - the same comparison the turn host refuses on, but
 * as a monitoring read rather than a turn gate. `containers` is undefined on
 * deployments without the AGENT_CONTAINER binding (unit tests, hermetic probe
 * configs) - that state is reported as unconfigured, never a crash.
 */
export function agentContainerRoutes(
  containers: DurableObjectNamespace | undefined,
  containerName: string,
  expectedVersion?: string,
): Hono {
  const app = new Hono();
  app.get("/api/online/agent-container/health", async (c) => {
    if (!containers) {
      return c.json(
        { ok: false, configured: false, error: "this deployment has no agent container binding" },
        503,
      );
    }
    const stub = containers.get(containers.idFromName(containerName));
    const startedAt = Date.now();
    try {
      // Container.fetch starts the instance when it is asleep and proxies to
      // the image's port once ready; the URL host is routing-irrelevant.
      const upstream = await stub.fetch("https://agent-container/api/health");
      const wakeMs = Date.now() - startedAt;
      const body = (await upstream.json().catch(() => null)) as { ok?: boolean; version?: unknown } | null;
      if (!upstream.ok || body?.ok !== true) {
        return c.json({ ok: false, configured: true, status: upstream.status, wakeMs }, 502);
      }
      const version = typeof body.version === "string" ? body.version : undefined;
      const skew = containerVersionSkewMessage(expectedVersion, version);
      // A skewed image is reported as not-ok with a 502, so the cron probe and
      // any monitor treat it as an outage - it is one: turns refuse on it.
      return c.json(
        {
          ok: !skew,
          configured: true,
          wakeMs,
          version: version ?? null,
          expectedVersion: expectedVersion ?? null,
          ...(skew ? { skew } : {}),
        },
        skew ? 502 : 200,
      );
    } catch (error) {
      return c.json(
        { ok: false, configured: true, error: error instanceof Error ? error.message : String(error) },
        502,
      );
    }
  });
  return app;
}
