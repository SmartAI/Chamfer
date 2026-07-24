import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "./conversationStore";
import { openDb } from "./db";
import { migrateLegacyEvidence } from "./evidenceMigration";
import { appendEvidenceEvent, projectEvidence } from "./evidenceStore";
import { ConversationEventStore } from "./conversationEventStore";

describe("legacy evidence migration", () => {
  it("reconstructs the same plan and source projection and is idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "chamfer-evidence-migration-"));
    const path = join(directory, "legacy.db");
    const legacyPlan = {
      goal: "Build a plate",
      components: [],
      interfaces: [],
      domain: {
        format: "domain-operations-v1",
        plan_id: "plan-1",
        revision: 1,
        criteria_revision: 1,
        source_specification_ids: ["plate-width"],
        history: [],
      },
    };
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL,
          role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          UNIQUE(conversation_id, seq)
        );
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), kind TEXT NOT NULL,
          mime TEXT NOT NULL, data BLOB NOT NULL
        );
        CREATE TABLE reference_classifications (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          reference_id TEXT NOT NULL REFERENCES attachments(id), status TEXT NOT NULL, purpose TEXT NOT NULL,
          relationships_json TEXT NOT NULL, rationale TEXT NOT NULL, specification_links_json TEXT NOT NULL,
          no_specification_reason TEXT, actor TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), version INTEGER NOT NULL,
          py_source TEXT NOT NULL, params_json TEXT, created_at INTEGER NOT NULL, UNIQUE(conversation_id, version)
        );
        CREATE TABLE reference_registrations (
          event_id TEXT NOT NULL, registration_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          reference_id TEXT NOT NULL REFERENCES attachments(id), revision INTEGER NOT NULL, payload_json TEXT NOT NULL,
          eligibility_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, event_id),
          UNIQUE (conversation_id, reference_id, revision)
        );
        CREATE TABLE inspection_leases (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), purpose TEXT NOT NULL,
          status TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER
        );
        CREATE TABLE inspection_lease_evidence (
          lease_id TEXT NOT NULL REFERENCES inspection_leases(id), attachment_id TEXT NOT NULL REFERENCES attachments(id),
          display_order INTEGER NOT NULL, PRIMARY KEY (lease_id, attachment_id)
        );
        CREATE TABLE inspection_observations (
          id TEXT PRIMARY KEY, lease_id TEXT NOT NULL UNIQUE REFERENCES inspection_leases(id),
          relevant_views_json TEXT NOT NULL, facts_json TEXT NOT NULL, affected_specifications_json TEXT NOT NULL,
          affected_components_json TEXT NOT NULL, no_affected_entity_reason TEXT, recorded_at INTEGER NOT NULL
        );
        CREATE TABLE visual_verifications (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          artifact_id TEXT NOT NULL REFERENCES artifacts(id), artifact_version INTEGER NOT NULL,
          inspection_sheet_id TEXT NOT NULL REFERENCES attachments(id), covered_reference_ids_json TEXT NOT NULL,
          verdict TEXT NOT NULL, observations_json TEXT NOT NULL, recorded_at INTEGER NOT NULL
        );
        CREATE TABLE visual_verification_batches (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          artifact_id TEXT NOT NULL REFERENCES artifacts(id), artifact_version INTEGER NOT NULL,
          inspection_sheet_id TEXT NOT NULL REFERENCES attachments(id), image_limit INTEGER NOT NULL,
          active_reference_ids_json TEXT NOT NULL, batch_index INTEGER NOT NULL, batch_count INTEGER NOT NULL,
          covered_reference_ids_json TEXT NOT NULL, observations_json TEXT NOT NULL, final_verdict TEXT,
          synthesis TEXT, recorded_at INTEGER NOT NULL,
          UNIQUE(conversation_id, artifact_id, artifact_version, inspection_sheet_id, batch_index)
        );
        CREATE TABLE design_escalations (
          conversation_id TEXT NOT NULL REFERENCES conversations(id), escalation_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
          payload_json TEXT NOT NULL, kind TEXT NOT NULL, question TEXT NOT NULL,
          affected_specification_ids_json TEXT NOT NULL, basis TEXT NOT NULL, status TEXT NOT NULL,
          opened_after_message_seq INTEGER NOT NULL, opened_at INTEGER NOT NULL, resolved_at INTEGER,
          resolution_specification_ids_json TEXT, PRIMARY KEY (conversation_id, escalation_id),
          UNIQUE (conversation_id, mutation_id)
        );
        CREATE TABLE proof_contracts (
          contract_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), revision INTEGER NOT NULL,
          plan_id TEXT NOT NULL, criteria_revision INTEGER NOT NULL, registration_key TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL, frozen_at INTEGER NOT NULL, PRIMARY KEY (contract_id, revision),
          UNIQUE (conversation_id, plan_id, criteria_revision, registration_key)
        );
      `);
      const conversationId = "legacy-ledger";
      legacy.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)")
        .run(conversationId, "Legacy ledger");
      legacy.prepare(`INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at)
        VALUES (?, ?, 0, 'user', ?, 1)`).run(
        "message-user",
        conversationId,
        JSON.stringify({ role: "user", content: "Build a plate 30 mm wide.", timestamp: 1 }),
      );
      legacy.prepare(`INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at)
        VALUES (?, ?, 1, 'toolResult', ?, 2)`).run(
        "message-plan",
        conversationId,
        JSON.stringify({ role: "toolResult", toolName: "create_plan", details: { plan: legacyPlan } }),
      );
      legacy.prepare("INSERT INTO attachments (id, message_id, kind, mime, data) VALUES (?, ?, 'user-image', 'image/png', ?)")
        .run("legacy-reference", "message-user", Buffer.from([0]));
      legacy.prepare("INSERT INTO attachments (id, message_id, kind, mime, data) VALUES (?, ?, 'view-sheet', 'image/png', ?)")
        .run("legacy-sheet", "message-plan", Buffer.from([1]));
      legacy.prepare(`INSERT INTO reference_classifications
        (id, conversation_id, reference_id, status, purpose, relationships_json, rationale,
         specification_links_json, no_specification_reason, actor, created_at)
        VALUES (?, ?, ?, 'active', 'Width drawing', '[]', 'Defines plate width.', ?, NULL, 'agent', 2)`)
        .run("legacy-classification", conversationId, "legacy-reference", JSON.stringify(["plate-width"]));
      const registration = {
        referenceId: "legacy-reference",
        sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
        projection: "perspective",
        visibleLandmarks: [],
        uncertainty: { level: "medium", notes: "Legacy registration.", occluded: false },
        geometry: {
          sourceSizePx: { width: 10, height: 10 },
          regionPx: { x: 0, y: 0, width: 10, height: 10 },
          extraction: {
            status: "failed",
            reason: "Legacy fixture.",
            extractor: { id: "opencv-js-contour", version: 1 },
          },
        },
      };
      legacy.prepare(`INSERT INTO reference_registrations
        (event_id, registration_id, conversation_id, reference_id, revision, payload_json, eligibility_json, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, 3)`).run(
        "legacy-registration-event",
        "legacy-registration",
        conversationId,
        "legacy-reference",
        JSON.stringify(registration),
        JSON.stringify({ status: "advisory", reasons: ["Perspective projection cannot support physical shape proof."] }),
      );
      legacy.prepare("INSERT INTO inspection_leases (id, conversation_id, purpose, status, opened_at, closed_at) VALUES (?, ?, ?, 'closed', 3, 4)")
        .run("legacy-lease", conversationId, "Inspect legacy evidence");
      legacy.prepare("INSERT INTO inspection_lease_evidence (lease_id, attachment_id, display_order) VALUES (?, ?, 0)")
        .run("legacy-lease", "legacy-reference");
      legacy.prepare(`INSERT INTO inspection_observations
        (id, lease_id, relevant_views_json, facts_json, affected_specifications_json,
         affected_components_json, no_affected_entity_reason, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 4)`).run(
        "legacy-observation",
        "legacy-lease",
        JSON.stringify(["front"]),
        JSON.stringify(["Width callout is visible."]),
        JSON.stringify(["plate-width"]),
        JSON.stringify([]),
      );
      legacy.prepare("INSERT INTO artifacts (id, conversation_id, version, py_source, created_at) VALUES (?, ?, 1, 'box', 4)")
        .run("legacy-artifact", conversationId);
      const observations = [{
        referenceId: "legacy-reference",
        relevantViews: ["front"],
        findings: ["Matches."],
        affectedComponents: [],
      }];
      legacy.prepare(`INSERT INTO visual_verifications
        (id, conversation_id, artifact_id, artifact_version, inspection_sheet_id,
         covered_reference_ids_json, verdict, observations_json, recorded_at)
        VALUES (?, ?, ?, 1, ?, ?, 'match', ?, 5)`).run(
        "legacy-visual",
        conversationId,
        "legacy-artifact",
        "legacy-sheet",
        JSON.stringify(["legacy-reference"]),
        JSON.stringify(observations),
      );
      legacy.prepare(`INSERT INTO visual_verification_batches
        (id, conversation_id, artifact_id, artifact_version, inspection_sheet_id, image_limit,
         active_reference_ids_json, batch_index, batch_count, covered_reference_ids_json,
         observations_json, final_verdict, synthesis, recorded_at)
        VALUES (?, ?, ?, 1, ?, 2, ?, 0, 1, ?, ?, 'match', 'Legacy match.', 5)`).run(
        "legacy-batch",
        conversationId,
        "legacy-artifact",
        "legacy-sheet",
        JSON.stringify(["legacy-reference"]),
        JSON.stringify(["legacy-reference"]),
        JSON.stringify(observations),
      );
      legacy.prepare(`INSERT INTO design_escalations
        (conversation_id, escalation_id, mutation_id, payload_json, kind, question,
         affected_specification_ids_json, basis, status, opened_after_message_seq, opened_at,
         resolved_at, resolution_specification_ids_json)
        VALUES (?, 'legacy-escalation', 'legacy-escalation-mutation', '{}', 'explicit-requirement-change',
          'Use the clarified width?', ?, 'The width changed.', 'resolved', 1, 5, 6, ?)`).run(
        conversationId,
        JSON.stringify(["plate-width"]),
        JSON.stringify(["plate-width"]),
      );
      const derivation = {
        planId: "plan-1",
        planRevision: 1,
        criteriaRevision: 1,
        sourceSpecificationIds: ["plate-width"],
        component: { id: "body", description: "Body" },
        criteria: [],
        plannedChecks: [],
        unavailableEvidence: [],
        invalidatedEvidenceIds: [],
        proofPolicy: { id: "proven-single-part-text", version: 1 },
        shapeProof: { status: "not-applicable", reason: "Legacy text proof." },
      };
      legacy.prepare(`INSERT INTO proof_contracts
        (contract_id, conversation_id, revision, plan_id, criteria_revision, registration_key, payload_json, frozen_at)
        VALUES ('legacy-contract', ?, 1, 'plan-1', 1, '', ?, 6)`).run(conversationId, JSON.stringify(derivation));
      legacy.close();

      const migrated = openDb(path);
      const first = projectEvidence(migrated, conversationId);
      migrated.close();
      const reopened = openDb(path);
      const second = projectEvidence(reopened, conversationId);

      expect(first.events.map((event) => event.recordedAt)).toEqual(
        first.events.map((event) => event.recordedAt).sort((left, right) => left - right),
      );
      expect(first.activePlan).toEqual(legacyPlan);
      expect(first.sourceSpecifications).toMatchObject([{
        id: "plate-width",
        actor: "migration",
        status: "active",
        source: { attachmentId: "legacy-reference" },
      }]);
      expect(first.referenceRecords).toMatchObject([{
        referenceId: "legacy-reference",
        status: "active",
        history: [{ id: "legacy-classification" }],
      }]);
      expect(first.referenceRegistrations).toMatchObject([{
        registrationId: "legacy-registration",
        revision: 1,
        status: "current",
      }]);
      expect(first.inspectionLeases).toMatchObject([{
        id: "legacy-lease",
        status: "closed",
        observation: { id: "legacy-observation" },
      }]);
      expect(first.visualVerificationBatches).toMatchObject([{ id: "legacy-batch", finalVerdict: "match" }]);
      expect(first.visualVerifications).toMatchObject([{ id: "legacy-visual", verdict: "match" }]);
      expect(first.designEscalations).toMatchObject([{ escalationId: "legacy-escalation", status: "resolved" }]);
      expect(first.proofContracts).toMatchObject([{ contractId: "legacy-contract", revision: 1, status: "current" }]);
      expect(second).toEqual(first);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the whole conversation when any transformed event fails", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Interrupted migration");
    db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at)
      VALUES (?, ?, 0, 'toolResult', ?, 1)`).run(
      "first-plan",
      conversation.id,
      JSON.stringify({
        role: "toolResult",
        toolName: "create_plan",
        details: { plan: { id: "plan-1", revision: 1 } },
      }),
    );
    db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at)
      VALUES (?, ?, 1, 'toolResult', ?, 2)`).run(
      "second-plan",
      conversation.id,
      JSON.stringify({
        role: "toolResult",
        toolName: "revise_plan",
        details: { plan: { id: "plan-1", revision: 2 } },
      }),
    );
    db.exec(`CREATE TRIGGER fail_second_migration_event
      BEFORE INSERT ON evidence_events WHEN NEW.sequence = 2
      BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END`);

    expect(() => migrateLegacyEvidence(db)).toThrow("fixture interruption");
    expect(projectEvidence(db, conversation.id).events).toEqual([]);
  });

  it("uses the host transaction boundary when one is available", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Hosted migration");
    db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at)
      VALUES (?, ?, 0, 'toolResult', ?, 1)`).run(
      "hosted-plan",
      conversation.id,
      JSON.stringify({
        role: "toolResult",
        toolName: "create_plan",
        details: { plan: { id: "plan-1", revision: 1 } },
      }),
    );
    const transactionSync = vi.fn(<T>(work: () => T): T => work());
    (db as unknown as { transactionSync: typeof transactionSync }).transactionSync = transactionSync;

    migrateLegacyEvidence(db);

    expect(transactionSync).toHaveBeenCalledOnce();
    expect(projectEvidence(db, conversation.id).events).toHaveLength(1);
  });

  it("moves legacy artifact verification payloads exclusively into the evidence ledger", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Verified legacy artifact");
    const gate = { status: "passed", checks: [] };
    const measurements = { bboxMm: [1, 1, 1], volumeMm3: 1, areaMm2: 6, children: [] };
    db.prepare(`INSERT INTO artifacts
      (id, conversation_id, version, py_source, gate_json, measurements_json, created_at)
      VALUES ('legacy-verified', ?, 1, 'result = Box(1, 1, 1)', ?, ?, 2)`)
      .run(conversation.id, JSON.stringify(gate), JSON.stringify(measurements));

    migrateLegacyEvidence(db);

    expect(projectEvidence(db, conversation.id).artifactVerifications).toMatchObject([{
      data: { artifactId: "legacy-verified", artifactVersion: 1, gate, measurements },
    }]);
    const linked = new ConversationEventStore(db).events(conversation.id)
      .find((event) => event.type === "evidence.linked" && event.data.relationship === "artifact");
    expect(linked).toBeDefined();
    expect(JSON.stringify(linked)).not.toContain("bboxMm");
  });

  it("does not backfill a current verification under a second migration identity", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Current verified artifact");
    const gate = { status: "passed" as const, checks: [] };
    const measurements = { bboxMm: [1, 1, 1] as [number, number, number], volumeMm3: 1, areaMm2: 6, children: [] };
    db.prepare(`INSERT INTO artifacts
      (id, conversation_id, version, py_source, gate_json, measurements_json, created_at)
      VALUES ('current-verified', ?, 1, 'result = Box(1, 1, 1)', ?, ?, 2)`)
      .run(conversation.id, JSON.stringify(gate), JSON.stringify(measurements));
    appendEvidenceEvent(db, conversation.id, {
      id: `${conversation.id}:artifact:current-verified:verified`,
      type: "artifact.verified",
      data: { artifactId: "current-verified", artifactVersion: 1, gate, measurements },
      recordedAt: 2,
    });

    expect(() => migrateLegacyEvidence(db)).not.toThrow();
    expect(projectEvidence(db, conversation.id).artifactVerifications).toHaveLength(1);
  });
});
