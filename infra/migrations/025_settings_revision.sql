ALTER TABLE assistant.workspaces
  ADD COLUMN settings_revision uuid NOT NULL DEFAULT gen_random_uuid();
