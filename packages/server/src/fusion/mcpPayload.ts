import type { FusionMcpClient } from "./mcpClient";

const EXECUTE_TOOL = "fusion_mcp_execute";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function parseFusionScriptPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Fusion script returned a non-object result");
  if (value.success === false) throw new Error(String(value.error ?? value.message ?? "Fusion script failed"));
  for (const key of ["output", "result", "scriptOutput", "message"]) {
    const nested = value[key];
    if (typeof nested !== "string") continue;
    const trimmed = nested.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) return parsed;
    } catch {
      if (key !== "message") throw new Error(`Fusion script output was not JSON: ${trimmed}`);
    }
  }
  return value;
}

// The installed Fusion MCP adapter leaks a sys.stdout wrapper on every script
// execution and never restores it, so the wrapper chain deepens by one per call.
// Once it passes Python's recursion limit, the adapter's own result-write hits a
// RecursionError and every subsequent tool call - including the adapter-internal
// apiDocumentation reads used by readiness - fails until Fusion is restarted.
// Raising the limit is process-global, so running it inside the frequently-called
// readiness/inspection execute keeps the whole adapter (reads included) below the
// ceiling for the life of a normal session. It cannot stop the leak, only the
// premature crash; the value stays well under the C-stack ceiling to avoid a
// segfault, and is a no-op on adapters that do not exhibit the leak.
const RECURSION_GUARD_PREAMBLE = [
  "import sys as _sys",
  "try:",
  "    if _sys.getrecursionlimit() < 8000:",
  "        _sys.setrecursionlimit(8000)",
  "except Exception:",
  "    pass",
  "",
].join("\n");

// The adapter stacks a fresh `_NsSanitizedWriter` on `sys.stdout` before every
// script and never unwinds it, so the wrapper chain deepens by one per execute
// (observed: 581 layers deep in a single session) until a write recurses through
// the whole chain and the interpreter stack overflows. The wrapper is a plain
// Python object that references the stream it wraps through `_original`, and our
// script runs in the same interpreter, so we can undo the leak from our side:
// wrap the adapter's `run` entry point and, in a finally, walk `sys.stdout` back
// down to the base stream. The collapse runs after the user body's output has
// already been captured by this call's wrapper (the adapter reads that wrapper
// object, not `sys.stdout`, so capture is preserved - verified), and it leaves
// `sys.stdout` at the base so the next call re-wraps from depth one instead of
// N+1. This makes the connector self-healing: no Fusion restart to clear the leak.
const STDOUT_COLLAPSE_POSTAMBLE = [
  "",
  "try:",
  "    _chamfer_user_run = run",
  "    def run(_context, _chamfer_user_run=_chamfer_user_run):",
  "        try:",
  "            return _chamfer_user_run(_context)",
  "        finally:",
  "            _chamfer_out = _sys.stdout",
  "            for _ in range(6000):",
  "                if type(_chamfer_out).__name__ == '_NsSanitizedWriter' and hasattr(_chamfer_out, '_original'):",
  "                    _chamfer_out = _chamfer_out._original",
  "                else:",
  "                    break",
  "            _sys.stdout = _chamfer_out",
  "except NameError:",
  "    pass",
  "",
].join("\n");

export async function executeFusionScript(
  client: FusionMcpClient,
  script: string,
  options?: { timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const value = await client.callJson(EXECUTE_TOOL, {
    featureType: "script",
    object: { script: `${RECURSION_GUARD_PREAMBLE}${script}${STDOUT_COLLAPSE_POSTAMBLE}` },
  }, options);
  return parseFusionScriptPayload(value);
}

// Runs the recursion-guard preamble against a freshly connected adapter so the
// interpreter limit is raised before readiness negotiation issues its ungated
// apiDocumentation reads - those reads execute adapter-internal scripts that
// leak the same sys.stdout wrapper, and they run first in the refresh sequence,
// so without this priming step they could push the chain past the default limit
// and fail negotiation before any guarded execute had a chance to raise it.
// Best-effort: a no-op on adapters that do not leak, and harmless if the adapter
// is already too deep to recover (a restart is the only cure in that case).
export async function primeFusionRecursionGuard(client: FusionMcpClient): Promise<void> {
  try {
    await executeFusionScript(client, "import json\ndef run(_c):\n    print(json.dumps({\"guard\": True}))\n");
  } catch {
    // Intentionally ignored - priming is opportunistic hardening, not a gate.
  }
}
