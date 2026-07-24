// Image build step: bakes the CAD Python environment so the first turn never
// downloads anything, and proves it by running the EXACT spawn the server
// uses (mcpTools.ts writeBuild123dMcpConfig) twice:
//   pass 1 (network allowed) - resolves build123d-mcp==0.3.79, downloads the
//     managed CPython and wheels, builds uv's cached tool environment, and
//     executes one real build123d snippet so the heavy OCCT import lands in
//     the environment's pycache.
//   pass 2 (UV_OFFLINE=1) - the same spawn must initialize and execute with
//     the network forbidden; a cold cache fails the docker build here instead
//     of stalling a user's first turn.
// Both passes also call render_view and require a real PNG back: VTK's render
// window needs a software-GL backend (libosmesa6), and if the image lacks one
// the tool does not error softly - it aborts the MCP worker ("worker crashed
// during 'render_view'"). Gating the build on a real render keeps that missing
// system library from shipping and breaking every visual check at runtime.
import { spawn } from "node:child_process";

const SPAWN = ["tool", "run", "--python", "3.12", "build123d-mcp==0.3.79"];
const EXECUTE_CODE = 'from build123d import *\nwarm = Box(1, 2, 3)\nshow(warm, "warm")';

function runPass(label, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("uv", SPAWN, { stdio: ["pipe", "pipe", "inherit"], env });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let buffer = "";
    const pending = new Map();
    const request = (id, method, params) =>
      new Promise((resolveRequest) => {
        pending.set(id, resolveRequest);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label}: failed to spawn uv: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (pending.size > 0) {
        clearTimeout(timer);
        reject(new Error(`${label}: server exited with code ${code} before responding`));
      }
    });

    (async () => {
      const init = await request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "chamfer-container-warmup", version: "0.0.0" },
      });
      if (!init.result?.serverInfo?.name) throw new Error(`${label}: initialize failed: ${JSON.stringify(init)}`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const executed = await request(2, "tools/call", {
        name: "execute",
        arguments: { code: EXECUTE_CODE },
      });
      if (executed.error || executed.result?.isError) {
        throw new Error(`${label}: warm execute failed: ${JSON.stringify(executed).slice(0, 2000)}`);
      }
      // Render the warm box and require a real PNG. A missing render backend
      // (no libosmesa6) does not surface as isError - it crashes the worker,
      // which the server reports as the render_view replay-loop failure. So
      // check for an actual image block, not just the absence of an error.
      const rendered = await request(3, "tools/call", {
        name: "render_view",
        arguments: { direction: "iso", format: "png" },
      });
      const content = rendered.result?.content ?? [];
      const image = content.find((block) => block?.type === "image" && typeof block.data === "string" && block.data.length > 0);
      if (rendered.error || rendered.result?.isError || !image) {
        throw new Error(`${label}: warm render_view produced no PNG: ${JSON.stringify(rendered).slice(0, 2000)}`);
      }
      clearTimeout(timer);
      child.kill();
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`warmup ${label}: initialize + build123d execute + render_view (${image.data.length}b PNG) ok in ${seconds}s`);
      resolve(undefined);
    })().catch((error) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    });
  });
}

await runPass("pass 1 (populate cache)", process.env, 900_000);
await runPass("pass 2 (UV_OFFLINE=1)", { ...process.env, UV_OFFLINE: "1" }, 300_000);
console.log("warmup complete: the exact mcpTools.ts spawn runs offline against the baked cache");
process.exit(0);
