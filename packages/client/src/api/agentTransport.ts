/**
 * Thin transport to the server-hosted pi agent session: POST a prompt, consume
 * the SSE event stream, fetch the latest exported mesh artifact. The agent loop
 * itself lives entirely in packages/server.
 */

export interface AgentImagePayload {
  /** Base64 payload without the data: URL prefix. */
  data: string;
  mimeType: string;
}

/** A pi AgentSessionEvent forwarded verbatim, or a server-added event
 * (artifact_updated, agent_error). Only `type` is guaranteed. */
export interface AgentStreamEvent {
  type: string;
  [key: string]: unknown;
}

async function throwOnError(response: Response): Promise<void> {
  if (response.ok) return;
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) message = body.error;
  } catch {
    // Non-JSON error bodies keep the status text.
  }
  throw new Error(message);
}

export async function postAgentMessage(
  conversationId: string,
  text: string,
  images: AgentImagePayload[] = [],
): Promise<void> {
  const response = await fetch(`/api/agent/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(images.length > 0 ? { text, images } : { text }),
  });
  await throwOnError(response);
}

export async function postAgentAbort(conversationId: string): Promise<void> {
  const response = await fetch(`/api/agent/${conversationId}/abort`, { method: "POST" });
  await throwOnError(response);
}

/** Opens the live agent event stream. Events arrive as JSON on unnamed SSE
 * messages; keepalive comments are filtered by the browser automatically. */
export function openAgentEvents(
  conversationId: string,
  onEvent: (event: AgentStreamEvent) => void,
): EventSource {
  const source = new EventSource(`/api/agent/${conversationId}/events`);
  source.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data as string) as AgentStreamEvent;
      if (parsed && typeof parsed.type === "string") onEvent(parsed);
    } catch {
      // Malformed frames are dropped; the stream itself stays healthy.
    }
  };
  return source;
}

export interface AgentArtifact {
  revision: number;
  /** Raw STL bytes. */
  data: ArrayBuffer;
}

/** Fetches the latest exported STL, or undefined when none exists yet. */
export async function fetchAgentArtifact(conversationId: string): Promise<AgentArtifact | undefined> {
  const response = await fetch(`/api/agent/${conversationId}/artifact`);
  if (response.status === 404) return undefined;
  await throwOnError(response);
  const revision = Number(response.headers.get("X-Artifact-Revision") ?? "0");
  return { revision, data: await response.arrayBuffer() };
}
