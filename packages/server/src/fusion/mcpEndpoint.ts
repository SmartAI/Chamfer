/** Endpoint shape validation, split from mcpClient so settings code (which is
 * also bundled into the online Worker) does not drag in the MCP SDK and its
 * node-flavored fetch types. */
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
