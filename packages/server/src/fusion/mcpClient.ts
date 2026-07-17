import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface FusionRawTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface FusionMcpSessionInfo {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  tools: FusionRawTool[];
}

export interface FusionMcpClient {
  connect(): Promise<FusionMcpSessionInfo>;
  callJson(toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function parseTextPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function validateFusionMcpEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Fusion MCP endpoint must be a valid URL");
  }
  if (
    endpoint !== url.href ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Fusion MCP endpoint must be exactly http://127.0.0.1:<port>/mcp");
  }
  return url;
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Fetch policy for the server-owned bridge. It follows no redirects and can
 * never be reused as a general proxy, even if the MCP SDK requests another URL. */
export function createLoopbackOnlyFetch(endpoint: URL, fetchImpl: FetchLike = fetch): FetchLike {
  const expected = endpoint.href;
  const allowedHeaders = new Set([
    "accept", "content-type", "last-event-id", "mcp-protocol-version", "mcp-session-id",
  ]);
  return async (input, init) => {
    const requested = new URL(String(input));
    if (requested.href !== expected) {
      throw new Error("Fusion MCP bridge refused a non-configured URL");
    }
    const headers = new Headers(init?.headers);
    for (const name of headers.keys()) {
      if (!allowedHeaders.has(name.toLowerCase())) {
        throw new Error(`Fusion MCP bridge refused request header ${name.toLowerCase()}`);
      }
    }
    const response = await fetchImpl(requested, {
      ...init,
      headers,
      redirect: "manual",
      credentials: "omit",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        try {
          validateFusionMcpEndpoint(new URL(location, requested).href);
        } catch {
          throw new Error("Fusion MCP bridge refused an unsafe redirect");
        }
      }
      throw new Error("Fusion MCP bridge does not follow redirects");
    }
    return response;
  };
}

export class SdkFusionMcpClient implements FusionMcpClient {
  private readonly client = new Client({ name: "chamfer-fusion-integrity-probe", version: "0.1.0" });
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(endpoint: string) {
    const url = validateFusionMcpEndpoint(endpoint);
    this.transport = new StreamableHTTPClientTransport(url, {
      fetch: createLoopbackOnlyFetch(url),
      requestInit: { redirect: "manual", credentials: "omit" },
    });
  }

  async connect(): Promise<FusionMcpSessionInfo> {
    await this.client.connect(this.transport);
    this.connected = true;
    const server = this.client.getServerVersion();
    const protocolVersion = this.transport.protocolVersion;
    if (!server || !protocolVersion) {
      throw new Error("Fusion MCP initialization did not return protocol and server versions");
    }
    const tools: FusionRawTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return {
      protocolVersion,
      serverName: server.name,
      serverVersion: server.version,
      tools,
    };
  }

  async callJson(toolName: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> {
    if (!this.connected) throw new Error("Fusion MCP client is not connected");
    // The SDK default request timeout is 60s. A legitimately complex action body
    // (many features + a full computeAll) can exceed that; pass an explicit
    // timeout with resetTimeoutOnProgress so a slow-but-alive execute is not cut
    // off and misrouted into hard-recovery.
    const result = await this.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      typeof options?.timeoutMs === "number" ? { timeout: options.timeoutMs, resetTimeoutOnProgress: true } : undefined,
    );
    const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
    if (result.isError) {
      const message = content
        .filter(isTextContent)
        .map((item) => item.text)
        .join("\n");
      throw new Error(message || `${toolName} returned an MCP tool error`);
    }
    if (isRecord(result.structuredContent)) return result.structuredContent;
    const texts = content
      .filter(isTextContent)
      .map((item) => parseTextPayload(item.text));
    if (texts.length === 1) return texts[0];
    if (texts.length > 1) return texts;
    return content;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.close();
  }
}
