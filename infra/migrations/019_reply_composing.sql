CREATE TABLE assistant.reply_composing (
  run_id uuid PRIMARY KEY REFERENCES assistant.runs(id) ON DELETE CASCADE,
  inference_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  sequence integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','composing','ended')),
  response_id text,
  item_id text,
  input_message_ids uuid[] NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()
);
