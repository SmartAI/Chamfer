import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { discoverFusionMcpEndpoint } from "../fusion/discovery";

/**
 * MCP wiring for the server-hosted pi agent. The MCP layer itself is
 * pi-mcp-adapter (loaded as a pi extension); this module only generates the
 * per-conversation `.mcp.json` the adapter reads from the session cwd, and
 * resolves the Fusion endpoint through discovery (the port is NOT fixed).
 */

export const BUILD123D_DIRECT_TOOLS = [
  "execute",
  "last_error",
  "inspect_part",
  "measure",
  "render_view",
  "export",
] as const;

export const FUSION_DIRECT_TOOLS = [
  "fusion_mcp_execute",
  "fusion_mcp_read",
  "fusion_mcp_update",
] as const;

/** Shared adapter settings: unprefixed tool names, no proxy tool when direct
 * tools resolve, and a request timeout that survives a long execute (first-run
 * wheel install, a full Fusion computeAll). */
const ADAPTER_SETTINGS = {
  toolPrefix: "none",
  disableProxyTool: true,
  requestTimeoutMs: 600_000,
} as const;

/** Absolute path of pi-mcp-adapter's pi extension entry point. */
export function mcpAdapterExtensionPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("pi-mcp-adapter/package.json")), "index.ts");
}

export function mcpConfigPath(conversationDir: string): string {
  return join(conversationDir, ".mcp.json");
}

/** Writes the build123d backend config: a per-conversation stdio server whose
 * process cwd is the conversation dir (build123d-mcp sandboxes file writes to
 * its server cwd, which is where ./artifact.stl lands). */
export function writeBuild123dMcpConfig(conversationDir: string): void {
  const config = {
    settings: ADAPTER_SETTINGS,
    mcpServers: {
      b123: {
        command: "uv",
        args: ["tool", "run", "--python", "3.12", "build123d-mcp==0.3.79"],
        lifecycle: "keep-alive",
        directTools: [...BUILD123D_DIRECT_TOOLS],
      },
    },
  };
  writeFileSync(mcpConfigPath(conversationDir), `${JSON.stringify(config, null, 2)}\n`);
}

/** Discovers the live Fusion MCP endpoint and writes the fusion backend config.
 * Returns the endpoint it resolved. Throws when Fusion is unreachable. */
export async function writeFusionMcpConfig(
  conversationDir: string,
  preferredEndpoint?: string,
): Promise<string> {
  const endpoint = await discoverFusionMcpEndpoint({ preferredEndpoint });
  if (!endpoint) {
    throw new Error(
      "Autodesk Fusion MCP adapter is not reachable on this machine. Is Fusion running with the MCP add-in?",
    );
  }
  const config = {
    settings: ADAPTER_SETTINGS,
    mcpServers: {
      fusion: {
        url: endpoint,
        lifecycle: "keep-alive",
        directTools: [...FUSION_DIRECT_TOOLS],
      },
    },
  };
  writeFileSync(mcpConfigPath(conversationDir), `${JSON.stringify(config, null, 2)}\n`);
  return endpoint;
}
