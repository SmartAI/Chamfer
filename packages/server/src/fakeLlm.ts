import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { LlmStreamer } from "./llm";
import { TITLE_SYSTEM_PROMPT } from "./titles";
import { sanitizeModelRequest, type ModelRequestDiagnostic } from "./imageContextDiagnostics";

export interface FakeLlmRequestDiagnostics extends LlmStreamer {
  getRequestDiagnostics(conversationId: string): ModelRequestDiagnostic[];
}

export const FAKE_MODEL = {
  id: "chamfer-fake",
  name: "Chamfer Fake Model",
  api: "anthropic-messages",
  provider: "anthropic" as const,
  baseUrl: "http://127.0.0.1/fake",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
  maxInputImages: 3,
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: FAKE_MODEL.api,
    provider: FAKE_MODEL.provider,
    model: FAKE_MODEL.id,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function* streamText(text: string): Generator<AssistantMessageEvent> {
  const partial = message([{ type: "text", text }], "stop");
  yield { type: "start", partial };
  yield { type: "text_start", contentIndex: 0, partial };
  yield { type: "text_delta", contentIndex: 0, delta: text, partial };
  yield { type: "text_end", contentIndex: 0, content: text, partial };
  yield { type: "done", reason: "stop", message: partial };
}

function* streamToolCall(id: string, name: string, args: object): Generator<AssistantMessageEvent> {
  const toolCall = { type: "toolCall" as const, id, name, arguments: {} };
  const partial = message([toolCall], "toolUse");
  yield { type: "start", partial };
  yield { type: "toolcall_start", contentIndex: 0, partial };
  yield { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial };
  const complete = message([{ ...toolCall, arguments: args }], "toolUse");
  yield { type: "toolcall_end", contentIndex: 0, toolCall: complete.content[0] as never, partial: complete };
  yield { type: "done", reason: "toolUse", message: complete };
}

const LONG_PLAN = {
  goal: "stress-test the expanded plan layout",
  components: Array.from({ length: 40 }, (_, index) => ({
    id: `part-${index + 1}`,
    description: `Component ${index + 1} with enough detail to represent a substantial plan`,
    bbox_mm: [10, 10, 10],
    checks: [{ id: "volume", kind: "volume", range_mm3: [900, 1100], target: `part-${index + 1}` }],
    status: "todo",
    free_floating_reason: "Independent layout fixture component.",
  })),
  interfaces: [],
};

// --- plan-flow scenario (triggered by "plan-flow" in the transcript) ---
// Drives the full plan artifact loop: plan -> build base -> mark done ->
// premature stop (drawing the deterministic plan nudge) -> assembly run ->
// mark everything done -> final summary. Component checks are byte-identical
// between the plan and the scripts, which is what evidence-checked "done"
// requires.
const BASE_CHECKS = [
  { id: "envelope", kind: "bbox", size_mm: [30, 30, 6], target: "base" },
  { id: "volume", kind: "volume", range_mm3: [5100, 5700], target: "base" },
];
const LID_CHECKS = [
  { id: "envelope", kind: "bbox", size_mm: [30, 30, 4], target: "lid" },
  { id: "volume", kind: "volume", range_mm3: [3400, 3800], target: "lid" },
];

const PLAN_V1 = {
  goal: "base plate with a lid resting on it",
  components: [
    { id: "base", description: "30x30x6 base plate", bbox_mm: [30, 30, 6], status: "todo", checks: BASE_CHECKS },
    { id: "lid", description: "30x30x4 lid", bbox_mm: [30, 30, 4], status: "todo", checks: LID_CHECKS },
  ],
  interfaces: [{ a: "base", b: "lid", kind: "clearance", min_mm: 0, max_mm: 0 }],
};

const BASE_SCRIPT = [
  "from build123d import *",
  "# --- params ---",
  "side = 30  # [10, 100] Plate side in mm",
  "base_t = 6  # [1, 20] Base thickness in mm",
  "# --- end params ---",
  "# --- expect ---",
  'EXPECT = {"bodies": 1, "bbox_mm": [30, 30, 6]}',
  "# --- end expect ---",
  "# --- checks ---",
  "CHECKS = [",
  '    {"kind": "bbox", "size_mm": [30, 30, 6], "target": "base"},',
  '    {"kind": "volume", "range_mm3": [5100, 5700], "target": "base"},',
  "]",
  "# --- end checks ---",
  "# --- component ---",
  'COMPONENT = "base"',
  "# --- end component ---",
  "base = Box(side, side, base_t)",
  'base.label = "base"',
  "result = base",
].join("\n");

const ASSEMBLY_SCRIPT = [
  "from build123d import *",
  "# --- params ---",
  "side = 30  # [10, 100] Plate side in mm",
  "base_t = 6  # [1, 20] Base thickness in mm",
  "lid_t = 4  # [1, 20] Lid thickness in mm",
  "# --- end params ---",
  "# --- expect ---",
  'EXPECT = {"bodies": 2, "bbox_mm": [30, 30, 10]}',
  "# --- end expect ---",
  "# --- checks ---",
  "CHECKS = [",
  '    {"kind": "bbox", "size_mm": [30, 30, 6], "target": "base"},',
  '    {"kind": "volume", "range_mm3": [5100, 5700], "target": "base"},',
  '    {"kind": "bbox", "size_mm": [30, 30, 4], "target": "lid"},',
  '    {"kind": "volume", "range_mm3": [3400, 3800], "target": "lid"},',
  '    {"kind": "clearance", "a": "base", "b": "lid", "min_mm": 0, "max_mm": 0},',
  "]",
  "# --- end checks ---",
  "# --- component ---",
  'COMPONENT = ["base", "lid"]',
  "# --- end component ---",
  "base = Box(side, side, base_t)",
  'base.label = "base"',
  "lid = Pos(0, 0, base_t / 2 + lid_t / 2) * Box(side, side, lid_t)",
  'lid.label = "lid"',
  "result = Compound(children=[base, lid])",
].join("\n");

function markDone(plan: typeof PLAN_V1, done: string[]): object {
  return {
    ...plan,
    components: plan.components.map((c) => (done.includes(c.id) ? { ...c, status: "done" } : c)),
  };
}

function* planFlowStep(transcript: string, lastMessage: string): Generator<AssistantMessageEvent> {
  // Tool CALL blocks serialize as {"type":"toolCall",...,"name":"<tool>"}; tool
  // results carry toolName instead, so these counts see only the calls.
  const plans = transcript.split('"name":"update_plan"').length - 1;
  const runs = transcript.split('"name":"run_build123d"').length - 1;
  if (lastMessage.includes("[Chamfer plan check]")) {
    yield* streamToolCall("plan-flow-run-2", "run_build123d", { code: ASSEMBLY_SCRIPT });
    return;
  }
  if (plans === 0) {
    yield* streamToolCall("plan-flow-plan-1", "update_plan", PLAN_V1);
    return;
  }
  if (plans === 1 && runs === 0) {
    yield* streamToolCall("plan-flow-run-1", "run_build123d", { code: BASE_SCRIPT });
    return;
  }
  if (plans === 1 && runs === 1) {
    yield* streamToolCall("plan-flow-plan-2", "update_plan", markDone(PLAN_V1, ["base"]));
    return;
  }
  if (plans === 2 && runs === 1) {
    // Premature stop with the lid still todo: the session must inject the
    // deterministic plan nudge, which the branch above answers with the
    // assembly run.
    yield* streamText("Base is done; stopping here for now.");
    return;
  }
  if (plans === 2 && runs === 2) {
    yield* streamToolCall("plan-flow-plan-3", "update_plan", markDone(PLAN_V1, ["base", "lid"]));
    return;
  }
  yield* streamText("Assembly complete: base and lid built, touching, both verified.");
}

// --- image-plan-gate scenario (triggered by "image-plan-gate") ---
// Exercises both deterministic rejection paths before completing a one-part image plan:
// premature CAD run -> plan without spec sheet -> valid plan -> verified run -> done plan.
const IMAGE_PLAN_CHECKS = [
  { id: "envelope", kind: "bbox", size_mm: [10, 10, 10], target: "spacer" },
  { id: "volume", kind: "volume", range_mm3: [900, 1100], target: "spacer" },
];

const IMAGE_PLAN_WITHOUT_SPEC = {
  goal: "10 mm spacer from the dimensioned drawing",
  components: [
    {
      id: "spacer",
      description: "10 mm cube spacer shown in the drawing",
      bbox_mm: [10, 10, 10],
      status: "todo",
      free_floating_reason: "single component",
      checks: IMAGE_PLAN_CHECKS,
    },
  ],
  interfaces: [],
};

const IMAGE_PLAN = {
  ...IMAGE_PLAN_WITHOUT_SPEC,
  spec_sheet: [
    {
      id: "overall-size",
      text: "The drawing shows a 10 mm overall width, depth, and height.",
      source: "image",
      check_refs: [{ component_id: "spacer", check_id: "envelope" }],
    },
    {
      id: "surface-finish",
      text: "The drawing calls for a matte surface finish.",
      source: "image",
      unverifiable_reason: "The geometry kernel cannot measure surface finish.",
    },
  ],
};

const IMAGE_PLAN_SCRIPT = [
  "from build123d import *",
  "# --- params ---",
  "side = 10  # [1, 100] Side length in mm",
  "# --- end params ---",
  "# --- expect ---",
  'EXPECT = {"bodies": 1, "bbox_mm": [10, 10, 10]}',
  "# --- end expect ---",
  "# --- checks ---",
  "CHECKS = [",
  '    {"kind": "bbox", "size_mm": [10, 10, 10], "target": "spacer"},',
  '    {"kind": "volume", "range_mm3": [900, 1100], "target": "spacer"},',
  "]",
  "# --- end checks ---",
  "# --- component ---",
  'COMPONENT = "spacer"',
  "# --- end component ---",
  "spacer = Box(side, side, side)",
  'spacer.label = "spacer"',
  "result = spacer",
].join("\n");

function* imagePlanGateStep(transcript: string, lastMessage: string): Generator<AssistantMessageEvent> {
  const plans = transcript.split('"name":"update_plan"').length - 1;
  const runs = transcript.split('"name":"run_build123d"').length - 1;
  if (lastMessage.includes("[Chamfer self-check]")) {
    yield* streamText("The spacer and both image-derived specifications are accounted for.");
    return;
  }
  if (runs === 0) {
    yield* streamToolCall("image-plan-run-rejected", "run_build123d", { code: IMAGE_PLAN_SCRIPT });
    return;
  }
  if (plans === 0) {
    yield* streamToolCall("image-plan-invalid", "update_plan", IMAGE_PLAN_WITHOUT_SPEC);
    return;
  }
  if (plans === 1) {
    yield* streamToolCall("image-plan-valid", "update_plan", IMAGE_PLAN);
    return;
  }
  if (runs === 1) {
    yield* streamToolCall("image-plan-run-valid", "run_build123d", { code: IMAGE_PLAN_SCRIPT });
    return;
  }
  if (plans === 2 && !transcript.includes("Dominant-form review:")) {
    yield* streamText(
      "Dominant-form review: the spacer is prismatic, and the largest semantic mismatch is none; all seven silhouettes match the dimensioned cube before detail work.",
    );
    return;
  }
  if (plans === 2) {
    yield* streamToolCall("image-plan-done", "update_plan", {
      ...IMAGE_PLAN,
      components: IMAGE_PLAN.components.map((component) => ({
        ...component,
        status: "done",
        form_review: {
          evidence_id: "image-plan-run-valid",
          views: ["isometric", "front", "back", "left", "right", "top", "bottom"].map((view) => ({
            view,
            verdict: "match",
            note: `${view} view matches the dimensioned cube drawing.`,
          })),
        },
      })),
    });
    return;
  }
  yield* streamText("Spacer complete: the image plan is built and verified.");
}

// --- skill-loop scenario (triggered by "skill-loop") ---
// Exercises the progressive-disclosure skill layer end to end: load a skill,
// fetch one of its resources, prove a duplicate load dedupes, then finish.
function* skillLoopStep(transcript: string): Generator<AssistantMessageEvent> {
  const loads = transcript.split('"name":"load_skill"').length - 1;
  if (loads === 0) {
    yield* streamToolCall("skill-loop-load-1", "load_skill", { name: "sweep-and-loft" });
    return;
  }
  if (loads === 1) {
    yield* streamToolCall("skill-loop-load-2", "load_skill", {
      name: "sweep-and-loft",
      resource: "snippets/sweep_diagnose.py",
    });
    return;
  }
  if (loads === 2) {
    yield* streamToolCall("skill-loop-load-3", "load_skill", { name: "sweep-and-loft" });
    return;
  }
  yield* streamText("Skill loop complete: skill loaded, probe resource fetched, duplicate deduplicated.");
}

function lifecycleScript(size: number): string {
  return [
    "from build123d import *",
    "# --- expect ---",
    `EXPECT = {"bodies": 1, "bbox_mm": [${size}, ${size}, ${size}]}`,
    "# --- end expect ---",
    `result = Box(${size}, ${size}, ${size})`,
  ].join("\n");
}

function* inspectionSheetLifecycleStep(transcript: string): Generator<AssistantMessageEvent> {
  if (!transcript.includes('"toolCallId":"sheet-lifecycle-run-1"')) {
    yield* streamToolCall("sheet-lifecycle-run-1", "run_build123d", { code: lifecycleScript(10) });
    return;
  }
  if (!transcript.includes('"toolCallId":"sheet-lifecycle-run-2"')) {
    yield* streamToolCall("sheet-lifecycle-run-2", "run_build123d", { code: lifecycleScript(12) });
    return;
  }
  if (transcript.includes("[Chamfer self-check]")) {
    yield* streamText("Both revision sheets checked view by view; the latest revision is complete.");
    return;
  }
  yield* streamText("Two CAD revisions rendered and verified.");
}

function referenceIdsIn(transcript: string): string[] {
  const ids: string[] = [];
  for (const match of transcript.matchAll(/\[Reference ([^:]+): status=/g)) {
    const id = match[1]?.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  for (const match of transcript.matchAll(/Pending reference images: ([^.\]]+)/g)) {
    for (const id of (match[1] ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  for (const match of transcript.matchAll(/\"referenceId\":\"([^\"]+)\"/g)) {
    const id = match[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function referenceIdForCall(transcript: string, callId: string): string | undefined {
  const start = transcript.indexOf(`\"id\":\"${callId}\"`);
  if (start < 0) return undefined;
  return transcript.slice(start, start + 2_000).match(/\"referenceId\":\"([^\"]+)\"/)?.[1];
}

function* referenceClassificationStep(transcript: string): Generator<AssistantMessageEvent> {
  const ids = referenceIdsIn(transcript);
  if (!transcript.includes('"toolCallId":"reference-premature-run"')) {
    yield* streamToolCall("reference-premature-run", "run_build123d", { code: "result = Box(1, 1, 1)" });
    return;
  }
  if (!transcript.includes('"toolCallId":"reference-active"')) {
    yield* streamToolCall("reference-active", "classify_reference", {
      referenceId: ids[0],
      status: "active",
      purpose: "Primary dimensioned drawing",
      relationships: [],
      rationale: "This drawing establishes the primary dimensions and form.",
      specificationLinks: ["plan.spec_sheet.primary-drawing"],
    });
    return;
  }
  const activeId = referenceIdForCall(transcript, "reference-active") ?? ids[0];
  if (!transcript.includes('"toolCallId":"reference-complementary"')) {
    const complementaryId = ids.find((id) => id !== activeId);
    yield* streamToolCall("reference-complementary", "classify_reference", {
      referenceId: complementaryId,
      status: "complementary",
      purpose: "Corrected front view",
      relationships: [{ type: "complements", referenceId: activeId }],
      rationale: "This view adds front-orientation evidence absent from the primary drawing.",
      specificationLinks: ["plan.spec_sheet.front-orientation"],
    });
    return;
  }
  const complementaryId = referenceIdForCall(transcript, "reference-complementary") ?? ids.find((id) => id !== activeId);
  if (!transcript.includes('"toolCallId":"reference-superseded"')) {
    yield* streamToolCall("reference-superseded", "classify_reference", {
      referenceId: activeId,
      status: "superseded",
      purpose: "Original orientation drawing",
      relationships: [{ type: "superseded-by", referenceId: complementaryId }],
      rationale: "The corrected front view replaces the original orientation evidence.",
      specificationLinks: ["plan.spec_sheet.front-orientation"],
    });
    return;
  }
  yield* streamText("Reference classifications recorded: the corrected view complements the dimensions and supersedes the original orientation.");
}

function inspectionLeaseIdIn(transcript: string): string | undefined {
  return transcript.match(/Open inspection lease ([^;\]]+)/)?.[1];
}

function* inspectionLeaseStep(
  transcript: string,
  imageCount: number,
): Generator<AssistantMessageEvent> {
  const referenceId = referenceIdsIn(transcript)[0];
  if (!transcript.includes('"toolCallId":"lease-classify"')) {
    yield* streamToolCall("lease-classify", "classify_reference", {
      referenceId,
      status: "active",
      purpose: "Earlier profile evidence",
      relationships: [],
      rationale: "The image establishes the profile that must be inspected later.",
      specificationLinks: ["spec.profile"],
    });
    return;
  }
  if (transcript.includes("lease-unavailable")) {
    if (transcript.includes('"toolCallId":"lease-unavailable-inspect"')) {
      yield* streamText("Unavailable evidence reported without creating an observation.");
    } else {
      yield* streamToolCall("lease-unavailable-inspect", "inspect_evidence", {
        evidenceIds: [referenceId],
        purpose: "Confirm unavailable evidence handling",
      });
    }
    return;
  }
  if (transcript.includes("lease-count")) {
    yield* streamText(`Lease context contains ${imageCount} native images.`);
    return;
  }
  if (!transcript.includes('"toolCallId":"lease-inspect"')) {
    if (transcript.includes("lease-open")) {
      yield* streamToolCall("lease-inspect", "inspect_evidence", {
        evidenceIds: [referenceId],
        purpose: "Compare the earlier front profile",
      });
    } else {
      yield* streamText("Reference classified and ready for later inspection.");
    }
    return;
  }
  if (!transcript.includes('"toolCallId":"lease-observe"')) {
    if (transcript.includes("lease-recover")) {
      yield* streamToolCall("lease-observe", "record_inspection_observation", {
        leaseId: inspectionLeaseIdIn(transcript),
        relevantViews: ["front", "isometric"],
        facts: ["The profile has a wider flange around the central body."],
        affectedSpecifications: ["spec.profile"],
        affectedComponents: ["body"],
      });
    } else {
      yield* streamText("Inspection interrupted with its durable lease still open.");
    }
    return;
  }
  yield* streamText("Recovered inspection recorded and pixels evicted.");
}

function* visualFinalizationStep(transcript: string, lastMessage: string, imageCount: number): Generator<AssistantMessageEvent> {
  const referenceId = referenceIdsIn(transcript)[0];
  if (!transcript.includes('"toolCallId":"visual-classify"') && !transcript.includes("status=active")) {
    yield* streamToolCall("visual-classify", "classify_reference", {
      referenceId,
      status: "active",
      purpose: "Primary form reference",
      relationships: [],
      rationale: "The image defines the requested visible proportions.",
      specificationLinks: ["visual.body-form"],
    });
    return;
  }
  if (!transcript.includes("visual-finalization-build")) {
    yield* streamText(lastMessage.includes("[Chamfer visual check]")
      ? "Waiting for a CAD artifact before visual verification."
      : "Active visual reference classified.");
    return;
  }

  const runs = transcript.split('"name":"run_build123d"').length - 1;
  const records = transcript.split('"name":"record_visual_verification_batch"').length - 1;
  const newRevision = transcript.includes("visual-finalization-new-revision");
  const batch = [...transcript.matchAll(/Visual verification batch (\d+)\/(\d+); artifact=([^@;]+)@(\d+); sheet=([^;]+); imageLimit=(\d+); activeSet=.*?; batchReferences=([^;]+);/g)].at(-1);
  if (batch) {
    const verdict = runs === 1 ? "needs-revision" : "match";
    const coveredReferenceIds = batch[7]!.split(",");
    yield* streamToolCall(`visual-batch-${runs}`, "record_visual_verification_batch", {
      artifactId: batch[3],
      artifactVersion: Number(batch[4]),
      inspectionSheetId: batch[5],
      imageLimit: Number(batch[6]),
      activeReferenceIds: referenceIdsIn(transcript).sort(),
      batchIndex: Number(batch[1]) - 1,
      batchCount: Number(batch[2]),
      coveredReferenceIds,
      observations: coveredReferenceIds.map((id) => ({
        referenceId: id,
        relevantViews: ["isometric", "front", "top"],
        findings: [verdict === "match"
          ? `Current silhouettes and proportions match the reference; request carried ${imageCount} images.`
          : `Front silhouette is too narrow; request carried ${imageCount} images.`],
        affectedComponents: verdict === "match" ? [] : ["body"],
      })),
      finalVerdict: verdict,
      synthesis: verdict === "match"
        ? "The active reference matches the current inspection sheet."
        : "The current front silhouette is too narrow and requires revision.",
    });
    return;
  }
  if (runs === 0) {
    yield* streamToolCall("visual-run-1", "run_build123d", { code: lifecycleScript(10) });
    return;
  }
  if (records === 0) {
    yield* streamText("Prematurely declaring the first CAD revision complete.");
    return;
  }
  if (runs === 1) {
    if (lastMessage.includes("[Chamfer visual check]")) {
      yield* streamToolCall("visual-run-2", "run_build123d", { code: lifecycleScript(12) });
    } else {
      yield* streamText("The visual verdict found a mismatch, but I am stopping before revision.");
    }
    return;
  }
  if (records === 1) {
    yield* streamText("Corrected geometry rendered; attempting to finish before refreshing visual evidence.");
    return;
  }
  if (!newRevision) {
    yield* streamText(lastMessage.includes("[Chamfer self-check]")
      ? "Current visual verification and the complete request are satisfied."
      : "Corrected revision complete with current visual match evidence.");
    return;
  }
  if (runs === 2) {
    yield* streamToolCall("visual-run-3", "run_build123d", { code: lifecycleScript(14) });
    return;
  }
  if (records === 2) {
    yield* streamText("The new CAD revision is numerically verified; attempting to reuse the earlier visual verdict.");
    return;
  }
  yield* streamText(lastMessage.includes("[Chamfer self-check]")
    ? "The newest revision has current visual verification."
    : "Newest CAD revision visually verified against the active reference.");
}

function* batchedVisualVerificationStep(transcript: string, lastMessage: string, imageCount: number): Generator<AssistantMessageEvent> {
  const batchMatches = [...transcript.matchAll(/Visual verification batch (\d+)\/(\d+); artifact=([^@;]+)@(\d+); sheet=([^;]+); imageLimit=(\d+); activeSet=.*?; batchReferences=([^;]+);/g)];
  const batchText = batchMatches.at(-1);
  if (batchText) {
    const batchIndex = Number(batchText[1]) - 1;
    const batchCount = Number(batchText[2]);
    const coveredReferenceIds = batchText[7]!.split(",");
    const activeReferenceIds = referenceIdsIn(transcript).sort();
    const final = batchIndex === batchCount - 1;
    yield* streamToolCall(`visual-batch-${batchIndex + 1}`, "record_visual_verification_batch", {
      artifactId: batchText[3],
      artifactVersion: Number(batchText[4]),
      inspectionSheetId: batchText[5],
      imageLimit: Number(batchText[6]),
      activeReferenceIds,
      batchIndex,
      batchCount,
      coveredReferenceIds,
      observations: coveredReferenceIds.map((referenceId) => ({
        referenceId,
        relevantViews: ["isometric", "front"],
        findings: [`Reference ${referenceId} matches; request carried ${imageCount} images including the shared sheet.`],
        affectedComponents: [],
      })),
      ...(final ? {
        finalVerdict: "match",
        synthesis: `All ${activeReferenceIds.length} active references match the shared current inspection sheet across ${batchCount} deterministic requests.`,
      } : {}),
    });
    return;
  }
  if (!transcript.includes('"name":"run_build123d"')) {
    yield* streamToolCall("batched-visual-run", "run_build123d", { code: lifecycleScript(10) });
    return;
  }
  if (transcript.includes('"finalVerification"')) {
    yield* streamText(lastMessage.includes("[Chamfer self-check]")
      ? "Batched visual verification and the complete request are satisfied."
      : "All batched visual evidence is covered by one synthesized match verdict.");
    return;
  }
  yield* streamText("CAD is ready; attempting to finish before batched visual verification.");
}

function activeReferenceIdsIn(transcript: string): string[] {
  const ids: string[] = [];
  for (const match of transcript.matchAll(/\[Reference ([^:]+): status=(active|complementary);/g)) {
    const id = match[1]?.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.sort();
}

function* retrievableEvidenceWorkflowStep(
  transcript: string,
  lastMessage: string,
  imageCount: number,
): Generator<AssistantMessageEvent> {
  const batch = [...transcript.matchAll(/Visual verification batch (\d+)\/(\d+); artifact=([^@;]+)@(\d+); sheet=([^;]+); imageLimit=(\d+); activeSet=.*?; batchReferences=([^;]+);/g)].at(-1);
  if (batch && lastMessage.includes(`Visual verification batch ${batch[1]}/${batch[2]}`)) {
    const batchIndex = Number(batch[1]) - 1;
    const batchCount = Number(batch[2]);
    const artifactVersion = Number(batch[4]);
    const coveredReferenceIds = batch[7]!.split(",");
    const final = batchIndex === batchCount - 1;
    const verdict = artifactVersion === 1 ? "needs-revision" : "match";
    yield* streamToolCall(`workflow-batch-${artifactVersion}-${batchIndex}`, "record_visual_verification_batch", {
      artifactId: batch[3],
      artifactVersion,
      inspectionSheetId: batch[5],
      imageLimit: Number(batch[6]),
      activeReferenceIds: activeReferenceIdsIn(transcript),
      batchIndex,
      batchCount,
      coveredReferenceIds,
      observations: coveredReferenceIds.map((referenceId) => ({
        referenceId,
        relevantViews: ["front", "isometric"],
        findings: [artifactVersion === 1
          ? `Revision 1 is too narrow for ${referenceId}; request carried ${imageCount} images.`
          : `Revision 2 matches ${referenceId}; request carried ${imageCount} images.`],
        affectedComponents: artifactVersion === 1 ? ["body"] : [],
      })),
      ...(final ? {
        finalVerdict: verdict,
        synthesis: verdict === "match"
          ? "All active and complementary references match the corrected current sheet."
          : "The first revision is consistently too narrow and requires another CAD revision.",
      } : {}),
    });
    return;
  }

  if (!transcript.includes('"toolCallId":"workflow-premature-run"')) {
    yield* streamToolCall("workflow-premature-run", "run_build123d", { code: lifecycleScript(8) });
    return;
  }
  if (!transcript.includes("workflow-classify-ready")) {
    yield* streamText("Premature CAD rejected until every uploaded reference is classified.");
    return;
  }
  const classifications = [
    ["workflow-classify-primary", "workflow-ref-primary", "active", "Primary silhouette", [], ["visual.primary"]],
    ["workflow-classify-detail", "workflow-ref-detail", "complementary", "Surface detail", [{ type: "complements", referenceId: "workflow-ref-primary" }], ["visual.detail"]],
    ["workflow-classify-profile", "workflow-ref-profile", "complementary", "Side profile", [{ type: "complements", referenceId: "workflow-ref-primary" }], ["visual.profile"]],
    ["workflow-classify-old", "workflow-ref-old", "superseded", "Earlier silhouette", [{ type: "superseded-by", referenceId: "workflow-ref-primary" }], ["visual.primary"]],
  ] as const;
  for (const [callId, referenceId, status, purpose, relationships, specificationLinks] of classifications) {
    if (!transcript.includes(`[Reference ${referenceId}: status=`) && !transcript.includes(`"toolCallId":"${callId}"`)) {
      yield* streamToolCall(callId, "classify_reference", {
        referenceId, status, purpose, relationships,
        rationale: `Workflow classification for ${referenceId}.`,
        specificationLinks,
      });
      return;
    }
  }
  if (!transcript.includes("workflow-retrieve")) return yield* streamText("Classified references are ready for retrieval.");
  if (!transcript.includes('"toolCallId":"workflow-inspect-old"')) {
    yield* streamToolCall("workflow-inspect-old", "inspect_evidence", {
      evidenceIds: ["workflow-ref-old"],
      purpose: "Retrieve the earlier silhouette and preserve one structured comparison fact.",
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"workflow-observe-old"')) {
    yield* streamToolCall("workflow-observe-old", "record_inspection_observation", {
      leaseId: inspectionLeaseIdIn(transcript),
      relevantViews: ["front"],
      facts: ["The superseded reference used a narrower front silhouette."],
      affectedSpecifications: ["visual.primary"],
      affectedComponents: ["body"],
    });
      return;
  }
  if (!transcript.includes("workflow-build-first")) {
    yield* streamText("Earlier reference retrieved, observed, and released from model context.");
    return;
  }
  const hasFirstRun = transcript.includes('"toolCallId":"workflow-run-1"');
  const hasSecondRun = transcript.includes('"toolCallId":"workflow-run-2"');
  if (!hasFirstRun) {
    yield* streamToolCall("workflow-run-1", "run_build123d", { code: lifecycleScript(10) });
    return;
  }
  if (transcript.includes('"finalVerdict":"needs-revision"') && !hasSecondRun) {
    if (lastMessage.includes("[Chamfer visual check]") && transcript.includes("workflow-revise")) {
      yield* streamToolCall("workflow-run-2", "run_build123d", { code: lifecycleScript(12) });
    } else {
      yield* streamText(lastMessage.includes("[Chamfer visual check]")
        ? "Mismatch recovery paused with the first revision still current."
        : "The first batched comparison found a mismatch; attempting to stop before revision.");
    }
    return;
  }
  if (transcript.includes('"finalVerdict":"match"')) {
    yield* streamText(lastMessage.includes("[Chamfer self-check]")
      ? "Retrievable evidence workflow complete after reload-safe final verification."
      : "Corrected revision finalized with complete batched visual evidence.");
    return;
  }
  yield* streamText("CAD revision rendered; attempting to finish before visual verification.");
}

export function fakeLlm(): FakeLlmRequestDiagnostics {
  const diagnostics = new Map<string, ModelRequestDiagnostic[]>();
  return {
    getRequestDiagnostics(conversationId) {
      return [...(diagnostics.get(conversationId) ?? [])];
    },
    async *stream(_model, context, options): AsyncIterable<AssistantMessageEvent> {
      const { messages = [], systemPrompt } = context as {
        messages?: Array<{ role?: string }>;
        systemPrompt?: string;
      };
      // Title-generation calls (see titles.ts) expect plain text, not a tool call.
      // Matched exactly: a substring probe ("title") also matches the agent's own
      // system prompt (e.g. "titled results"), hijacking every scenario turn.
      if (systemPrompt === TITLE_SYSTEM_PROMPT) {
        yield* streamText("Fake Box Design");
        return;
      }
      const conversationId = typeof options.sessionId === "string" ? options.sessionId : "unscoped";
      const captures = diagnostics.get(conversationId) ?? [];
      captures.push(sanitizeModelRequest(captures.length + 1, context));
      diagnostics.set(conversationId, captures);
      // The plan-flow scenario drives the whole plan artifact loop and owns its
      // own step machine, including the plan-check nudge reply.
      const transcript = JSON.stringify(messages);
      const imageCount = messages.reduce((count, candidate) => {
        const content = (candidate as { content?: unknown }).content;
        if (!Array.isArray(content)) return count;
        return count + content.filter((block) => (block as { type?: unknown })?.type === "image").length;
      }, 0);
      if (transcript.includes("attachment-replay")) {
        yield* streamText(`Received ${imageCount} native image block${imageCount === 1 ? "" : "s"}.`);
        return;
      }
      if (transcript.includes("retrievable-evidence-workflow")) {
        yield* retrievableEvidenceWorkflowStep(transcript, JSON.stringify(messages.at(-1)), imageCount);
        return;
      }
      if (transcript.includes("long-plan-layout")) {
        if (transcript.includes('"name":"update_plan"')) {
          yield* streamText("Long plan ready for review.");
        } else {
          yield* streamToolCall("long-plan-layout-plan", "update_plan", LONG_PLAN);
        }
        return;
      }
      if (transcript.includes("plan-flow")) {
        yield* planFlowStep(transcript, JSON.stringify(messages.at(-1)));
        return;
      }
      if (transcript.includes("image-plan-gate")) {
        yield* imagePlanGateStep(transcript, JSON.stringify(messages.at(-1)));
        return;
      }
      if (transcript.includes("skill-loop")) {
        yield* skillLoopStep(transcript);
        return;
      }
      if (transcript.includes("sheet-lifecycle")) {
        yield* inspectionSheetLifecycleStep(transcript);
        return;
      }
      if (transcript.includes("reference-classification-gate")) {
        yield* referenceClassificationStep(transcript);
        return;
      }
      if (transcript.includes("inspection-lease-workflow")) {
        yield* inspectionLeaseStep(transcript, imageCount);
        return;
      }
      if (transcript.includes("visual-finalization-setup")) {
        yield* visualFinalizationStep(transcript, JSON.stringify(messages.at(-1)), imageCount);
        return;
      }
      if (transcript.includes("batched-visual-verification-setup")) {
        yield* batchedVisualVerificationStep(transcript, JSON.stringify(messages.at(-1)), imageCount);
        return;
      }
      // The self-check nudge the session injects after a gate pass arrives as a
      // trailing user message; answer it with a completed checklist instead of
      // falling through to the tool-call branch (which would start a second,
      // duplicate CAD run and hang the e2e flow).
      if (JSON.stringify(messages.at(-1)).includes("[Chamfer self-check]")) {
        yield* streamText("Checked the request: single box, all dimensions satisfied. Nothing missing.");
        return;
      }
      // The gate-fail scenario (triggered by "gate-fail" anywhere in the
      // transcript) emits a script whose EXPECT bbox is deliberately wrong,
      // so e2e can exercise a failing verify gate end to end.
      const gateFail = JSON.stringify(messages).includes("gate-fail");
      if (messages.at(-1)?.role === "toolResult") {
        yield* streamText(
          gateFail
            ? "The verify gate failed as expected for this scenario."
            : "Built a 10x20x30 box. All views verified.",
        );
        return;
      }

      const code = [
        "from build123d import *",
        "# --- params ---",
        "width = 10  # [1, 100] Width in mm",
        "depth = 20  # [1, 100] Depth in mm",
        "height = 30  # [1, 100] Height in mm",
        "# --- end params ---",
        "# --- expect ---",
        // The gate-fail variant expects a 31mm dimension the box never has.
        `EXPECT = {"bodies": 1, "bbox_mm": [10, 20, ${gateFail ? 31 : 30}]}`,
        "# --- end expect ---",
        "result = Box(width, depth, height)",
      ].join("\n");
      yield* streamToolCall("fake-run-1", "run_build123d", { code });
    },
  };
}
