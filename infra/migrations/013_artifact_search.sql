ALTER TABLE artifacts ADD COLUMN search_text text;
ALTER TABLE artifacts ADD COLUMN search_text_truncated boolean NOT NULL DEFAULT false;
ALTER TABLE artifacts ADD COLUMN search_indexed boolean NOT NULL DEFAULT false;
