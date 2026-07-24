# @chamfer/online

The hosted deployment of Chamfer, running on Cloudflare Workers.

> **Status: hosted agent turns are implemented (ADR 0003 increments 1-3 complete, issue #51).**
> Agent turns run in a per-user Cloudflare Container executing the unmodified pi harness; the user's Durable Object seeds the transcript, mints per-turn LLM proxy tokens, relays the event stream, and drains every finished turn back into its store and R2.
> `agentHosting` flips true only on a fully configured deployment (container binding + `CHAMFER_LLM_TOKEN_SECRET` + a container-reachable proxy origin); anything less keeps the honest degraded posture - no `/api/agent/*` mounted, the composer disabled with a notice pointing at `npx chamfer`, and `agent-hosting` under `degraded` in `/api/online/health`.
> See `docs/adr/0003-hosted-agent-on-cloudflare-containers.md` and umbrella issue #40; the hosted deployment is a trial funnel, the local deployment stays the full product.
> Fusion is local-only, permanently.

**Live**: <https://app.chamferonline.com> (custom domain) and <https://chamfer-online.minliu905.workers.dev>.
The zone apex <https://chamferonline.com> intentionally keeps serving the marketing landing page; the app owns the `app.` subdomain.

## Architecture

- The Vite client (built with `VITE_CHAMFER_ONLINE=1`) is served as Worker static assets.
  Agent turns execute in the per-user container (below); the Worker itself never runs CAD code.
- The Worker terminates authentication (better-auth, Google/GitHub social sign-in, sessions in D1) and routes every `/api/*` request to a per-user Durable Object.
- Each user owns one SQLite-backed Durable Object holding all of their state: conversations, messages, settings, and their lifetime demo spend.
  Isolation is physical - the Worker derives the object id from the authenticated user id and nothing else.
- Image attachment blobs live in the `chamfer-online-attachments` R2 bucket, keyed under the owning Durable Object's id (`users/<do-id>/images/...`), so they inherit the same per-user isolation.
  Only content-addressed metadata stays in SQLite.
  Blobs written by earlier deployments into chunked SQLite rows migrate to R2 automatically the next time the user's object wakes.
- The Durable Object runs the same Hono route modules as the local server (`packages/server/src/routes/*`), over a `DatabaseSync`-shaped shim on DO SQLite.
  Fusion routes are excluded: a cloud worker cannot reach a loopback MCP adapter, so the Fusion connector remains a local-install feature.
- LLM calls without a user-configured key fall back to the server-held demo key (Anthropic only), metered in dollars against two caps: a one-time per-account lifetime cap and a shared global monthly ceiling.
  A key configured in Settings passes through unmetered (both payment modes coexist).

## Container-facing LLM proxy (`/api/llm/*`)

Groundwork for the hosted agent (ADR 0003 increment 2b, issue #48): the Worker is the only place a real LLM provider key exists, and the agent container reaches Anthropic exclusively through this proxy.
The worst a hostile prompt inside the container can spend is its own already-metered short-lived token.

The contract the container consumes (wired per turn since increment 3b):

- The container's pi session sets its Anthropic base URL override to `https://<host>/api/llm/anthropic/<conversationId>` - no `/v1`, because the Anthropic SDK appends its own `/v1/...` paths.
- Its "API key" is a short-lived conversation-scoped JWT (HS256, jose) minted by the user's Durable Object (`llmToken.ts`, signed with the `CHAMFER_LLM_TOKEN_SECRET` secret, 15 minute default TTL; `sub` = user id, private claim `cnv` = conversation id).
  The SDK sends it as `x-api-key`; `Authorization: Bearer` is accepted too.
- The route is deliberately not behind the better-auth session: the container has no cookie jar.
  Invalid, expired, or cross-conversation tokens get a uniform 401; a deployment without the secret answers 503.
- On a valid token the Worker routes to the Durable Object of the user the token names, which resolves the key with the same policy as chat: the user's Settings key first (unmetered, their base URL honored), demo key fallback (metered).
- Demo traffic debits the same dollar accounting as the chat path - the per-account lifetime cap (`online_demo_spend` in the user's DO) and the shared global monthly ceiling (`global_demo_spend` in D1) - priced from the streamed usage breakdown, so switching surfaces cannot double-spend or dodge a cap.
  A spent per-account cap answers 429 with the chat path's message; a spent global pool answers 429 with the capacity message and cuts the demo to BYOK for everyone until the UTC month rolls over.
  Demo traffic is also pinned to the demo model (`DEMO_MODEL_ID` in `onlineApp.ts`, the same pin the chat path defaults to): cost is priced from that model's rates, so a request naming any other model is refused with 403.
  BYOK traffic is the user's own bill and is never model-restricted.
- Responses stream through incrementally; upstream auth headers never echo back and the resolved key never appears in the response.

`npm run probe:llm-proxy` (in this package) is the integration probe: it boots a hermetic `wrangler dev` on a private port against a fake Anthropic upstream and completes a streamed request through the proxy the way the container will.

## Self-hosted demo gateway (cloudflared tunnel + Cloudflare Access)

The free demo can be funded by a self-hosted Anthropic-compatible gateway (for example a box on a home network with only an internal IP) instead of a metered Anthropic key.
`CHAMFER_DEMO_ANTHROPIC_BASE_URL` already routes both demo upstream paths - the chat path (`budget.ts`, via pi-ai's `model.baseUrl`) and the hosted-agent proxy (`llmProxy.ts`) - so this is a configuration change plus one code seam for edge auth.

The gateway must speak the Anthropic **Messages** API at `<base>/v1/messages`, authenticate the `x-api-key` header, and be able to serve the demo model (`claude-sonnet-5`, `DEMO_MODEL_ID` in `onlineApp.ts`, the pin the demo is priced against).
The base URL is the gateway **root without `/v1`** - both paths append `/v1/messages` themselves.

**BYOK is never affected.** A user who configures their own key in Settings passes through unmetered to their own base URL (or the real provider default); the demo base URL and the Access token below are reachable only on the keyless demo branch, which the `budget.test.ts` / `llmProxy.test.ts` "never overrides a user's own key" and "never presents the Access token on BYOK" cases lock in.

### Expose the gateway (`cloudflared`)

`cloudflared` dials **out** from the gateway host to Cloudflare, so no inbound ports or public IP are needed. On the gateway host:

```bash
cloudflared tunnel login                       # authorize your Cloudflare zone's account
cloudflared tunnel create chamfer-llm          # writes ~/.cloudflared/<UUID>.json
# ~/.cloudflared/config.yml:
#   tunnel: <UUID>
#   credentials-file: /home/<you>/.cloudflared/<UUID>.json
#   ingress:
#     - hostname: llm.example.com
#       service: http://localhost:8080          # the local gateway
#     - service: http_status:404
cloudflared tunnel route dns chamfer-llm llm.example.com   # proxied CNAME on the zone
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

### Guard the tunnel (Cloudflare Access service token)

Without edge auth the tunnel hostname is a public endpoint anyone who finds it can hit.
A Cloudflare Access **service token** makes the edge reject every request that lacks it, so only this Worker ever reaches the gateway:

1. Zero Trust dashboard -> Access -> Service Auth -> Service Tokens -> create one; keep the Client ID and Client Secret.
2. Zero Trust -> Access -> Applications -> add a self-hosted app for `llm.example.com` with a single **Allow** policy whose include rule is that service token (and no identity-based fallback, so nothing else is admitted).
3. Give the Worker the token as secrets:
   ```bash
   wrangler secret put CHAMFER_DEMO_ANTHROPIC_BASE_URL   # https://llm.example.com
   wrangler secret put CHAMFER_DEMO_ANTHROPIC_KEY        # the gateway's x-api-key value
   wrangler secret put CHAMFER_DEMO_ACCESS_CLIENT_ID     # <uuid>.access
   wrangler secret put CHAMFER_DEMO_ACCESS_CLIENT_SECRET
   ```

Both demo upstream paths then send `CF-Access-Client-Id` / `CF-Access-Client-Secret`; the proxy path also strips any copy a container prompt tries to smuggle inbound before setting its own.
Leaving the two Access secrets unset keeps the tunnel guarded by the gateway key alone (simpler, but the gateway is reachable by anyone who discovers the hostname).

## Per-user agent container (ADR 0003 increment 3a)

Each user's Durable Object has a per-user Cloudflare Container attached that runs the hosted agent image from `container/` (issue #50).
The `containers` block in `wrangler.jsonc` binds the `ChamferAgentContainer` class (instance type `standard-1` per ADR 0003) to the `AGENT_CONTAINER` Durable Object namespace.
The pinned `image` is a pre-built reference in the Cloudflare registry, never a Dockerfile: Workers Builds has no Docker, so deploys only reference the image.
Container-affecting changes ship by bumping the pinned tag in `wrangler.jsonc` and pushing the image before merging; the `container:push` script builds and pushes exactly the pinned name:tag so image and reference cannot drift.
The reliable way to run it is the `container-image` GitHub Actions workflow (`gh workflow run container-image.yml --ref <branch>`; needs the `CLOUDFLARE_API_TOKEN` repo secret with the Containers Edit permission): runners build `linux/amd64` natively on a clean network.
`npm run container:push` also works locally with Docker and a wrangler login carrying the containers scopes, but large-layer pushes are hostage to the local network.
`npm run dev` and the e2e gate still build the image from `container/Dockerfile` (via the generated `.wrangler.dev.jsonc` and the e2e's own config), so local work always runs this branch's container code.
Instances are named by the owning user DO's id, so compute isolation follows the same authenticated-user-id boundary as state isolation.
`sleepAfter` is minutes, not hours: an idle container scales to zero, which is the trial-funnel economics the ADR chose.

The container boots with an exact-allowlist environment (`agentContainerBootEnv` in `src/agentContainer.ts`): `CHAMFER_LLM_BASE_URL` pointing at this deployment's own origin, the demo model as `CHAMFER_MODEL`, and a placeholder `CHAMFER_LLM_TOKEN`.
The placeholder is not a credential; the real conversation-scoped token arrives per turn in the seed request (see "Hosted agent turns" below) and overwrites it before the first LLM request.
No LLM provider key ever appears in the container environment - that is the #40 custody rule, and the boot-env unit tests enforce the allowlist.

## Hosted agent turns (ADR 0003 increment 3b, issue #51)

`POST /api/agent/:id/messages` on the user's Durable Object drives one turn on that user's container (`src/agentTurns.ts`):

1. Wake the container (any `Container.fetch` does) and seed the full stored transcript through the watermark-idempotent `POST /api/container/:id/seed`; rows the container already holds are skipped.
2. Mint a fresh conversation-scoped proxy token (TTL sized to a worst-case turn at the deployment's `CHAMFER_MAX_CAD_RUNS`; 30 min at the default cap of 10) and deliver it with this conversation's proxy base URL in the same seed body; the container writes both into its settings and refreshes its live model runtime, so the turn never starts on stale credentials.
3. Forward the prompt and answer 202.

Turns serialize per container: the delivered URL and token are conversation-scoped while the container's settings table is global, so a prompt for a second conversation during a live turn is refused; a follow-up for the live conversation forwards through (pi queues it) carrying a fresh token.
The DO consumes the container's SSE stream itself and fans events out to browser connections unbuffered, so turn completion is observed even with every tab closed: at `agent_end` it drains the turn's new transcript rows verbatim into the DO conversation store and copies the artifact bytes into R2 (`src/r2ArtifactStore.ts`, a persisted revision counter behind the shared `ArtifactStore` contract).
A persisted turn marker plus a DO alarm (30 s cadence, well inside the container's 5 min `sleepAfter`) survive DO eviction and finish the drain when the in-memory watcher cannot.
By turn end everything of record has left the container - a container eviction between turns loses nothing, and a woken container reseeds from the store.
`GET /api/agent/:id/artifact` serves from R2, so the viewer works while the container sleeps.

Only build123d conversations run hosted; a prompt on a Fusion conversation is refused before the container is touched (#40: Fusion is local-only, permanently).

`npm run e2e:hosted-turns` (in this package) is the end-to-end gate: a hermetic `wrangler dev` plus local Docker plus the fake Anthropic upstream, driven through a real browser from prompt to rendered artifact.
It then asserts the statelessness rule from the outside - transcript rows in the DO store, the artifact object in R2 - and runs the amnesia test: docker-kill the run's container mid-conversation, prompt again, and require the fresh container to replay the full context.
It also records the first-turn latency (prompt to artifact visible), the trial-funnel number.
It needs Docker running (skips cleanly otherwise) and a Playwright Chromium.

### Deploy prerequisites for agent hosting

- Workers paid plan with Containers enabled (the `containers` block in `wrangler.jsonc`).
- Local Docker running at deploy time: `wrangler deploy` builds and pushes the `linux/amd64` image.
- `CHAMFER_LLM_TOKEN_SECRET` set as a Worker secret; without it the deployment stays in the degraded posture (`agentHosting: false`) instead of half-working.
- `CHAMFER_APP_ORIGIN` reachable from inside the container (production default); local dev uses `CHAMFER_CONTAINER_LLM_ORIGIN` in `.dev.vars` instead.
- `max_instances: 10` in the `containers` block is a deliberate trial-funnel default: it globally caps how many users' containers can run at once, and the eleventh concurrent user's turn fails to start until one scales to zero (`sleepAfter` 5 min).
  Raise it in `wrangler.jsonc` as real usage grows; each instance only costs while running.
- Optional `CHAMFER_MAX_CAD_RUNS` (positive integer, default 10) raises the per-turn CAD-execution cap; it sizes the per-turn token TTL and passes through to the container boot env so both stay aligned.

`GET /api/online/agent-container/health` (session-authenticated, served by the user's DO) wakes that user's container, calls its `/api/health`, and reports `ok` plus the observed wake latency in ms.
On a deployment without the container binding it answers 503 with `configured: false` instead of crashing; increment 4's cron probe hooks in here.

### Image build staging

Wrangler builds the image from `container/Dockerfile` with that directory as the Docker build context, but the context must be staged first: `node container/build.mjs` bundles the server's container entry into `container/dist/`.
The `predev` and `predeploy` scripts in this package run the staging step automatically, so use `npm run dev` and `npm run deploy` here (or `npm run deploy:online` at the repo root), not bare `npx wrangler dev|deploy`.
A stale `container/dist/` silently ships old agent code; a missing one fails the Docker build loudly.

### Local development with the container

`wrangler dev` runs the container against your local Docker daemon, so Docker must be running.
Set `CHAMFER_CONTAINER_LLM_ORIGIN` in `.dev.vars` to the wrangler-dev origin as seen from inside Docker (`http://host.docker.internal:<port>` on macOS/Windows Docker); localhost inside the container is the container itself.
To iterate on the Worker without Docker, pass `--enable-containers=false` to `wrangler dev`; the probe route then reports the unconfigured state.

### Deploying the container

`wrangler deploy` with a `containers` block requires local Docker: it builds the image (`linux/amd64`) and pushes it to the Cloudflare registry on first deploy and on every image change.
For Workers Builds, the build command must also stage the context, i.e. `npm ci --include=dev && npm run build:online && node packages/online/container/build.mjs`.

## Local development

```bash
cp .dev.vars.example .dev.vars       # enables CHAMFER_DEV_LOGIN; add a demo key if you want streaming
npm run build:client                 # builds the client into client-dist/
npx wrangler d1 migrations apply chamfer-online-auth --local
npx wrangler dev                     # http://localhost:8787
```

With `CHAMFER_DEV_LOGIN=1` every request is signed in as a fixed dev user, so no OAuth credentials are needed.

## Hosts

- **chamferonline.com** (apex) - the landing page. Signed-in visitors get an "Open Chamfer" shortcut to the app.
- **app.chamferonline.com** - the application. Signed-out visitors are redirected to the apex.

Both are the same Worker; `worker.ts` and `OnlineGate.tsx` branch on the request host, driven by `CHAMFER_LANDING_ORIGIN` / `CHAMFER_APP_ORIGIN`. A single Google sign-in spans both hosts via a `.chamferonline.com` session cookie (`CHAMFER_COOKIE_DOMAIN` + `crossSubDomainCookies` in `auth.ts`), and `CHAMFER_TRUSTED_ORIGINS` lets better-auth redirect between them.

### Apex cutover (done 2026-07-17)

The apex previously served the GitHub Pages project page. To make it the Worker landing, its four GitHub Pages A records were deleted and the Worker custom domain attached. `www.chamferonline.com` still CNAMEs to `smartai.github.io` (the old project page) and the `_github-pages-challenge-smartai` TXT is untouched.

**Rollback** (revert the apex to GitHub Pages): in the Cloudflare dashboard DNS for chamferonline.com, remove the `chamferonline.com` Worker custom domain, then re-add four proxied A records on the apex pointing at `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`, and drop the apex route from `wrangler.jsonc`.

## Production setup (done 2026-07-17, kept for rebuild-from-scratch)

1. `npx wrangler d1 create chamfer-online-auth` and put the returned `database_id` into `wrangler.jsonc` (current id is committed there).
2. `npx wrangler d1 migrations apply chamfer-online-auth --remote`.
   Then the attachment bucket: enable R2 on the account first (Dashboard → R2; requires accepting the R2 terms - the API refuses with code 10042 until then), then `npx wrangler r2 bucket create chamfer-online-attachments`.
3. Secrets (`npx wrangler secret put <NAME>`), all set:
   - `BETTER_AUTH_SECRET` - `openssl rand -base64 32`.
   - `CHAMFER_DEMO_ANTHROPIC_KEY` + `CHAMFER_DEMO_ANTHROPIC_BASE_URL` - funds the free demo quota. The base URL may be a self-hosted Anthropic-compatible gateway reached over a `cloudflared` tunnel; add `CHAMFER_DEMO_ACCESS_CLIENT_ID` + `CHAMFER_DEMO_ACCESS_CLIENT_SECRET` when that tunnel is guarded by Cloudflare Access. See "Self-hosted demo gateway" below.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - OAuth client `chamfer-online` in GCP project `smartai-personal`; authorized redirect URIs cover the workers.dev, apex, and `app.` callbacks (`/api/auth/callback/google`).
   - `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` - GitHub OAuth app "Chamfer Online" (owned by SmartAI), callback `https://chamfer-online.minliu905.workers.dev/api/auth/callback/github`. GitHub allows one callback per app: switch it to `https://app.chamferonline.com/api/auth/callback/github` when GitHub sign-in should work on the custom domain.
   - `CHAMFER_LLM_TOKEN_SECRET` - `openssl rand -base64 32`; signs the short-lived conversation tokens that authenticate the container-facing LLM proxy (see below).
     Unset keeps `/api/llm/*` answering 503 and, since increment 3b, the whole deployment in the degraded no-agent-hosting posture.
4. Vars in `wrangler.jsonc`: tune the demo dollar caps - `CHAMFER_DEMO_LIFETIME_USD` (per-account lifetime, default 2) and `CHAMFER_DEMO_MONTHLY_USD` (global monthly ceiling across all users, default 50). `BETTER_AUTH_URL` is unset on purpose - the auth base URL follows the request origin, which keeps every attached hostname working.
5. Domain: `routes` in `wrangler.jsonc` attaches `app.chamferonline.com` as a Workers custom domain on deploy. The apex cannot be attached while the landing page's DNS records exist (Cloudflare error 100117); move the landing or keep the split.
6. Deploy: see below.

## Deploying

Two ways, pick one:

- **Cloudflare Workers Builds (automatic, recommended - this is what's configured).** The `chamfer-online` Worker is connected to `SmartAI/Chamfer-private`; Cloudflare builds and deploys on every push to `main`. Because this is an npm-workspaces monorepo and the client must be built into `client-dist` first, the build settings are:
  - **Root directory:** `/` (repo root)
  - **Build command:** `npm ci --include=dev && npm run build:online` (builds `@chamfer/shared` + the online client into `packages/online/client-dist`; `--include=dev` guards against the builder skipping devDependencies)
  - The container image is never built here: `wrangler.jsonc` references a pre-built image in the Cloudflare registry, pushed ahead of time via `npm run container:push` (see "Per-user agent container" above).
  - **Deploy command (production branch):** `npx wrangler deploy --config packages/online/wrangler.jsonc`
  - **Non-production branch deploy command (preview builds):** `npx wrangler deploy --dry-run --config packages/online/wrangler.jsonc`
  - **Production branch:** `main`

  The non-production command is deliberately a dry run, not `wrangler versions upload`: version uploads reject any Worker carrying a new Durable Object migration (API error 10211, hit when the `v2` container migration landed), while migrations may only apply through the real production deploy.
  The dry run still validates the build, the config, and the bindings on every PR; we never consumed preview versions.

  Both deploy commands **must** carry `--config packages/online/wrangler.jsonc`: the root directory is the repo root, so without it wrangler can't find the config and fails with "Missing entry-point." (The non-production command defaults to `npx wrangler versions upload` with no `--config` — that's the one to remember to fix.)

  Worker secrets set via `wrangler secret` persist across these deploys — no need to re-add them. Cloudflare injects its own deploy credentials, so there's no API token to manage. **Note:** the deploy does *not* run D1 migrations — the auth schema is applied manually (`wrangler d1 migrations apply chamfer-online-auth --remote`); per-user Durable Object schemas apply themselves in code on each object. Only re-run the D1 step if `migrations/` changes.

- **From your machine (manual).** From the repo root: `npm run deploy:online` (builds shared + the online client, then `wrangler deploy --config packages/online/wrangler.jsonc`).
  Docker is not needed for the deploy itself; it is only needed by `npm run container:push` when the container image changes.

Never set `CHAMFER_DEV_LOGIN` in production - it bypasses authentication entirely and belongs only in `.dev.vars`.

## Monitoring

Two layers guard against the online API surface silently drifting from what the client calls (the failure that took down `/api/designs`):

- **Build-time gate.** `routeParity.test.ts` (runs in CI via `npm test`) diffs `createOnlineApp` against the local server's `createApp` and fails if any server route is missing online except the documented `DELIBERATE_ONLINE_OMISSIONS`. A new server route that forgets the cloud can never merge.
- **Runtime probe.** `GET /api/online/health` is public (no session) and forwards to a dedicated health Durable Object, so it exercises DO boot, schema init, and the live route table end to end. It returns `200 {ok:true}` when the client-critical routes are mounted and `503 {ok:false,missing:[...]}` otherwise - unlike a plain `GET /`, which stayed 200 throughout the incident. Point an uptime monitor (Sentry Uptime or a Cloudflare Health Check) at it and alert on non-200.

Error reporting uses Sentry, disabled unless a DSN is configured:

- **Worker:** set the `SENTRY_DSN` secret (`wrangler secret put SENTRY_DSN`); optional `SENTRY_ENVIRONMENT`, `CHAMFER_RELEASE`. Captures uncaught errors in auth, session resolution, and rejected DO subrequests. Instrumenting Durable-Object-internal errors is a deliberate follow-up (it requires the DO to extend the `cloudflare:workers` base class).
- **Client:** set `VITE_SENTRY_DSN` in the build environment (Cloudflare Workers Builds env vars, or your shell for a local `build:online`). Optional `VITE_SENTRY_ENVIRONMENT`, `VITE_CHAMFER_RELEASE`. Captures unhandled errors plus handled failures that signal a broken deployment (a failed startup fetch, any 5xx).

## Follow-ups deliberately out of scope for v1

- Cloudflare Turnstile on sign-in (social OAuth plus per-user budgets bound abuse for now).
- Signed-out read-only demo / example gallery.
- Re-authentication prompt when a session expires mid-conversation (today the client surfaces persist errors and recovers on reload).
- A visible budget meter in the UI (`GET /api/online/budget` already serves the data).
