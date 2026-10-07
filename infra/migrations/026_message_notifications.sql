ALTER TABLE workspaces ADD COLUMN notification_show_content boolean NOT NULL DEFAULT true;
ALTER TABLE notification_intents ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE notification_intents ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE notification_intents DROP CONSTRAINT notification_intents_outcome_check;
ALTER TABLE notification_intents ADD CONSTRAINT notification_intents_outcome_check
  CHECK (outcome IN ('succeeded','failed','unknown','message'));
ALTER TABLE notification_intents ADD CONSTRAINT notification_message_required
  CHECK (outcome <> 'message' OR message_id IS NOT NULL);
CREATE UNIQUE INDEX notification_message_once ON notification_intents(message_id) WHERE outcome='message';
CREATE TABLE notification_attention_messages (
  run_id uuid NOT NULL REFERENCES runs(id),
  state text NOT NULL CHECK (state IN ('failed','unknown')),
  message_id uuid NOT NULL REFERENCES messages(id),
  PRIMARY KEY(run_id,state)
);
UPDATE notification_deliveries SET state='suppressed',lease_id=NULL,lease_until=NULL
  WHERE state IN ('pending','leased');
