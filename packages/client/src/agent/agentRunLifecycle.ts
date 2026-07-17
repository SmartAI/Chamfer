import {
  AGENT_RUN_LIFECYCLE_VERSION,
  type AgentConfigurationTraceIdentity,
  type AgentRunEvaluationIdentity,
  type AgentRunLifecycleBatch,
  type AgentRunLifecycleEvent,
  type AgentRunOutcome,
} from "@chamfer/shared";
import * as rest from "../api/rest";

type PostEvents = (
  conversationId: string,
  runId: string,
  batch: AgentRunLifecycleBatch,
  signal?: AbortSignal,
) => Promise<unknown>;

interface ReporterOptions {
  conversationId: string;
  configuration: AgentConfigurationTraceIdentity;
  evaluation?: AgentRunEvaluationIdentity;
  postEvents?: PostEvents;
  now?: () => number;
  randomUUID?: () => string;
  deadlineMs?: number;
}

type EventPayload = AgentRunLifecycleEvent extends infer Event
  ? Event extends AgentRunLifecycleEvent
    ? Omit<Event, "version" | "runId" | "seq" | "timestamp">
    : never
  : never;

/** Best-effort ordered browser reporter. A failed batch disables the rest of that run. */
export class AgentRunReporter {
  readonly runId: string;
  private readonly now: () => number;
  private readonly postEvents: PostEvents;
  private readonly deadlineMs: number;
  private readonly pending: AgentRunLifecycleEvent[] = [];
  private sending: Promise<void> = Promise.resolve();
  private seq = 0;
  private startedAt?: number;
  private disabled = false;
  private finished = false;

  constructor(private readonly options: ReporterOptions) {
    this.now = options.now ?? Date.now;
    this.postEvents = options.postEvents ?? rest.postAgentRunEvents;
    this.deadlineMs = options.deadlineMs ?? 1_000;
    this.runId = (options.randomUUID ?? crypto.randomUUID.bind(crypto))();
  }

  private enqueue(payload: EventPayload): void {
    if (this.disabled || this.finished) return;
    this.pending.push({
      version: AGENT_RUN_LIFECYCLE_VERSION,
      runId: this.runId,
      seq: this.seq++,
      timestamp: this.now(),
      ...payload,
    } as AgentRunLifecycleEvent);
  }

  private async sendBatch(events: AgentRunLifecycleEvent[]): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deadlineMs);
    try {
      await this.postEvents(
        this.options.conversationId,
        this.runId,
        { version: AGENT_RUN_LIFECYCLE_VERSION, events },
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private flush(): Promise<void> {
    if (this.disabled) {
      this.pending.splice(0);
      return this.sending;
    }
    const events = this.pending.splice(0, 32);
    if (events.length === 0) return this.sending;
    this.sending = this.sending
      .then(() => this.disabled ? undefined : this.sendBatch(events))
      .catch(() => {
        this.disabled = true;
        this.pending.splice(0);
      });
    void this.sending.then(() => {
      if (!this.disabled && this.pending.length > 0) void this.flush();
    });
    return this.sending;
  }

  async start(): Promise<void> {
    if (this.startedAt !== undefined) return;
    this.startedAt = this.now();
    this.enqueue({
      type: "run.started",
      agentConfiguration: this.options.configuration,
      ...(this.options.evaluation ? { evaluation: this.options.evaluation } : {}),
    });
    await this.flush();
  }

  operationStarted(
    type: "turn" | "tool" | "compaction",
    operationId: string,
    name?: string,
  ): Promise<void> {
    if (type === "tool") {
      this.enqueue({ type: "tool.started", operationId, ...(name ? { name } : {}) });
    } else {
      this.enqueue({ type: `${type}.started`, operationId } as EventPayload);
    }
    return this.flush();
  }

  operationCompleted(
    type: "turn" | "tool" | "compaction",
    operationId: string,
    outcome: "ok" | "error" | "aborted",
    durationMs: number,
  ): void {
    this.enqueue({ type: `${type}.completed`, operationId, outcome, durationMs } as EventPayload);
    void this.flush();
  }

  recordRetry(attempt: number, delayMs: number): void {
    this.enqueue({ type: "retry.recorded", attempt, delayMs });
    void this.flush();
  }

  recordPersistence(operationId: string, succeeded: boolean, durationMs: number): void {
    this.enqueue({
      type: succeeded ? "persistence.completed" : "persistence.failed",
      operationId,
      durationMs,
    });
    void this.flush();
  }

  async finish(outcome: AgentRunOutcome): Promise<void> {
    if (this.finished) return;
    const timestamp = this.now();
    this.enqueue({
      type: "run.completed",
      outcome,
      durationMs: Math.max(0, timestamp - (this.startedAt ?? timestamp)),
    });
    this.finished = true;
    await this.flush();
    while (!this.disabled && this.pending.length > 0) await this.flush();
    await this.sending;
  }
}

function safeIdentityPart(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  return value.replace(/[^A-Za-z0-9._:/-]/g, "_").slice(0, 200) || "unknown";
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hashes private behavior inputs and returns only safe filter dimensions. */
export async function createAgentConfigurationTraceIdentity(input: {
  modelJson: string;
  systemPrompt: string;
  toolNames: string[];
  skillMode: string;
  maxCadRuns: number;
}): Promise<AgentConfigurationTraceIdentity> {
  let model: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(input.modelJson) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) model = parsed as Record<string, unknown>;
  } catch {
    // The session parser reports malformed model JSON separately. Identity stays unresolved-safe.
  }
  const canonical = JSON.stringify({
    modelJson: input.modelJson,
    systemPrompt: input.systemPrompt,
    toolNames: [...input.toolNames].sort(),
    skillMode: input.skillMode,
    maxCadRuns: input.maxCadRuns,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return {
    identityHash: bytesToHex(new Uint8Array(digest)),
    provider: safeIdentityPart(model.provider),
    model: safeIdentityPart(model.id),
    skillMode: safeIdentityPart(input.skillMode),
  };
}

/** Reads the optional controlled-evaluation identity carried by a fresh browser URL. */
export function evaluationTraceIdentity(search: string): AgentRunEvaluationIdentity | undefined {
  const params = new URLSearchParams(search);
  const caseExecutionId = params.get("evaluationCaseExecutionId");
  const caseId = params.get("evaluationCaseId");
  const corpusVersion = params.get("evaluationCorpusVersion");
  const repetition = Number(params.get("evaluationRepetition"));
  const safe = (value: string | null): value is string =>
    value !== null && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
  if (!safe(caseExecutionId) || !safe(caseId) || !safe(corpusVersion) ||
      !Number.isInteger(repetition) || repetition < 0 || repetition > 10_000) {
    return undefined;
  }
  return { caseExecutionId, caseId, corpusVersion, repetition };
}
