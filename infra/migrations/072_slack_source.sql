-- Slack is watched the same way as Gmail (single looks, items per thread, reply drafts).
ALTER TABLE attention_sources DROP CONSTRAINT attention_sources_kind_check;
ALTER TABLE attention_sources ADD CONSTRAINT attention_sources_kind_check CHECK (kind IN ('gmail','slack'));
