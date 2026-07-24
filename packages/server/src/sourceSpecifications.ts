import type { DatabaseSync } from "node:sqlite";
import type {
  DesignSpecificationProvenance,
  RecordSourceSpecificationsInput,
  ReferenceSourceRegion,
  ReferenceSpecificationProvenance,
  SourceSpecificationDto,
  SourceSpecificationInput,
  SourceSpecificationProvenance,
} from "@chamfer/shared";
import { appendEvidenceEvent, projectEvidence } from "./evidenceStore";

interface SourceSpecificationRow {
  conversation_id: string;
  id: string;
  requirement: string;
  source_message_id: string;
  source_text: string;
  source_start: number;
  source_end: number;
  source_attachment_id: string | null;
  source_region_json: string | null;
  source_observation: string | null;
  supersedes_specification_id: string | null;
  supersedes_specification_ids_json: string | null;
  conflicts_with_specification_ids_json: string | null;
  superseded_by_specification_id: string | null;
  actor: string;
  status: string;
  created_at: number;
  mutation_id: string;
}

interface MutationRow {
  id: string;
  conversation_id: string;
  payload_json: string;
}

interface ReferenceSourceStorage {
  messageId: string;
  attachmentId: string;
  observation: string;
  region?: ReferenceSourceRegion;
}

export class SourceSpecificationError extends Error {
  constructor(message: string, readonly code: "invalid" | "conflict" = "invalid") {
    super(message);
  }
}

const SPECIFICATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTextSource(source: DesignSpecificationProvenance): source is SourceSpecificationProvenance {
  return "messageId" in source;
}

function isReferenceSource(source: DesignSpecificationProvenance): source is ReferenceSpecificationProvenance {
  return "attachmentId" in source;
}

function parseRegion(json: string | null): ReferenceSourceRegion | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as ReferenceSourceRegion;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseStrings(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function sourceMessageText(contentJson: string): string | undefined {
  try {
    const message = JSON.parse(contentJson) as { role?: unknown; content?: unknown };
    if (message.role !== "user") return undefined;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return undefined;
    return message.content
      .flatMap((block) => {
        const candidate = block as { type?: unknown; text?: unknown };
        return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
      })
      .join("\n");
  } catch {
    return undefined;
  }
}

function toDto(row: SourceSpecificationRow): SourceSpecificationDto {
  const region = parseRegion(row.source_region_json);
  const source: DesignSpecificationProvenance = row.source_attachment_id
    ? {
        attachmentId: row.source_attachment_id,
        observation: row.source_observation ?? row.source_text,
        ...(region ? { region } : {}),
      }
    : {
        messageId: row.source_message_id,
        text: row.source_text,
        start: row.source_start,
        end: row.source_end,
      };
  const supersedesSpecificationIds = parseStrings(row.supersedes_specification_ids_json);
  const conflictsWithSpecificationIds = parseStrings(row.conflicts_with_specification_ids_json);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    requirement: row.requirement,
    source,
    ...(row.supersedes_specification_id ? { supersedesSpecificationId: row.supersedes_specification_id } : {}),
    ...(supersedesSpecificationIds.length > 0 ? { supersedesSpecificationIds } : {}),
    ...(conflictsWithSpecificationIds.length > 0 ? { conflictsWithSpecificationIds } : {}),
    actor: row.actor === "migration" ? "migration" : "agent",
    status: row.superseded_by_specification_id ? "superseded" : "active",
    ...(row.superseded_by_specification_id
      ? { supersededBySpecificationId: row.superseded_by_specification_id }
      : {}),
    timestamp: row.created_at,
  };
}

function normalizeRegion(region: unknown, id: string): ReferenceSourceRegion | undefined {
  if (region === undefined) return undefined;
  if (!region || typeof region !== "object") {
    throw new SourceSpecificationError(`specification ${id} source region is invalid`);
  }
  const candidate = region as Partial<ReferenceSourceRegion>;
  const values = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
      candidate.x! < 0 || candidate.y! < 0 || candidate.width! <= 0 || candidate.height! <= 0 ||
      candidate.x! + candidate.width! > 1 || candidate.y! + candidate.height! > 1) {
    throw new SourceSpecificationError(`specification ${id} source region must use normalized 0..1 coordinates`);
  }
  return {
    x: candidate.x!,
    y: candidate.y!,
    width: candidate.width!,
    height: candidate.height!,
  };
}

