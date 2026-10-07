ALTER TABLE messages ADD COLUMN phase text;
ALTER TABLE messages ADD CONSTRAINT messages_assistant_phase_check
  CHECK (phase IS NULL OR (role = 'assistant' AND phase IN ('commentary', 'final_answer')));
