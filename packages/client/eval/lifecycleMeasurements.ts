import type { AgentRunLifecycleDto } from "@chamfer/shared";
import type { EvaluationResult } from "./result";

export function mergeLifecycleMeasurements(input: {
  measurements: EvaluationResult["measurements"];
  lifecycle: Pick<AgentRunLifecycleDto, "status" | "counters" | "durations">;
}): EvaluationResult["measurements"] {
  if (input.lifecycle.status !== "completed") {
    throw new Error("Agent lifecycle evidence did not reach its durable completion barrier");
  }
  const { counters, durations } = input.lifecycle;
  return {
    ...input.measurements,
    modelCalls: counters.modelCalls,
    toolCalls: counters.toolCalls,
    cadRuns: counters.cadRuns,
    retries: counters.retries,
    compactions: counters.compactions,
    searches: counters.searches,
    skillLoads: counters.skillLoads,
    persistenceFailures: counters.persistenceFailures,
    modelLatencyMs: durations.modelMs,
    toolLatencyMs: durations.toolMs,
    cadLatencyMs: durations.cadMs,
    compactionLatencyMs: durations.compactionMs,
    persistenceLatencyMs: durations.persistenceMs,
    retryDelayMs: durations.retryDelayMs,
  };
}
