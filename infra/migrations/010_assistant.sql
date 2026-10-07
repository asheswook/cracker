ALTER TABLE assistant.workspaces
  ADD COLUMN default_conversation_id uuid,
  ADD COLUMN persona_name text NOT NULL DEFAULT 'Assistant' CHECK (char_length(btrim(persona_name)) BETWEEN 1 AND 80),
  ADD COLUMN persona_role text NOT NULL DEFAULT '' CHECK (char_length(persona_role) <= 2000),
  ADD COLUMN persona_style text NOT NULL DEFAULT '' CHECK (char_length(persona_style) <= 2000),
  ADD CONSTRAINT workspace_default_conversation_scope
    FOREIGN KEY (id, default_conversation_id) REFERENCES assistant.conversations(workspace_id, id);
