import type { OfflineExperimentCohort } from "./langfuseExperimentSync";
import { offlineExperimentTraceId } from "./langfuseExperimentSync";
import {
  semanticReviewScoreConfigs,
  syncReviewQueue,
  type ReviewQueueSyncResult,
  type ReviewQueueTransport,
} from "./reviewQueue";

export function syncOfflineReviewCohort(input: {
  cohort: OfflineExperimentCohort;
  transport: ReviewQueueTransport;
  queueName?: string;
}): Promise<ReviewQueueSyncResult> {
  return syncReviewQueue({
    queueName: input.queueName ?? "chamfer-semantic-review-v1",
    configs: semanticReviewScoreConfigs,
    candidates: input.cohort.cases.map((item) => ({
      evidenceId: `${item.caseId}@${item.caseVersion}#${item.repetition.index}`,
      objectId: offlineExperimentTraceId(
        input.cohort.cohortId,
        item.caseId,
        item.caseVersion,
        item.repetition.hash,
      ),
      objectType: "TRACE" as const,
      selectionReasons: ["offline-semantic-rubric"],
      scoreProvenance: `offline-canonical@${input.cohort.identities.evaluator}`,
      evidenceSufficient: Boolean(item.taskOutcome && item.output && item.measurements),
    })),
    transport: input.transport,
  });
}
