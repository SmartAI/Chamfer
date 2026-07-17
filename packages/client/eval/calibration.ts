export interface CalibrationIdentity {
  judge: { model: string; prompt: string; promptVersion: number; rubricVersion: number };
  inferenceSettings: Record<string, unknown>;
  dataset: { id: string; version: number };
  evaluator: { id: string; version: number };
  runId: string;
}

export interface CalibrationRow {
  evidenceId: string;
  split: "dev" | "test";
  evidence: unknown;
  expected: string;
  actual: string;
}

export interface CalibrationPolicy {
  minimumSensitivity: number;
  minimumSpecificity: number;
  minimumValidRows: number;
}

const defaultPolicy: CalibrationPolicy = {
  minimumSensitivity: 0.9,
  minimumSpecificity: 0.9,
  minimumValidRows: 30,
};

function normalize(label: string): string {
  return label.trim().toUpperCase();
}

function divide(numerator: number, denominator: number, note: string, notes: string[]): number | null {
  if (denominator === 0) {
    notes.push(note);
    return null;
  }
  return numerator / denominator;
}

export function buildJudgeTaskInput(row: CalibrationRow): { evidenceId: string; evidence: unknown } {
  return { evidenceId: row.evidenceId, evidence: row.evidence };
}

export interface CalibrationReport {
  schemaVersion: 1;
  identity: CalibrationIdentity;
  labels: { positive: string; negative: string };
  policy: CalibrationPolicy;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  confusion: { tp: number; fp: number; fn: number; tn: number };
  metrics: {
    accuracy: number | null;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    sensitivity: number | null;
    specificity: number | null;
  };
  notes: string[];
  automationAllowed: boolean;
  itemScores: Array<{
    evidenceId: string;
    expected: string;
    actual: string;
    valid: boolean;
    exactMatch?: boolean;
    cell?: "tp" | "fp" | "fn" | "tn";
  }>;
}

interface CalibrationSyncMeasurement {
  name: string;
  value: number | string;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
}

export interface CalibrationExperimentCohort {
  datasetName: string;
  cohortId: string;
  release: string;
  evaluationMode: "judge-calibration";
  modality: "structured-evidence";
  complexity: "calibration";
  category: "semantic-judge";
  purpose: "held-out-calibration";
  gating: "diagnostic" | "automation-eligible";
  identities: {
    corpus: string;
    agentConfiguration: string;
    commit: string;
    model: string;
    evaluator: string;
    rubric: string;
    runner: string;
    repetition: string;
  };
  cases: Array<{
    caseId: string;
    caseVersion: string;
    input: unknown;
    expectedOutput?: unknown;
    output: unknown;
    taskOutcome: string;
    measurements: {
      integrity: CalibrationSyncMeasurement[];
      proficiency: CalibrationSyncMeasurement[];
      reliability: CalibrationSyncMeasurement[];
      efficiency: CalibrationSyncMeasurement[];
      diagnostic: CalibrationSyncMeasurement[];
    };
  }>;
}

export function calibrateBinaryJudge(input: {
  identity: CalibrationIdentity;
  rows: CalibrationRow[];
  promptExampleEvidenceIds: string[];
  positiveLabel: string;
  negativeLabel: string;
  policy?: CalibrationPolicy;
}): CalibrationReport {
  const positive = normalize(input.positiveLabel);
  const negative = normalize(input.negativeLabel);
  if (!positive || !negative || positive === negative) throw new Error("Calibration labels must be distinct");
  const policy = input.policy ?? defaultPolicy;
  const rowSplits = new Map<string, CalibrationRow["split"]>();
  for (const row of input.rows) {
    const existing = rowSplits.get(row.evidenceId);
    if (existing && existing !== row.split) throw new Error(`Split leakage for evidence ${row.evidenceId}`);
    rowSplits.set(row.evidenceId, row.split);
  }
  const heldOutIds = new Set(input.rows.filter((row) => row.split === "test").map((row) => row.evidenceId));
  const leaked = input.promptExampleEvidenceIds.find((id) => heldOutIds.has(id));
  if (leaked) throw new Error(`Split leakage: held-out evidence ${leaked} appears in judge prompt examples`);

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const allowed = new Set([positive, negative]);
  const heldOutRows = input.rows.filter((row) => row.split === "test");
  const itemScores = heldOutRows.map((row) => {
    const expected = normalize(row.expected);
    const actual = normalize(row.actual);
    if (!allowed.has(expected) || !allowed.has(actual)) {
      return { evidenceId: row.evidenceId, expected, actual, valid: false };
    }
    let cell: "tp" | "fp" | "fn" | "tn";
    if (expected === positive && actual === positive) {
      tp += 1;
      cell = "tp";
    } else if (expected === negative && actual === positive) {
      fp += 1;
      cell = "fp";
    } else if (expected === positive && actual === negative) {
      fn += 1;
      cell = "fn";
    } else {
      tn += 1;
      cell = "tn";
    }
    return { evidenceId: row.evidenceId, expected, actual, valid: true, exactMatch: expected === actual, cell };
  });
  const validRows = tp + fp + fn + tn;
  const notes: string[] = [];
  const accuracy = divide(tp + tn, validRows, "Accuracy is undefined because there are no valid labels.", notes);
  const precision = divide(tp, tp + fp, "Precision is undefined because the judge produced no positive labels.", notes);
  const recall = divide(tp, tp + fn, "Recall and sensitivity are undefined because no positive labels exist.", notes);
  const specificity = divide(tn, tn + fp, "Specificity is undefined because no negative labels exist.", notes);
  const f1 = precision === null || recall === null ? null
    : precision + recall === 0 ? 0
    : (2 * precision * recall) / (precision + recall);
  if (validRows < policy.minimumValidRows) {
    notes.push(`Valid sample size ${validRows} is below the required ${policy.minimumValidRows}.`);
  }
  const automationAllowed = validRows >= policy.minimumValidRows &&
    recall !== null && recall >= policy.minimumSensitivity &&
    specificity !== null && specificity >= policy.minimumSpecificity;
  return {
    schemaVersion: 1,
    identity: input.identity,
    labels: { positive, negative },
    policy,
    totalRows: heldOutRows.length,
    validRows,
    invalidRows: heldOutRows.length - validRows,
    confusion: { tp, fp, fn, tn },
    metrics: { accuracy, precision, recall, f1, sensitivity: recall, specificity },
    notes,
    automationAllowed,
    itemScores,
  };
}

