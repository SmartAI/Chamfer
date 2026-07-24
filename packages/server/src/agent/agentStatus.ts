import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Authoritative run status derived from pi session events. The server tracks
 * this so an SSE (re)connect can be initialized with a snapshot instead of the
 * client guessing from stream silence (long Fusion executes emit nothing for
 * minutes between tool_execution_start and tool_execution_end). */

export interface AgentRunStatus {
  running: boolean;
  /** Epoch ms when the current run started; present only while running. */
  startedAt?: number;
  /** The tool currently executing, if any; present only while running. */
  activeTool?: { name: string; startedAt: number };
}

/** One JSON-serializable server-sent event: a pi AgentSessionEvent forwarded
 * verbatim, or one of the server-added event kinds. agent_error is reserved
 * for run-fatal failures (the client flips to idle on it); agent_status is
 * the synthetic snapshot the events route emits on every (re)connect. Lives
 * here rather than in piSession so consumers that only speak the event
 * contract (routes, the online turn host) never pull the session host - and
 * its Node-only import graph - into their compile. */
export type AgentServerEvent =
  | AgentSessionEvent
  | { type: "artifact_updated"; revision: number }
  | { type: "agent_error"; message: string }
  | ({ type: "agent_status" } & AgentRunStatus);

interface StatusEvent {
  type: string;
  toolName?: string;
}

/** Folds session events into a run status. Only agent_start / agent_settled
 * change the running flag; tool_execution_start/end maintain the active tool.
 * Message-level events never touch the status.
 *
 * agent_settled, not agent_end, is pi's end-of-run signal: the session runs
 * `agent.prompt()` then keeps calling `agent.continue()` for retries,
 * overflow-compaction recovery, and queued continuations - each cycle emits
 * its own agent_end (and the overflow case emits it with willRetry false),
 * so a status keyed on agent_end reports idle mid-compaction while the run
 * is very much alive. agent_settled fires exactly once, when the whole
 * prompt (continuations included, aborts too) has settled. */
export class AgentStatusTracker {
  private state: AgentRunStatus = { running: false };

  apply(event: StatusEvent): void {
    switch (event.type) {
      case "agent_start":
        this.state = { running: true, startedAt: Date.now() };
        break;
      case "agent_end":
        // A continuation may follow; only drop the active tool.
        this.state = { running: this.state.running, ...(this.state.startedAt ? { startedAt: this.state.startedAt } : {}) };
        break;
      case "agent_settled":
        this.state = { running: false };
        break;
      case "tool_execution_start":
        if (typeof event.toolName === "string") {
          this.state = { ...this.state, activeTool: { name: event.toolName, startedAt: Date.now() } };
        }
        break;
      case "tool_execution_end":
        this.state = { running: this.state.running, ...(this.state.startedAt ? { startedAt: this.state.startedAt } : {}) };
        break;
      default:
        break;
    }
  }

  snapshot(): AgentRunStatus {
    return { ...this.state, ...(this.state.activeTool ? { activeTool: { ...this.state.activeTool } } : {}) };
  }
}