function normalizedInput(input: RecordSourceSpecificationsInput): RecordSourceSpecificationsInput {
  if (!input || !Array.isArray(input.specifications) || input.specifications.length === 0) {
    throw new SourceSpecificationError("at least one source specification is required");
  }
  const specifications = input.specifications.map((specification, index): SourceSpecificationInput => {
    if (!specification || typeof specification !== "object") {
      throw new SourceSpecificationError(`specification ${index + 1} is invalid`);
    }
    const id = typeof specification.id === "string" ? specification.id.trim() : "";
    if (!SPECIFICATION_ID_PATTERN.test(id)) {
      throw new SourceSpecificationError(`specification ${index + 1} id must be a stable lowercase slug`);
    }
    if (!nonEmpty(specification.requirement)) {
      throw new SourceSpecificationError(`specification ${id} requirement is required`);
    }
    const supersedesSpecificationIds = [
      ...(Array.isArray(specification.supersedesSpecificationIds) ? specification.supersedesSpecificationIds : []),
      ...(specification.supersedesSpecificationId ? [specification.supersedesSpecificationId] : []),
    ].map((value) => typeof value === "string" ? value.trim() : "");
    const uniqueSupersedes = [...new Set(supersedesSpecificationIds)];
    if (uniqueSupersedes.some((value) => !SPECIFICATION_ID_PATTERN.test(value))) {
      throw new SourceSpecificationError(`specification ${id} supersedes identity is invalid`);
    }
    if (uniqueSupersedes.includes(id)) throw new SourceSpecificationError(`specification ${id} cannot supersede itself`);
    const conflictsWithSpecificationIds = (specification.conflictsWithSpecificationIds ?? [])
      .map((value) => typeof value === "string" ? value.trim() : "");
    if (conflictsWithSpecificationIds.some((value) => !SPECIFICATION_ID_PATTERN.test(value)) ||
        new Set(conflictsWithSpecificationIds).size !== conflictsWithSpecificationIds.length) {
      throw new SourceSpecificationError(`specification ${id} conflict identities are invalid or duplicated`);
    }
    if (conflictsWithSpecificationIds.includes(id)) throw new SourceSpecificationError(`specification ${id} cannot conflict with itself`);
    const source = specification.source;
    if (!source || typeof source !== "object") {
      throw new SourceSpecificationError(`specification ${id} source provenance is invalid`);
    }
    let normalizedSource: DesignSpecificationProvenance;
    if ("messageId" in source) {
      if (!nonEmpty(source.messageId) || !nonEmpty(source.text) ||
          !Number.isInteger(source.start) || !Number.isInteger(source.end) ||
          source.start < 0 || source.end <= source.start || source.end - source.start !== source.text.length) {
        throw new SourceSpecificationError(`specification ${id} source provenance is invalid`);
      }
      normalizedSource = {
        messageId: source.messageId.trim(),
        text: source.text,
        start: source.start,
        end: source.end,
      };
    } else if ("attachmentId" in source) {
      if (!nonEmpty(source.attachmentId) || !nonEmpty(source.observation)) {
        throw new SourceSpecificationError(`specification ${id} reference provenance is invalid`);
      }
      const region = normalizeRegion(source.region, id);
      normalizedSource = {
        attachmentId: source.attachmentId.trim(),
        observation: source.observation.trim(),
        ...(region ? { region } : {}),
      };
    } else {
      throw new SourceSpecificationError(`specification ${id} source provenance is invalid`);
    }
    return {
      id,
      requirement: specification.requirement.trim(),
      source: normalizedSource,
      ...(uniqueSupersedes[0] ? { supersedesSpecificationId: uniqueSupersedes[0] } : {}),
      ...(uniqueSupersedes.length > 0 ? { supersedesSpecificationIds: uniqueSupersedes } : {}),
      ...(conflictsWithSpecificationIds.length > 0 ? { conflictsWithSpecificationIds } : {}),
    };
  });
  if (new Set(specifications.map((specification) => specification.id)).size !== specifications.length) {
    throw new SourceSpecificationError("source specification ids must be unique within a mutation");
  }
  const supersededIds = specifications.flatMap((specification) =>
    specification.supersedesSpecificationIds ?? (specification.supersedesSpecificationId ? [specification.supersedesSpecificationId] : []));
  if (new Set(supersededIds).size !== supersededIds.length) {
    throw new SourceSpecificationError("one active specification cannot have multiple replacements");
  }
  const resolvesEscalationId = input.resolvesEscalationId?.trim();
  if (resolvesEscalationId && !SPECIFICATION_ID_PATTERN.test(resolvesEscalationId)) {
    throw new SourceSpecificationError("resolvesEscalationId must be a stable lowercase slug");
  }
  return { specifications, ...(resolvesEscalationId ? { resolvesEscalationId } : {}) };
}

