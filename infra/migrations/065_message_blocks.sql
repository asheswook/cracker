-- Structured message parts (cards) next to the text. NULL means a plain text message, so earlier messages read unchanged.
-- Each element is one block validated by packages/protocol MessageBlock; the text in `content` stays the readable fallback
-- (notifications, search, the knowledge tree and older clients use it).
ALTER TABLE assistant.messages ADD COLUMN IF NOT EXISTS blocks jsonb;
ALTER TABLE assistant.messages DROP CONSTRAINT IF EXISTS messages_blocks_shape;
ALTER TABLE assistant.messages ADD CONSTRAINT messages_blocks_shape CHECK (blocks IS NULL OR (jsonb_typeof(blocks)='array' AND jsonb_array_length(blocks) BETWEEN 1 AND 8));
