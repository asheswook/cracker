ALTER TABLE assistant.reply_composing DROP CONSTRAINT reply_composing_status_check;
ALTER TABLE assistant.reply_composing ADD CONSTRAINT reply_composing_status_check
  CHECK (status IN ('idle','composing','ended','settling','delivering'));
ALTER TABLE assistant.reply_composing ADD COLUMN delivery_event_id uuid;
ALTER TABLE assistant.reply_composing ADD CONSTRAINT reply_handoff_identity_check
  CHECK (status NOT IN ('settling','delivering') OR (response_id IS NOT NULL AND item_id IS NOT NULL));
ALTER TABLE assistant.reply_composing ADD CONSTRAINT reply_handoff_delivery_check
  CHECK (status <> 'delivering' OR delivery_event_id IS NOT NULL);
