-- Idempotent: scripts/migrate.ts runs this on every start. All times are UTC (timestamptz).

CREATE TABLE IF NOT EXISTS incidents (
  id            bigserial PRIMARY KEY,
  group_key     text NOT NULL,                -- Alertmanager groupKey; catalog-based grouping replaces it (F8)
  title         text NOT NULL,
  state         text NOT NULL DEFAULT 'candidate'
                CHECK (state IN ('candidate','declared','mitigated','resolved','postmortem','closed','dismissed')),
  sev           smallint CHECK (sev BETWEEN 1 AND 4),
  sev_suggested smallint CHECK (sev_suggested BETWEEN 1 AND 4),
  status_line   text NOT NULL DEFAULT '',
  impact        text NOT NULL DEFAULT '',
  next_update_at timestamptz,
  roles         jsonb NOT NULL DEFAULT '{}',  -- {ic|ops|comms|planning: {who, doing, updated_at}}
  detected_at   timestamptz NOT NULL,         -- first alert startsAt
  declared_at   timestamptz,
  mitigated_at  timestamptz,
  resolved_at   timestamptz,
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_group_key ON incidents (group_key, created_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  fingerprint  text NOT NULL,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz,
  status       text NOT NULL CHECK (status IN ('firing','resolved')),
  alertname    text NOT NULL,
  severity     text NOT NULL DEFAULT '',
  labels       jsonb NOT NULL,
  annotations  jsonb NOT NULL,
  incident_id  bigint NOT NULL REFERENCES incidents(id),
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fingerprint, starts_at)
);
CREATE INDEX IF NOT EXISTS alerts_incident ON alerts (incident_id);

CREATE TABLE IF NOT EXISTS timeline (
  id          bigserial PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES incidents(id),
  at          timestamptz NOT NULL,
  kind        text NOT NULL,   -- alert_firing | alert_resolved | state | sev | role | summary | note | decision | reopen
  actor       text NOT NULL,   -- 'alertmanager' or the operator
  body        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS timeline_incident ON timeline (incident_id, at);

-- Role checklists (PRD F7). Template items are copied in when an incident is declared; users add their own.
CREATE TABLE IF NOT EXISTS checklist_items (
  id           bigserial PRIMARY KEY,
  incident_id  bigint NOT NULL REFERENCES incidents(id),
  role         text NOT NULL CHECK (role IN ('ic','ops','comms','planning')),
  phase        text NOT NULL CHECK (phase IN ('declare','mitigate','resolve','close')),
  text         text NOT NULL,
  template_key text,            -- null for items a user added
  added_by     text,
  done_by      text,
  done_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, template_key)
);
CREATE INDEX IF NOT EXISTS checklist_incident ON checklist_items (incident_id);
-- How an item was handled (written when it is checked off; editable afterwards).
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS note text;

-- Paging (PRD F10). Delivery is mocked: each row is a page "sent" to ntfy/Slack. step 0 = SEV3 Slack post (no ack);
-- steps 1.. = escalation until someone acknowledges. UNIQUE stops a step being sent twice.
CREATE TABLE IF NOT EXISTS pages (
  id          bigserial PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES incidents(id),
  step        smallint NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('ntfy','slack')),
  priority    text NOT NULL,
  message     text NOT NULL,
  sent_at     timestamptz NOT NULL,
  UNIQUE (incident_id, step)
);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS acked_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS acked_by text;

-- Watching the watcher (PRD F11): when the Watchdog alert was last received, and planned maintenance.
CREATE TABLE IF NOT EXISTS monitor (
  name              text PRIMARY KEY,
  last_seen         timestamptz,
  maintenance_until timestamptz,
  maintenance_by    text
);

-- IC checkpoints (PRD F13): where a long incident stands, plus an optional wake condition (PromQL) that pages the
-- IC once when it returns any series. Only the newest checkpoint's condition is watched; it stops when the incident
-- leaves declared/mitigated. A wake page is a pages row with step = -checkpoint id (escalation steps are > 0).
CREATE TABLE IF NOT EXISTS checkpoints (
  id              bigserial PRIMARY KEY,
  incident_id     bigint NOT NULL REFERENCES incidents(id),
  status_line     text NOT NULL,
  hypothesis      text NOT NULL DEFAULT '',
  action          text NOT NULL DEFAULT '',
  action_eta      timestamptz,
  wake_expr       text NOT NULL DEFAULT '',
  next_step       text NOT NULL DEFAULT '',
  handoff_to      text NOT NULL DEFAULT '',
  author          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  wake_state      text CHECK (wake_state IN ('watching','fired','stopped')),
  wake_checked_at timestamptz,
  wake_error      text,
  wake_fired_at   timestamptz
);
CREATE INDEX IF NOT EXISTS checkpoints_incident ON checkpoints (incident_id, id DESC);

-- Change events (PRD F12) from the Flux notification webhook: one row per Flux event. components = topology
-- nodes deployed by the object (topology.yaml `flux`); empty for sources and objects no node maps to.
CREATE TABLE IF NOT EXISTS change_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('info','error')),
  object_kind text NOT NULL,
  object_ns   text NOT NULL,
  object_name text NOT NULL,
  reason      text NOT NULL,
  message     text NOT NULL,
  revision    text NOT NULL DEFAULT '',
  components  text[] NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_kind, object_ns, object_name, reason, revision, at)
);
CREATE INDEX IF NOT EXISTS change_events_at ON change_events (at DESC);

-- Alert grouping (PRD F8): the topology component an alert is about (lib/grouping.ts componentOf), null if unknown.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS component text;

