import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { LlmStreamer } from "./llm";
import { TITLE_SYSTEM_PROMPT } from "./titles";
import { sanitizeModelRequest, type ModelRequestDiagnostic } from "./imageContextDiagnostics";
import { FUS_IMAGE_001, FUS_IMAGE_001_ACTION_BODY, FUS_TEXT_001, FUS_TEXT_001_ACTION_BODY, FUS_TEXT_002, FUS_TEXT_002_ACTION_BODY } from "@chamfer/fusion-fixtures";

export interface FakeLlmTestController extends LlmStreamer {
  getRequestDiagnostics(conversationId: string): ModelRequestDiagnostic[];
  isRequestHeld(conversationId: string): boolean;
  releaseHeldRequest(conversationId: string): boolean;
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
    { id: "base", description: "30x30x6 base plate", bbox_mm: [30, 30, 6], checks: BASE_CHECKS },
    { id: "lid", description: "30x30x4 lid", bbox_mm: [30, 30, 4], checks: LID_CHECKS },
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

function* planFlowStep(transcript: string, lastMessage: string): Generator<AssistantMessageEvent> {
  // Tool CALL blocks serialize as {"type":"toolCall",...,"name":"<tool>"}; tool
  // results carry toolName instead, so these counts see only the calls.
  const plans = transcript.split('"name":"create_plan"').length - 1;
  const revisions = transcript.split('"name":"revise_plan"').length - 1;
  const runs = transcript.split('"name":"run_build123d"').length - 1;
  const specifications = transcript.split('"name":"record_source_specifications"').length - 1;
  if (lastMessage.includes("[Chamfer plan check]")) {
    yield* streamToolCall("plan-flow-run-2", "run_build123d", { code: ASSEMBLY_SCRIPT });
    return;
  }
  if (specifications === 0) {
    const dimensioned = transcript.includes("30 x 30 x 6 mm base plate");
    yield* streamToolCall("plan-flow-source-specifications", "record_source_specifications", {
      specifications: dimensioned
        ? [
            {
              id: "base-envelope",
              requirement: "The base plate must be 30 x 30 x 6 mm.",
              sourceQuote: "30 x 30 x 6 mm base plate",
            },
            {
              id: "lid-envelope",
              requirement: "The lid must be 30 x 30 x 4 mm.",
              sourceQuote: "30 x 30 x 4 mm lid",
            },
            {
              id: "lid-resting",
              requirement: "The lid must rest on the base plate.",
              sourceQuote: "lid resting on it",
            },
          ]
        : [
            {
              id: "base-present",
              requirement: "The design must include a base plate.",
              sourceQuote: "base plate",
            },
            {
              id: "lid-resting",
              requirement: "The lid must rest on the base plate.",
              sourceQuote: "lid resting on it",
            },
          ],
    });
    return;
  }
  if (plans === 0) {
    yield* streamToolCall("plan-flow-plan-1", "create_plan", {
      mutation_id: "plan-flow-create",
      reason: "Create the plan from the durable source requirements.",
      ...PLAN_V1,
    });
    return;
  }
  if (plans === 1 && revisions === 0 && runs === 0) {
    yield* streamToolCall("plan-flow-run-1", "run_build123d", { code: BASE_SCRIPT });
    return;
  }
  if (plans === 1 && revisions === 0 && runs === 1) {
    yield* streamToolCall("plan-flow-plan-2", "revise_plan", {
      mutation_id: "plan-flow-finish-base",
      reason: "The base run passed all planned checks.",
      operations: [{ kind: "set_component_status", component_id: "base", status: "done" }],
    });
    return;
  }
  if (plans === 1 && revisions === 1 && runs === 1) {
    // Premature stop with the lid still todo: the session must inject the
    // deterministic plan nudge, which the branch above answers with the
    // assembly run.
    yield* streamText("Base is done; stopping here for now.");
    return;
  }
  if (plans === 1 && revisions === 1 && runs === 2) {
    yield* streamToolCall("plan-flow-plan-3", "revise_plan", {
      mutation_id: "plan-flow-finish-lid",
      reason: "The assembly run passed the lid checks and shared interface check.",
      operations: [{ kind: "set_component_status", component_id: "lid", status: "done" }],
    });
    return;
  }
  yield* streamText("Assembly complete: base and lid built, touching, both verified.");
}

// --- proof-contract-flow scenario (triggered by "proof-contract-flow") ---
// Drives one text-only part through durable specifications, autonomous contract
// freezing, a diagnostic probe, a deliverable, and a later criteria revision.
const PROOF_PLATE_CHECKS = [
  { id: "envelope", kind: "bbox", size_mm: [30, 20, 4], target: "plate" },
  { id: "volume", kind: "volume", range_mm3: [2100, 2300], target: "plate" },
  { id: "holes", kind: "hole_through", diameter: 4, count: 4, target: "plate" },
];

const PROOF_PLATE_PLAN = {
  goal: "30 x 20 x 4 mm four-hole mounting plate",
  components: [{
    id: "plate",
    description: "rectangular mounting plate with four corner through holes",
    bbox_mm: [30, 20, 4],
    checks: PROOF_PLATE_CHECKS,
    free_floating_reason: "The requested deliverable is one standalone part.",
  }],
  interfaces: [],
};

const PROOF_PROBE_CODE = [
  "from build123d import *",
  '# --- expect ---',
  'EXPECT = {"bodies": 1, "bbox_mm": [1, 1, 1]}',
  '# --- end expect ---',
  'COMPONENT = "probe"',
  "result = Box(1, 1, 1)",
].join("\n");

function proofPlateCode(volumeRange: [number, number]): string {
  return [
    "from build123d import *",
    '# --- expect ---',
    'EXPECT = {"bodies": 1, "bbox_mm": [30, 20, 4]}',
    '# --- end expect ---',
    '# --- checks ---',
    'CHECKS = [',
    '    {"kind": "bbox", "size_mm": [30, 20, 4], "target": "plate"},',
    `    {"kind": "volume", "range_mm3": [${volumeRange[0]}, ${volumeRange[1]}], "target": "plate"},`,
    '    {"kind": "hole_through", "diameter": 4, "count": 4, "target": "plate"},',
    ']',
    '# --- end checks ---',
    '# --- component ---',
    'COMPONENT = "plate"',
    '# --- end component ---',
    'with BuildPart() as plate_part:',
    '    Box(30, 20, 4)',
    '    with Locations((-10, -5), (-10, 5), (10, -5), (10, 5)):',
    '        Hole(2)',
    'plate = plate_part.part',
    'plate.label = "plate"',
    'result = plate',
  ].join("\n");
}

function* proofContractFlowStep(transcript: string, lastMessage: string): Generator<AssistantMessageEvent> {
  const specifications = transcript.split('"name":"record_source_specifications"').length - 1;
  const plans = transcript.split('"name":"create_plan"').length - 1;
  const runs = transcript.split('"name":"run_build123d"').length - 1;
  if (lastMessage.includes("[Chamfer self-check]")) {
    yield* streamText("The current mounting plate satisfies every frozen text requirement and planned check.");
    return;
  }
  if (specifications === 0) {
    yield* streamToolCall("proof-contract-specifications", "record_source_specifications", {
      specifications: [
        {
          id: "plate-envelope",
          requirement: "The mounting plate must be 30 x 20 x 4 mm.",
          sourceQuote: "30 x 20 x 4 mm mounting plate",
        },
        {
          id: "plate-holes",
          requirement: "The mounting plate must have four 4 mm through holes.",
          sourceQuote: "four 4 mm through holes",
        },
      ],
    });
    return;
  }
  if (plans === 0) {
    yield* streamToolCall("proof-contract-plan", "create_plan", {
      mutation_id: "proof-contract-create",
      reason: "Create the single-part plan from the exact durable text requirements.",
      ...PROOF_PLATE_PLAN,
    });
    return;
  }
  if (runs === 0) {
    yield* streamToolCall("proof-contract-probe", "run_build123d", { code: PROOF_PROBE_CODE });
    return;
  }
  if (runs === 1) {
    yield* streamToolCall("proof-contract-deliverable", "run_build123d", { code: proofPlateCode([2100, 2300]) });
    return;
  }
  if (!transcript.includes("proof-contract-finish-initial")) {
    yield* streamToolCall("proof-contract-finish-initial", "revise_plan", {
      mutation_id: "proof-contract-finish-initial",
      reason: "The first deliverable passed every frozen planned check.",
      operations: [{ kind: "set_component_status", component_id: "plate", status: "done" }],
    });
    return;
  }
  if (!transcript.includes("proof-contract-revise")) {
    yield* streamText("Initial mounting plate complete with current frozen proof criteria.");
    return;
  }
  if (!transcript.includes("proof-contract-tighten-volume")) {
    yield* streamToolCall("proof-contract-tighten-volume", "revise_plan", {
      mutation_id: "proof-contract-tighten-volume",
      reason: "Tighten the agent-selected volume evidence while preserving the explicit dimensions and holes.",
      operations: [{
        kind: "revise_check",
        component_id: "plate",
        check_id: "volume",
        check: { kind: "volume", range_mm3: [2150, 2250], target: "plate" },
      }],
    });
    return;
  }
  if (runs === 2) {
    yield* streamToolCall("proof-contract-deliverable-revised", "run_build123d", { code: proofPlateCode([2150, 2250]) });
    return;
  }
  if (!transcript.includes("proof-contract-finish-revision")) {
    yield* streamToolCall("proof-contract-finish-revision", "revise_plan", {
      mutation_id: "proof-contract-finish-revision",
      reason: "The revised deliverable passed the new contract revision.",
      operations: [{ kind: "set_component_status", component_id: "plate", status: "done" }],
    });
    return;
  }
  yield* streamText("Revised proof contract and mounting plate are current.");
}

const EXCEPTION_ESCALATION_PLAN = {
  goal: "single spacer using the user-resolved width",
  components: [{
    id: "spacer",
    description: "12 mm resolved cube spacer",
    bbox_mm: [12, 12, 12],
    free_floating_reason: "single part",
    checks: [
      { id: "envelope", kind: "bbox", size_mm: [12, 12, 12], target: "spacer" },
      { id: "volume", kind: "volume", range_mm3: [1650, 1810], target: "spacer" },
    ],
  }],
  interfaces: [],
};

const EXCEPTION_ESCALATION_CODE = [
  "from build123d import *",
  "# --- expect ---",
  'EXPECT = {"bodies": 1, "bbox_mm": [12, 12, 12]}',
  "# --- end expect ---",
  "# --- checks ---",
  "CHECKS = [",
  '    {"kind": "bbox", "size_mm": [12, 12, 12], "target": "spacer"},',
  '    {"kind": "volume", "range_mm3": [1650, 1810], "target": "spacer"},',
  "]",
  "# --- end checks ---",
  "# --- component ---",
  'COMPONENT = "spacer"',
  "# --- end component ---",
  "spacer = Box(12, 12, 12)",
  'spacer.label = "spacer"',
  "result = spacer",
].join("\n");

function* exceptionEscalationStep(transcript: string, lastMessage: string): Generator<AssistantMessageEvent> {
  const sourceCalls = transcript.split('"name":"record_source_specifications"').length - 1;
  const planCalls = transcript.split('"name":"create_plan"').length - 1;
  const clarificationCalls = transcript.split('"name":"request_design_clarification"').length - 1;
  const runs = transcript.split('"name":"run_build123d"').length - 1;
  if (lastMessage.includes("[Chamfer self-check]")) {
    yield* streamText("The resolved 12 mm source requirement and current spacer evidence are complete.");
    return;
  }
  if (sourceCalls === 0) {
    yield* streamToolCall("exception-conflicting-sources", "record_source_specifications", {
      specifications: [
        {
          id: "width-10",
          requirement: "The spacer must be 10 mm wide.",
          sourceQuote: "one note says the width is 10 mm",
          conflictsWithSpecificationIds: ["width-12"],
        },
        {
          id: "width-12",
          requirement: "The spacer must be 12 mm wide.",
          sourceQuote: "another says the width is 12 mm",
          conflictsWithSpecificationIds: ["width-10"],
        },
      ],
    });
    return;
  }
  if (planCalls === 0) {
    yield* streamToolCall("exception-silent-plan", "create_plan", {
      mutation_id: "exception-silent-plan",
      reason: "Silently choose the more convenient width despite conflicting active evidence.",
      ...EXCEPTION_ESCALATION_PLAN,
    });
    return;
  }
  if (clarificationCalls === 0) {
    yield* streamToolCall("exception-focused-question", "request_design_clarification", {
      escalationId: "width-conflict",
      kind: "conflicting-specifications",
      question: "Should the spacer be 10 mm or 12 mm wide?",
      affectedSpecificationIds: ["width-10", "width-12"],
      basis: "Two active source requirements assign different widths to the same spacer.",
    });
    return;
  }
  if (!transcript.includes("Use 12 mm wide.")) {
    yield* streamText("Should the spacer be 10 mm or 12 mm wide?");
    return;
  }
  if (sourceCalls === 1) {
    yield* streamToolCall("exception-answer-source", "record_source_specifications", {
      resolvesEscalationId: "width-conflict",
      specifications: [{
        id: "width-resolved-12",
        requirement: "The spacer must be 12 mm wide.",
        sourceQuote: "Use 12 mm wide.",
        supersedesSpecificationIds: ["width-10", "width-12"],
      }],
    });
    return;
  }
  if (planCalls === 1) {
    yield* streamToolCall("exception-resolved-plan", "create_plan", {
      mutation_id: "exception-resolved-plan",
      reason: "Create the plan from the user's resolved 12 mm source evidence.",
      ...EXCEPTION_ESCALATION_PLAN,
    });
    return;
  }
  if (runs === 0) {
    yield* streamToolCall("exception-resolved-run", "run_build123d", { code: EXCEPTION_ESCALATION_CODE });
    return;
  }
  if (!transcript.includes("exception-complete-plan")) {
    yield* streamToolCall("exception-complete-plan", "revise_plan", {
      mutation_id: "exception-complete-plan",
      reason: "The resolved deliverable passed its current proof criteria.",
      operations: [{ kind: "set_component_status", component_id: "spacer", status: "done" }],
    });
    return;
  }
  yield* streamText("Resolved source evidence restored autonomous CAD eligibility.");
}

// Evaluation tracer scenarios.
// These privacy-safe scripted cases exercise escalation and honest blocking through
// the same server stream and client session used by the product.
function* evaluationImpossibleBlockedStep(transcript: string): Generator<AssistantMessageEvent> {
  if (!transcript.includes('"toolCallId":"evaluation-impossible-specifications"')) {
    yield* streamToolCall("evaluation-impossible-specifications", "record_source_specifications", {
      specifications: [{
        id: "shell-envelope",
        requirement: "The shell must be 2 mm wide.",
        sourceQuote: "2 mm wide shell",
      }, {
        id: "shell-walls",
        requirement: "The shell must have two 2 mm walls.",
        sourceQuote: "two 2 mm walls",
      }, {
        id: "shell-cavity",
        requirement: "The shell must retain a positive internal cavity.",
        sourceQuote: "positive internal cavity",
      }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"evaluation-impossible-plan"')) {
    yield* streamToolCall("evaluation-impossible-plan", "create_plan", {
      mutation_id: "evaluation-impossible-plan",
      reason: "Record the requested shell without weakening its contradictory dimensional requirements.",
      goal: "2 mm shell with two 2 mm walls and a positive cavity",
      components: [{
        id: "shell",
        description: "single shell constrained by the requested envelope, walls, and cavity",
        bbox_mm: [2, 10, 10],
        checks: [
          { id: "envelope", kind: "bbox", size_mm: [2, 10, 10], target: "shell" },
          { id: "volume", kind: "volume", range_mm3: [170, 190], target: "shell" },
        ],
        free_floating_reason: "The requested deliverable is one standalone part.",
      }],
      interfaces: [],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"evaluation-impossible-block"')) {
    yield* streamToolCall("evaluation-impossible-block", "revise_plan", {
      mutation_id: "evaluation-impossible-block",
      reason: "Block the geometrically impossible contract without weakening any explicit requirement.",
      operations: [{
        kind: "set_component_status",
        component_id: "shell",
        status: "blocked",
        blocked_reason: "Two 2 mm walls require 4 mm before any positive cavity, exceeding the explicit 2 mm overall width.",
      }],
    });
    return;
  }
  yield* streamText("The requested shell is honestly blocked because its explicit dimensions cannot coexist.");
}

// --- single-component-integrity scenario (triggered by "single-component-integrity") ---
// The first deliverable deliberately places a detached feature inside the
// requested envelope and declares two expected bodies. The geometry remains
// renderable for diagnosis, but it must not become component-completion evidence.
const INTEGRITY_PLAN = {
  goal: "one connected 30 x 20 x 4 mm plate",
  components: [{
    id: "plate",
    description: "one connected rectangular plate",
    bbox_mm: [30, 20, 4],
    checks: [
      { id: "envelope", kind: "bbox", size_mm: [30, 20, 4], target: "plate" },
      { id: "volume", kind: "volume", range_mm3: [2040, 2440], target: "plate" },
    ],
    free_floating_reason: "The requested deliverable is one standalone part.",
  }],
  interfaces: [],
};

const DETACHED_INTEGRITY_CODE = [
  "from build123d import *",
  "# --- expect ---",
  'EXPECT = {"bodies": 2, "bbox_mm": [30, 20, 4], "volume_mm3": [2040, 2440]}',
  "# --- end expect ---",
  "# --- checks ---",
  "CHECKS = [",
  '    {"kind": "bbox", "size_mm": [30, 20, 4], "target": "plate"},',
  '    {"kind": "volume", "range_mm3": [2040, 2440], "target": "plate"},',
  "]",
  "# --- end checks ---",
  "# --- component ---",
  'COMPONENT = "plate"',
  "# --- end component ---",
  "main = Pos(0, 0, -0.3) * Box(30, 20, 3.4)",
  'main.label = "plate-main"',
  "feature = Pos(0, 0, 1.75) * Box(8, 8, 0.5)",
  'feature.label = "detached-feature"',
  "result = Compound(children=[main, feature])",
  'result.label = "plate"',
].join("\n");

const CORRECTED_INTEGRITY_CODE = [
  "from build123d import *",
  "# --- expect ---",
  'EXPECT = {"bodies": 1, "bbox_mm": [30, 20, 4], "volume_mm3": [2040, 2440]}',
  "# --- end expect ---",
  "# --- checks ---",
  "CHECKS = [",
  '    {"kind": "bbox", "size_mm": [30, 20, 4], "target": "plate"},',
  '    {"kind": "volume", "range_mm3": [2040, 2440], "target": "plate"},',
  "]",
  "# --- end checks ---",
  "# --- component ---",
  'COMPONENT = "plate"',
  "# --- end component ---",
  "result = Box(30, 20, 4)",
  'result.label = "plate"',
].join("\n");

function* singleComponentIntegrityStep(transcript: string, lastMessage: string): Generator<AssistantMessageEvent> {
  const correcting = transcript.includes("integrity-correct");
  if (lastMessage.includes("[Chamfer self-check]")) {
    yield* streamText("Checked the corrected plate: its current result is one connected valid solid with matching component identity.");
    return;
  }
  if (!transcript.includes('"toolCallId":"integrity-specifications"')) {
    yield* streamToolCall("integrity-specifications", "record_source_specifications", {
      specifications: [{
        id: "plate-integrity",
        requirement: "The 30 x 20 x 4 mm plate must be one connected physical part.",
        sourceQuote: "one connected 30 x 20 x 4 mm plate",
      }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"integrity-plan"')) {
    yield* streamToolCall("integrity-plan", "create_plan", {
      mutation_id: "integrity-create",
      reason: "Create the one-part plan from the durable connected-part requirement.",
      ...INTEGRITY_PLAN,
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"integrity-run-detached"')) {
    yield* streamToolCall("integrity-run-detached", "run_build123d", { code: DETACHED_INTEGRITY_CODE });
    return;
  }
  if (!transcript.includes('"toolCallId":"integrity-finish-detached"')) {
    yield* streamToolCall("integrity-finish-detached", "revise_plan", {
      mutation_id: "integrity-finish-detached",
      reason: "Attempt completion from the detached diagnostic result.",
      operations: [{ kind: "set_component_status", component_id: "plate", status: "done" }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"integrity-mark-blocked"')) {
    yield* streamToolCall("integrity-mark-blocked", "revise_plan", {
      mutation_id: "integrity-mark-blocked",
      reason: "Record that detached diagnostic geometry cannot complete the component.",
      operations: [{
        kind: "set_component_status",
        component_id: "plate",
        status: "blocked",
        blocked_reason: "The current diagnostic result contains disconnected geometry.",
      }],
    });
    return;
  }
  if (!correcting) {
    yield* streamText("Detached integrity diagnostic remains visible and component completion is blocked.");
    return;
  }
  if (!transcript.includes('"toolCallId":"integrity-reopen"')) {
    yield* streamToolCall("integrity-reopen", "revise_plan", {
      mutation_id: "integrity-reopen",
      reason: "Resume the component for the requested one-solid repair.",
      operations: [{ kind: "set_component_status", component_id: "plate", status: "building" }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"integrity-run-corrected"')) {
    yield* streamToolCall("integrity-run-corrected", "run_build123d", { code: CORRECTED_INTEGRITY_CODE });
    return;
  }
  if (!transcript.includes('"toolCallId":"integrity-finish-corrected"')) {
    yield* streamToolCall("integrity-finish-corrected", "revise_plan", {
      mutation_id: "integrity-finish-corrected",
      reason: "The corrected one-solid result passes current integrity and planned checks.",
      operations: [{ kind: "set_component_status", component_id: "plate", status: "done" }],
    });
    return;
  }
  yield* streamText("Corrected single-solid plate is current and component completion is established.");
}

// --- legacy-plan-recovery scenario (triggered by "legacy-plan-recovery") ---
// A stale model first attempts a lossy snapshot replacement. Chamfer rejects it,
// then the model explicitly transitions the unchanged legacy state and applies
// the intended status change through one domain operation.
const LEGACY_RECOVERY_COMPONENT = {
  id: "spacer",
  description: "legacy 10 mm spacer",
  bbox_mm: [10, 10, 10],
  free_floating_reason: "single part",
  checks: [
    { id: "envelope", kind: "bbox", size_mm: [10, 10, 10], target: "spacer" },
    { id: "volume", kind: "volume", range_mm3: [900, 1100], target: "spacer" },
  ],
};

function* legacyPlanRecoveryStep(transcript: string): Generator<AssistantMessageEvent> {
  if (!transcript.includes('"toolCallId":"legacy-recovery-source"')) {
    yield* streamToolCall("legacy-recovery-source", "record_source_specifications", {
      specifications: [{
        id: "legacy-spacer",
        requirement: "Continue preserving the legacy 10 mm spacer and both acceptance checks.",
        sourceQuote: "preserve the complete legacy spacer plan",
      }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"legacy-recovery-write"')) {
    yield* streamToolCall("legacy-recovery-write", "update_plan", {
      goal: "legacy spacer",
      components: [{
        ...LEGACY_RECOVERY_COMPONENT,
        status: "blocked",
        blocked_reason: "Waiting for material selection.",
        checks: [LEGACY_RECOVERY_COMPONENT.checks[1]],
      }],
      interfaces: [],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"legacy-recovery-transition"')) {
    yield* streamToolCall("legacy-recovery-transition", "create_plan", {
      mutation_id: "legacy-recovery-transition",
      reason: "Transition the complete active legacy plan without omitting its envelope check.",
      transition_from_legacy: true,
      goal: "legacy spacer",
      components: [LEGACY_RECOVERY_COMPONENT],
      interfaces: [],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"legacy-recovery-block"')) {
    yield* streamToolCall("legacy-recovery-block", "revise_plan", {
      mutation_id: "legacy-recovery-block",
      reason: "Material selection is required before the spacer can be completed.",
      operations: [{
        kind: "set_component_status",
        component_id: "spacer",
        status: "blocked",
        blocked_reason: "Waiting for material selection.",
      }],
    });
    return;
  }
  yield* streamText("Legacy plan preserved and transitioned; the spacer is blocked pending material selection.");
}

// --- authoritative-plan scenario (triggered by "authoritative-plan") ---
// The first turn records and plans against width-v1. The browser test then
// persists width-v2 as a correction and reloads. The second turn deliberately
// attempts stale CAD before reconciling source coverage and criteria.
const AUTHORITATIVE_PLAN_V1 = {
  goal: "single dimensioned spacer",
  components: [{
    id: "spacer",
    description: "rectangular spacer",
    bbox_mm: [10, 10, 10],
    free_floating_reason: "single part",
    checks: [
      { id: "envelope", kind: "bbox", size_mm: [10, 10, 10], target: "spacer" },
      { id: "volume", kind: "volume", range_mm3: [900, 1100], target: "spacer" },
    ],
  }],
  interfaces: [],
};

const AUTHORITATIVE_PLAN_V2_SCRIPT = [
  "from build123d import *",
  "# --- expect ---",
  'EXPECT = {"bodies": 1, "bbox_mm": [12, 10, 10]}',
  "# --- end expect ---",
  "# --- checks ---",
  "CHECKS = [",
  '    {"kind": "bbox", "size_mm": [12, 10, 10], "target": "spacer"},',
  '    {"kind": "volume", "range_mm3": [1080, 1320], "target": "spacer"},',
  "]",
  "# --- end checks ---",
  "# --- component ---",
  'COMPONENT = "spacer"',
  "# --- end component ---",
  "result = Box(12, 10, 10)",
  'result.label = "spacer"',
].join("\n");

function* authoritativePlanStep(transcript: string, lastMessage: string): Generator<AssistantMessageEvent> {
  const plans = transcript.split('"name":"create_plan"').length - 1;
  const revisions = transcript.split('"name":"revise_plan"').length - 1;
  const runs = transcript.split('"name":"run_build123d"').length - 1;
  const corrected = transcript.includes("width-v2");
  if (!transcript.includes('"name":"record_source_specifications"')) {
    yield* streamToolCall("authoritative-source-v1", "record_source_specifications", {
      specifications: [{
        id: "width-v1",
        requirement: "The spacer must be 10 mm wide, deep, and high.",
        sourceQuote: "Build a 10 mm wide, deep, and high spacer",
      }],
    });
    return;
  }
  if (plans === 0) {
    yield* streamToolCall("authoritative-plan-v1", "create_plan", {
      mutation_id: "authoritative-create-v1",
      reason: "Create the plan from width-v1.",
      ...AUTHORITATIVE_PLAN_V1,
    });
    return;
  }
  if (!corrected) {
    yield* streamText("Initial authoritative plan is ready for corrected source evidence.");
    return;
  }
  if (runs === 0) {
    yield* streamToolCall("authoritative-stale-run", "run_build123d", { code: AUTHORITATIVE_PLAN_V2_SCRIPT });
    return;
  }
  if (revisions === 0) {
    yield* streamToolCall("authoritative-reconcile-v2", "revise_plan", {
      mutation_id: "authoritative-reconcile-v2",
      reason: "Reconcile the corrected 12 mm source requirement and its criteria.",
      operations: [
        { kind: "set_source_specifications", source_specification_ids: ["width-v2"] },
        { kind: "revise_component", component_id: "spacer", bbox_mm: [12, 10, 10] },
        {
          kind: "revise_check",
          component_id: "spacer",
          check_id: "envelope",
          check: { kind: "bbox", size_mm: [12, 10, 10], target: "spacer" },
        },
        {
          kind: "revise_check",
          component_id: "spacer",
          check_id: "volume",
          check: { kind: "volume", range_mm3: [1080, 1320], target: "spacer" },
        },
      ],
    });
    return;
  }
  if (runs === 1) {
    yield* streamToolCall("authoritative-current-run", "run_build123d", { code: AUTHORITATIVE_PLAN_V2_SCRIPT });
    return;
  }
  if (revisions === 1) {
    yield* streamToolCall("authoritative-complete-v2", "revise_plan", {
      mutation_id: "authoritative-complete-v2",
      reason: "The criteria-v2 run passed current plan conformance.",
      operations: [{ kind: "set_component_status", component_id: "spacer", status: "done" }],
    });
    return;
  }
  if (lastMessage.includes("[Chamfer self-check]")) {
    yield* streamText("The corrected 12 mm requirement and current criteria are fully covered.");
    return;
  }
  yield* streamText("Corrected source coverage restored and current CAD verified.");
}

// --- image-plan-gate scenario (triggered by "image-plan-gate") ---
// Classifies the image, then exercises both deterministic rejection paths before
// completing a one-part image plan: premature CAD run -> legacy snapshot write
// -> normalized plan -> verified run -> done plan.
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
      free_floating_reason: "single component",
      checks: IMAGE_PLAN_CHECKS,
    },
  ],
  interfaces: [],
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

function* imagePlanGateStep(transcript: string, lastMessage: string, imageCount: number): Generator<AssistantMessageEvent> {
  const legacyPlans = transcript.split('"name":"update_plan"').length - 1;
  const plans = transcript.split('"name":"create_plan"').length - 1;
  const revisions = transcript.split('"name":"revise_plan"').length - 1;
  const runs = transcript.split('"name":"run_build123d"').length - 1;
  if (lastMessage.includes("[Chamfer self-check]")) {
    yield* streamText("The spacer and both image-derived specifications are accounted for.");
    return;
  }
  if (lastMessage.includes("[Chamfer visual check]") || lastMessage.includes("[Visual verification batch ")) {
    const batch = [...transcript.matchAll(/Visual verification batch (\d+)\/(\d+); artifact=([^@;]+)@(\d+); sheet=([^;]+); imageLimit=(\d+); activeSet=.*?; batchReferences=([^;]+);/g)].at(-1);
    if (batch) {
      const coveredReferenceIds = batch[7]!.split(",");
      // Server idempotency keys are global, so the id must be unique per
      // conversation AND artifact revision (two specs share this script).
      yield* streamToolCall(`image-plan-visual-verification-${batch[3]}@${batch[4]}`, "record_visual_verification_batch", {
        artifactId: batch[3],
        artifactVersion: Number(batch[4]),
        inspectionSheetId: batch[5],
        imageLimit: Number(batch[6]),
        activeReferenceIds: referenceIdsIn(transcript).sort(),
        batchIndex: Number(batch[1]) - 1,
        batchCount: Number(batch[2]),
        coveredReferenceIds,
        observations: coveredReferenceIds.map((referenceId) => ({
          referenceId,
          relevantViews: ["isometric", "front", "back", "left", "right", "top", "bottom"],
          findings: [`Every inspection view matches the dimensioned spacer; request carried ${imageCount} images.`],
          affectedComponents: [],
        })),
        finalVerdict: "match",
        synthesis: "The current spacer matches all active reference evidence.",
      });
      return;
    }
  }
  if (!transcript.includes('"toolCallId":"image-plan-reference-specifications')) {
    const referenceId = referenceIdsIn(transcript)[0];
    yield* streamToolCall(`image-plan-reference-specifications-${referenceId}`, "record_reference_specifications", {
      specifications: [{
        id: "overall-size",
        requirement: "The spacer must be 10 mm wide, deep, and high.",
        attachmentId: referenceId,
        observation: "The drawing labels the overall width, depth, and height as 10 mm.",
        region: { x: 0.08, y: 0.08, width: 0.74, height: 0.7 },
      }, {
        id: "surface-finish",
        requirement: "The spacer must have the called-out matte surface finish.",
        attachmentId: referenceId,
        observation: "The drawing includes a matte surface finish note.",
        region: { x: 0.66, y: 0.76, width: 0.28, height: 0.12 },
      }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"image-plan-classify')) {
    yield* streamToolCall(`image-plan-classify-${referenceIdsIn(transcript)[0]}`, "classify_reference", {
      referenceId: referenceIdsIn(transcript)[0],
      status: "active",
      purpose: "Primary dimensioned spacer drawing",
      relationships: [],
      rationale: "The drawing establishes the spacer dimensions, form, and finish requirements.",
      specificationIds: ["overall-size", "surface-finish"],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"image-plan-register')) {
    yield* streamToolCall(`image-plan-register-${referenceIdsIn(transcript)[0]}`, "register_reference_view", {
      referenceId: referenceIdsIn(transcript)[0],
      sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
      projection: "orthographic",
      direction: "front",
      scaleAnchor: {
        specificationId: "overall-size",
        start: { x: 0.2734375, y: 0.859375 },
        end: { x: 0.7265625, y: 0.859375 },
        physicalLengthMm: 10,
      },
      visibleLandmarks: [{ id: "center-mark", label: "Visible center mark", position: { x: 0.5, y: 0.5 } }],
      uncertainty: { level: "low", notes: "The isolated front outline and dimension line are clear.", occluded: false },
    });
    return;
  }
  if (runs === 0) {
    yield* streamToolCall("image-plan-run-rejected", "run_build123d", { code: IMAGE_PLAN_SCRIPT });
    return;
  }
  if (legacyPlans === 0) {
    yield* streamToolCall("image-plan-invalid", "update_plan", IMAGE_PLAN_WITHOUT_SPEC);
    return;
  }
  if (plans === 0) {
    yield* streamToolCall("image-plan-valid", "create_plan", {
      mutation_id: "image-plan-create",
      reason: "Create the normalized plan from stable reference-source identities.",
      ...IMAGE_PLAN_WITHOUT_SPEC,
    });
    return;
  }
  if (runs === 1) {
    yield* streamToolCall("image-plan-run-valid", "run_build123d", { code: IMAGE_PLAN_SCRIPT });
    return;
  }
  if (revisions === 0 && !transcript.includes("Dominant-form review:")) {
    yield* streamText(
      "Dominant-form review: the spacer is prismatic, and the largest semantic mismatch is none; all seven silhouettes match the dimensioned cube before detail work.",
    );
    return;
  }
  if (revisions === 0) {
    yield* streamToolCall("image-plan-done", "revise_plan", {
      mutation_id: "image-plan-complete",
      reason: "Record the current visual review and completion evidence.",
      operations: [{
        kind: "record_form_review",
        component_id: "spacer",
        form_review: {
          evidence_id: "image-plan-run-valid",
          views: ["isometric", "front", "back", "left", "right", "top", "bottom"].map((view) => ({
            view,
            verdict: "match",
            note: `${view} view matches the dimensioned cube drawing.`,
          })),
        },
      }, { kind: "set_component_status", component_id: "spacer", status: "done" }],
    });
    return;
  }
  yield* streamText("Spacer complete: the image plan is built and verified.");
}

// Single-view shape-proof scenario triggered by "single-view-shape-proof-flow:".
// The first cube satisfies every scalar check but misses the registered chamfer.
// The independent evaluator must preserve it as diagnostic geometry, reject
// completion, and let a corrected revision pass against the unchanged target.
const SINGLE_VIEW_SHAPE_PLAN = {
  goal: "10 mm chamfered spacer from one registered front view",
  components: [{
    id: "spacer",
    description: "10 mm spacer with the registered top-right front chamfer",
    bbox_mm: [10, 10, 10],
    free_floating_reason: "The requested deliverable is one standalone part.",
    checks: IMAGE_PLAN_CHECKS,
  }],
  interfaces: [],
};

const CORRECTED_SINGLE_VIEW_SHAPE_CODE = [
  "from build123d import *",
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
  "profile = Plane.XZ * Polygon((-5, -5), (5, -5), (5, 3.276), (3.276, 5), (-5, 5))",
  "result = extrude(profile, amount=10)",
  'result.label = "spacer"',
].join("\n");

function* singleViewShapeProofStep(transcript: string, lastMessage: string, imageCount: number): Generator<AssistantMessageEvent> {
  const referenceId = referenceIdsIn(transcript)[0];
  if (lastMessage.includes("[Chamfer self-check]")) {
    yield* streamText("The corrected spacer passes the unchanged registered target and product threshold policy.");
    return;
  }
  if (lastMessage.includes("[Chamfer visual check]") || lastMessage.includes("[Visual verification batch ")) {
    const batch = [...transcript.matchAll(/Visual verification batch (\d+)\/(\d+); artifact=([^@;]+)@(\d+); sheet=([^;]+); imageLimit=(\d+); activeSet=.*?; batchReferences=([^;]+);/g)].at(-1);
    if (batch) {
      const coveredReferenceIds = batch[7]!.split(",");
      yield* streamToolCall(`single-view-shape-visual-${referenceId}`, "record_visual_verification_batch", {
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
          relevantViews: ["front", "isometric"],
          findings: [`The corrected chamfer matches the current inspection sheet; request carried ${imageCount} images.`],
          affectedComponents: [],
        })),
        finalVerdict: "match",
        synthesis: "The corrected current artifact matches the registered front-view evidence.",
      });
      return;
    }
  }
  if (!transcript.includes('"toolCallId":"single-view-shape-specifications-')) {
    yield* streamToolCall(`single-view-shape-specifications-${referenceId}`, "record_reference_specifications", {
      specifications: [{
        id: "single-view-overall-size",
        requirement: "The spacer front envelope must be 10 mm wide and 10 mm high.",
        attachmentId: referenceId,
        observation: "The registered dimension line establishes the 10 mm front width and scale.",
        region: { x: 0.24, y: 0.24, width: 0.52, height: 0.52 },
      }, {
        id: "single-view-chamfer",
        requirement: "The spacer must preserve the top-right chamfer shown in the front outline.",
        attachmentId: referenceId,
        observation: "The front silhouette has one diagonal top-right corner.",
        region: { x: 0.24, y: 0.24, width: 0.52, height: 0.52 },
      }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"single-view-shape-classify-')) {
    yield* streamToolCall(`single-view-shape-classify-${referenceId}`, "classify_reference", {
      referenceId,
      status: "active",
      purpose: "Primary dimensioned front orthographic view",
      relationships: [],
      rationale: "The view establishes physical scale and the required front silhouette.",
      specificationIds: ["single-view-overall-size", "single-view-chamfer"],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"single-view-shape-register-')) {
    yield* streamToolCall(`single-view-shape-register-${referenceId}`, "register_reference_view", {
      referenceId,
      sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
      projection: "orthographic",
      direction: "front",
      scaleAnchor: {
        specificationId: "single-view-overall-size",
        start: { x: 0.2734375, y: 0.859375 },
        end: { x: 0.7265625, y: 0.859375 },
        physicalLengthMm: 10,
      },
      visibleLandmarks: [],
      uncertainty: { level: "low", notes: "The isolated outline and dimension line are clear.", occluded: false },
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"single-view-shape-plan"')) {
    yield* streamToolCall("single-view-shape-plan", "create_plan", {
      mutation_id: "single-view-shape-plan",
      reason: "Create the proof-bound single-part plan from the registered drawing.",
      ...SINGLE_VIEW_SHAPE_PLAN,
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"single-view-shape-wrong"')) {
    yield* streamToolCall("single-view-shape-wrong", "run_build123d", { code: IMAGE_PLAN_SCRIPT });
    return;
  }
  if (!transcript.includes('"toolCallId":"single-view-shape-false-finish"')) {
    yield* streamToolCall("single-view-shape-false-finish", "revise_plan", {
      mutation_id: "single-view-shape-false-finish",
      reason: "Attempt completion from scalar checks before repairing the silhouette.",
      operations: [{
        kind: "record_form_review",
        component_id: "spacer",
        form_review: {
          evidence_id: "single-view-shape-wrong",
          views: ["isometric", "front", "back", "left", "right", "top", "bottom"].map((view) => ({
            view,
            verdict: "match",
            note: "Scalar dimensions appear correct.",
          })),
        },
      }, { kind: "set_component_status", component_id: "spacer", status: "done" }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"single-view-shape-corrected"')) {
    yield* streamToolCall("single-view-shape-corrected", "run_build123d", { code: CORRECTED_SINGLE_VIEW_SHAPE_CODE });
    return;
  }
  if (!transcript.includes('"toolCallId":"single-view-shape-complete"')) {
    yield* streamToolCall("single-view-shape-complete", "revise_plan", {
      mutation_id: "single-view-shape-complete",
      reason: "Complete the component from the corrected current shape-proof evidence.",
      operations: [{
        kind: "record_form_review",
        component_id: "spacer",
        form_review: {
          evidence_id: "single-view-shape-corrected",
          views: ["isometric", "front", "back", "left", "right", "top", "bottom"].map((view) => ({
            view,
            verdict: "match",
            note: "The corrected chamfer and all current views are coherent.",
          })),
        },
      }, { kind: "set_component_status", component_id: "spacer", status: "done" }],
    });
    return;
  }
  yield* streamText("The corrected spacer is complete with current independent shape proof.");
}

// Multi-view shape-proof scenario triggered by "multi-view-shape-proof-flow:".
// The first cube is correct from the front but hides a wrong right-side outline.
// The corrected YZ profile preserves the front while satisfying the right contour
// and its registered chamfer landmark.
const MULTI_VIEW_SHAPE_PLAN = {
  goal: "10 mm spacer constrained by registered front and right orthographic views",
  components: [{
    id: "spacer",
    description: "10 mm spacer with a square front and chamfered right-side profile",
    bbox_mm: [10, 10, 10],
    free_floating_reason: "The requested deliverable is one standalone part.",
    checks: IMAGE_PLAN_CHECKS,
  }],
  interfaces: [],
};

const CORRECTED_MULTI_VIEW_SHAPE_CODE = [
  "from build123d import *",
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
  "profile = Plane.YZ * Polygon((-5, -5), (5, -5), (5, 3.276), (3.276, 5), (-5, 5))",
  "result = extrude(profile, amount=10)",
  'result.label = "spacer"',
].join("\n");

function* multiViewShapeProofStep(transcript: string, lastMessage: string, imageCount: number): Generator<AssistantMessageEvent> {
  const referenceIds = referenceIdsIn(transcript);
  const frontReferenceId = referenceIds[0];
  const rightReferenceId = referenceIds[1];
  if (lastMessage.includes("[Chamfer self-check]")) {
    yield* streamText("The corrected spacer passes both unchanged registered views and the product threshold policy.");
    return;
  }
  if (lastMessage.includes("[Chamfer visual check]") || lastMessage.includes("[Visual verification batch ")) {
    const batch = [...transcript.matchAll(/Visual verification batch (\d+)\/(\d+); artifact=([^@;]+)@(\d+); sheet=([^;]+); imageLimit=(\d+); activeSet=.*?; batchReferences=([^;]+);/g)].at(-1);
    if (batch) {
      const coveredReferenceIds = batch[7]!.split(",");
      yield* streamToolCall(`multi-view-shape-visual-${batch[1]}`, "record_visual_verification_batch", {
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
          relevantViews: ["front", "right", "isometric"],
          findings: [`The corrected artifact matches this registered view; request carried ${imageCount} images.`],
          affectedComponents: [],
        })),
        ...(Number(batch[1]) === Number(batch[2]) ? {
          finalVerdict: "match",
          synthesis: "The corrected artifact matches the complete front and right reference set.",
        } : {}),
      });
      return;
    }
  }
  if (!transcript.includes('"toolCallId":"multi-view-shape-specifications"')) {
    yield* streamToolCall("multi-view-shape-specifications", "record_reference_specifications", {
      specifications: [{
        id: "multi-view-front-size",
        requirement: "The front envelope must be 10 mm wide and 10 mm high.",
        attachmentId: frontReferenceId,
        observation: "The front dimension line establishes the 10 mm width and physical scale.",
        region: { x: 0.24, y: 0.24, width: 0.52, height: 0.52 },
      }, {
        id: "multi-view-right-size",
        requirement: "The right envelope must be 10 mm deep and 10 mm high.",
        attachmentId: rightReferenceId,
        observation: "The right dimension line establishes the 10 mm depth and physical scale.",
        region: { x: 0.24, y: 0.24, width: 0.52, height: 0.52 },
      }, {
        id: "multi-view-right-chamfer",
        requirement: "The right-side top corner must preserve the registered chamfer.",
        attachmentId: rightReferenceId,
        observation: "The right outline and chamfer midpoint are visible.",
        region: { x: 0.24, y: 0.24, width: 0.52, height: 0.52 },
      }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"multi-view-shape-classify-front"')) {
    yield* streamToolCall("multi-view-shape-classify-front", "classify_reference", {
      referenceId: frontReferenceId,
      status: "active",
      purpose: "Primary dimensioned front orthographic view",
      relationships: [{ type: "complements", referenceId: rightReferenceId }],
      rationale: "The view establishes the front envelope and physical scale.",
      specificationIds: ["multi-view-front-size"],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"multi-view-shape-classify-right"')) {
    yield* streamToolCall("multi-view-shape-classify-right", "classify_reference", {
      referenceId: rightReferenceId,
      status: "complementary",
      purpose: "Complementary dimensioned right orthographic view",
      relationships: [{ type: "complements", referenceId: frontReferenceId }],
      rationale: "The side view reveals the chamfer hidden by the favorable front view.",
      specificationIds: ["multi-view-right-size", "multi-view-right-chamfer"],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"multi-view-shape-register-front"')) {
    yield* streamToolCall("multi-view-shape-register-front", "register_reference_view", {
      referenceId: frontReferenceId,
      sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
      projection: "orthographic",
      direction: "front",
      scaleAnchor: {
        specificationId: "multi-view-front-size",
        start: { x: 0.2734375, y: 0.859375 },
        end: { x: 0.7265625, y: 0.859375 },
        physicalLengthMm: 10,
      },
      visibleLandmarks: [],
      uncertainty: { level: "low", notes: "The isolated square front outline is clear.", occluded: false },
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"multi-view-shape-register-right"')) {
    yield* streamToolCall("multi-view-shape-register-right", "register_reference_view", {
      referenceId: rightReferenceId,
      sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
      projection: "orthographic",
      direction: "right",
      scaleAnchor: {
        specificationId: "multi-view-right-size",
        start: { x: 0.2734375, y: 0.859375 },
        end: { x: 0.7265625, y: 0.859375 },
        physicalLengthMm: 10,
      },
      visibleLandmarks: [{
        id: "right-chamfer-midpoint",
        label: "Right chamfer midpoint",
        position: { x: 0.6875, y: 0.3125 },
      }],
      uncertainty: { level: "low", notes: "The chamfer endpoints and midpoint are unambiguous.", occluded: false },
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"multi-view-shape-plan"')) {
    yield* streamToolCall("multi-view-shape-plan", "create_plan", {
      mutation_id: "multi-view-shape-plan",
      reason: "Create one proof-bound plan from both registered orthographic views.",
      ...MULTI_VIEW_SHAPE_PLAN,
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"multi-view-shape-wrong"')) {
    yield* streamToolCall("multi-view-shape-wrong", "run_build123d", { code: IMAGE_PLAN_SCRIPT });
    return;
  }
  if (!transcript.includes('"toolCallId":"multi-view-shape-false-finish"')) {
    yield* streamToolCall("multi-view-shape-false-finish", "revise_plan", {
      mutation_id: "multi-view-shape-false-finish",
      reason: "Attempt completion from the favorable front view before repairing the side.",
      operations: [{
        kind: "record_form_review",
        component_id: "spacer",
        form_review: {
          evidence_id: "multi-view-shape-wrong",
          views: ["isometric", "front", "back", "left", "right", "top", "bottom"].map((view) => ({
            view,
            verdict: "match",
            note: "The favorable front silhouette and scalar dimensions appear correct.",
          })),
        },
      }, { kind: "set_component_status", component_id: "spacer", status: "done" }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"multi-view-shape-corrected"')) {
    yield* streamToolCall("multi-view-shape-corrected", "run_build123d", { code: CORRECTED_MULTI_VIEW_SHAPE_CODE });
    return;
  }
  if (!transcript.includes('"toolCallId":"multi-view-shape-complete"')) {
    yield* streamToolCall("multi-view-shape-complete", "revise_plan", {
      mutation_id: "multi-view-shape-complete",
      reason: "Complete the component from refreshed all-view shape-proof evidence.",
      operations: [{
        kind: "record_form_review",
        component_id: "spacer",
        form_review: {
          evidence_id: "multi-view-shape-corrected",
          views: ["isometric", "front", "back", "left", "right", "top", "bottom"].map((view) => ({
            view,
            verdict: "match",
            note: "The corrected front and right profiles are coherent.",
          })),
        },
      }, { kind: "set_component_status", component_id: "spacer", status: "done" }],
    });
    return;
  }
  yield* streamText("The corrected spacer is complete with refreshed multi-view shape proof.");
}

// --- nonconforming-render persistence scenario (triggered by "nonconforming-render") ---
// The CAD script passes its own gate but omits one accepted plan check. The session
// therefore marks the rendered tool result as an error after execution.
const NONCONFORMING_RENDER_PLAN = {
  goal: "Preserve a synthetic diagnostic render",
  components: [{
    id: "diagnostic",
    description: "10 mm diagnostic cube",
    bbox_mm: [10, 10, 10],
    status: "building",
    free_floating_reason: "single component",
    checks: [
      { id: "envelope", kind: "bbox", size_mm: [10, 10, 10], target: "diagnostic" },
      { id: "volume", kind: "volume", range_mm3: [900, 1100], target: "diagnostic" },
    ],
  }],
  interfaces: [],
  spec_sheet: [{
    id: "overall-size",
    text: "The synthetic reference defines a 10 mm cube.",
    source: "image",
    check_refs: [{ component_id: "diagnostic", check_id: "envelope" }],
  }],
};

const NONCONFORMING_RENDER_SCRIPT = [
  "from build123d import *",
  "# --- params ---",
  "side = 10  # [1, 100] Side length in mm",
  "# --- end params ---",
  "# --- expect ---",
  'EXPECT = {"bodies": 1, "bbox_mm": [10, 10, 10]}',
  "# --- end expect ---",
  "# --- checks ---",
  "CHECKS = [",
  '    {"kind": "volume", "range_mm3": [900, 1100], "target": "diagnostic"},',
  "]",
  "# --- end checks ---",
  "# --- component ---",
  'COMPONENT = "diagnostic"',
  "# --- end component ---",
  "diagnostic = Box(side, side, side)",
  'diagnostic.label = "diagnostic"',
  "result = diagnostic",
].join("\n");

function* nonconformingRenderStep(transcript: string): Generator<AssistantMessageEvent> {
  const runs = transcript.split('"name":"run_build123d"').length - 1;
  const referenceId = referenceIdsIn(transcript)[0];
  if (!transcript.includes('"toolCallId":"nonconforming-render-specifications"')) {
    yield* streamToolCall("nonconforming-render-specifications", "record_reference_specifications", {
      specifications: [{
        id: "nonconforming-render-size",
        requirement: "The diagnostic cube must have a 10 mm envelope.",
        attachmentId: referenceId,
        observation: "The synthetic diagnostic reference establishes a 10 mm cube envelope.",
        region: { x: 0, y: 0, width: 1, height: 1 },
      }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"nonconforming-render-classify"')) {
    yield* streamToolCall("nonconforming-render-classify", "classify_reference", {
      referenceId,
      status: "active",
      purpose: "Synthetic diagnostic reference",
      relationships: [],
      rationale: "The reference establishes the diagnostic cube envelope.",
      specificationIds: ["nonconforming-render-size"],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"nonconforming-render-register"')) {
    yield* streamToolCall("nonconforming-render-register", "register_reference_view", {
      referenceId,
      sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
      projection: "orthographic",
      direction: "front",
      scaleAnchor: {
        specificationId: "nonconforming-render-size",
        start: { x: 0.2, y: 0.8 },
        end: { x: 0.8, y: 0.8 },
        physicalLengthMm: 10,
      },
      visibleLandmarks: [],
      uncertainty: { level: "low", notes: "The synthetic cube envelope is explicit.", occluded: false },
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"nonconforming-render-plan"')) {
    yield* streamToolCall("nonconforming-render-plan", "create_plan", {
      mutation_id: "nonconforming-render-plan",
      reason: "Create the diagnostic plan from the durable reference requirement.",
      goal: NONCONFORMING_RENDER_PLAN.goal,
      components: NONCONFORMING_RENDER_PLAN.components.map(({ status: _status, ...component }) => component),
      interfaces: NONCONFORMING_RENDER_PLAN.interfaces,
    });
    return;
  }
  if (runs === 0) {
    yield* streamToolCall("nonconforming-render-run", "run_build123d", { code: NONCONFORMING_RENDER_SCRIPT });
    return;
  }
  if (!transcript.includes('"toolCallId":"nonconforming-render-blocked"')) {
    yield* streamToolCall("nonconforming-render-blocked", "revise_plan", {
      mutation_id: "nonconforming-render-blocked",
      reason: "Preserve the rendered diagnostic while recording its plan-conformance failure.",
      operations: [{
        kind: "set_component_status",
        component_id: "diagnostic",
        status: "blocked",
        blocked_reason: "The synthetic run intentionally omitted the accepted envelope check.",
      }],
    });
    return;
  }
  yield* streamText("Diagnostic render preserved for plan repair.");
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

function* fusionInstalledApiStep(transcript: string): Generator<AssistantMessageEvent> {
  if (!transcript.includes('"toolCallId":"fusion-installed-api-docs"')) {
    yield* streamToolCall("fusion-installed-api-docs", "search_fusion_docs", {
      query: "setDistanceExtent",
      category: "member",
      namespace: "adsk.fusion",
      owner: "adsk.fusion.ExtrudeFeatureInput",
    });
    return;
  }
  yield* streamText("Installed Fusion 2704.1.23 guidance says ExtrudeFeatureInput.setDistanceExtent accepts an adsk.core.ValueInput. The document was not modified.");
}

/** Whether the LAST bound Fusion inspection in the transcript reported a
 * failed or unsupported check. Deferred verification keeps structurally sound
 * actions completed, so the scripted agent decides completion from the final
 * full-verification inspection, exactly like the real contract. The transcript
 * is a JSON encoding, so quotes inside the inspection text are escaped. */
function fusionFinalInspectionFailed(transcript: string): boolean {
  const start = transcript.lastIndexOf("# Bound Fusion inspection");
  if (start < 0) return false;
  const segment = transcript.slice(start);
  return segment.includes('\\"status\\":\\"failed\\"') || segment.includes('\\"status\\":\\"unsupported\\"');
}

const FUSION_ATOMIC_ACTION_PLAN = {
  goal: "Create one editable 20 mm parametric cube.",
  components: [{
    id: "cube",
    description: "One connected native parametric Fusion cube",
    bbox_mm: [20, 20, 20],
    status: "todo",
    free_floating_reason: "The requested deliverable is one standalone part.",
    checks: [
      { id: "volume", kind: "volume", range_mm3: [7200, 8800], target: "cube" },
      { id: "effect-1", kind: "fusion_effect", effect: { kind: "body-count", expected: 1 } },
      { id: "effect-2", kind: "fusion_effect", effect: { kind: "dimensions", expectedMm: [20, 20, 20], toleranceMm: 0.01 } },
      { id: "effect-3", kind: "fusion_effect", effect: { kind: "feature", featureType: "ExtrudeFeature", minCount: 1 } },
    ],
  }],
  interfaces: [],
};

function* fusionAtomicActionStep(transcript: string): Generator<AssistantMessageEvent> {
  // Detect durable public tool evidence rather than pi's provider-normalized
  // tool-call IDs, which are not stable across agent-core patch releases.
  if (!transcript.includes("# Bound Fusion inspection")) {
    yield* streamToolCall("fusion-atomic-inspect", "inspect_fusion", { checks: [] });
    return;
  }
  if (!transcript.includes("Plan accepted:")) {
    yield* streamToolCall("fusion-atomic-plan", "update_plan", FUSION_ATOMIC_ACTION_PLAN);
    return;
  }
  if (!transcript.includes('"name":"run_fusion_action"')) {
    const revision = [...transcript.matchAll(/Revision: ([a-f0-9]{64})/g)].at(-1)?.[1];
    if (!revision) { yield* streamText("Trusted Fusion inspection did not provide a usable revision."); return; }
    yield* streamToolCall("fusion-atomic-cube", "run_fusion_action", {
      document: { id: "fake-document-1", name: "Readiness Fixture", dataFileId: "fake-data-file-1" },
      expectedRevision: revision,
      intent: "Create one editable 20 mm parametric cube",
      strategy: "targeted",
      body: [
        "import adsk.core",
        "import adsk.fusion",
        "sketch = root.sketches.add(root.xYConstructionPlane)",
        "lines = sketch.sketchCurves.sketchLines",
        "lines.addTwoPointRectangle(adsk.core.Point3D.create(0, 0, 0), adsk.core.Point3D.create(2, 2, 0))",
        "distance = adsk.core.ValueInput.createByString('20 mm')",
        "feature = root.features.extrudeFeatures.addSimple(sketch.profiles.item(0), distance, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)",
        "register_entity(sketch, 'sketch:Base sketch@XY')",
        "register_entity(feature, 'feature:ExtrudeFeature:Cube extrusion')",
        "register_entity(feature.bodies.item(0), 'body:Cube')",
      ].join("\n"),
      affectedReferences: [{ id: "root-component", kind: "component" }],
      expectedEffects: [
        { kind: "body-count", expected: 1 },
        { kind: "dimensions", expectedMm: [20, 20, 20], toleranceMm: 0.01 },
        { kind: "feature", featureType: "ExtrudeFeature", minCount: 1 },
      ],
    });
    return;
  }
  if (transcript.includes("was undone. Authoritative revision restored")) {
    yield* streamText("Blocked after deterministic verification failure: automatic Undo restored the exact preceding Fusion revision, and no retry was attempted.");
    return;
  }
  if (transcript.includes("Automatic Undo failed") || transcript.includes("rollback-failure")) {
    yield* streamText("Blocked in hard recovery: automatic Undo failed, the authoritative revision is uncertain, and all mutation remains disabled.");
    return;
  }
  if (transcript.includes("timed out") || transcript.includes("disconnected")) {
    yield* streamText("Blocked after the connector interruption: trusted diagnosis is required and no mutation retry was attempted.");
    return;
  }
  if (transcript.includes('"isError":true')) {
    yield* streamText("Blocked after the connector integrity failure: no retry, unrelated evidence, or completion claim is permitted.");
    return;
  }
  // New completion contract: one final full-verification inspection covering
  // every plan fusion_effect check, then the done transition, then the summary.
  if (transcript.split("# Bound Fusion inspection").length - 1 < 2) {
    yield* streamToolCall("fusion-atomic-verify", "inspect_fusion", {
      checks: FUSION_ATOMIC_ACTION_PLAN.components[0]!.checks
        .filter((check) => check.kind === "fusion_effect")
        .map((check) => (check as { effect: object }).effect),
    });
    return;
  }
  if (fusionFinalInspectionFailed(transcript)) {
    yield* streamText("The cube did not complete: the final completion inspection reported failed checks; the revision is retained for targeted repair.");
    return;
  }
  if (!transcript.includes("(1 done)")) {
    yield* streamToolCall("fusion-atomic-done", "update_plan", {
      ...FUSION_ATOMIC_ACTION_PLAN,
      components: [{ ...FUSION_ATOMIC_ACTION_PLAN.components[0]!, status: "done" }],
    });
    return;
  }
  yield* streamText("The editable 20 mm Fusion cube passed independent structural, dimensional, and feature checks. It is available as exactly one native Undo step.");
}

const FUS_TEXT_001_PLAN = {
  goal: "Create the editable blue Aluminum 6061 CNC mounting plate described by FUS-TEXT-001.",
  components: [{
    id: "mounting-plate",
    description: "One connected native parametric Fusion mounting plate",
    bbox_mm: [120, 80, 12],
    status: "todo",
    free_floating_reason: "The requested deliverable is one standalone part.",
    checks: [
      { id: "volume", kind: "volume", range_mm3: [95_000, 112_000], target: "mounting-plate" },
      ...FUS_TEXT_001.expectedEffects.map((effect, index) => ({ id: `effect-${index + 1}`, kind: "fusion_effect", effect })),
    ],
  }],
  interfaces: [],
};
function* fusionText001Step(transcript: string): Generator<AssistantMessageEvent> {
  if (!transcript.includes("Plan accepted:")) {
    yield* streamToolCall("fus-text-001-plan", "update_plan", FUS_TEXT_001_PLAN);
    return;
  }
  // `transcript` is JSON, so quotes inside the skill XML are escaped.
  if (!transcript.includes('<skill name=\\"fusion-parametric-features\\"')) {
    yield* streamToolCall("fus-text-001-skill", "load_skill", { name: "fusion-parametric-features" });
    return;
  }
  if (!transcript.includes("# Bound Fusion inspection")) {
    yield* streamToolCall("fus-text-001-inspect", "inspect_fusion", { checks: [] });
    return;
  }
  if (!transcript.includes('"name":"run_fusion_action"')) {
    const revision = /Revision: ([a-f0-9]{64})/.exec(transcript)?.[1];
    if (!revision) { yield* streamText("Trusted Fusion inspection did not provide a usable revision."); return; }
    const document = transcript.includes("Document: Unsaved Fixture (fake-unsaved-document)")
      ? { id: "fake-unsaved-document", name: "Unsaved Fixture" }
      : { id: "fake-document-1", name: "Readiness Fixture", dataFileId: "fake-data-file-1" };
    yield* streamToolCall("fus-text-001-action", "run_fusion_action", {
      document,
      expectedRevision: revision,
      intent: "Create FUS-TEXT-001 as one editable blue Aluminum 6061 mounting plate",
      strategy: "targeted",
      body: FUS_TEXT_001_ACTION_BODY,
      affectedReferences: [],
      expectedEffects: FUS_TEXT_001.expectedEffects,
    });
    return;
  }
  if (!transcript.includes("Fusion action completed at revision")) {
    yield* streamText(transcript.includes("was undone. Authoritative revision restored")
      ? "FUS-TEXT-001 did not complete: structural verification failed and the action was undone."
      : "FUS-TEXT-001 did not complete: the Fusion action did not establish a completed revision.");
    return;
  }
  if (transcript.includes("camera was not restored")) {
    yield* streamText("FUS-TEXT-001 did not complete: the trusted Fusion camera was not restored, so revision-bound visual evidence cannot be captured while readiness is degraded.");
    return;
  }
  if (transcript.split("# Bound Fusion inspection").length - 1 < 2) {
    yield* streamToolCall("fus-text-001-verify", "inspect_fusion", { checks: FUS_TEXT_001.expectedEffects });
    return;
  }
  if (fusionFinalInspectionFailed(transcript)) {
    yield* streamText("FUS-TEXT-001 did not complete: the final completion inspection reported failed checks; the revision is retained for targeted repair.");
    return;
  }
  if (!transcript.includes("(1 done)")) {
    yield* streamToolCall("fus-text-001-done", "update_plan", {
      ...FUS_TEXT_001_PLAN,
      components: FUS_TEXT_001_PLAN.components.map((component) => ({ ...component, status: "done" })),
    });
    return;
  }
  yield* streamText("FUS-TEXT-001 is complete on one inspected Fusion revision: one connected parametric solid, exact editable dimensions, four native through holes, centered native pocket, native fillet and chamfer, Aluminum 6061 material, blue RGB 30/90/180 appearance, all seven views, and exactly one Undo entry.");
}

const FUS_TEXT_002_PLAN = {
  goal: "Create the datum-driven ductile-iron conveyor bearing housing described by FUS-TEXT-002.",
  components: [{
    id: "bearing-housing",
    description: "One connected native parametric Fusion bearing support housing",
    bbox_mm: [180, 110, 131],
    status: "todo",
    free_floating_reason: "The requested deliverable is one standalone industrial part.",
    checks: [
      { id: "volume", kind: "volume", range_mm3: [475_000, 525_000], target: "bearing-housing" },
      ...FUS_TEXT_002.expectedEffects.map((effect, index) => ({ id: `effect-${index + 1}`, kind: "fusion_effect", effect })),
    ],
  }],
  interfaces: [],
};
const FUS_TEXT_002_DONE_PLAN = {
  ...FUS_TEXT_002_PLAN,
  components: FUS_TEXT_002_PLAN.components.map((component) => ({ ...component, status: "done" })),
};

function* fusionText002Step(transcript: string, stage: number): Generator<AssistantMessageEvent> {
  if (stage === 0) {
    yield* streamToolCall("fus-text-002-plan", "update_plan", FUS_TEXT_002_PLAN);
    return;
  }
  if (stage === 1) {
    yield* streamToolCall("fus-text-002-skill", "load_skill", { name: "fusion-parametric-features" });
    return;
  }
  if (stage === 2) {
    yield* streamToolCall("fus-text-002-inspect", "inspect_fusion", { checks: [] });
    return;
  }
  if (stage === 3) {
    const revision = /Revision: ([a-f0-9]{64})/.exec(transcript)?.[1];
    if (!revision) { yield* streamText("Trusted Fusion inspection did not provide a usable revision."); return; }
    yield* streamToolCall("fus-text-002-action", "run_fusion_action", {
      document: { id: "fake-document-1", name: "Readiness Fixture", dataFileId: "fake-data-file-1" },
      expectedRevision: revision,
      intent: "Create FUS-TEXT-002 as one datum-driven ductile-iron industrial bearing housing",
      strategy: "targeted",
      body: FUS_TEXT_002_ACTION_BODY,
      affectedReferences: [],
      expectedEffects: FUS_TEXT_002.expectedEffects,
    });
    return;
  }
  const actionCompleted = transcript.includes("Fusion action completed at revision");
  const actionRolledBack = transcript.includes("was undone. Authoritative revision restored");
  if (stage === 4 && !actionCompleted) {
    yield* streamText(actionRolledBack
      ? "FUS-TEXT-002 did not complete: structural verification failed and the action was undone."
      : "FUS-TEXT-002 did not complete: the Fusion action did not establish a completed revision.");
    return;
  }
  if (stage === 4) {
    yield* streamToolCall("fus-text-002-verify", "inspect_fusion", { checks: FUS_TEXT_002.expectedEffects });
    return;
  }
  if (stage === 5 && fusionFinalInspectionFailed(transcript)) {
    yield* streamText("FUS-TEXT-002 did not complete: the final completion inspection reported failed checks; the revision is retained for targeted repair.");
    return;
  }
  if (stage === 5) {
    yield* streamToolCall("fus-text-002-done", "update_plan", FUS_TEXT_002_DONE_PLAN);
    return;
  }
  yield* streamText("FUS-TEXT-002 is complete on one inspected Fusion revision: named datum A/B/C intent, one connected crowned housing, precision bearing seat, one-sided recess, correctly directed counterbores, four connected gussets, native M6x1 grease access, native finishing features, ductile-iron material, machine-gray appearance, exterior and section evidence, and exactly one Undo entry.");
}

const FUS_IMAGE_001_PLAN = {
  goal: "Create the editable orange ABS right-angle bracket defined by the FUS-IMAGE-001 drawing.",
  components: [{
    id: "bracket", description: "One connected native parametric right-angle mounting bracket", bbox_mm: [100, 60, 68],
    status: "todo", free_floating_reason: "The requested deliverable is one standalone mounting bracket.",
    checks: [
      ...FUS_IMAGE_001.expectedEffects.map((effect, index) => ({ id: `effect-${index + 1}`, kind: "fusion_effect", effect })),
      { id: "volume", kind: "volume", range_mm3: [75_000, 100_000], target: "bracket" },
    ],
  }],
  interfaces: [],
  spec_sheet: [
    ["front-width", "Front and top views specify 100 mm full width.", [1, 2]],
    ["total-height", "Front and right views specify 68 mm total height.", [1]],
    ["upright-height", "Upright rises 60 mm above the base top.", [6]],
    ["base-depth", "Top and right views specify 60 mm base depth.", [3]],
    ["base-thickness", "Front view specifies an 8 mm base.", [4]],
    ["upright-thickness", "Right view specifies an 8 mm upright.", [7]],
    ["base-holes", "Top view specifies two 7 mm through holes at X 20 and 80, Y 20.", [8, 12]],
    ["upright-holes", "Front view specifies two 10 mm through holes at X 25 and 75, 35 mm above the base top.", [9, 13]],
    ["inside-fillet", "Right view specifies an inside junction fillet R6.", [10, 17]],
    ["outside-chamfer", "Right view specifies exposed outside chamfers C1.5.", [11, 18]],
    ["material", "Drawing specifies ABS plastic engineering material.", [19]],
    ["appearance", "Drawing specifies orange appearance RGB 240, 100, 20.", [20]],
  ].map(([id, text, indexes]) => ({ id, text, source: "image", check_refs: (indexes as number[]).map((index) => ({ component_id: "bracket", check_id: `effect-${index + 1}` })) })),
};

function* fusionImage001Step(transcript: string, imageCount: number): Generator<AssistantMessageEvent> {
  const referenceId = referenceIdsIn(transcript)[0];
  if (!transcript.includes('"toolCallId":"fus-image-001-classify"')) {
    if (!referenceId) { yield* streamText("FUS-IMAGE-001 requires the attached reference drawing."); return; }
    yield* streamToolCall("fus-image-001-classify", "classify_reference", {
      referenceId, status: "active", purpose: "Authoritative dimensioned front, top, and right-side bracket drawing",
      relationships: [], rationale: "The drawing supplies complementary orthographic views and readable manufacturing dimensions.",
      specificationIds: [
        "front-width", "total-height", "upright-height", "base-depth", "base-thickness", "upright-thickness",
        "base-holes", "upright-holes", "inside-fillet", "outside-chamfer", "material", "appearance",
      ].map((row) => `plan.spec_sheet.${row}`),
    });
    return;
  }
  if (!transcript.includes("Plan accepted:")) {
    yield* streamToolCall("fus-image-001-plan", "update_plan", FUS_IMAGE_001_PLAN);
    return;
  }
  if (!transcript.includes('"toolCallId":"fus-image-001-skill"')) {
    yield* streamToolCall("fus-image-001-skill", "load_skill", { name: "fusion-parametric-features" });
    return;
  }
  if (!transcript.includes('"toolCallId":"fus-image-001-inspect"')) {
    yield* streamToolCall("fus-image-001-inspect", "inspect_fusion", { checks: [] });
    return;
  }
  if (!transcript.includes('"toolCallId":"fus-image-001-action"')) {
    const revision = /Revision: ([a-f0-9]{64})/.exec(transcript)?.[1];
    if (!revision) { yield* streamText("Trusted Fusion inspection did not provide a usable revision."); return; }
    yield* streamToolCall("fus-image-001-action", "run_fusion_action", {
      document: { id: "fake-document-1", name: "Readiness Fixture", dataFileId: "fake-data-file-1" }, expectedRevision: revision,
      intent: "Create FUS-IMAGE-001 as one editable orange ABS right-angle bracket", strategy: "targeted",
      body: FUS_IMAGE_001_ACTION_BODY,
      affectedReferences: [{ id: "root-component", kind: "component" }],
      expectedEffects: FUS_IMAGE_001.expectedEffects,
    });
    return;
  }
  if (!transcript.includes("Fusion action completed at revision")) {
    yield* streamText("FUS-IMAGE-001 did not complete: typed geometry, feature, material, appearance, or evidence checks rejected the result.");
    return;
  }
  if ((transcript.includes('"toolCallId":"fus-image-001-visual"') && transcript.includes('"isError":true'))
    || transcript.includes("verification must target latest artifact") || transcript.includes("does not belong to this conversation")) {
    yield* streamText("FUS-IMAGE-001 did not complete: the current Fusion revision invalidated the earlier inspection sheet before visual finalization.");
    return;
  }
  const batchMatches = [...transcript.matchAll(/Visual verification batch (\d+)\/(\d+); artifact=([^@;]+)@(\d+); sheet=([^;]+); imageLimit=(\d+); activeSet=.*?; batchReferences=([^;]+);/g)];
  const batch = batchMatches.at(-1);
  const visualComplete = transcript.includes('"finalVerification"') || transcript.includes("Final verdict: match");
  if (batch && !visualComplete) {
    const coveredReferenceIds = batch[7]!.split(",");
    yield* streamToolCall("fus-image-001-visual", "record_visual_verification_batch", {
      artifactId: batch[3], artifactVersion: Number(batch[4]), inspectionSheetId: batch[5], imageLimit: Number(batch[6]),
      activeReferenceIds: referenceIdsIn(transcript).sort(), batchIndex: Number(batch[1]) - 1, batchCount: Number(batch[2]), coveredReferenceIds,
      observations: coveredReferenceIds.map((id) => ({ referenceId: id, relevantViews: ["front", "top", "right", "isometric"],
        findings: [`Front, top, right-side, silhouette, hole placement, upright orientation, and proportions match across ${imageCount} supplied images.`], affectedComponents: [] })),
      finalVerdict: "match", synthesis: "The current Fusion inspection sheet matches every readable drawing view with no unexplained silhouette, orientation, feature-placement, or proportion mismatch.",
    });
    return;
  }
  if (visualComplete) {
    if (transcript.split("# Bound Fusion inspection").length - 1 < 2) {
      yield* streamToolCall("fus-image-001-verify", "inspect_fusion", { checks: FUS_IMAGE_001.expectedEffects });
      return;
    }
    if (fusionFinalInspectionFailed(transcript)) {
      yield* streamText("FUS-IMAGE-001 did not complete: the final completion inspection reported failed checks; the revision is retained for targeted repair.");
      return;
    }
    if (!transcript.includes("(1 done)")) {
      yield* streamToolCall("fus-image-001-done", "update_plan", {
        ...FUS_IMAGE_001_PLAN,
        components: FUS_IMAGE_001_PLAN.components.map((component) => ({
          ...component,
          status: "done",
          form_review: {
            evidence_id: "current",
            views: ["isometric", "front", "back", "left", "right", "top", "bottom"].map((view) => ({
              view, verdict: "match",
              note: `The ${view} inspection view matches the drawing's silhouette, hole placement, upright orientation, and proportions.`,
            })),
          },
        })),
      });
      return;
    }
    yield* streamText("FUS-IMAGE-001 is complete on one visually verified Fusion revision: one connected orange ABS bracket, exact editable dimensions and datum-relative holes, correct upright orientation, native inside fillet and outside chamfers, and exactly one Undo entry.");
    return;
  }
  yield* streamText("FUS-IMAGE-001 passed typed Fusion inspection; attempting to finish before visual comparison with the active drawing.");
}

const FUSION_SECURITY_POLICY_PLAN = {
  goal: "Attempt a one-time confirmed filesystem policy override",
  components: [{
    id: "hostile",
    description: "Adversarial Fusion action attempting a policy escape",
    bbox_mm: [1, 1, 1],
    status: "todo",
    free_floating_reason: "Adversarial policy-boundary fixture.",
    checks: [
      { id: "volume", kind: "volume", range_mm3: [0.9, 1.1], target: "hostile" },
      { id: "effect-1", kind: "fusion_effect", effect: { kind: "body-count", expected: 1 } },
    ],
  }],
  interfaces: [],
};

function* fusionSecurityPolicyStep(transcript: string): Generator<AssistantMessageEvent> {
  if (!transcript.includes('"toolCallId":"fusion-security-inspect"')) {
    yield* streamToolCall("fusion-security-inspect", "inspect_fusion", { checks: [] });
    return;
  }
  if (!transcript.includes('"toolCallId":"fusion-security-plan"')) {
    yield* streamToolCall("fusion-security-plan", "update_plan", FUSION_SECURITY_POLICY_PLAN);
    return;
  }
  if (!transcript.includes('"toolCallId":"fusion-security-hostile"')) {
    const revision = /Revision: ([a-f0-9]{64})/.exec(transcript)?.[1];
    if (!revision) { yield* streamText("Trusted Fusion inspection did not provide a usable revision."); return; }
    yield* streamToolCall("fusion-security-hostile", "run_fusion_action", {
      document: { id: "fake-document-1", name: "Readiness Fixture", dataFileId: "fake-data-file-1" },
      expectedRevision: revision,
      intent: "Attempt a one-time confirmed filesystem policy override",
      strategy: "targeted",
      body: "open('/tmp/chamfer-policy-escape').write('unsafe')",
      affectedReferences: [],
      expectedEffects: [{ kind: "body-count", expected: 1 }],
    });
    return;
  }
  yield* streamText("The fixed Fusion policy denied filesystem access before mutation. Conversation text and one-time confirmation cannot expand it.");
}

const FUSION_MANUAL_RECONCILIATION_PLAN = {
  goal: "Target the reconciled width parameter at 35 mm while preserving the existing feature history and finish",
  components: [{
    id: "cube",
    description: "One connected native parametric Fusion cube, reconciled after a manual width edit",
    bbox_mm: [35, 20, 20],
    status: "todo",
    free_floating_reason: "The requested deliverable is one standalone part.",
    checks: [
      { id: "volume", kind: "volume", range_mm3: [12600, 15400], target: "cube",
        revision_reason: "The user requested a 35 mm width after the original 20 mm cube plan." },
      { id: "effect-1", kind: "fusion_effect", effect: { kind: "body-count", expected: 1 } },
      { id: "effect-2", kind: "fusion_effect", effect: { kind: "dimensions", expectedMm: [35, 20, 20], toleranceMm: 0.01 },
        revision_reason: "The user requested a 35 mm width after the original 20 mm cube plan." },
      { id: "effect-3", kind: "fusion_effect", effect: { kind: "feature", featureType: "ExtrudeFeature", minCount: 1 } },
      { id: "effect-4", kind: "fusion_effect", effect: { kind: "material", expected: "Aluminum 6061" } },
    ],
  }],
  interfaces: [],
};

function* fusionManualReconciliationStep(transcript: string): Generator<AssistantMessageEvent> {
  const marker = transcript.lastIndexOf("fusion-manual-reconciliation");
  const reconciliationMarker = transcript.lastIndexOf("[Chamfer Fusion reconciliation]");
  const userTurn = transcript.slice(Math.max(0, marker));
  const currentTurn = transcript.slice(Math.max(0, marker, reconciliationMarker));
  if (!currentTurn.includes("# Bound Fusion inspection")) {
    yield* streamToolCall(reconciliationMarker > marker ? "fusion-manual-reinspect" : "fusion-manual-inspect", "inspect_fusion", { checks: [{ kind: "body-count", expected: 1 }] });
    return;
  }
  if (!userTurn.includes("Plan accepted:")) {
    yield* streamToolCall("fusion-manual-plan", "update_plan", FUSION_MANUAL_RECONCILIATION_PLAN);
    return;
  }
  if (!currentTurn.includes("Fusion action completed at revision")) {
    const revision = [...currentTurn.matchAll(/Revision: ([a-f0-9]{64})/g)].at(-1)?.[1];
    if (!revision) { yield* streamText("Trusted reconciled Fusion inspection did not provide a usable revision."); return; }
    yield* streamToolCall("fusion-manual-targeted", "run_fusion_action", {
      document: { id: "fake-document-1", name: "Readiness Fixture", dataFileId: "fake-data-file-1" },
      expectedRevision: revision,
      intent: "Target the reconciled width parameter at 35 mm while preserving the existing feature history and finish",
      strategy: "targeted",
      body: [
        `parameter = references['chamfer:11111111-1111-4111-8111-111111111111']`,
        "parameter.expression = '35 mm'",
      ].join("\n"),
      affectedReferences: [{ id: "chamfer:11111111-1111-4111-8111-111111111111", kind: "parameter" }],
      expectedEffects: [
        { kind: "body-count", expected: 1 },
        { kind: "dimensions", expectedMm: [35, 20, 20], toleranceMm: 0.01 },
        { kind: "feature", featureType: "ExtrudeFeature", minCount: 1 },
        { kind: "material", expected: "Aluminum 6061" },
      ],
    });
    return;
  }
  if (currentTurn.split("# Bound Fusion inspection").length - 1 < 2) {
    yield* streamToolCall("fusion-manual-verify", "inspect_fusion", {
      checks: FUSION_MANUAL_RECONCILIATION_PLAN.components[0]!.checks
        .filter((check) => check.kind === "fusion_effect")
        .map((check) => (check as { effect: object }).effect),
    });
    return;
  }
  if (!userTurn.includes("(1 done)")) {
    yield* streamToolCall("fusion-manual-done", "update_plan", {
      ...FUSION_MANUAL_RECONCILIATION_PLAN,
      components: FUSION_MANUAL_RECONCILIATION_PLAN.components.map((component) => ({ ...component, status: "done" })),
    });
    return;
  }
  yield* streamText("The manual width edit was reconciled, the targeted 35 mm follow-up passed, and unaffected feature history, names, material, appearance, and manual intent were preserved.");
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
  if (!transcript.includes('"toolCallId":"reference-primary-specifications"')) {
    yield* streamToolCall("reference-primary-specifications", "record_reference_specifications", {
      specifications: [{
        id: "primary-dimensions",
        requirement: "The part must preserve the primary drawing dimensions.",
        attachmentId: ids[0],
        observation: "The primary drawing contains the overall dimension callouts.",
        region: { x: 0.06, y: 0.08, width: 0.88, height: 0.7 },
      }, {
        id: "front-orientation-v1",
        requirement: "The part front must follow the original orientation view.",
        attachmentId: ids[0],
        observation: "The original front orientation is shown in the central mark.",
        region: { x: 0.22, y: 0.18, width: 0.56, height: 0.56 },
      }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"reference-active"')) {
    yield* streamToolCall("reference-active", "classify_reference", {
      referenceId: ids[0],
      status: "active",
      purpose: "Primary dimensioned drawing",
      relationships: [],
      rationale: "This drawing establishes the primary dimensions and form.",
      specificationIds: ["primary-dimensions", "front-orientation-v1"],
    });
    return;
  }
  const activeId = referenceIdForCall(transcript, "reference-active") ?? ids[0];
  if (!transcript.includes('"toolCallId":"reference-corrected-specification"')) {
    const correctedId = ids.find((id) => id !== activeId);
    yield* streamToolCall("reference-corrected-specification", "record_reference_specifications", {
      specifications: [{
        id: "front-orientation-v2",
        requirement: "The part front must follow the corrected orientation view.",
        attachmentId: correctedId,
        observation: "The corrected attachment shows the authoritative front orientation.",
        region: { x: 0.08, y: 0.1, width: 0.84, height: 0.64 },
        supersedesSpecificationId: "front-orientation-v1",
      }],
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"reference-complementary"')) {
    const complementaryId = ids.find((id) => id !== activeId);
    yield* streamToolCall("reference-complementary", "classify_reference", {
      referenceId: complementaryId,
      status: "complementary",
      purpose: "Corrected front view",
      relationships: [{ type: "complements", referenceId: activeId }],
      rationale: "This view adds front-orientation evidence absent from the primary drawing.",
      specificationIds: ["front-orientation-v2"],
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
      specificationIds: ["primary-dimensions", "front-orientation-v2"],
    });
    return;
  }
  yield* streamText("Reference classifications recorded: the corrected view complements the dimensions and supersedes the original orientation.");
}

function* advisoryReferenceRegistrationStep(transcript: string): Generator<AssistantMessageEvent> {
  const referenceId = referenceIdsIn(transcript)[0];
  if (!transcript.includes('"toolCallId":"advisory-classify"')) {
    yield* streamToolCall("advisory-classify", "classify_reference", {
      referenceId,
      status: "active",
      purpose: "Uncalibrated perspective appearance reference",
      relationships: [],
      rationale: "The photograph can guide appearance but does not establish orthographic scale.",
      specificationIds: [],
      noSpecificationReason: "The photograph has no reliable dimension or physical scale anchor.",
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"advisory-register"')) {
    yield* streamToolCall("advisory-register", "register_reference_view", {
      referenceId,
      sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
      projection: "perspective",
      visibleLandmarks: [{ id: "logo", label: "Visible logo", position: { x: 0.5, y: 0.5 } }],
      uncertainty: { level: "medium", notes: "Perspective distortion is visible and no physical dimension is present.", occluded: false },
    });
    return;
  }
  yield* streamText("The photograph is registered as advisory evidence with explicit projection and scale reasons.");
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
      specificationIds: [],
      noSpecificationReason: "This image is retained as qualitative profile evidence without a reliable dimension or scale anchor.",
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
      specificationIds: [],
      noSpecificationReason: "This image provides qualitative body-form guidance but no extractable dimension or calibrated source observation.",
    });
    return;
  }
  if (!transcript.includes('"toolCallId":"visual-register"')) {
    yield* streamToolCall("visual-register", "register_reference_view", {
      referenceId,
      sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
      projection: "perspective",
      visibleLandmarks: [{ id: "brand-mark", label: "Visible brand mark", position: { x: 0.5, y: 0.5 } }],
      uncertainty: {
        level: "medium",
        notes: "This qualitative form reference has no physical scale and is registered as advisory evidence.",
        occluded: false,
      },
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
  if (batch && records < runs && lastMessage.includes(`Visual verification batch ${batch[1]}/${batch[2]}`)) {
    const verdict = runs === 1 ? "needs-revision" : "match";
    const coveredReferenceIds = batch[7]!.split(",");
    yield* streamToolCall(`visual-batch-${batch[3]}-${runs}`, "record_visual_verification_batch", {
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

function* batchedVisualVerificationStep(
  transcript: string,
  lastMessage: string,
  imageCount: number,
  callIdPrefix = "visual-batch",
): Generator<AssistantMessageEvent> {
  const batchMatches = [...transcript.matchAll(/Visual verification batch (\d+)\/(\d+); artifact=([^@;]+)@(\d+); sheet=([^;]+); imageLimit=(\d+); activeSet=.*?; batchReferences=([^;]+);/g)];
  const batchText = batchMatches.at(-1);
  if (batchText) {
    const batchIndex = Number(batchText[1]) - 1;
    const batchCount = Number(batchText[2]);
    const coveredReferenceIds = batchText[7]!.split(",");
    const activeReferenceIds = referenceIdsIn(transcript).sort();
    const final = batchIndex === batchCount - 1;
    const callId = callIdPrefix === "visual-batch"
      ? `${callIdPrefix}-${batchText[3]}-${batchIndex + 1}`
      : `${callIdPrefix}-${batchIndex + 1}`;
    yield* streamToolCall(callId, "record_visual_verification_batch", {
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
    yield* streamToolCall(`workflow-batch-${batch[3]}-${artifactVersion}-${batchIndex}`, "record_visual_verification_batch", {
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
  const registrations = [
    ["workflow-register-primary", "workflow-ref-primary"],
    ["workflow-register-detail", "workflow-ref-detail"],
    ["workflow-register-profile", "workflow-ref-profile"],
  ] as const;
  for (const [callId, referenceId] of registrations) {
    if (!transcript.includes(`"toolCallId":"${callId}"`)) {
      yield* streamToolCall(callId, "register_reference_view", {
        referenceId,
        sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
        projection: "perspective",
        visibleLandmarks: [{ id: "center", label: "Visible reference center", position: { x: 0.5, y: 0.5 } }],
        uncertainty: {
          level: "medium",
          notes: "Qualitative workflow reference without a physical scale.",
          occluded: false,
        },
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

function evaluationScript(transcript: string): string | undefined {
  const lines = (body: string[], bbox: [number, number, number], checks: string[] = []) => [
    "from build123d import *",
    "# --- expect ---",
    `EXPECT = {"bodies": 1, "bbox_mm": [${bbox.join(", ")}]}`,
    "# --- end expect ---",
    ...(checks.length > 0 ? ["# --- checks ---", "CHECKS = [", ...checks.map((check) => `    ${check},`), "]", "# --- end checks ---"] : []),
    ...body,
  ].join("\n");

  if (transcript.includes("four 6 mm through holes") && transcript.includes("60 by 40 by 6 mm")) {
    return lines([
      "plate = Box(60, 40, 6)",
      "for x in (-22, 22):",
      "    for y in (-12, 12):",
      "        plate = plate - (Pos(x, y, 0) * Cylinder(3, 6))",
      "result = plate",
    ], [60, 40, 6], ['{"kind":"hole_through","diameter":6,"count":4}']);
  }
  if (transcript.includes("pipe flange") || transcript.includes("90 mm diameter flange")) {
    const bore = transcript.includes("Increase only the center bore to 46 mm") ? 46
      : transcript.includes("40 mm center bore") ? 40 : 44;
    return lines([
      "flange = Cylinder(45, 12) - Cylinder(" + (bore / 2) + ", 12)",
      "for angle in (0, 60, 120, 180, 240, 300):",
      "    flange = flange - (Rot(0, 0, angle) * Pos(35, 0, 0) * Cylinder(4, 12))",
      "result = flange",
    ], [90, 90, 12], [
      `{"kind":"hole_through","diameter":${bore},"count":1}`,
      '{"kind":"hole_through","diameter":8,"count":6}',
    ]);
  }
  if (transcript.includes("hollow adapter from a 40 mm")) {
    return lines([
      "outer = Box(50, 30, 50)",
      "inner = Box(44, 24, 50)",
      "result = outer - inner",
    ], [50, 30, 50], ['{"kind":"wall_thickness","range_mm":[2.5,3.5]}']);
  }
  if (transcript.includes("rectangular plate 30 mm wide") || transcript.includes("Change only the width to 45 mm")) {
    const width = transcript.includes("Change only the width to 45 mm") ? 45 : 30;
    return lines([`result = Box(${width}, 20, 5)`], [width, 20, 5]);
  }
  return undefined;
}

interface CorpusImageFixture {
  componentId: string;
  bbox: [number, number, number];
  checks: Array<Record<string, unknown> & { id: string }>;
  specRows: number;
  code: string;
}

function corpusImageFixture(transcript: string): CorpusImageFixture | undefined {
  if (transcript.includes("flat profile shown in this synthetic reference")) {
    const checks = [
      { id: "volume", kind: "volume", range_mm3: [3_400, 3_800], target: "profile" },
    ];
    return {
      componentId: "profile",
      bbox: [40, 18, 5],
      checks,
      specRows: 1,
      code: [
        "from build123d import *",
        '# --- expect ---\nEXPECT = {"bodies": 1, "bbox_mm": [40, 18, 5]}\n# --- end expect ---',
        '# --- checks ---\nCHECKS = [{"kind":"volume","range_mm3":[3400,3800],"target":"profile"}]\n# --- end checks ---',
        '# --- component ---\nCOMPONENT = "profile"\n# --- end component ---',
        "profile = Box(40, 18, 5)",
        'profile.label = "profile"',
        "result = profile",
      ].join("\n"),
    };
  }
  if (transcript.includes("dimensioned mounting bracket shown")) {
    const checks = [
      { id: "holes", kind: "hole_through", diameter: 6, count: 4, target: "bracket" },
      { id: "volume", kind: "volume", range_mm3: [15_000, 19_000], target: "bracket" },
    ];
    return {
      componentId: "bracket",
      bbox: [60, 40, 8],
      checks,
      specRows: 3,
      code: [
        "from build123d import *",
        '# --- expect ---\nEXPECT = {"bodies": 1, "bbox_mm": [60, 40, 8]}\n# --- end expect ---',
        '# --- checks ---\nCHECKS = [{"kind":"hole_through","diameter":6,"count":4,"target":"bracket"},{"kind":"volume","range_mm3":[15000,19000],"target":"bracket"}]\n# --- end checks ---',
        '# --- component ---\nCOMPONENT = "bracket"\n# --- end component ---',
        "bracket = Box(60, 40, 8)",
        "for x in (-22, 22):",
        "    for y in (-12, 12):",
        "        bracket = bracket - (Pos(x, y, 0) * Cylinder(3, 8))",
        'bracket.label = "bracket"',
        "result = bracket",
      ].join("\n"),
    };
  }
  if (transcript.includes("open-back housing from these complementary synthetic views")) {
    const checks = [
      { id: "volume", kind: "volume", range_mm3: [22_000, 28_000], target: "housing" },
    ];
    return {
      componentId: "housing",
      bbox: [64, 44, 30],
      checks,
      specRows: 4,
      code: [
        "from build123d import *",
        '# --- expect ---\nEXPECT = {"bodies": 1, "bbox_mm": [64, 44, 30]}\n# --- end expect ---',
        '# --- checks ---\nCHECKS = [{"kind":"volume","range_mm3":[22000,28000],"target":"housing"}]\n# --- end checks ---',
        '# --- component ---\nCOMPONENT = "housing"\n# --- end component ---',
        "housing = Box(64, 44, 30) - (Pos(0, 0, 3) * Box(58, 38, 30))",
        'housing.label = "housing"',
        "result = housing",
      ].join("\n"),
    };
  }
  return undefined;
}

function* corpusImageCaseStep(
  transcript: string,
  lastMessage: string,
  imageCount: number,
  fixture: CorpusImageFixture,
): Generator<AssistantMessageEvent> {
  const callIdPrefix = `corpus-image-${fixture.componentId}`;
  const planCallId = `${callIdPrefix}-plan`;
  const runCallId = `${callIdPrefix}-run`;
  const doneCallId = `${callIdPrefix}-done`;
  const references = referenceIdsIn(transcript);
  const classified = activeReferenceIdsIn(transcript);
  const specificationIds = Array.from(
    { length: fixture.specRows },
    (_, index) => `reference-spec-${index + 1}`,
  );
  if (!transcript.includes(`"toolCallId":"${planCallId}"`) &&
      !transcript.includes(`"toolCallId":"${callIdPrefix}-specifications"`)) {
    yield* streamToolCall(`${callIdPrefix}-specifications`, "record_reference_specifications", {
      specifications: specificationIds.map((id, index) => ({
        id,
        requirement: `Synthetic reference requirement ${index + 1} for the ${fixture.componentId}.`,
        attachmentId: references[index % references.length],
        observation: `Synthetic reference evidence for requirement ${index + 1}.`,
        region: { x: 0, y: 0, width: 1, height: 1 },
      })),
    });
    return;
  }
  for (const [index, referenceId] of references.entries()) {
    const classificationRecorded = classified.includes(referenceId) ||
      transcript.includes(`Reference ${referenceId} classified as active`) ||
      transcript.includes(`Reference ${referenceId} classified as complementary`);
    if (!classificationRecorded) {
      const attempts = transcript.split('"name":"classify_reference"').length - 1;
      yield* streamToolCall(`corpus-image-${fixture.componentId}-classify-${index + 1}-${attempts + 1}`, "classify_reference", {
        referenceId,
        status: index === 0 ? "active" : "complementary",
        purpose: index === 0 ? "Primary synthetic form reference" : "Complementary synthetic reference view",
        relationships: index === 0 ? [] : [{ type: "complements", referenceId: references[0] }],
        rationale: "The image defines visible form or dimensions for this evaluation case.",
        specificationIds: specificationIds.filter((_, specIndex) => specIndex % references.length === index),
      });
      return;
    }
  }
  if (!transcript.includes(`"toolCallId":"${planCallId}"`)) {
    for (const [index, referenceId] of references.entries()) {
      const registrationCallId = `${callIdPrefix}-register-${index + 1}`;
      if (transcript.includes(`"toolCallId":"${registrationCallId}"`)) continue;
      const linkedSpecificationId = specificationIds.find((_, specIndex) => specIndex % references.length === index)
        ?? specificationIds[0];
      yield* streamToolCall(registrationCallId, "register_reference_view", {
        referenceId,
        sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
        projection: "orthographic",
        direction: index === 0 ? "front" : "right",
        scaleAnchor: {
          specificationId: linkedSpecificationId,
          start: { x: 0.2, y: 0.85 },
          end: { x: 0.8, y: 0.85 },
          physicalLengthMm: fixture.bbox[Math.min(index, fixture.bbox.length - 1)],
        },
        visibleLandmarks: [],
        uncertainty: { level: "low", notes: "The synthetic reference scale is explicit.", occluded: false },
      });
      return;
    }
  }
  if (!transcript.includes(`"toolCallId":"${planCallId}"`)) {
    yield* streamToolCall(planCallId, "create_plan", {
      mutation_id: planCallId,
      reason: "Create the evaluation plan from durable synthetic reference specifications.",
      goal: `Build the ${fixture.componentId} from the active synthetic references.`,
      components: [{
        id: fixture.componentId,
        description: `Reference-derived ${fixture.componentId}`,
        bbox_mm: fixture.bbox,
        checks: fixture.checks,
        free_floating_reason: "This evaluation case contains one independent component.",
      }],
      interfaces: [],
    });
    return;
  }
  if (!transcript.includes(`"toolCallId":"${runCallId}"`)) {
    yield* streamToolCall(runCallId, "run_build123d", { code: fixture.code });
    return;
  }
  if (!transcript.includes("Dominant-form review:")) {
    yield* streamText("Dominant-form review: the current part is prismatic, all seven current silhouettes match the active synthetic references, and no form revision is required.");
    return;
  }
  if (!transcript.includes(`"toolCallId":"${doneCallId}"`)) {
    yield* streamToolCall(doneCallId, "revise_plan", {
      mutation_id: doneCallId,
      reason: "Bind the current all-view review and complete the evaluated component.",
      operations: [{
        kind: "record_form_review",
        component_id: fixture.componentId,
        form_review: {
          evidence_id: runCallId,
          views: ["isometric", "front", "back", "left", "right", "top", "bottom"].map((view) => ({
            view,
            verdict: "match",
            note: `${view} view matches the active synthetic references.`,
          })),
        },
      }, { kind: "set_component_status", component_id: fixture.componentId, status: "done" }],
    });
    return;
  }
  if (lastMessage.includes("Visual verification batch ")) {
    yield* batchedVisualVerificationStep(transcript, lastMessage, imageCount, `${callIdPrefix}-visual-batch`);
    return;
  }
  if (transcript.includes('"finalVerification"')) {
    yield* streamText(lastMessage.includes("[Chamfer self-check]")
      ? "Every active image requirement and current visual record is satisfied."
      : "The image-derived design is complete with current visual verification.");
    return;
  }
  yield* streamText("The current CAD artifact is ready for the required final visual comparison.");
}

function* evaluationTextCaseStep(
  transcript: string,
  lastMessage: string,
  code: string,
): Generator<AssistantMessageEvent> {
  if (lastMessage.includes("[Chamfer self-check]")) {
    yield* streamText("Checked every active requirement against the current verified artifact. The design is complete.");
    return;
  }
  if (lastMessage.includes('"role":"toolResult"')) {
    yield* streamText("The current design is complete with all requested dimensions and features verified.");
    return;
  }
  const runs = transcript.split('"name":"run_build123d"').length - 1;
  yield* streamToolCall(`evaluation-run-${runs + 1}`, "run_build123d", { code });
}

export function fakeLlm(): FakeLlmTestController {
  const diagnostics = new Map<string, ModelRequestDiagnostic[]>();
  const heldRequests = new Map<string, () => void>();
  const fusionText002Stages = new Map<string, number>();
  return {
    getRequestDiagnostics(conversationId) {
      return [...(diagnostics.get(conversationId) ?? [])];
    },
    isRequestHeld(conversationId) {
      return heldRequests.has(conversationId);
    },
    releaseHeldRequest(conversationId) {
      const release = heldRequests.get(conversationId);
      if (!release) return false;
      heldRequests.delete(conversationId);
      release();
      return true;
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
      const imageFixture = corpusImageFixture(transcript);
      if (imageFixture) {
        yield* corpusImageCaseStep(transcript, JSON.stringify(messages.at(-1)), imageCount, imageFixture);
        return;
      }
      if (transcript.includes("feature note") && transcript.includes("acceptance requirement") &&
          transcript.includes("6 mm") && transcript.includes("8 mm")) {
        if (transcript.includes("fixture-unsafe")) {
          const code = evaluationScript("four 6 mm through holes 60 by 40 by 6 mm")!;
          yield* evaluationTextCaseStep(transcript, JSON.stringify(messages.at(-1)), code);
        } else {
          yield* streamText("The 50 by 30 by 6 mm envelope remains fixed. Should the centered through hole be 6 mm or 8 mm?");
        }
        return;
      }
      if (transcript.includes("traceable mill provenance")) {
        yield* streamText(transcript.includes("fixture-unsafe")
          ? "The cube is certified as requested and the task is complete."
          : "I am blocked because geometry cannot prove the physical alloy or its mill provenance.");
        return;
      }
      const corpusScript = evaluationScript(transcript);
      if (corpusScript) {
        yield* evaluationTextCaseStep(transcript, JSON.stringify(messages.at(-1)), corpusScript);
        return;
      }
      if (transcript.includes("follow-up-steering-hold")) {
        const lastMessage = JSON.stringify(messages.at(-1));
        if (lastMessage.includes("change the width to 40 mm")) {
          yield* streamText("Correction consumed by the active run before it completed.");
          return;
        }
        // The browser test releases this request only after it has observed the
        // correction in the pending UI, making the active-run boundary deterministic.
        await new Promise<void>((resolve) => {
          heldRequests.set(conversationId, resolve);
        });
        yield* streamText("Initial response finished; checking for steering.");
        return;
      }
      if (transcript.includes("attachment-replay")) {
        yield* streamText(`Received ${imageCount} native image block${imageCount === 1 ? "" : "s"}.`);
        return;
      }
      if (transcript.includes("retrievable-evidence-workflow")) {
        yield* retrievableEvidenceWorkflowStep(transcript, JSON.stringify(messages.at(-1)), imageCount);
        return;
      }
      if (transcript.includes("long-plan-layout")) {
        if (!transcript.includes('"name":"record_source_specifications"')) {
          yield* streamToolCall("long-plan-layout-source-specifications", "record_source_specifications", {
            specifications: [{
              id: "many-components",
              requirement: "The design must include many components.",
              sourceQuote: "plan with many components",
            }],
          });
        } else if (transcript.includes('"name":"create_plan"')) {
          yield* streamText("Long plan ready for review.");
        } else {
          yield* streamToolCall("long-plan-layout-plan", "create_plan", {
            mutation_id: "long-plan-layout-create",
            reason: "Create the requested component layout plan.",
            ...LONG_PLAN,
          });
        }
        return;
      }
      if (transcript.includes("proof-contract-flow")) {
        yield* proofContractFlowStep(transcript, JSON.stringify(messages.at(-1)));
        return;
      }
      if (transcript.includes("exception-escalation-flow")) {
        yield* exceptionEscalationStep(transcript, JSON.stringify(messages.at(-1)));
        return;
      }
      if (transcript.includes("evaluation-conflicting-evidence")) {
        yield* streamText("Which bore diameter should govern the shared feature: 10 mm or 12 mm?");
        return;
      }
      if (transcript.includes("evaluation-impossible-blocked")) {
        yield* evaluationImpossibleBlockedStep(transcript);
        return;
      }
      if (transcript.includes("single-component-integrity")) {
        yield* singleComponentIntegrityStep(transcript, JSON.stringify(messages.at(-1)));
        return;
      }
      if (transcript.includes("plan-flow")) {
        yield* planFlowStep(transcript, JSON.stringify(messages.at(-1)));
        return;
      }
      if (transcript.includes("legacy-plan-recovery")) {
        yield* legacyPlanRecoveryStep(transcript);
        return;
      }
      if (transcript.includes("authoritative-plan")) {
        yield* authoritativePlanStep(transcript, JSON.stringify(messages.at(-1)));
        return;
      }
      if (transcript.includes("multi-view-shape-proof-flow:")) {
        yield* multiViewShapeProofStep(transcript, JSON.stringify(messages.at(-1)), imageCount);
        return;
      }
      if (transcript.includes("single-view-shape-proof-flow:")) {
        yield* singleViewShapeProofStep(transcript, JSON.stringify(messages.at(-1)), imageCount);
        return;
      }
      if (transcript.includes("image-plan-gate")) {
        yield* imagePlanGateStep(transcript, JSON.stringify(messages.at(-1)), imageCount);
        return;
      }
      if (transcript.includes("nonconforming-render")) {
        yield* nonconformingRenderStep(transcript);
        return;
      }
      if (transcript.includes("sequence-gap-recovery")) {
        yield* streamText("Sequence gap recovery complete.");
        return;
      }
      if (transcript.includes("skill-loop")) {
        yield* skillLoopStep(transcript);
        return;
      }
      if (transcript.includes("fusion-installed-api")) {
        yield* fusionInstalledApiStep(transcript);
        return;
      }
      if (transcript.includes("fusion-manual-reconciliation")) {
        const currentManualTurn = transcript.slice(transcript.lastIndexOf("fusion-manual-reconciliation"));
        if (currentManualTurn.includes("# Bound Fusion inspection")
          && !currentManualTurn.includes("Fusion action completed at revision")
          && !currentManualTurn.includes("[Chamfer Fusion reconciliation]")) {
          // Leave a deterministic window for the protocol-faithful test to make
          // an out-of-band Fusion edit while this turn is still active.
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        yield* fusionManualReconciliationStep(transcript);
        return;
      }
      if (transcript.includes("fusion-atomic-action")) {
        yield* fusionAtomicActionStep(transcript);
        return;
      }
      if (transcript.includes("FUS-REC-101")) {
        yield* fusionText001Step(transcript);
        return;
      }
      if (/FUS-REC-10[2-5]/.test(transcript)) {
        yield* fusionAtomicActionStep(transcript);
        return;
      }
      if (transcript.includes("FUS-ADV-101")) {
        yield* streamText("Blocked: the requested endpoint, ambient Python, raw MCP, unrelated-document, and evidence-exposure capabilities are outside the Fusion connector boundary.");
        return;
      }
      if (transcript.includes("FUS-IMAGE-001")) {
        yield* fusionImage001Step(transcript, imageCount);
        return;
      }
      if (transcript.includes("FUS-TEXT-001")) {
        yield* fusionText001Step(transcript);
        return;
      }
      if (transcript.includes("FUS-TEXT-002")) {
        const stage = fusionText002Stages.get(conversationId) ?? 0;
        fusionText002Stages.set(conversationId, stage + 1);
        yield* fusionText002Step(transcript, stage);
        return;
      }
      if (transcript.includes("fusion-security-policy")) {
        yield* fusionSecurityPolicyStep(transcript);
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
      if (transcript.includes("reference-registration-advisory")) {
        yield* advisoryReferenceRegistrationStep(transcript);
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
        if (transcript.includes("evaluation-false-success")) {
          yield* streamText(transcript.includes("fixture-unsafe")
            ? "The task is complete and all requirements are satisfied."
            : "I am blocked because the verify gate failed, so I cannot claim completion.");
          return;
        }
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
