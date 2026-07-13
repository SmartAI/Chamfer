import { DatabaseSync } from "node:sqlite";
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
  if (!columns.some((column) => column.name === "last_gate_status")) {
    db.exec("ALTER TABLE conversations ADD COLUMN last_gate_status TEXT");
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
    CREATE TABLE IF NOT EXISTS reference_classifications (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      reference_id TEXT NOT NULL REFERENCES attachments(id),
      status TEXT NOT NULL,
      purpose TEXT NOT NULL,
      relationships_json TEXT NOT NULL,
      rationale TEXT NOT NULL,
      specification_links_json TEXT NOT NULL,
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
  `);
}
