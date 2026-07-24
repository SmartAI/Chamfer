import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrateLegacyEvidence } from "./evidenceMigration";
import { migrateConversationEventLog } from "./conversationEventStore";

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  initializeSchema(db);
  return db;
}

/** Creates the schema and applies migrations. Runtime-agnostic: callers hand in
 * any DatabaseSync-shaped handle (node:sqlite locally, the Durable Object SQL
 * shim online), so nothing in here may touch the filesystem or PRAGMAs that
 * only node:sqlite supports. */
export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cad_environment TEXT NOT NULL DEFAULT 'build123d' CHECK (cad_environment IN ('build123d', 'fusion')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source_specifications_required INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(conversation_id, seq)
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id),
      kind TEXT NOT NULL,
      mime TEXT NOT NULL,
      data BLOB,
      content_hash TEXT,
      byte_size INTEGER,
      blob_path TEXT,
      display_order INTEGER
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      version INTEGER NOT NULL,
      py_source TEXT NOT NULL,
      params_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(conversation_id, version)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS headless_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'completed', 'stopped', 'crashed')),
      model_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      resumable INTEGER NOT NULL CHECK (resumable IN (0, 1)),
      last_event_seq INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS headless_runs_conversation_idx
      ON headless_runs(conversation_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS agent_run_leases (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
      run_id TEXT NOT NULL UNIQUE REFERENCES headless_runs(id),
      driver TEXT NOT NULL CHECK (driver IN ('browser', 'headless')),
      holder_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS headless_run_events (
      run_id TEXT NOT NULL REFERENCES headless_runs(id),
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS headless_run_latest (
      run_id TEXT NOT NULL REFERENCES headless_runs(id),
      kind TEXT NOT NULL CHECK (kind IN ('session', 'mesh')),
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, kind)
    );
    CREATE TABLE IF NOT EXISTS cad_gate_evidence (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES headless_runs(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      code_sha256 TEXT NOT NULL,
      gate_json TEXT NOT NULL,
      measurements_json TEXT NOT NULL,
      witnessed_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cad_gate_evidence_artifact_idx ON cad_gate_evidence(artifact_id);
    CREATE TRIGGER IF NOT EXISTS cad_gate_evidence_no_update
      BEFORE UPDATE ON cad_gate_evidence BEGIN SELECT RAISE(ABORT, 'CAD gate evidence is immutable'); END;
    CREATE TABLE IF NOT EXISTS evidence_events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      UNIQUE(conversation_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS evidence_events_conversation_idx
      ON evidence_events(conversation_id, sequence);
    CREATE TABLE IF NOT EXISTS evidence_deletion_authorizations (
      conversation_id TEXT PRIMARY KEY
    );
    CREATE TRIGGER IF NOT EXISTS evidence_events_no_update
      BEFORE UPDATE ON evidence_events BEGIN SELECT RAISE(ABORT, 'Evidence ledger is immutable'); END;
    DROP TRIGGER IF EXISTS evidence_events_no_delete;
    CREATE TRIGGER evidence_events_no_delete
      BEFORE DELETE ON evidence_events
      WHEN NOT EXISTS (
        SELECT 1 FROM evidence_deletion_authorizations
        WHERE conversation_id = OLD.conversation_id
      )
      BEGIN SELECT RAISE(ABORT, 'Evidence ledger is immutable'); END;
    CREATE TABLE IF NOT EXISTS conversation_events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      UNIQUE(conversation_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS conversation_events_conversation_idx
      ON conversation_events(conversation_id, sequence);
    CREATE TABLE IF NOT EXISTS conversation_event_deletion_authorizations (
      conversation_id TEXT PRIMARY KEY
    );
    CREATE TRIGGER IF NOT EXISTS conversation_events_no_update
      BEFORE UPDATE ON conversation_events BEGIN SELECT RAISE(ABORT, 'Conversation event log is immutable'); END;
    DROP TRIGGER IF EXISTS conversation_events_no_delete;
    CREATE TRIGGER conversation_events_no_delete
      BEFORE DELETE ON conversation_events
      WHEN NOT EXISTS (
        SELECT 1 FROM conversation_event_deletion_authorizations
        WHERE conversation_id = OLD.conversation_id
      )
      BEGIN SELECT RAISE(ABORT, 'Conversation event log is immutable'); END;
    CREATE TABLE IF NOT EXISTS conversation_ui_projection (
      conversation_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY(conversation_id, key)
    );
    CREATE TABLE IF NOT EXISTS conversation_evidence_links (
      conversation_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY(conversation_id, evidence_id, relationship)
    );
  `);
  migrateDb(db);
}

/** Additive migrations for databases created before a column existed. */
export function migrateDb(db: DatabaseSync): void {
  db.exec("DROP TRIGGER IF EXISTS cad_gate_evidence_no_delete");
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "cad_environment")) {
    db.exec("ALTER TABLE conversations ADD COLUMN cad_environment TEXT NOT NULL DEFAULT 'build123d'");
  }
  if (!columns.some((column) => column.name === "last_gate_status")) {
    db.exec("ALTER TABLE conversations ADD COLUMN last_gate_status TEXT");
  }
  if (!columns.some((column) => column.name === "source_specifications_required")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_specifications_required INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "design_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN design_id TEXT");
  }

  const artifactColumns = new Set((db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!artifactColumns.has("gate_json")) db.exec("ALTER TABLE artifacts ADD COLUMN gate_json TEXT");
  if (!artifactColumns.has("measurements_json")) db.exec("ALTER TABLE artifacts ADD COLUMN measurements_json TEXT");

  const attachmentColumns = db.prepare("PRAGMA table_info(attachments)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const dataColumn = attachmentColumns.find((column) => column.name === "data");
  if (dataColumn?.notnull === 1) {
    db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON");
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE attachments RENAME TO attachments_legacy;
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id),
          kind TEXT NOT NULL,
          mime TEXT NOT NULL,
          data BLOB,
          content_hash TEXT,
          byte_size INTEGER,
          blob_path TEXT,
          display_order INTEGER
        );
        INSERT INTO attachments (id, message_id, kind, mime, data)
          SELECT id, message_id, kind, mime, data FROM attachments_legacy;
        DROP TABLE attachments_legacy;
        COMMIT;
      `);
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON");
    }
  } else {
    const currentNames = new Set(attachmentColumns.map((column) => column.name));
    if (!currentNames.has("content_hash")) db.exec("ALTER TABLE attachments ADD COLUMN content_hash TEXT");
    if (!currentNames.has("byte_size")) db.exec("ALTER TABLE attachments ADD COLUMN byte_size INTEGER");
    if (!currentNames.has("blob_path")) db.exec("ALTER TABLE attachments ADD COLUMN blob_path TEXT");
    if (!currentNames.has("display_order")) db.exec("ALTER TABLE attachments ADD COLUMN display_order INTEGER");
  }
  // This table must be created after a legacy attachments table is rebuilt. Creating
  // it before ALTER TABLE ... RENAME can rewrite its FK to attachments_legacy.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fusion_document_bindings (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
      endpoint TEXT NOT NULL,
      document_id TEXT NOT NULL,
      document_name TEXT NOT NULL,
      data_file_id TEXT,
      data_file_version_id TEXT,
      data_file_version_number INTEGER,
      role TEXT NOT NULL CHECK (role IN ('owner', 'read-only')),
      resumable INTEGER NOT NULL DEFAULT 1 CHECK (resumable IN (0, 1)),
      bound_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS fusion_document_bindings_endpoint_owner_idx
      ON fusion_document_bindings(endpoint) WHERE role = 'owner';
    CREATE TABLE IF NOT EXISTS fusion_inspections (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      revision TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      screenshots_json TEXT NOT NULL,
      camera_restored INTEGER NOT NULL CHECK (camera_restored IN (0, 1)),
      captured_at INTEGER NOT NULL,
      stale_at INTEGER,
      UNIQUE(conversation_id, revision)
    );
    CREATE INDEX IF NOT EXISTS fusion_inspections_conversation_idx
      ON fusion_inspections(conversation_id, captured_at DESC);
    CREATE TABLE IF NOT EXISTS fusion_reconciliation_ledger (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      preceding_revision TEXT NOT NULL,
      observed_revision TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reconciled', 'needs-user')),
      reason TEXT NOT NULL,
      summary TEXT NOT NULL,
      changes_json TEXT NOT NULL,
      refreshed_references_json TEXT NOT NULL,
      refreshed_checks_json TEXT NOT NULL,
      evidence_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fusion_reconciliation_conversation_idx
      ON fusion_reconciliation_ledger(conversation_id, recorded_at);
    CREATE TRIGGER IF NOT EXISTS fusion_reconciliation_ledger_no_update
      BEFORE UPDATE ON fusion_reconciliation_ledger BEGIN SELECT RAISE(ABORT, 'Fusion reconciliation ledger is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS fusion_reconciliation_ledger_no_delete
      BEFORE DELETE ON fusion_reconciliation_ledger BEGIN SELECT RAISE(ABORT, 'Fusion reconciliation ledger is immutable'); END;
    CREATE TABLE IF NOT EXISTS fusion_reconciliation_resolutions (
      id TEXT PRIMARY KEY,
      reconciliation_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      expected_revision TEXT,
      intent TEXT,
      affected_references_json TEXT,
      recorded_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS fusion_reconciliation_resolutions_no_update
      BEFORE UPDATE ON fusion_reconciliation_resolutions BEGIN SELECT RAISE(ABORT, 'Fusion reconciliation resolution ledger is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS fusion_reconciliation_resolutions_no_delete
      BEFORE DELETE ON fusion_reconciliation_resolutions BEGIN SELECT RAISE(ABORT, 'Fusion reconciliation resolution ledger is immutable'); END;
    CREATE TABLE IF NOT EXISTS fusion_action_ledger (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('attempt', 'rejected', 'failed', 'rollback', 'completed')),
      recorded_at INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      expected_revision TEXT NOT NULL,
      observed_revision TEXT,
      final_revision TEXT,
      model_json TEXT NOT NULL,
      skills_json TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      intent TEXT NOT NULL,
      body_sha256 TEXT NOT NULL,
      affected_references_json TEXT NOT NULL,
      expected_effects_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fusion_action_ledger_conversation_idx
      ON fusion_action_ledger(conversation_id, recorded_at);
    CREATE TRIGGER IF NOT EXISTS fusion_action_ledger_no_update
      BEFORE UPDATE ON fusion_action_ledger BEGIN SELECT RAISE(ABORT, 'Fusion action ledger is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS fusion_action_ledger_no_delete
      BEFORE DELETE ON fusion_action_ledger BEGIN SELECT RAISE(ABORT, 'Fusion action ledger is immutable'); END;
    CREATE TABLE IF NOT EXISTS fusion_action_operational_context (
      action_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      affected_references_json TEXT NOT NULL,
      expected_effects_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, action_id)
    );
    CREATE INDEX IF NOT EXISTS fusion_action_operational_conversation_idx
      ON fusion_action_operational_context(conversation_id, recorded_at);
    CREATE TRIGGER IF NOT EXISTS fusion_action_operational_no_update
      BEFORE UPDATE ON fusion_action_operational_context BEGIN SELECT RAISE(ABORT, 'Fusion action operational context is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS fusion_action_operational_no_delete
      BEFORE DELETE ON fusion_action_operational_context BEGIN SELECT RAISE(ABORT, 'Fusion action operational context is immutable'); END;
    CREATE TABLE IF NOT EXISTS fusion_recovery_ledger (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      action_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('diagnosing', 'hard-recovery', 'resolved')),
      failure_class TEXT NOT NULL,
      diagnosis TEXT NOT NULL,
      allowed_operation TEXT NOT NULL,
      preceding_revision TEXT NOT NULL,
      observed_revision TEXT,
      evidence_ids_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fusion_recovery_ledger_endpoint_idx
      ON fusion_recovery_ledger(endpoint, recorded_at);
    CREATE TRIGGER IF NOT EXISTS fusion_recovery_ledger_no_update
      BEFORE UPDATE ON fusion_recovery_ledger BEGIN SELECT RAISE(ABORT, 'Fusion recovery ledger is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS fusion_recovery_ledger_no_delete
      BEFORE DELETE ON fusion_recovery_ledger BEGIN SELECT RAISE(ABORT, 'Fusion recovery ledger is immutable'); END;
    CREATE TABLE IF NOT EXISTS fusion_save_evidence (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      preceding_document_json TEXT NOT NULL,
      resulting_document_json TEXT NOT NULL,
      revision TEXT NOT NULL,
      inspection_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fusion_save_evidence_conversation_idx
      ON fusion_save_evidence(conversation_id, captured_at);
    CREATE TRIGGER IF NOT EXISTS fusion_save_evidence_no_update
      BEFORE UPDATE ON fusion_save_evidence BEGIN SELECT RAISE(ABORT, 'Fusion Save evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS fusion_save_evidence_no_delete
      BEFORE DELETE ON fusion_save_evidence BEGIN SELECT RAISE(ABORT, 'Fusion Save evidence is immutable'); END;
    CREATE TABLE IF NOT EXISTS reference_classifications (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      reference_id TEXT NOT NULL REFERENCES attachments(id),
      status TEXT NOT NULL,
      purpose TEXT NOT NULL,
      relationships_json TEXT NOT NULL,
      rationale TEXT NOT NULL,
      specification_links_json TEXT NOT NULL,
      specification_ids_json TEXT,
      legacy_specification_links_json TEXT,
      no_specification_reason TEXT,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reference_classifications_reference_idx
      ON reference_classifications(conversation_id, reference_id, created_at);
    CREATE TABLE IF NOT EXISTS inspection_leases (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      purpose TEXT NOT NULL,
      status TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS inspection_lease_evidence (
      lease_id TEXT NOT NULL REFERENCES inspection_leases(id),
      attachment_id TEXT NOT NULL REFERENCES attachments(id),
      display_order INTEGER NOT NULL,
      PRIMARY KEY (lease_id, attachment_id)
    );
    CREATE TABLE IF NOT EXISTS inspection_observations (
      id TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL UNIQUE REFERENCES inspection_leases(id),
      relevant_views_json TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      affected_specifications_json TEXT NOT NULL,
      affected_components_json TEXT NOT NULL,
      no_affected_entity_reason TEXT,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inspection_leases_conversation_status_idx
      ON inspection_leases(conversation_id, status, opened_at);
    CREATE TABLE IF NOT EXISTS visual_verifications (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      artifact_version INTEGER NOT NULL,
      inspection_sheet_id TEXT NOT NULL REFERENCES attachments(id),
      visual_comparison_evidence_id TEXT NOT NULL DEFAULT 'legacy-unmeasured',
      covered_reference_ids_json TEXT NOT NULL,
      verdict TEXT NOT NULL,
      observations_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS visual_verifications_conversation_idx
      ON visual_verifications(conversation_id, recorded_at);
    CREATE TABLE IF NOT EXISTS visual_verification_batches (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      artifact_version INTEGER NOT NULL,
      inspection_sheet_id TEXT NOT NULL REFERENCES attachments(id),
      visual_comparison_evidence_id TEXT NOT NULL DEFAULT 'legacy-unmeasured',
      image_limit INTEGER NOT NULL,
      active_reference_ids_json TEXT NOT NULL,
      batch_index INTEGER NOT NULL,
      batch_count INTEGER NOT NULL,
      covered_reference_ids_json TEXT NOT NULL,
      observations_json TEXT NOT NULL,
      final_verdict TEXT,
      synthesis TEXT,
      recorded_at INTEGER NOT NULL,
      UNIQUE(conversation_id, artifact_id, artifact_version, inspection_sheet_id, batch_index)
    );
    CREATE INDEX IF NOT EXISTS visual_verification_batches_identity_idx
      ON visual_verification_batches(conversation_id, artifact_id, artifact_version, inspection_sheet_id, batch_index);
    CREATE TABLE IF NOT EXISTS source_specification_mutations (
      id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, id)
    );
    CREATE TABLE IF NOT EXISTS source_specifications (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      id TEXT NOT NULL,
      requirement TEXT NOT NULL,
      source_message_id TEXT NOT NULL REFERENCES messages(id),
      source_text TEXT NOT NULL,
      source_start INTEGER NOT NULL,
      source_end INTEGER NOT NULL,
      source_attachment_id TEXT REFERENCES attachments(id),
      source_region_json TEXT,
      source_observation TEXT,
      supersedes_specification_id TEXT,
      conflicts_with_specification_ids_json TEXT NOT NULL DEFAULT '[]',
      actor TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      mutation_id TEXT NOT NULL,
      mutation_order INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, id),
      FOREIGN KEY (conversation_id, mutation_id)
        REFERENCES source_specification_mutations(conversation_id, id)
    );
    CREATE INDEX IF NOT EXISTS source_specifications_source_idx
      ON source_specifications(conversation_id, source_message_id, source_start, mutation_order);
    CREATE TABLE IF NOT EXISTS source_specification_supersessions (
      conversation_id TEXT NOT NULL,
      replacement_specification_id TEXT NOT NULL,
      superseded_specification_id TEXT NOT NULL,
      PRIMARY KEY (conversation_id, superseded_specification_id),
      FOREIGN KEY (conversation_id, replacement_specification_id)
        REFERENCES source_specifications(conversation_id, id),
      FOREIGN KEY (conversation_id, superseded_specification_id)
        REFERENCES source_specifications(conversation_id, id)
    );
    CREATE TABLE IF NOT EXISTS design_escalations (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      escalation_id TEXT NOT NULL,
      mutation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      kind TEXT NOT NULL,
      question TEXT NOT NULL,
      affected_specification_ids_json TEXT NOT NULL,
      basis TEXT NOT NULL,
      status TEXT NOT NULL,
      opened_after_message_seq INTEGER NOT NULL,
      opened_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution_specification_ids_json TEXT,
      PRIMARY KEY (conversation_id, escalation_id),
      UNIQUE (conversation_id, mutation_id)
    );
    CREATE TABLE IF NOT EXISTS proof_contracts (
      contract_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      revision INTEGER NOT NULL,
      plan_id TEXT NOT NULL,
      criteria_revision INTEGER NOT NULL,
      registration_key TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      frozen_at INTEGER NOT NULL,
      PRIMARY KEY (contract_id, revision),
      UNIQUE (conversation_id, plan_id, criteria_revision, registration_key)
    );
    CREATE INDEX IF NOT EXISTS proof_contracts_conversation_idx
      ON proof_contracts(conversation_id, frozen_at, revision);
    CREATE TABLE IF NOT EXISTS reference_registrations (
      event_id TEXT NOT NULL,
      registration_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      reference_id TEXT NOT NULL REFERENCES attachments(id),
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      eligibility_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, event_id),
      UNIQUE (conversation_id, reference_id, revision)
    );
    CREATE INDEX IF NOT EXISTS reference_registrations_conversation_idx
      ON reference_registrations(conversation_id, reference_id, revision);
    CREATE TABLE IF NOT EXISTS proof_reports (
      report_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      proof_contract_id TEXT NOT NULL,
      proof_contract_revision INTEGER NOT NULL,
      plan_id TEXT NOT NULL,
      criteria_revision INTEGER NOT NULL,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      artifact_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (conversation_id, artifact_id, artifact_version)
    );
    CREATE INDEX IF NOT EXISTS proof_reports_conversation_idx
      ON proof_reports(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS proof_report_requests (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      idempotency_key TEXT NOT NULL,
      report_id TEXT NOT NULL REFERENCES proof_reports(report_id),
      request_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      status TEXT NOT NULL,
      outcome TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      total_duration_ms INTEGER,
      release TEXT NOT NULL,
      agent_configuration_json TEXT NOT NULL,
      evaluation_json TEXT,
      last_seq INTEGER NOT NULL,
      counters_json TEXT NOT NULL,
      durations_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_runs_conversation_started_idx
      ON agent_runs(conversation_id, started_at);
    CREATE TABLE IF NOT EXISTS agent_run_events (
      run_id TEXT NOT NULL REFERENCES agent_runs(id),
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS agent_run_trace_refs (
      run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
      trace_id TEXT NOT NULL,
      observation_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_run_feedback (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      run_id TEXT NOT NULL REFERENCES agent_runs(id),
      rating TEXT NOT NULL,
      release TEXT NOT NULL,
      agent_configuration_hash TEXT NOT NULL,
      score_name TEXT NOT NULL,
      score_provenance TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sync_status TEXT NOT NULL,
      UNIQUE(conversation_id, run_id, score_name)
    );
    CREATE TABLE IF NOT EXISTS online_run_scores (
      run_id TEXT PRIMARY KEY,
      release TEXT NOT NULL,
      agent_configuration_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      modality TEXT NOT NULL,
      score_provenance TEXT NOT NULL,
      score_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS online_review_inventory (
      run_id TEXT PRIMARY KEY,
      reasons_json TEXT NOT NULL,
      sampling_policy_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS online_review_queue_refs (
      run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
      queue_id TEXT NOT NULL,
      queue_item_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      reasons_json TEXT NOT NULL,
      score_provenance TEXT NOT NULL,
      review_reference TEXT NOT NULL,
      synced_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS online_failure_signatures (
      signature TEXT PRIMARY KEY,
      first_run_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const fusionBindingColumns = new Set(
    (db.prepare("PRAGMA table_info(fusion_document_bindings)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  const visualVerificationColumns = new Set(
    (db.prepare("PRAGMA table_info(visual_verifications)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!visualVerificationColumns.has("visual_comparison_evidence_id")) {
    db.exec("ALTER TABLE visual_verifications ADD COLUMN visual_comparison_evidence_id TEXT NOT NULL DEFAULT 'legacy-unmeasured'");
  }
  const visualBatchColumns = new Set(
    (db.prepare("PRAGMA table_info(visual_verification_batches)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!visualBatchColumns.has("visual_comparison_evidence_id")) {
    db.exec("ALTER TABLE visual_verification_batches ADD COLUMN visual_comparison_evidence_id TEXT NOT NULL DEFAULT 'legacy-unmeasured'");
  }
  if (!fusionBindingColumns.has("data_file_version_id")) {
    db.exec("ALTER TABLE fusion_document_bindings ADD COLUMN data_file_version_id TEXT");
  }
  if (!fusionBindingColumns.has("data_file_version_number")) {
    db.exec("ALTER TABLE fusion_document_bindings ADD COLUMN data_file_version_number INTEGER");
  }

  const proofContractColumns = new Set((db.prepare("PRAGMA table_info(proof_contracts)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!proofContractColumns.has("registration_key")) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE proof_contracts RENAME TO proof_contracts_legacy;
      CREATE TABLE proof_contracts (
        contract_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        revision INTEGER NOT NULL,
        plan_id TEXT NOT NULL,
        criteria_revision INTEGER NOT NULL,
        registration_key TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        frozen_at INTEGER NOT NULL,
        PRIMARY KEY (contract_id, revision),
        UNIQUE (conversation_id, plan_id, criteria_revision, registration_key)
      );
      INSERT INTO proof_contracts
        (contract_id, conversation_id, revision, plan_id, criteria_revision, registration_key, payload_json, frozen_at)
      SELECT contract_id, conversation_id, revision, plan_id, criteria_revision, '', payload_json, frozen_at
      FROM proof_contracts_legacy;
      DROP TABLE proof_contracts_legacy;
      CREATE INDEX proof_contracts_conversation_idx
        ON proof_contracts(conversation_id, frozen_at, revision);
      COMMIT;
    `);
  }

  const classificationColumns = new Set((db.prepare("PRAGMA table_info(reference_classifications)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!classificationColumns.has("specification_ids_json")) {
    db.exec("ALTER TABLE reference_classifications ADD COLUMN specification_ids_json TEXT");
  }
  if (!classificationColumns.has("legacy_specification_links_json")) {
    db.exec("ALTER TABLE reference_classifications ADD COLUMN legacy_specification_links_json TEXT");
  }

  const specificationColumns = new Set((db.prepare("PRAGMA table_info(source_specifications)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!specificationColumns.has("source_attachment_id")) {
    db.exec("ALTER TABLE source_specifications ADD COLUMN source_attachment_id TEXT REFERENCES attachments(id)");
  }
  if (!specificationColumns.has("source_region_json")) {
    db.exec("ALTER TABLE source_specifications ADD COLUMN source_region_json TEXT");
  }
  if (!specificationColumns.has("source_observation")) {
    db.exec("ALTER TABLE source_specifications ADD COLUMN source_observation TEXT");
  }
  if (!specificationColumns.has("supersedes_specification_id")) {
    db.exec("ALTER TABLE source_specifications ADD COLUMN supersedes_specification_id TEXT");
  }
  if (!specificationColumns.has("conflicts_with_specification_ids_json")) {
    db.exec("ALTER TABLE source_specifications ADD COLUMN conflicts_with_specification_ids_json TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec(`
    INSERT OR IGNORE INTO source_specification_supersessions
      (conversation_id, replacement_specification_id, superseded_specification_id)
    SELECT conversation_id, id, supersedes_specification_id
    FROM source_specifications
    WHERE supersedes_specification_id IS NOT NULL;
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS source_specifications_single_superseder_idx
      ON source_specifications(conversation_id, supersedes_specification_id)
      WHERE supersedes_specification_id IS NOT NULL;
  `);
  migrateLegacySpecificationLinks(db);
  migrateDesignAggregates(db);
  migrateConversationEventLog(db);
  migrateLegacyEvidence(db);
  db.exec(`
    DROP TABLE IF EXISTS proof_report_requests;
    DROP TABLE IF EXISTS proof_reports;
    DROP TABLE IF EXISTS proof_contracts;
    DROP TABLE IF EXISTS design_escalations;
    DROP TABLE IF EXISTS source_specification_supersessions;
    DROP TABLE IF EXISTS reference_registrations;
    DROP TABLE IF EXISTS visual_verification_batches;
    DROP TABLE IF EXISTS visual_verifications;
    DROP TABLE IF EXISTS inspection_observations;
    DROP TABLE IF EXISTS inspection_lease_evidence;
    DROP TABLE IF EXISTS inspection_leases;
    DROP TABLE IF EXISTS reference_classifications;
    DROP TABLE IF EXISTS source_specifications;
    DROP TABLE IF EXISTS source_specification_mutations;
  `);
}

/** Introduces an independent design lifecycle and promotes only legacy artifacts
 * that can be tied to persisted passing gate evidence. Safe to run repeatedly. */
function migrateDesignAggregates(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS designs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      cad_environment TEXT NOT NULL CHECK (cad_environment IN ('build123d', 'fusion')),
      current_revision INTEGER,
      provenance_design_id TEXT,
      provenance_revision INTEGER,
      fusion_document_id TEXT,
      fusion_document_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS design_revisions (
      id TEXT PRIMARY KEY,
      design_id TEXT NOT NULL REFERENCES designs(id),
      revision INTEGER NOT NULL,
      py_source TEXT,
      parameters_json TEXT NOT NULL DEFAULT '[]',
      gate_json TEXT NOT NULL,
      measurements_json TEXT,
      source_conversation_id TEXT,
      source_artifact_id TEXT,
      fusion_revision TEXT,
      source_fusion_action_id TEXT,
      provenance_design_id TEXT,
      provenance_revision INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(design_id, revision)
    );
    CREATE TABLE IF NOT EXISTS design_revision_gate_evidence (
      design_revision_id TEXT PRIMARY KEY REFERENCES design_revisions(id),
      source_evidence_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      source_conversation_id TEXT NOT NULL,
      source_artifact_id TEXT NOT NULL,
      code_sha256 TEXT NOT NULL,
      gate_json TEXT NOT NULL,
      measurements_json TEXT NOT NULL,
      witnessed_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS design_revisions_source_artifact_idx
      ON design_revisions(source_artifact_id) WHERE source_artifact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS conversations_design_idx ON conversations(design_id);
  `);
  const revisionColumns = new Set((db.prepare("PRAGMA table_info(design_revisions)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!revisionColumns.has("fusion_revision")) db.exec("ALTER TABLE design_revisions ADD COLUMN fusion_revision TEXT");
  if (!revisionColumns.has("source_fusion_action_id")) {
    db.exec("ALTER TABLE design_revisions ADD COLUMN source_fusion_action_id TEXT");
  }
  db.exec(`DROP INDEX IF EXISTS design_revisions_source_fusion_action_idx`);
  db.exec(`CREATE UNIQUE INDEX design_revisions_source_fusion_action_idx
    ON design_revisions(source_conversation_id, source_fusion_action_id)
    WHERE source_fusion_action_id IS NOT NULL`);

  const conversations = db.prepare(`
    SELECT id, title, cad_environment AS cadEnvironment, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE design_id IS NULL ORDER BY created_at, rowid
  `).all() as Array<{
    id: string;
    title: string;
    cadEnvironment: "build123d" | "fusion";
    createdAt: number;
    updatedAt: number;
  }>;
  if (conversations.length === 0) return;

  const fusionBindingsExist = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fusion_document_bindings'",
  ).get() !== undefined;
  const insertDesign = db.prepare(`
    INSERT OR IGNORE INTO designs
      (id, name, description, cad_environment, current_revision, fusion_document_id,
       fusion_document_name, created_at, updated_at)
    VALUES (?, ?, '', ?, NULL, ?, ?, ?, ?)
  `);
  const insertRevision = db.prepare(`
    INSERT OR IGNORE INTO design_revisions
      (id, design_id, revision, py_source, parameters_json, gate_json, measurements_json,
       source_conversation_id, source_artifact_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const conversation of conversations) {
      const binding = fusionBindingsExist && conversation.cadEnvironment === "fusion"
        ? db.prepare(`SELECT document_id AS documentId, document_name AS documentName
            FROM fusion_document_bindings WHERE conversation_id = ?`).get(conversation.id) as
            { documentId: string; documentName: string } | undefined
        : undefined;
      const sharedFusion = binding
        ? db.prepare(`SELECT c.design_id AS designId FROM fusion_document_bindings b
            JOIN conversations c ON c.id = b.conversation_id
            WHERE b.document_id = ? AND c.design_id IS NOT NULL LIMIT 1`).get(binding.documentId) as
            { designId: string } | undefined
        : undefined;
      const designId = sharedFusion?.designId ?? `legacy-design:${conversation.id}`;
      insertDesign.run(
        designId,
        conversation.title,
        conversation.cadEnvironment,
        binding?.documentId ?? null,
        binding?.documentName ?? null,
        conversation.createdAt,
        conversation.updatedAt,
      );
      db.prepare("UPDATE conversations SET design_id = ? WHERE id = ?").run(designId, conversation.id);
      if (conversation.cadEnvironment === "fusion") {
        const completed = db.prepare(`SELECT action_id AS actionId, final_revision AS finalRevision,
            result_json AS resultJson, recorded_at AS recordedAt
            FROM fusion_action_ledger
            WHERE conversation_id = ? AND event = 'completed' AND final_revision IS NOT NULL
            ORDER BY recorded_at DESC, rowid DESC LIMIT 1`).get(conversation.id) as {
          actionId: string;
          finalRevision: string;
          resultJson: string;
          recordedAt: number;
        } | undefined;
        if (!completed) continue;
        try {
          const result = JSON.parse(completed.resultJson) as {
            checks?: Array<{ kind?: unknown; status?: unknown; detail?: unknown }>;
          };
          const checks = result.checks ?? [];
          if (checks.length === 0 || checks.some((check) => check.status !== "passed")) continue;
          const next = db.prepare(`SELECT COALESCE(MAX(revision), 0) + 1 AS revision
            FROM design_revisions WHERE design_id = ?`).get(designId) as { revision: number };
          const gate = {
            status: "passed",
            checks: checks.map((check) => ({
              name: typeof check.kind === "string" ? check.kind : "fusion-check",
              passed: true,
              detail: typeof check.detail === "string" ? check.detail : "Passed",
            })),
          };
          db.prepare(`INSERT OR IGNORE INTO design_revisions
            (id, design_id, revision, py_source, parameters_json, gate_json, measurements_json,
             source_conversation_id, fusion_revision, source_fusion_action_id, created_at)
            VALUES (?, ?, ?, NULL, '[]', ?, NULL, ?, ?, ?, ?)`)
            .run(
              `legacy-fusion-revision:${conversation.id}:${completed.actionId}`,
              designId,
              next.revision,
              JSON.stringify(gate),
              conversation.id,
              completed.finalRevision,
              completed.actionId,
              completed.recordedAt,
            );
          db.prepare("UPDATE designs SET current_revision = ?, updated_at = ? WHERE id = ?")
            .run(next.revision, Math.max(conversation.updatedAt, completed.recordedAt), designId);
        } catch {
          // Invalid historical action evidence cannot establish an accepted revision.
        }
        continue;
      }
      if (sharedFusion) continue;

      const messages = db.prepare(
        "SELECT content_json AS contentJson FROM messages WHERE conversation_id = ? AND role = 'toolResult' ORDER BY seq",
      ).all(conversation.id) as Array<{ contentJson: string }>;
      const evidenceByArtifact = new Map<string, { gateJson: string; measurementsJson: string | null }>();
      for (const message of messages) {
        try {
          const parsed = JSON.parse(message.contentJson) as {
            details?: { code?: { artifactId?: unknown }; gate?: { status?: unknown }; measurements?: unknown };
          };
          const artifactId = parsed.details?.code?.artifactId;
          if (typeof artifactId !== "string" || parsed.details?.gate?.status !== "passed") continue;
          evidenceByArtifact.set(artifactId, {
            gateJson: JSON.stringify(parsed.details.gate),
            measurementsJson: parsed.details.measurements === undefined
              ? null
              : JSON.stringify(parsed.details.measurements),
          });
        } catch {
          // Malformed historical transcripts remain readable but cannot establish acceptance evidence.
        }
      }
      const artifacts = db.prepare(`SELECT id, py_source AS pySource, params_json AS paramsJson,
          gate_json AS gateJson, measurements_json AS measurementsJson, created_at AS createdAt
          FROM artifacts WHERE conversation_id = ? ORDER BY version, rowid`).all(conversation.id) as Array<{
        id: string;
        pySource: string;
        paramsJson: string | null;
        gateJson: string | null;
        measurementsJson: string | null;
        createdAt: number;
      }>;
      let revision = 0;
      for (const artifact of artifacts) {
        let storedGate: { status?: unknown } | undefined;
        try {
          storedGate = artifact.gateJson ? JSON.parse(artifact.gateJson) as { status?: unknown } : undefined;
        } catch {
          storedGate = undefined;
        }
        const historical = evidenceByArtifact.get(artifact.id);
        if (storedGate?.status !== "passed" && !historical) continue;
        revision += 1;
        insertRevision.run(
          `legacy-revision:${artifact.id}`,
          designId,
          revision,
          artifact.pySource,
          artifact.paramsJson ?? "[]",
          artifact.gateJson ?? historical!.gateJson,
          artifact.measurementsJson ?? historical?.measurementsJson ?? null,
          conversation.id,
          artifact.id,
          artifact.createdAt,
        );
      }
      if (revision > 0) {
        db.prepare("UPDATE designs SET current_revision = ? WHERE id = ?").run(revision, designId);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const SPECIFICATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function migratedSpecificationId(link: string): string {
  if (SPECIFICATION_ID_PATTERN.test(link)) return link;
  const hash = createHash("sha256").update(link).digest("hex").slice(0, 16);
  return `legacy.${hash}`;
}

/**
 * Preserve pre-durable string locators while binding every historical
 * classification to a real immutable specification identity.
 */
function migrateLegacySpecificationLinks(db: DatabaseSync): void {
  const rows = db.prepare(`
    SELECT rc.id, rc.conversation_id, rc.reference_id, rc.purpose,
      rc.specification_links_json, rc.created_at, a.message_id
    FROM reference_classifications rc
    JOIN attachments a ON a.id = rc.reference_id
    WHERE rc.specification_ids_json IS NULL
    ORDER BY rc.created_at ASC, rc.rowid ASC
  `).all() as Array<{
    id: string;
    conversation_id: string;
    reference_id: string;
    purpose: string;
    specification_links_json: string;
    created_at: number;
    message_id: string;
  }>;
  if (rows.length === 0) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const insertMutation = db.prepare(`
      INSERT OR IGNORE INTO source_specification_mutations
        (id, conversation_id, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertSpecification = db.prepare(`
      INSERT OR IGNORE INTO source_specifications
        (conversation_id, id, requirement, source_message_id, source_text,
         source_start, source_end, source_attachment_id, source_region_json,
         source_observation, supersedes_specification_id, actor, status,
         created_at, mutation_id, mutation_order)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, NULL, 'migration', 'active', ?, ?, 0)
    `);
    const updateClassification = db.prepare(`
      UPDATE reference_classifications
      SET specification_ids_json = ?, legacy_specification_links_json = ?
      WHERE id = ?
    `);

    for (const row of rows) {
      let links: string[] = [];
      try {
        const parsed = JSON.parse(row.specification_links_json);
        if (Array.isArray(parsed)) links = parsed.filter((value): value is string => typeof value === "string");
      } catch {
        links = [];
      }
      const migratedLinks = links
        .map((link) => link.trim())
        .filter((link) => link.length > 0)
        .map((legacyLink) => ({ legacyLink, specificationId: migratedSpecificationId(legacyLink) }));
      const uniqueMigratedLinks = migratedLinks.filter((candidate, index) =>
        migratedLinks.findIndex((other) => other.specificationId === candidate.specificationId) === index);
      const specificationIds = uniqueMigratedLinks.map(({ specificationId }) => specificationId);
      for (const { legacyLink, specificationId } of uniqueMigratedLinks) {
        const mutationId = `legacy-reference-specification:${specificationId}`;
        const observation = `Migrated legacy specification link ${JSON.stringify(legacyLink)} from reference classification history.`;
        insertMutation.run(
          mutationId,
          row.conversation_id,
          JSON.stringify({ migration: "reference-classification-string-link", legacyLink }),
          row.created_at,
        );
        insertSpecification.run(
          row.conversation_id,
          specificationId,
          `Legacy source requirement ${legacyLink}`,
          row.message_id,
          observation,
          observation.length,
          row.reference_id,
          observation,
          row.created_at,
          mutationId,
        );
      }
      updateClassification.run(JSON.stringify(specificationIds), JSON.stringify(links), row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
