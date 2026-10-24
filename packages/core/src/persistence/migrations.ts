/**
 * Versioned, forward-only migrations. Never edit an applied migration: append a new one.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT,
  result_json TEXT,
  budget_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX idx_missions_status ON missions(status);
CREATE INDEX idx_missions_created ON missions(created_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  objective TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  result_json TEXT,
  error TEXT,
  block_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (mission_id, step_id)
);
CREATE INDEX idx_tasks_mission ON tasks(mission_id);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  model TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  ai_calls INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_agent_runs_mission ON agent_runs(mission_id);
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent, started_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  description TEXT NOT NULL,
  consequences TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL,
  output_json TEXT,
  error TEXT,
  verified INTEGER,
  policy_decision TEXT,
  approval_id TEXT REFERENCES approvals(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER
);
CREATE INDEX idx_tool_calls_task ON tool_calls(task_id);
CREATE INDEX idx_tool_calls_mission ON tool_calls(mission_id, started_at);
CREATE INDEX idx_tool_calls_idem ON tool_calls(idempotency_key);

CREATE TABLE mission_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  mission_id TEXT,
  task_id TEXT,
  agent TEXT,
  tool_id TEXT,
  category TEXT NOT NULL,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX idx_events_mission ON mission_events(mission_id, seq);
CREATE INDEX idx_events_category ON mission_events(category, seq);

-- Audit log is append-only. Deletion is only possible during an explicit, logged purge
-- (see HermesStore.purgeHistory), which inserts the maintenance flag first.
CREATE TABLE maintenance_flags (name TEXT PRIMARY KEY);
CREATE TRIGGER mission_events_no_update BEFORE UPDATE ON mission_events
BEGIN SELECT RAISE(ABORT, 'mission_events est en ajout seul'); END;
CREATE TRIGGER mission_events_no_delete BEFORE DELETE ON mission_events
WHEN NOT EXISTS (SELECT 1 FROM maintenance_flags WHERE name = 'purge_events')
BEGIN SELECT RAISE(ABORT, 'suppression des evenements interdite hors purge explicite'); END;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
  task_id TEXT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  sha256 TEXT,
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_mission ON artifacts(mission_id);

CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  origin TEXT NOT NULL,
  mission_id TEXT,
  confidence REAL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_kind ON memory_entries(kind);

-- Non-secret settings only. Secrets live in the OS credential vault.
CREATE TABLE provider_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE model_assignments (
  role TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  fallbacks_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
`,
  },
  {
    version: 2,
    name: 'semantic memory (FTS5 + embeddings)',
    sql: `
-- Vector of the content (float32, little-endian) and the model that produced it.
ALTER TABLE memory_entries ADD COLUMN embedding BLOB;
ALTER TABLE memory_entries ADD COLUMN embedding_model TEXT;

-- BM25 keyword index kept in sync with memory_entries (external-content FTS5 table).
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  content='memory_entries',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
INSERT INTO memory_fts(rowid, content) SELECT rowid, content FROM memory_entries;
CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
-- A changed text invalidates its vector (recomputed in the background).
CREATE TRIGGER memory_fts_au AFTER UPDATE OF content ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
  UPDATE memory_entries SET embedding = NULL, embedding_model = NULL WHERE rowid = new.rowid;
END;
`,
  },
  {
    version: 3,
    name: 'scheduled triggers and artifact annotations',
    sql: `
-- Free-form metadata of an artifact (e.g. OCR lines or vision target boxes drawn on a capture).
ALTER TABLE artifacts ADD COLUMN meta_json TEXT;

CREATE TABLE scheduled_triggers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  mission_template TEXT NOT NULL,
  budget_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_start INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  last_mission_id TEXT,
  last_error TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE trigger_runs (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES scheduled_triggers(id) ON DELETE CASCADE,
  mission_id TEXT,
  fired_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  source_mission_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  request TEXT
);
CREATE INDEX idx_trigger_runs_trigger ON trigger_runs(trigger_id, fired_at);
CREATE INDEX idx_trigger_runs_mission ON trigger_runs(mission_id);
`,
  },
];
