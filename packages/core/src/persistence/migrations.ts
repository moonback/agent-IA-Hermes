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
];
