ALTER TABLE assistant.tasks ADD COLUMN origin text NOT NULL DEFAULT 'user' CHECK (origin IN ('user','schedule','responsibility'));
ALTER TABLE assistant.messages
  ADD COLUMN origin text NOT NULL DEFAULT 'user' CHECK (origin IN ('user','schedule','responsibility')),
  ADD COLUMN notify boolean NOT NULL DEFAULT false;
