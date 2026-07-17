import { describe, expect, it } from "vitest";
import type { FusionMcpClient } from "./mcpClient";
import { executeFusionScript } from "./mcpPayload";

/** Captures the exact script string handed to the adapter's execute tool. */
function capturingClient(): { client: FusionMcpClient; scripts: string[] } {
  const scripts: string[] = [];
  const client: FusionMcpClient = {
    connect: async () => ({}) as never,
    close: async () => {},
    callJson: async (toolName, args) => {
      expect(toolName).toBe("fusion_mcp_execute");
      const object = (args as { object: { script: string } }).object;
      scripts.push(object.script);
      // Minimal well-formed payload the parser accepts.
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
  };
  return { client, scripts };
}

describe("executeFusionScript adapter hardening", () => {
  it("raises the recursion limit before the body and collapses the stdout wrapper after run", async () => {
    const { client, scripts } = capturingClient();
    await executeFusionScript(client, "import adsk.core\ndef run(_c):\n    print('hi')\n");
    expect(scripts).toHaveLength(1);
    const sent = scripts[0] ?? "";

    // Preamble first: lift the interpreter recursion ceiling before the body runs.
    expect(sent.startsWith("import sys as _sys")).toBe(true);
    expect(sent).toContain("setrecursionlimit(8000)");

    // The original body is preserved verbatim between preamble and postamble.
    expect(sent).toContain("def run(_c):\n    print('hi')");

    // Postamble last: wrap run and, in a finally, walk sys.stdout back down the
    // leaked _NsSanitizedWriter chain to the base stream so depth never grows.
    const preambleEnd = sent.indexOf("def run(_c):");
    const postamble = sent.slice(preambleEnd);
    expect(postamble).toContain("_chamfer_user_run = run");
    expect(postamble).toContain("finally:");
    expect(postamble).toContain("_NsSanitizedWriter");
    expect(postamble).toContain("_original");
    expect(postamble).toContain("_sys.stdout = _chamfer_out");
    // Guarded so a script that never defines run cannot make execution fail.
    expect(postamble).toContain("except NameError:");
  });
});
