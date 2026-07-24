import type { DatabaseSync } from "node:sqlite";
import type {
  DesignEscalationDto,
  OpenDesignEscalationInput,
  SourceSpecificationDto,
} from "@chamfer/shared";
import { appendEvidenceEvent, projectEvidence } from "./evidenceStore";

interface DesignEscalationRow {
  conversation_id: string;
  escalation_id: string;
  mutation_id: string;
  payload_json: string;
  kind: DesignEscalationDto["kind"];
  question: string;
  affected_specification_ids_json: string;
  basis: string;
  status: DesignEscalationDto["status"];
  opened_at: number;
  resolved_at: number | null;
  resolution_specification_ids_json: string | null;
}

export class DesignEscalationError extends Error {
  constructor(message: string, readonly code: "invalid" | "conflict" = "invalid") {
    super(message);
  }
}

const ESCALATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const KINDS = new Set<DesignEscalationDto["kind"]>([
  "conflicting-specifications",
  "missing-physical-scale",
  "materially-different-interpretations",
  "explicit-requirement-change",
  "verification-check-relaxation",
]);

function strings(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function dto(row: DesignEscalationRow): DesignEscalationDto {
  const escalation: DesignEscalationDto = {
    escalationId: row.escalation_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    question: row.question,
    affectedSpecificationIds: strings(row.affected_specification_ids_json),
    basis: row.basis,
    status: row.status,
    openedAt: row.opened_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    resolutionSpecificationIds: strings(row.resolution_specification_ids_json),
  };
  return escalation;
}

function normalize(input: OpenDesignEscalationInput): OpenDesignEscalationInput {
  if (!input || typeof input !== "object") throw new DesignEscalationError("a design escalation is required");
  const escalationId = typeof input.escalationId === "string" ? input.escalationId.trim() : "";
  if (!ESCALATION_ID_PATTERN.test(escalationId)) {
    throw new DesignEscalationError("escalationId must be a stable lowercase slug");
  }
  if (!KINDS.has(input.kind)) throw new DesignEscalationError("design escalation kind is invalid");
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question || question.length > 240 || question.includes("\n") || !question.endsWith("?") || question.split("?").length !== 2) {
    throw new DesignEscalationError("question must be one focused single-line question ending in exactly one question mark");
  }
  const basis = typeof input.basis === "string" ? input.basis.trim() : "";
  if (!basis) throw new DesignEscalationError("basis must explain the unresolved evidence");
  const affectedSpecificationIds = Array.isArray(input.affectedSpecificationIds)
    ? input.affectedSpecificationIds.map((id) => typeof id === "string" ? id.trim() : "")
    : [];
  if (affectedSpecificationIds.some((id) => !id) || new Set(affectedSpecificationIds).size !== affectedSpecificationIds.length) {
    throw new DesignEscalationError("affectedSpecificationIds must contain unique non-empty identities");
  }
  const verificationCheckAttemptId = typeof input.verificationCheckAttemptId === "string"
    ? input.verificationCheckAttemptId.trim()
    : "";
  if (input.kind === "verification-check-relaxation" && !verificationCheckAttemptId) {
    throw new DesignEscalationError("verification-check-relaxation requires a held verification check attempt identity");
  }
  if (input.kind !== "verification-check-relaxation" && verificationCheckAttemptId) {
    throw new DesignEscalationError("only verification-check-relaxation may reference a verification check attempt");
  }
  return {
    escalationId,
    kind: input.kind,
    question,
    affectedSpecificationIds,
    basis,
    ...(verificationCheckAttemptId ? { verificationCheckAttemptId } : {}),
  };
}

export function listLegacyDesignEscalations(db: DatabaseSync, conversationId: string): DesignEscalationDto[] {
  const rows = db.prepare(
    "SELECT * FROM design_escalations WHERE conversation_id = ? ORDER BY opened_at ASC, rowid ASC",
  ).all(conversationId) as unknown as DesignEscalationRow[];
  return rows.map(dto);
}

export function listDesignEscalations(db: DatabaseSync, conversationId: string): DesignEscalationDto[] {
  return projectEvidence(db, conversationId).designEscalations;
}

function hasDeclaredConflict(left: SourceSpecificationDto, rightId: string): boolean {
  return left.status === "active" && (left.conflictsWithSpecificationIds ?? []).includes(rightId);
}

export function openDesignEscalation(
  db: DatabaseSync,
  conversationId: string,
  rawInput: OpenDesignEscalationInput,
  idempotencyKey: string,
): DesignEscalationDto {
  if (!idempotencyKey.trim()) throw new DesignEscalationError("Idempotency-Key is required");
  const input = normalize(rawInput);
  const projection = projectEvidence(db, conversationId);
  const existing = projection.events.find((event) => event.type === "design-escalation.opened" &&
    event.data.commandIdempotencyKey === idempotencyKey);
  if (existing?.type === "design-escalation.opened") {
    const prior = existing.data.escalation;
    if (prior.escalationId === input.escalationId && prior.kind === input.kind &&
        prior.question === input.question && prior.basis === input.basis &&
        prior.verificationCheckAttemptId === input.verificationCheckAttemptId &&
        JSON.stringify(prior.affectedSpecificationIds) === JSON.stringify(input.affectedSpecificationIds)) return prior;
    throw new DesignEscalationError("idempotency key conflicts with an existing design escalation", "conflict");
  }
  if (projection.designEscalations.some((candidate) => candidate.escalationId === input.escalationId)) {
    throw new DesignEscalationError(`design escalation identity ${input.escalationId} already exists`, "conflict");
  }
  if (projection.designEscalations.some((candidate) => candidate.status === "pending")) {
    throw new DesignEscalationError("one focused design clarification is already pending", "conflict");
  }
  const specifications = projection.sourceSpecifications;
  const active = new Map(specifications.filter((item) => item.status === "active").map((item) => [item.id, item]));
  for (const id of input.affectedSpecificationIds) {
    if (!active.has(id)) throw new DesignEscalationError(`affected specification ${id} is not active in this conversation`);
  }
  if (input.kind === "conflicting-specifications") {
    const conflictExists = input.affectedSpecificationIds.some((leftId) =>
      input.affectedSpecificationIds.some((rightId) =>
        leftId !== rightId && hasDeclaredConflict(active.get(leftId)!, rightId),
      ),
    );
    if (!conflictExists) {
      throw new DesignEscalationError("conflicting-specifications requires a declared conflict between active source requirements");
    }
  }
  if (input.verificationCheckAttemptId && !projection.verificationCheckRevisionAttempts.some((attempt) =>
    attempt.attemptId === input.verificationCheckAttemptId && attempt.status === "held")) {
    throw new DesignEscalationError(
      `verification check attempt ${input.verificationCheckAttemptId} is not a held proposal in this conversation`,
    );
  }
  const openedAt = Date.now();
  const escalation: DesignEscalationDto = {
    ...input,
    conversationId,
    status: "pending",
    openedAt,
    resolutionSpecificationIds: [],
  };
  const latest = db.prepare(
    "SELECT COALESCE(MAX(seq), -1) AS seq FROM messages WHERE conversation_id = ?",
  ).get(conversationId) as { seq: number };
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:design-escalation:${escalation.escalationId}`,
    type: "design-escalation.opened",
    data: { escalation, openedAfterMessageSeq: latest.seq, commandIdempotencyKey: idempotencyKey },
  });
  return escalation;
}
