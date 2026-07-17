import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export interface FreshStack {
  clientUrl: string;
  apiUrl: string;
  model: { id: string; provider: string };
  stop(): Promise<void>;
}

async function portIsAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

export async function assertPortsAvailable(ports: number[]): Promise<void> {
  for (const port of new Set(ports)) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid evaluation port ${port}`);
    }
    if (!await portIsAvailable(port)) {
      throw new Error(`Fresh evaluation stack refused stale listener on port ${port}`);
    }
  }
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  terminateProcessGroup(child, "SIGTERM");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000));
  if (await Promise.race([exited.then(() => "exited" as const), timeout]) === "timeout") {
    terminateProcessGroup(child, "SIGKILL");
    await exited;
  }
}

async function waitForUrl(url: string, child: ChildProcess, logs: () => string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Evaluation stack exited with code ${child.exitCode}.\n${logs()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Startup probes are expected to fail until both dev servers are ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for fresh evaluation stack at ${url}.\n${logs()}`);
}

export function evaluationStackEnvironment(base: NodeJS.ProcessEnv, fakeModel: boolean): NodeJS.ProcessEnv {
  return {
    ...base,
    ...(fakeModel ? {
      CHAMFER_MODEL: "",
      CHAMFER_PROVIDER: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
      GOOGLE_BASE_URL: "",
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
      LANGFUSE_BASE_URL: "",
    } : {}),
  };
}

export async function startFreshStack(options: {
  repoRoot: string;
  dataDir: string;
  clientPort: number;
  apiPort: number;
  fakeModel: boolean;
  timeoutMs?: number;
}): Promise<FreshStack> {
  await assertPortsAvailable([options.clientPort, options.apiPort]);
  const output: string[] = [];
  const child = spawn("npm", ["run", "dev"], {
    cwd: options.repoRoot,
    detached: true,
    env: {
      ...evaluationStackEnvironment(process.env, options.fakeModel),
      CLIENT_PORT: String(options.clientPort),
      PORT: String(options.apiPort),
      CHAMFER_DATA_DIR: options.dataDir,
      CHAMFER_FAKE_LLM: options.fakeModel ? "1" : "0",
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const retain = (chunk: Buffer) => {
    output.push(chunk.toString("utf8"));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  child.stdout?.on("data", retain);
  child.stderr?.on("data", retain);
  const logs = () => output.join("").slice(-12_000);
  const clientUrl = `http://localhost:${options.clientPort}`;
  const apiUrl = `http://127.0.0.1:${options.apiPort}`;
  try {
    await waitForUrl(`${apiUrl}/api/health`, child, logs, options.timeoutMs ?? 120_000);
    await waitForUrl(clientUrl, child, logs, options.timeoutMs ?? 120_000);
    const settings = await (await fetch(`${apiUrl}/api/settings`)).json() as { modelJson?: string };
    const model = settings.modelJson
      ? JSON.parse(settings.modelJson) as { id?: string; provider?: string }
      : undefined;
    if (options.fakeModel && model?.id !== "chamfer-fake") {
      throw new Error(`Fresh evaluation stack configuration mismatch: expected chamfer-fake, found ${model?.id ?? "none"}`);
    }
    if (!options.fakeModel && model?.id === "chamfer-fake") {
      throw new Error("Fresh evaluation stack configuration mismatch: live mode resolved chamfer-fake");
    }
    if (!model?.id || !model.provider) {
      throw new Error("Fresh evaluation stack configuration mismatch: provider and model must resolve before execution");
    }
    return {
      clientUrl,
      apiUrl,
      model: { id: model.id, provider: model.provider },
      stop: async () => stopChild(child),
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}
