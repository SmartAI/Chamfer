import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateFusionMcpEndpoint } from "./mcpClient";

const execFileAsync = promisify(execFile);

/** Fusion's preferred MCP port when it is free; it only drifts to an ephemeral
 * port when this one is already held (for example by a still-exiting instance). */
export const DEFAULT_FUSION_MCP_PORT = 27182;

const ADAPTER_SERVER_NAME = "MCP Server Adapter";

/** Probe one loopback port with an MCP initialize handshake. Resolves the
 * canonical endpoint only when the port answers as the Fusion adapter, and
 * never contacts anything other than 127.0.0.1/mcp. */
export type FusionMcpPortProbe = (port: number) => Promise<boolean>;

/** Lists the loopback TCP ports the local Autodesk Fusion process is listening
 * on. Best-effort and platform-specific; returns [] when it cannot enumerate. */
export type FusionPortLister = () => Promise<number[]>;

export interface DiscoverFusionMcpEndpointOptions {
  /** Endpoint to try first (an explicit setting or the last known-good one). */
  preferredEndpoint?: string;
  probe?: FusionMcpPortProbe;
  listPorts?: FusionPortLister;
  /** Injectable for tests; defaults to the preferred port constant. */
  defaultPort?: number;
}

async function defaultProbe(port: number, timeoutMs = 1500): Promise<boolean> {
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  try {
    validateFusionMcpEndpoint(endpoint);
  } catch {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "chamfer-fusion-discovery", version: "0.1.0" },
        },
      }),
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.text();
    // The adapter answers this handshake (JSON or SSE) with its serverInfo. Any
    // other loopback service on the port will not carry the exact adapter name.
    return new RegExp(`"serverInfo"[\\s\\S]*?"name"\\s*:\\s*"${ADAPTER_SERVER_NAME}"`).test(body);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultListPorts(): Promise<number[]> {
  // macOS/Linux only. On other platforms enumeration is skipped and discovery
  // falls back to the preferred and default ports, which cover normal launches.
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  try {
    const { stdout: pids } = await execFileAsync("pgrep", [
      "-f",
      "Autodesk Fusion.app/Contents/MacOS/Autodesk Fusion",
    ]);
    const pid = pids.split("\n").map((line) => line.trim()).find(Boolean);
    if (!pid) return [];
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid]);
    const ports = new Set<number>();
    for (const match of stdout.matchAll(/127\.0\.0\.1:(\d+)\b/g)) ports.add(Number(match[1]));
    return [...ports];
  } catch {
    return [];
  }
}

function portOf(endpoint: string | undefined): number | undefined {
  if (!endpoint) return undefined;
  try {
    const port = Number(new URL(endpoint).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the live Fusion MCP endpoint without a hardcoded port. Tries the
 * preferred endpoint, then the preferred default, then every loopback port the
 * local Fusion process is listening on, and returns the first that answers as
 * the adapter. Returns undefined when Fusion is not reachable. */
export async function discoverFusionMcpEndpoint(
  options: DiscoverFusionMcpEndpointOptions = {},
): Promise<string | undefined> {
  const probe = options.probe ?? ((port: number) => defaultProbe(port));
  const listPorts = options.listPorts ?? defaultListPorts;
  const defaultPort = options.defaultPort ?? DEFAULT_FUSION_MCP_PORT;

  const ordered: number[] = [];
  const push = (port: number | undefined) => {
    if (port !== undefined && Number.isInteger(port) && port > 0) ordered.push(port);
  };
  push(portOf(options.preferredEndpoint));
  push(defaultPort);
  for (const port of await listPorts()) push(port);

  const seen = new Set<number>();
  for (const port of ordered) {
    if (seen.has(port)) continue;
    seen.add(port);
    if (await probe(port)) return `http://127.0.0.1:${port}/mcp`;
  }
  return undefined;
}
