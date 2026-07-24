import { Hono } from "hono";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { initializeSchema } from "../../server/src/db";
import { realLlm } from "../../server/src/llm";
import { doDatabase } from "./doDatabase";
import { migrateDbBlobsToR2, R2AttachmentStore } from "./r2AttachmentStore";
import { R2ArtifactStore } from "./r2ArtifactStore";
import { budgetedLlm, DEFAULT_DEMO_LIFETIME_USD, DEFAULT_DEMO_MONTHLY_USD } from "./budget";
import { makeGlobalDemoBudget } from "./globalDemoBudget";
import { usdToMicroUsd } from "./demoPricing";
import { createOnlineApp, DEMO_MODEL_ID, type OnlineAgentHosting } from "./onlineApp";
import { llmProxyRoutes } from "./llmProxy";
import { mintLlmToken } from "./llmToken";
import {
  agentContainerName,
  agentContainerProxyBaseUrl,
  agentContainerRoutes,
  agentHostingConfigured,
} from "./agentContainer";
import { ContainerTurnHost, turnTokenTtlSeconds, type TurnMarker, type TurnStateStore } from "./agentTurns";
import { CHAMFER_USER_ID_HEADER, type OnlineEnv } from "./env";

const TURN_MARKER_KEY = "agent-turn-marker";

/** TurnStateStore over the DO's own storage: the marker (KV) and the alarm
 * both persist through eviction, which is what makes the turn-end drain
 * independent of any browser connection. */
function durableTurnState(storage: DurableObjectStorage): TurnStateStore {
  return {
    get: async () => (await storage.get<TurnMarker>(TURN_MARKER_KEY)) ?? undefined,
    put: (marker) => storage.put(TURN_MARKER_KEY, marker),
    clear: async () => {
      await storage.delete(TURN_MARKER_KEY);
    },
    scheduleAlarm: (atMs) => storage.setAlarm(atMs),
    cancelAlarm: () => storage.deleteAlarm(),
  };
}

/** One instance per signed-in user, holding that user's Chamfer state
 * (conversations, settings, budget) in its own SQLite database. Image blobs
 * live in R2 under this object's id as the key prefix, so they inherit the
 * same isolation: the Worker only ever routes a user's requests to the object
 * derived from their user id. On hosting-configured deployments the object
 * also drives that user's agent container (issue #51): it seeds transcripts,
 * mints per-turn proxy tokens, relays the event stream, and drains each
 * finished turn back into this database and R2. */
export class ChamferUserDurableObject {
  private readonly app: Hono;
  private readonly turnHost: ContainerTurnHost | undefined;
  /** Authenticated user id, learned from the Worker's trusted header (the
   * object's own id is a hash of it). Stable for the object's lifetime - one
   * instance serves exactly one user - and required before a token can mint. */
  private userId: string | undefined;

