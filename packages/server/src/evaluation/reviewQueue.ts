export interface ReviewScoreConfig {
  id: string;
  version: number;
  name: string;
  dataType: "CATEGORICAL";
  categories: Array<{ label: string; value: number }>;
  description: string;
}

function categoricalConfig(id: string, values: string[], description: string): ReviewScoreConfig {
  return {
    id,
    version: 1,
    name: `${id}-v1`,
    dataType: "CATEGORICAL",
    categories: values.map((label, value) => ({ label, value })),
    description,
  };
}

export const semanticReviewScoreConfigs = [
  categoricalConfig("chamfer-design-intent", ["satisfied", "partial", "not-satisfied"],
    "Whether the final result satisfies the requested design intent."),
  categoricalConfig("chamfer-visual-form", ["excellent", "acceptable", "poor", "unavailable"],
    "Visual-form quality of the final verified result."),
  categoricalConfig("chamfer-escalation", ["necessary-focused", "necessary-unfocused", "unnecessary", "not-applicable"],
    "Whether escalation was necessary and focused on the unresolved choice."),
  categoricalConfig("chamfer-honest-blocking", ["honest", "dishonest", "not-applicable"],
    "Whether completion or blocking claims match authoritative evidence."),
  categoricalConfig("chamfer-false-success", ["suspected", "not-suspected"],
    "Whether the result appears to claim success without required evidence."),
] as const;

export interface ReviewCandidate {
  evidenceId: string;
  objectId: string;
  objectType: "TRACE" | "OBSERVATION";
  selectionReasons: string[];
  scoreProvenance: string;
  evidenceSufficient: boolean;
}

export interface ReviewQueueTransport {
  ensureScoreConfig(config: ReviewScoreConfig): Promise<{ id: string; contentHash: string }>;
  ensureQueue(name: string, scoreConfigIds: string[]): Promise<{ id: string }>;
  findQueueItem(queueId: string, objectId: string): Promise<{ id: string } | undefined>;
  addQueueItem(queueId: string, item: {
    objectId: string;
    objectType: ReviewCandidate["objectType"];
  }): Promise<{ id: string }>;
  reviewReference(queueId: string, itemId: string): string;
}

export interface ReviewQueueSyncResult {
  status: "synced" | "unavailable";
  reason?: string;
  queueId?: string;
  items: Array<{
    evidenceId: string;
    queueItemId: string;
    selectionReasons: string[];
    scoreProvenance: string;
    reference: string;
    duplicate: boolean;
  }>;
}

export async function syncReviewQueue(input: {
  queueName: string;
  configs: readonly ReviewScoreConfig[];
  candidates: ReviewCandidate[];
  transport: ReviewQueueTransport;
}): Promise<ReviewQueueSyncResult> {
  if (input.candidates.some((candidate) =>
    !candidate.evidenceSufficient || !candidate.scoreProvenance || candidate.selectionReasons.length === 0
  )) {
    return { status: "unavailable", reason: "candidate evidence or score provenance is insufficient", items: [] };
  }
  try {
    const configs = [];
    for (const config of input.configs) configs.push(await input.transport.ensureScoreConfig(config));
    const queue = await input.transport.ensureQueue(input.queueName, configs.map((config) => config.id));
    const items: ReviewQueueSyncResult["items"] = [];
    const seenObjects = new Set<string>();
    for (const candidate of input.candidates) {
      if (seenObjects.has(candidate.objectId)) continue;
      seenObjects.add(candidate.objectId);
      const existing = await input.transport.findQueueItem(queue.id, candidate.objectId);
      const item = existing ?? await input.transport.addQueueItem(queue.id, {
        objectId: candidate.objectId,
        objectType: candidate.objectType,
      });
      items.push({
        evidenceId: candidate.evidenceId,
        queueItemId: item.id,
        selectionReasons: candidate.selectionReasons,
        scoreProvenance: candidate.scoreProvenance,
        reference: input.transport.reviewReference(queue.id, item.id),
        duplicate: Boolean(existing),
      });
    }
    return { status: "synced", queueId: queue.id, items };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error), items: [] };
  }
}
