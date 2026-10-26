-- A short name for what was handed over ("보안 공지 Slack 공유"), shown instead of the full instructions.
ALTER TABLE responsibilities ADD COLUMN title text CHECK (title IS NULL OR length(title) <= 60);
ALTER TABLE schedules ADD COLUMN title text CHECK (title IS NULL OR length(title) <= 60);
ALTER TABLE tasks ADD COLUMN title text CHECK (title IS NULL OR length(title) <= 60);