-- Page kinds: escalation (F10, steps 1..), wake (F13, step = -checkpoint id), triage (F8: a candidate with a firing
-- critical alert left unhandled for 15 minutes, step 1). Unique per incident, kind and step.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'escalation';
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_incident_id_step_key;
CREATE UNIQUE INDEX IF NOT EXISTS pages_incident_kind_step ON pages (incident_id, kind, step);
UPDATE pages SET kind = 'wake' WHERE step < 0 AND kind = 'escalation';

-- Runbook steps ticked during an incident (PRD F6). step_key = hash of section + step text (lib/runbooks.ts).
CREATE TABLE IF NOT EXISTS runbook_steps (
  incident_id bigint NOT NULL REFERENCES incidents(id),
  runbook     text NOT NULL,
  step_key    text NOT NULL,
  text        text NOT NULL,
  done_by     text NOT NULL,
  done_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, runbook, step_key)
);

-- Postmortem follow-ups (PRD F14). Issues are mocked: "creating" one records a number and labels; no GitHub call.
-- An incident cannot leave postmortem for closed while a follow-up has no issue. done = the issue was closed.
CREATE TABLE IF NOT EXISTS follow_ups (
  id               bigserial PRIMARY KEY,
  incident_id      bigint NOT NULL REFERENCES incidents(id),
  action           text NOT NULL,
  type             text NOT NULL CHECK (type IN ('prevent','detect','mitigate')),
  priority         text NOT NULL CHECK (priority IN ('P0','P1','P2')),
  owner            text NOT NULL DEFAULT '',
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  issue_number     int,
  issue_labels     text[],
  issue_created_at timestamptz,
  done_by          text,
  done_at          timestamptz
);
CREATE INDEX IF NOT EXISTS follow_ups_incident ON follow_ups (incident_id);

-- Shift handoffs (PRD F5). One per shift instance (shift id + its start). The collected data is live while a draft
-- and frozen into `data` when marked ready (or acknowledged without being marked ready).
CREATE TABLE IF NOT EXISTS handoffs (
  id          bigserial PRIMARY KEY,
  shift_id    text NOT NULL,
  shift_start timestamptz NOT NULL,
  shift_end   timestamptz NOT NULL,
  to_shift_id text NOT NULL,
  from_people text[] NOT NULL,
  to_people   text[] NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','acked')),
  note        text NOT NULL DEFAULT '',
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ready_at    timestamptz,
  ready_by    text,
  acked_at    timestamptz,
  acked_by    text,
  paged_at    timestamptz,
  UNIQUE (shift_id, shift_start)
);
-- What the incoming person ticked as read before acknowledging (F5 read-through).
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS reads text[];

-- Changes proposed by agents (P2). Never executed by the agent: the IC approves, the executor runs it.
CREATE TABLE IF NOT EXISTS agent_actions (
  id          bigserial PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES incidents(id),
  type        text NOT NULL,
  params      jsonb NOT NULL,
  command     text NOT NULL,
  reason      text NOT NULL,
  expected    text NOT NULL,
  risk        text NOT NULL,
  rollback    text NOT NULL DEFAULT '',
  verify      text NOT NULL,
  runbook     text,
  status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','running','done','failed','skipped')),
  proposed_by text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_by  text,
  decided_at  timestamptz,
  result      jsonb
);
CREATE INDEX IF NOT EXISTS agent_actions_incident ON agent_actions (incident_id, proposed_at);
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high'));

-- Agent runs (P2): one ir-lead conversation per incident (shared Kagent context), each run one IC request or the
-- automatic response on declare. Steps are the tool calls the console saw, for the Response tab and the audit.
CREATE TABLE IF NOT EXISTS agent_runs (
  id          bigserial PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES incidents(id),
  kind        text NOT NULL CHECK (kind IN ('respond','chat')),
  prompt      text NOT NULL,
  asked_by    text NOT NULL,
  context_id  text,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','stopped')),
  answer      text NOT NULL DEFAULT '',
  error       text,
  tool_calls  int NOT NULL DEFAULT 0,
  tokens_in   int NOT NULL DEFAULT 0,
  tokens_out  int NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE INDEX IF NOT EXISTS agent_runs_incident ON agent_runs (incident_id, started_at);
-- General chat (the ⌘K assistant): no incident, one private thread per person.
ALTER TABLE agent_runs ALTER COLUMN incident_id DROP NOT NULL;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_kind_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_kind_check CHECK (kind IN ('respond','chat','general'));
-- Kagent agent that ran it; a Kagent context belongs to one agent.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS agent text NOT NULL DEFAULT 'ir-lead';
-- At most one running run per incident.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_running ON agent_runs (incident_id) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS agent_steps (
  id      bigserial PRIMARY KEY,
  run_id  bigint NOT NULL REFERENCES agent_runs(id),
  at      timestamptz NOT NULL DEFAULT now(),
  author  text NOT NULL,
  call_id text NOT NULL,
  name    text NOT NULL,
  args    jsonb,
  result  text
);
CREATE INDEX IF NOT EXISTS agent_steps_run ON agent_steps (run_id, id);

-- Console switches. ai_enabled = 'false' stops new agent runs (the AI off switch on /ai).
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- AI briefings (P2): the AI's current summary and next steps for an incident; the newest version is shown.
CREATE TABLE IF NOT EXISTS agent_briefings (
  id          bigserial PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES incidents(id),
  version     int NOT NULL,
  body        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, version)
);
-- An action from a briefing step: run through the executor, then its runbook step is ticked.
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS briefing_id bigint REFERENCES agent_briefings(id);
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS runbook text;
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS step_key text;
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS step_text text;

-- The postmortem written for an incident (lineth-observability postmortems/<id>), and its draft pull request.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS postmortem_id text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS postmortem_pr text;
-- Per-incident notes on a handoff ({"<incident id>": "text"}); `note` is the note on the shift as a whole.
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS notes jsonb NOT NULL DEFAULT '{}';
