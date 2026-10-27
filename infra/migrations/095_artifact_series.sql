ALTER TABLE assistant.artifacts
  ADD COLUMN series_key text NULL,
  ADD COLUMN previous_id uuid NULL REFERENCES assistant.artifacts(id),
  ADD COLUMN change_summary text NULL CHECK (char_length(change_summary) <= 200);

CREATE INDEX artifacts_series_latest ON assistant.artifacts(workspace_id, series_key, created_at DESC);
