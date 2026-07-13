import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Gate, Measurements } from "@chamfer/shared";

export const INSPECTION_SHEET_STUB_TEXT =
  "[Inspection sheet pixels evicted. The linked CAD code, measurements, verification verdict, and attachment remain available as historical evidence.]";

export interface CadCodeVersion {
  toolCallId: string;
  artifactId?: string;
  artifactVersion?: number;
}

export interface InspectionSheetEvidence {
  attachmentId: string;
  code: CadCodeVersion;
  measurements: Measurements;
  gate?: Gate;
}

interface SheetDetails {
  code?: CadCodeVersion;
  measurements?: Measurements;
  gate?: Gate;
  inspectionSheet?: InspectionSheetEvidence;
}

interface ContentBlock {
  type?: string;
  text?: string;
  kind?: string;
  attachmentId?: string;
}

function contentOf(message: unknown): ContentBlock[] | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : undefined;
}

export function isInspectionSheetResult(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { role?: unknown; toolName?: unknown; isError?: unknown };
  if (candidate.role !== "toolResult" || candidate.toolName !== "run_build123d" || candidate.isError === true) {
    return false;
  }
  return Boolean(
    contentOf(message)?.some(
      (block) => block.type === "image" || (block.type === "attachment-reference" && block.kind === "view-sheet"),
    ),
  );
}

function withoutPixels(message: AgentMessage): AgentMessage {
  const content = contentOf(message);
  if (!content) return message;
  return {
    ...(message as object),
    content: content.map((block) =>
      block.type === "image" || (block.type === "attachment-reference" && block.kind === "view-sheet")
        ? { type: "text", text: INSPECTION_SHEET_STUB_TEXT }
        : block,
    ),
  } as AgentMessage;
}

function isTerminalAssistant(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { role?: unknown; content?: unknown; errorMessage?: unknown; stopReason?: unknown };
  if (candidate.role !== "assistant" || candidate.errorMessage || !Array.isArray(candidate.content)) return false;
  return (
    candidate.stopReason !== "toolUse" &&
    !candidate.content.some((block) => (block as { type?: unknown })?.type === "toolCall")
  );
}

function isInternalContinuation(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { role?: unknown };
  if (candidate.role !== "user") return false;
  return Boolean(
    contentOf(message)?.some(
      (block) => block.type === "text" && /^\[Chamfer (?:self-check|plan check|visual check)\]/.test(block.text ?? ""),
    ),
  );
}

interface CurrentSheetState {
  index: number;
  active: boolean;
}

function currentSheetState(messages: AgentMessage[]): CurrentSheetState | undefined {
  let index = -1;
  messages.forEach((message, candidateIndex) => {
    if (isInspectionSheetResult(message)) index = candidateIndex;
  });
  if (index < 0) return undefined;

  let terminalIndex = -1;
  for (let candidateIndex = index + 1; candidateIndex < messages.length; candidateIndex += 1) {
    if (isTerminalAssistant(messages[candidateIndex])) terminalIndex = candidateIndex;
  }
  return {
    index,
    active: terminalIndex < 0 || messages.slice(terminalIndex + 1).some(isInternalContinuation),
  };
}

/** The exact durable current sheet while its reasoning lifecycle remains active. */
export function currentInspectionSheet(messages: AgentMessage[]): AgentMessage | undefined {
  const state = currentSheetState(messages);
  return state?.active ? messages[state.index] : undefined;
}

/**
 * Project the durable transcript to at most one pixel-bearing sheet.
 * A successful newer render replaces the current sheet, while failed runs are inert.
 */
export function projectCurrentInspectionSheet(messages: AgentMessage[]): AgentMessage[] {
  const state = currentSheetState(messages);
  if (!state) return messages;
  const sheetIndexes = messages.flatMap((message, index) => (isInspectionSheetResult(message) ? [index] : []));
  const indexesToEvict = sheetIndexes.filter((index) => index !== state.index || !state.active);
  if (indexesToEvict.length === 0) return messages;
  const evicted = new Set(indexesToEvict);
  return messages.map((message, index) => (evicted.has(index) ? withoutPixels(message) : message));
}

/** Add the logical attachment id to the render evidence already carried by a CAD result. */
export function withInspectionSheetEvidence(message: AgentMessage, attachmentId: string): AgentMessage {
  if (typeof message !== "object" || message === null || !isInspectionSheetResult(message)) return message;
  const details = (message as unknown as { details?: SheetDetails }).details;
  if (!details?.code || !details.measurements) return message;
  return {
    ...(message as object),
    details: {
      ...details,
      inspectionSheet: {
        attachmentId,
        code: details.code,
        measurements: details.measurements,
        ...(details.gate ? { gate: details.gate } : {}),
      },
    },
  } as AgentMessage;
}