/** Maps held-out judge evidence and run measures to the canonical offline synchronization contract. */
export function buildCalibrationExperimentCohort(
  report: CalibrationReport,
  rows: CalibrationRow[],
): CalibrationExperimentCohort {
  const heldOut = new Map(rows.filter((row) => row.split === "test").map((row) => [row.evidenceId, row]));
  const emptyFamilies = () => ({
    integrity: [] as CalibrationSyncMeasurement[],
    reliability: [] as CalibrationSyncMeasurement[],
    efficiency: [] as CalibrationSyncMeasurement[],
  });
  const cases: CalibrationExperimentCohort["cases"] = report.itemScores.map((item) => {
    const row = heldOut.get(item.evidenceId);
    if (!row) throw new Error(`Calibration report references missing held-out evidence ${item.evidenceId}`);
    return {
      caseId: `judge.${item.evidenceId}`,
      caseVersion: "1",
      input: buildJudgeTaskInput(row),
      expectedOutput: { label: item.expected },
      output: { label: item.actual },
      taskOutcome: item.valid ? item.exactMatch ? "matched" : "mismatched" : "invalid",
      measurements: {
        ...emptyFamilies(),
        proficiency: [
          { name: "valid-label", value: item.valid ? 1 : 0, dataType: "BOOLEAN" },
          ...(item.valid ? [{ name: "exact-match", value: item.exactMatch ? 1 : 0, dataType: "BOOLEAN" as const }] : []),
        ],
        diagnostic: item.cell ? [{ name: "confusion-cell", value: item.cell, dataType: "CATEGORICAL" }] : [],
      },
    };
  });
  cases.push({
    caseId: "judge.calibration-summary",
    caseVersion: "1",
    input: { runId: report.identity.runId },
    output: { automationAllowed: report.automationAllowed },
    taskOutcome: report.automationAllowed ? "automation-eligible" : "diagnostic-only",
    measurements: {
      ...emptyFamilies(),
      proficiency: Object.entries(report.metrics).flatMap(([name, value]) =>
        value === null ? [] : [{ name, value, dataType: "NUMERIC" as const }]
      ),
      diagnostic: [
        { name: "valid-rows", value: report.validRows, dataType: "NUMERIC" },
        { name: "invalid-rows", value: report.invalidRows, dataType: "NUMERIC" },
        { name: "automation-allowed", value: report.automationAllowed ? 1 : 0, dataType: "BOOLEAN" },
      ],
    },
  });
  return {
    datasetName: `chamfer-${report.identity.dataset.id}-v${report.identity.dataset.version}`,
    cohortId: report.identity.runId,
    release: "semantic-judge",
    evaluationMode: "judge-calibration",
    modality: "structured-evidence",
    complexity: "calibration",
    category: "semantic-judge",
    purpose: "held-out-calibration",
    gating: report.automationAllowed ? "automation-eligible" : "diagnostic",
    identities: {
      corpus: `${report.identity.dataset.id}@${report.identity.dataset.version}`,
      agentConfiguration: JSON.stringify(report.identity.inferenceSettings),
      commit: "judge-calibration",
      model: report.identity.judge.model,
      evaluator: `${report.identity.evaluator.id}@${report.identity.evaluator.version}`,
      rubric: `semantic-rubric@${report.identity.judge.rubricVersion}`,
      runner: `judge-prompt@${report.identity.judge.promptVersion}`,
      repetition: report.identity.runId,
    },
    cases,
  };
}
