# The hosted deployment runs the unmodified pi harness in per-user Cloudflare Containers

The M1 pivot (issue #33) replaced the browser-resident agent loop with the off-the-shelf pi-coding-agent harness, which is an OS-native program: it persists sessions on a filesystem, spawns MCP servers as stdio subprocesses, and runs CAD tools on real CPython with native OCCT.
That ended the property that made chamferonline.com nearly free to operate - visitors' browsers supplying the compute - so agent turns went dark online, and this decision chooses how to restore them.

We decided three things.
First, the hosted deployment is a trial funnel, not a parity product surface: its job is "stranger runs a first verified part in under a minute and converts to `npx chamfer`", so scale-to-zero economics and honest capability gaps (no Fusion connector, budgeted runs) are by design.
Second, we host the harness unmodified rather than build a browser-native second arm (pi-agent-core loop plus a Pyodide/OCP.wasm executor): the benchmarked artifact is the value, both prior hand-built arms lost their benches, and a browser arm would re-own exactly the maintenance treadmill the pivot escaped, plus the Pyodide version-matrix tax.
Third, the machine we provide is a per-user Cloudflare Container (`standard-1`: half vCPU, 4 GiB, 8 GB disk) attached to the existing per-user Durable Object, with the uv/build123d-mcp environment baked into the image.

We rejected the full-Node-host migration (the earlier README sketch) because the local server is single-user by design: a shared Node box would need auth, tenancy, state migration off DO SQLite/D1/R2, and - since LLM-written Python must never share an OS between users - a hand-operated container layer anyway, discarding the working Worker/DO/R2 stack to rebuild what Containers sell.
We rejected external sandbox services (Modal, E2B, Fly Machines) because they add a second vendor, move user code and keys outside Cloudflare, and buy capabilities (GPUs, large memory) a trial funnel does not need.

Consequences: compute isolation now follows the same boundary as state isolation (everything derives from the authenticated user id); marginal cost is roughly $0 idle and cents per trial, with demo-key LLM tokens - already budget-metered - dominating; and the image is plain `linux/amd64` Docker, so any container host remains an escape hatch if the platform disappoints.
One hard rule follows from hosting untrusted CAD code next to the agent: no LLM provider key ever enters a machine that executes CAD code on the hosted deployment.
The container's pi session calls a Worker-hosted LLM proxy through a base-URL override, authenticated by a short-lived conversation-scoped token; the Worker injects the real key and enforces the token budget at that choke point, so the worst a hostile prompt can steal is its own already-metered session token.
A second principle follows from scale-to-zero: the container is stateless compute, never a store of record.
By the end of each turn, everything later turns depend on has left the machine - the full turn transcript including tool calls with the CAD code goes to the conversation store, and the exported artifact goes to R2 - and a woken container rebuilds its pi session by reseeding from that store.
This also fixes two latent defects that predate hosting: local server restarts currently leave follow-up turns amnesiac, and the executed CAD code is not durably persisted anywhere (only the final assistant prose and the artifact file survive a process exit).
