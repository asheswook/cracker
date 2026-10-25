-- Outside sources the assistant watches on the user's behalf (first: Gmail through the VM browser).
-- A source exists only because the user asked for it (source_message_id); code decides when to look, the model reads
-- and judges, and what it found is kept as items until resolved. Freshness is explicit: last_success_at and
-- covered_through move only after a complete look.
CREATE TABLE attention_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 conversation_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('gmail')),
 account text NOT NULL,
 skill_id uuid, skill_revision integer,
 source_message_id uuid NOT NULL,
 source_quote text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 interval_minutes integer NOT NULL DEFAULT 120 CHECK (interval_minutes BETWEEN 30 AND 1440),
 next_check_at timestamptz NOT NULL DEFAULT now(),
 last_attempt_at timestamptz, last_success_at timestamptz, covered_through timestamptz,
 health text NOT NULL DEFAULT 'ok' CHECK (health IN ('ok','retrying','needs_user')),
 failure_count integer NOT NULL DEFAULT 0,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, kind, account)
);
CREATE TABLE attention_source_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_id uuid NOT NULL REFERENCES attention_sources(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 task_id uuid NOT NULL UNIQUE,
 window_start timestamptz,
 as_of timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'dispatched' CHECK (state IN ('dispatched','complete','partial','failed','expired')),
 error_kind text, items_seen integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX attention_source_runs_open ON attention_source_runs(source_id) WHERE state = 'dispatched';
-- One item per source thread. version changes when the thread's content changes (new message, new deadline).
-- briefed_version is the version the user was last told about.
CREATE TABLE attention_source_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_id uuid NOT NULL REFERENCES attention_sources(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 thread_key text NOT NULL,
 url text, subject text NOT NULL, counterpart text,
 category text NOT NULL CHECK (category IN ('request','deadline','waiting','alert')),
 reason text NOT NULL, due_at timestamptz,
 version text NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','dismissed')),
 briefed_version text,
 first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (source_id, thread_key)
);
CREATE INDEX attention_source_items_open ON attention_source_items(workspace_id) WHERE state = 'open';
