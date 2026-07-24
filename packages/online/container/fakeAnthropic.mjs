// Scripted Anthropic Messages stub for the container smoke: stands in for the
// increment-2b Worker LLM proxy so a fake-LLM turn exercises the real pi
// session, the real MCP adapter, and the baked build123d environment with no
// provider key anywhere. The script is a fixed three-beat turn:
//   request 1 -> tool_use execute (build a 10x20x30 box, show it)
//   request 2 -> tool_use export (./artifact.stl, stl)
//   request 3 -> final text
// Steps are keyed on how many tool_result blocks the transcript carries, so
// retries replay deterministically. Emits the Anthropic streaming SSE format
// that pi-ai's anthropic-messages API consumes (message_start,
// content_block_*, message_delta, message_stop).
import { createServer } from "node:http";

export const FAKE_BOX_CODE = [
  "from build123d import *",
  "width = 10",
  "depth = 20",
  "height = 30",
  "box = Box(width, depth, height)",
  'show(box, "box")',
].join("\n");

function toolResultCount(body) {
  let count = 0;
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "tool_result") count += 1;
    }
  }
  return count;
}

function sseFrames(step) {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const start = {
    type: "message_start",
    message: {
      id: `msg_fake_${step}`,
      type: "message",
      role: "assistant",
      model: "chamfer-fake",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  };
  const stop = (reason) => [
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  if (step === 0 || step === 1) {
    const toolUse = step === 0
      ? { name: "execute", input: { code: FAKE_BOX_CODE } }
      : { name: "export", input: { filename: "./artifact.stl", format: "stl" } };
    return [
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: `toolu_fake_${step}`, name: toolUse.name, input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.input) },
      },
      ...stop("tool_use"),
    ];
  }
  const text = "Done - built the 10x20x30 box and exported it to ./artifact.stl.";
  return [
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ...stop("end_turn"),
  ];
}

/**
 * Starts the stub on 0.0.0.0 (containers reach it via host.docker.internal).
 * Returns { port, requests, close }; requests records one entry per LLM call
 * with the api key header and tool names offered, for smoke assertions.
 */
export function startFakeAnthropic(port = 0) {
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw);
      const step = toolResultCount(body);
      requests.push({
        step,
        apiKey: req.headers["x-api-key"] ?? null,
        toolNames: (body.tools ?? []).map((tool) => tool.name),
      });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      for (const frame of sseFrames(step)) {
        res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      }
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
