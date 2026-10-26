-- AgentBot schema v1
-- 时间统一为 epoch ms INTEGER。JSON 字段以 TEXT 存储并在 repo 层解析。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_definitions (
  id               TEXT PRIMARY KEY,
  adapter_name     TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('builtin','custom')),
  version          TEXT,
  command          TEXT NOT NULL,
  protocol         TEXT NOT NULL,
  capabilities     TEXT NOT NULL,            -- JSON CapabilitySet
  event_capabilities TEXT NOT NULL,          -- JSON EventType[]
  min_version      TEXT,
  health_status    TEXT NOT NULL DEFAULT 'unprobed',
  probe_detail     TEXT,
  last_probe_at    INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  persona             TEXT NOT NULL DEFAULT '',
  avatar              TEXT,
  default_runtime_id  TEXT REFERENCES runtime_definitions(id) ON DELETE SET NULL,
  -- 内置引擎绑定的模型供应商（providers.json 里的 id）；其它运行时为 NULL
  provider_id         TEXT,
  execution_location  TEXT NOT NULL DEFAULT 'local' CHECK (execution_location IN ('local','worktree')),
  -- 默认工作区（可空）：会话/群聊未指定时回退到这里；内置引擎直接用作 cwd
  repo_path           TEXT,
  worktree_path       TEXT,
  worktree_state      TEXT,                  -- ready | missing | failed
  -- 管理员 Bot 多一个 create_bot 工具；不自动获得 full 权限
  role                TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  -- Bot 默认权限模式；会话显式设置优先于它
  permission_mode     TEXT NOT NULL DEFAULT 'confirm'
    CHECK (permission_mode IN ('confirm','auto','plan','full')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  -- 权限边界
  allow_dirs          TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  allow_shell         INTEGER NOT NULL DEFAULT 0,
  allow_network       INTEGER NOT NULL DEFAULT 0,
  auto_approve_write  INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_bindings (
  id           TEXT PRIMARY KEY,
  bot_id       TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  runtime_id   TEXT NOT NULL REFERENCES runtime_definitions(id) ON DELETE CASCADE,
  location     TEXT NOT NULL,
  worktree_path TEXT,
  bound_at     INTEGER NOT NULL,
  unbound_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bindings_bot ON runtime_bindings(bot_id, bound_at DESC);

CREATE TABLE IF NOT EXISTS channels (
  id                 TEXT PRIMARY KEY,
  type               TEXT NOT NULL CHECK (type IN ('dm','group','task')),
  name               TEXT NOT NULL,
  participant_bot_ids TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  host_bot_id        TEXT,
  -- 群聊/私聊的工作区：群聊全员共用；DM 即该会话工作区
  workspace_path     TEXT,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  bot_id             TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel_id         TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  runtime_id         TEXT,
  runtime_session_id TEXT,
  resume_state       TEXT NOT NULL DEFAULT 'fresh' CHECK (resume_state IN ('fresh','resumed','rebuilt')),
  status             TEXT NOT NULL DEFAULT 'created',
  process_pid        INTEGER,
  process_started_at INTEGER,
  -- 会话级覆盖：优先于 Bot 的默认工作区与模型（每次 prompt 重新读取）
  workspace_path     TEXT,
  provider_id        TEXT,
  model              TEXT,
  permission_mode    TEXT NOT NULL DEFAULT 'confirm'
    CHECK (permission_mode IN ('confirm','auto','plan','full')),
  seq_counter        INTEGER NOT NULL DEFAULT 0,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_bot ON sessions(bot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL DEFAULT '',
  content_version INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'streaming',  -- streaming | done | interrupted | failed
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT,
  turn_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  raw        TEXT,
  created_at INTEGER NOT NULL
);
-- 会话内顺序 + 虚拟滚动分页
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
-- SSE 重连游标（全局单调）
CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id, id);
-- 保留期批删
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at);

CREATE TABLE IF NOT EXISTS assignments (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  deliverable      TEXT NOT NULL DEFAULT '',
  bot_id           TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_channel_id TEXT,
  session_id       TEXT,
  worktree_path    TEXT,
  status           TEXT NOT NULL DEFAULT 'queued',
  queue_pos        INTEGER NOT NULL DEFAULT 0,
  report           TEXT,
  fail_reason      TEXT,
  started_at       INTEGER,
  ended_at         INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_bot_status ON assignments(bot_id, status);

CREATE TABLE IF NOT EXISTS memory_entries (
  id                TEXT PRIMARY KEY,
  bot_id            TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  source_session_id TEXT,
  kind              TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','summary')),
  -- 作用域：bot = 该 Bot 全局（历史数据回填值）；session = 仅来源会话；
  -- channel = 该群聊/渠道内共享（群聊里每个 Bot 的会话都能读到）
  scope             TEXT NOT NULL DEFAULT 'bot' CHECK (scope IN ('bot','channel','session')),
  channel_id        TEXT,
  injected          INTEGER NOT NULL DEFAULT 1,
  version           INTEGER NOT NULL DEFAULT 1,
  updated_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_bot ON memory_entries(bot_id, injected, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_scope
  ON memory_entries(scope, channel_id, injected, updated_at DESC);

CREATE TABLE IF NOT EXISTS schedules (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  bot_id           TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  trigger_type     TEXT NOT NULL CHECK (trigger_type IN ('once','interval','daily')),
  interval_minutes INTEGER,
  delay_minutes    INTEGER,
  at_time          TEXT,                 -- HH:MM
  next_run_at      INTEGER,
  last_result      TEXT,
  last_run_at      INTEGER,
  fail_count       INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS permission_requests (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bot_id            TEXT NOT NULL,
  turn_id           TEXT NOT NULL,
  action            TEXT NOT NULL,
  target            TEXT NOT NULL,
  boundary_snapshot TEXT NOT NULL,          -- JSON，判定时的边界副本
  boundary_version  INTEGER NOT NULL DEFAULT 0,
  timeout_policy    TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  held_since        INTEGER,
  expires_at        INTEGER,
  decision          TEXT,
  decided_by        TEXT,
  decided_at        INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perm_pending ON permission_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_perm_bot ON permission_requests(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS permission_grants (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL,
  session_id TEXT,
  action_key TEXT NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('session','bot')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grants_lookup ON permission_grants(bot_id, action_key, scope);

CREATE TABLE IF NOT EXISTS usage_records (
  id            TEXT PRIMARY KEY,
  bot_id        TEXT NOT NULL,
  runtime_id    TEXT,
  session_id    TEXT,
  mode          TEXT NOT NULL DEFAULT 'interactive',   -- interactive | headless
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- 缓存读/写 token：OpenAI prompt_tokens_details.cached_tokens /
  -- Anthropic cache_read_input_tokens / cache_creation_input_tokens
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  -- 本轮实际使用的模型（会话内可切，聚合时按模型区分）
  model         TEXT,
  reported      INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
-- 按 Bot × 运行时聚合要 ≤2s（10 万行覆盖索引）
CREATE INDEX IF NOT EXISTS idx_usage_agg ON usage_records(bot_id, runtime_id, created_at);