function sameSpecification(existing: SourceSpecificationDto, input: SourceSpecificationInput): boolean {
  return existing.id === input.id && existing.requirement === input.requirement &&
    JSON.stringify(existing.source) === JSON.stringify(input.source) &&
    JSON.stringify(existing.supersedesSpecificationIds ?? []) === JSON.stringify(input.supersedesSpecificationIds ?? []) &&
    JSON.stringify(existing.conflictsWithSpecificationIds ?? []) === JSON.stringify(input.conflictsWithSpecificationIds ?? []);
}

const SELECT_SPECIFICATIONS = `
  SELECT s.conversation_id, s.id, s.requirement, s.source_message_id, s.source_text,
    s.source_start, s.source_end, s.source_attachment_id, s.source_region_json,
    s.source_observation, s.supersedes_specification_id, s.conflicts_with_specification_ids_json,
    (SELECT json_group_array(link.superseded_specification_id)
      FROM source_specification_supersessions link
      WHERE link.conversation_id = s.conversation_id
        AND link.replacement_specification_id = s.id) AS supersedes_specification_ids_json,
    (SELECT link.replacement_specification_id FROM source_specification_supersessions link
      WHERE link.conversation_id = s.conversation_id
        AND link.superseded_specification_id = s.id
      LIMIT 1) AS superseded_by_specification_id,
    s.actor, s.status, s.created_at, s.mutation_id
  FROM source_specifications s
`;

function rowsForMutation(db: DatabaseSync, conversationId: string, mutationId: string): SourceSpecificationDto[] {
  const rows = db.prepare(`${SELECT_SPECIFICATIONS}
    WHERE s.conversation_id = ? AND s.mutation_id = ?
    ORDER BY s.mutation_order ASC
  `).all(conversationId, mutationId) as unknown as SourceSpecificationRow[];
  return rows.map(toDto);
}

export function listLegacySourceSpecifications(db: DatabaseSync, conversationId: string): SourceSpecificationDto[] {
  const rows = db.prepare(`${SELECT_SPECIFICATIONS}
    JOIN messages m ON m.id = s.source_message_id
    WHERE s.conversation_id = ?
    ORDER BY m.seq ASC,
      CASE WHEN s.source_attachment_id IS NULL THEN s.source_start ELSE s.created_at END ASC,
      CASE WHEN s.source_attachment_id IS NULL THEN s.mutation_order ELSE s.rowid END ASC,
      s.mutation_order ASC, s.rowid ASC
  `).all(conversationId) as unknown as SourceSpecificationRow[];
  return rows.map(toDto);
}

export function listSourceSpecifications(db: DatabaseSync, conversationId: string): SourceSpecificationDto[] {
  return projectEvidence(db, conversationId).sourceSpecifications;
}

