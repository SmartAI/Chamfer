import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
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
  `);
  migrateDb(db);
  return db;
}

/** Additive migrations for databases created before a column existed. */
export function migrateDb(db: DatabaseSync): void {
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

  const attachmentColumns = db.prepare("PRAGMA table_info(attachments)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const dataColumn = attachmentColumns.find((column) => column.name === "data");
  if (dataColumn?.notnull === 1) {
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
