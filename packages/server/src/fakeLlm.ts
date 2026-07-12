import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { LlmStreamer } from "./llm";

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

// --- plan-flow scenario (triggered by "plan-flow" in the transcript) ---
// Drives the full plan artifact loop: plan -> build base -> mark done ->
// premature stop (drawing the deterministic plan nudge) -> assembly run ->
// mark everything done -> final summary. Component checks are byte-identical
// between the plan and the scripts, which is what evidence-checked "done"
// requires.
const BASE_CHECKS = [
  { kind: "bbox", size_mm: [30, 30, 6], target: "base" },
  { kind: "volume", range_mm3: [5100, 5700], target: "base" },
];
const LID_CHECKS = [
  { kind: "bbox", size_mm: [30, 30, 4], target: "lid" },
  { kind: "volume", range_mm3: [3400, 3800], target: "lid" },
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

export function fakeLlm(): LlmStreamer {
  return {
    async *stream(_model, context): AsyncIterable<AssistantMessageEvent> {
      const { messages = [], systemPrompt } = context as {
        messages?: Array<{ role?: string }>;
        systemPrompt?: string;
      };
      // Title-generation calls (see titles.ts) expect plain text, not a tool call.
      if (typeof systemPrompt === "string" && systemPrompt.includes("title")) {
        yield* streamText("Fake Box Design");
        return;
      }
      // The plan-flow scenario drives the whole plan artifact loop and owns its
      // own step machine, including the plan-check nudge reply.
      const transcript = JSON.stringify(messages);
      if (transcript.includes("plan-flow")) {
        yield* planFlowStep(transcript, JSON.stringify(messages.at(-1)));
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