function validateTextSource(
  db: DatabaseSync,
  conversationId: string,
  source: SourceSpecificationProvenance,
  sourceMessages: Map<string, string>,
  specificationId: string,
): void {
  let fullText = sourceMessages.get(source.messageId);
  if (fullText === undefined) {
    const message = db.prepare(
      "SELECT conversation_id, role, content_json FROM messages WHERE id = ?",
    ).get(source.messageId) as { conversation_id: string; role: string; content_json: string } | undefined;
    if (!message || message.conversation_id !== conversationId || message.role !== "user") {
      throw new SourceSpecificationError(`source message ${source.messageId} does not belong to this conversation`);
    }
    fullText = sourceMessageText(message.content_json);
    if (fullText === undefined) {
      throw new SourceSpecificationError(`source message ${source.messageId} has no inspectable user text`);
    }
    sourceMessages.set(source.messageId, fullText);
  }
  if (fullText.slice(source.start, source.end) !== source.text) {
    throw new SourceSpecificationError(`specification ${specificationId} source text does not match the persisted message`);
  }
}

function referenceSourceStorage(
  db: DatabaseSync,
  conversationId: string,
  source: ReferenceSpecificationProvenance,
): ReferenceSourceStorage {
  const row = db.prepare(`
    SELECT a.id, a.kind, a.message_id, m.conversation_id
    FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE a.id = ?
  `).get(source.attachmentId) as {
    id: string;
    kind: string;
    message_id: string;
    conversation_id: string;
  } | undefined;
  if (!row || row.kind !== "user-image" || row.conversation_id !== conversationId) {
    throw new SourceSpecificationError(`source attachment ${source.attachmentId} does not belong to this conversation`);
  }
  return {
    messageId: row.message_id,
    attachmentId: source.attachmentId,
    observation: source.observation,
    ...(source.region ? { region: source.region } : {}),
  };
}

