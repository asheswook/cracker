CREATE TABLE semantic_source_retention (
 workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, source_message_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('inherit','allow','deny_turn','deny_task')), quote text,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,source_message_id),
 FOREIGN KEY(workspace_id,conversation_id,source_message_id) REFERENCES messages(workspace_id,conversation_id,id),
 CHECK((action='inherit' AND quote IS NULL) OR (action<>'inherit' AND length(quote)>0))
);