  constructor(state: DurableObjectState, env: OnlineEnv) {
    const db = doDatabase(state.storage);
    initializeSchema(db);
    const doId = state.id.toString();
    const store = new R2AttachmentStore(env.ATTACHMENTS, `users/${doId}`);
    // Earlier deployments chunked blobs into this database; move them to R2
    // before serving requests. Failure (R2 unreachable) leaves the rows in
    // place for the next wake and must not brick the object.
    state.blockConcurrencyWhile(() =>
      migrateDbBlobsToR2(db, store).catch((error) => {
        console.error("attachment blob migration failed; will retry on next start", error);
      }),
    );
    // Demo funding is dollar-metered against two caps: this account's lifetime
    // spend (in its own DO database, below) and a shared monthly pool (D1, the
    // true ceiling). Both default to whole-dollar env vars.
    const lifetimeMicroUsd = usdToMicroUsd(
      Number(env.CHAMFER_DEMO_LIFETIME_USD) || DEFAULT_DEMO_LIFETIME_USD,
    );
    const monthlyMicroUsd = usdToMicroUsd(
      Number(env.CHAMFER_DEMO_MONTHLY_USD) || DEFAULT_DEMO_MONTHLY_USD,
    );
    const globalBudget = makeGlobalDemoBudget(env.AUTH_DB, monthlyMicroUsd);
    const llm = budgetedLlm(
      realLlm(),
      db,
      {
        apiKey: env.CHAMFER_DEMO_ANTHROPIC_KEY,
        baseUrl: env.CHAMFER_DEMO_ANTHROPIC_BASE_URL,
        accessClientId: env.CHAMFER_DEMO_ACCESS_CLIENT_ID,
        accessClientSecret: env.CHAMFER_DEMO_ACCESS_CLIENT_SECRET,
        lifetimeMicroUsd,
      },
      globalBudget,
    );

    // Hosted agent turns (issue #51), only when fully configured: container
    // binding + token secret + a container-reachable proxy origin. The token
    // secret stays here - the container gets only minted tokens (#40 custody).
    const demoModel = getBuiltinModel("anthropic", DEMO_MODEL_ID);
    let agent: OnlineAgentHosting | undefined;
    const containers = env.AGENT_CONTAINER;
    const tokenSecret = env.CHAMFER_LLM_TOKEN_SECRET;
    if (containers && tokenSecret && agentHostingConfigured(env)) {
      const stub = containers.get(containers.idFromName(agentContainerName(doId)));
      const artifacts = new R2ArtifactStore(env.ATTACHMENTS, `users/${doId}`);
      // Token TTL and turn deadline follow the deployment's CAD-run cap, so
      // raising CHAMFER_MAX_CAD_RUNS cannot silently outrun the tokens.
      const turnTtlSeconds = turnTokenTtlSeconds(env.CHAMFER_MAX_CAD_RUNS);
      const turnHost = new ContainerTurnHost({
        db,
        containerFetch: (path, init) => stub.fetch(`https://agent-container${path}`, init),
        mintTurnToken: (conversationId) => {
          if (!this.userId) {
            throw new Error("user identity not established; cannot mint a conversation token");
          }
          return mintLlmToken(tokenSecret, {
            userId: this.userId,
            conversationId,
            ttlSeconds: turnTtlSeconds,
          });
        },
        proxyBaseUrl: (provider, conversationId) => agentContainerProxyBaseUrl(env, provider, conversationId),
        artifacts,
        turnState: durableTurnState(state.storage),
        turnTtlSeconds,
        // The demo fallback for keyless turns, present only when the demo key
        // can actually fund them - the same pin the chat path defaults to.
        demoModelJson: demoModel && env.CHAMFER_DEMO_ANTHROPIC_KEY ? JSON.stringify(demoModel) : undefined,
      });
      this.turnHost = turnHost;
      agent = { sessions: turnHost, artifacts };
      // A turn that outlived the previous instance resumes watching (and
      // draining) before any request lands.
      state.blockConcurrencyWhile(() =>
        turnHost.restore().catch((error) => {
          console.error("agent turn restore failed; the alarm will retry", error);
        }),
      );
    }

    const app = new Hono();
    // The Worker stamps the authenticated user id on every session-routed
    // request (and every other DO ingress path strips inbound copies), so
    // every observed value is the same trusted id; the capture overwrites on
    // each request and feeds token minting above.
    app.use("*", (c, next) => {
      const userId = c.req.header(CHAMFER_USER_ID_HEADER);
      if (userId) this.userId = userId;
      return next();
    });
    app.route(
      "/",
      createOnlineApp(db, llm, store, {
        lifetimeMicroUsd,
        demoQuota: Boolean(env.CHAMFER_DEMO_ANTHROPIC_KEY),
        agent,
      }),
    );
    // Container-facing LLM proxy (issue #48). Mounted here rather than in
    // createOnlineApp on purpose: the route-parity guard accounts for the
    // browser client's route surface, and the browser never calls /api/llm.
    // The Worker gate (llmProxyGate) has already verified the conversation
    // token and routed here by its user id claim, so this handler shares the
    // same key policy and budget tables as the chat path above.
    app.route(
      "/",
      llmProxyRoutes(db, {
        demoApiKey: env.CHAMFER_DEMO_ANTHROPIC_KEY,
        demoBaseUrl: env.CHAMFER_DEMO_ANTHROPIC_BASE_URL,
        accessClientId: env.CHAMFER_DEMO_ACCESS_CLIENT_ID,
        accessClientSecret: env.CHAMFER_DEMO_ACCESS_CLIENT_SECRET,
        lifetimeMicroUsd,
        allowedDemoModels: [DEMO_MODEL_ID],
        global: globalBudget,
      }),
    );
    // This user's agent container probe (issue #50): named by this object's
    // id, the same key the R2 prefix above uses, so compute isolation follows
    // state isolation. Also outside createOnlineApp - the route-parity guard
    // tracks the browser client's surface, and the probe is an operational hook.
    app.route("/", agentContainerRoutes(env.AGENT_CONTAINER, agentContainerName(doId)));
    this.app = app;
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.app.fetch(request);
  }

  /** Fires while a hosted turn is (or may be) live: the drain safety net that
   * needs neither a browser connection nor a surviving in-memory watcher. */
  async alarm(): Promise<void> {
    await this.turnHost?.onAlarm();
  }
}