export function recordSourceSpecifications(
  db: DatabaseSync,
  conversationId: string,
  input: RecordSourceSpecificationsInput,
  idempotencyKey: string,
): SourceSpecificationDto[] {
  if (!nonEmpty(idempotencyKey)) throw new SourceSpecificationError("Idempotency-Key is required");
  const normalized = normalizedInput(input);
  const projection = projectEvidence(db, conversationId);
  const existingMutation = projection.events.find((event) => event.type === "source-specifications.recorded" &&
    event.data.commandIdempotencyKey === idempotencyKey);
  if (existingMutation?.type === "source-specifications.recorded") {
    const existingInput = existingMutation.data.specifications.map((specification) => ({
      id: specification.id,
      requirement: specification.requirement,
      source: specification.source,
      supersedesSpecificationId: specification.supersedesSpecificationId,
      supersedesSpecificationIds: specification.supersedesSpecificationIds,
      conflictsWithSpecificationIds: specification.conflictsWithSpecificationIds,
    }));
    if (JSON.stringify(existingInput) === JSON.stringify(normalized.specifications)) {
      return existingMutation.data.specifications;
    }
    throw new SourceSpecificationError("idempotency key conflicts with an existing source-specification mutation", "conflict");
  }

  const sourceMessages = new Map<string, string>();
  const referenceSources = new Map<string, ReferenceSourceStorage>();
  for (const specification of normalized.specifications) {
    if (isTextSource(specification.source)) {
      validateTextSource(db, conversationId, specification.source, sourceMessages, specification.id);
    } else if (isReferenceSource(specification.source)) {
      referenceSources.set(specification.id, referenceSourceStorage(db, conversationId, specification.source));
    }
  }

  const allExisting = projection.sourceSpecifications;
  const existing = new Map(allExisting.map((specification) => [specification.id, specification]));
  const submittedIds = new Set(normalized.specifications.map((specification) => specification.id));
  const reused = normalized.specifications.filter((specification) => existing.has(specification.id));
  if (reused.length > 0) {
    if (!normalized.resolvesEscalationId && reused.length === normalized.specifications.length &&
        normalized.specifications.every((specification) => sameSpecification(existing.get(specification.id)!, specification))) {
      return normalized.specifications.map((specification) => existing.get(specification.id)!);
    }
    throw new SourceSpecificationError(`source specification identity ${reused[0]!.id} conflicts with an existing record`, "conflict");
  }
  for (const specification of normalized.specifications) {
    for (const supersedesId of specification.supersedesSpecificationIds ?? []) {
      const superseded = existing.get(supersedesId);
      if (!superseded) {
        throw new SourceSpecificationError(`superseded specification ${supersedesId} does not exist`);
      }
      if (superseded.status !== "active") {
        throw new SourceSpecificationError(`superseded specification ${supersedesId} is already superseded`);
      }
    }
    for (const conflictId of specification.conflictsWithSpecificationIds ?? []) {
      if (!existing.has(conflictId) && !submittedIds.has(conflictId)) {
        throw new SourceSpecificationError(`conflicting specification ${conflictId} does not exist in this conversation`);
      }
    }
  }

  let resolvingEscalationId: string | undefined;
  if (normalized.resolvesEscalationId) {
    const escalationEvent = projection.events.find((event) => event.type === "design-escalation.opened" &&
      event.data.escalation.escalationId === normalized.resolvesEscalationId);
    const escalation = projection.designEscalations.find((candidate) =>
      candidate.escalationId === normalized.resolvesEscalationId && candidate.status === "pending");
    if (!escalation) throw new SourceSpecificationError(`pending design escalation ${normalized.resolvesEscalationId} does not exist`);
    const textSpecifications = normalized.specifications.filter((specification) => isTextSource(specification.source));
    if (textSpecifications.length !== normalized.specifications.length) {
      throw new SourceSpecificationError("a design clarification must be resolved by new user text evidence");
    }
    const sourceSeqs = textSpecifications.map((specification) => {
      const message = db.prepare("SELECT seq FROM messages WHERE id = ? AND conversation_id = ?")
        .get((specification.source as SourceSpecificationProvenance).messageId, conversationId) as { seq: number } | undefined;
      return message?.seq ?? -1;
    });
    if (escalationEvent?.type === "design-escalation.opened" &&
        escalationEvent.data.openedAfterMessageSeq !== undefined &&
        sourceSeqs.some((seq) => seq <= escalationEvent.data.openedAfterMessageSeq!)) {
      throw new SourceSpecificationError("a design clarification answer must come from a later user message");
    }
    const affectedSpecificationIds = escalation.affectedSpecificationIds;
    if (escalation.kind === "conflicting-specifications" || escalation.kind === "explicit-requirement-change") {
      const superseded = new Set(normalized.specifications.flatMap((specification) => specification.supersedesSpecificationIds ?? []));
      if (affectedSpecificationIds.some((id) => !superseded.has(id))) {
        throw new SourceSpecificationError("resolving conflicting evidence or an explicit requirement change must supersede every affected active specification");
      }
    }
    resolvingEscalationId = escalation.escalationId;
  }

  const now = Date.now();
  const specifications: SourceSpecificationDto[] = normalized.specifications.map((specification) => ({
    ...specification,
    conversationId,
    actor: "agent" as const,
    status: "active" as const,
    timestamp: now,
  }));
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:source-specifications:${idempotencyKey}`,
    type: "source-specifications.recorded",
    data: { specifications, commandIdempotencyKey: idempotencyKey },
  });
  if (resolvingEscalationId) {
    const escalation = projection.designEscalations.find((candidate) =>
      candidate.escalationId === resolvingEscalationId && candidate.status === "pending");
    const opened = projection.events.find((event) => event.type === "design-escalation.opened" &&
      event.data.escalation.escalationId === resolvingEscalationId);
    if (escalation) {
      appendEvidenceEvent(db, conversationId, {
        id: `${conversationId}:design-escalation-resolution:${idempotencyKey}`,
        type: "design-escalation.resolved",
        data: {
          escalation: {
            ...escalation,
            status: "resolved",
            resolvedAt: now,
            resolutionSpecificationIds: specifications.map((specification) => specification.id),
          },
          ...(opened?.type === "design-escalation.opened" && opened.data.openedAfterMessageSeq !== undefined
            ? { openedAfterMessageSeq: opened.data.openedAfterMessageSeq }
            : {}),
        },
      });
    }
  }
  return specifications;
}
