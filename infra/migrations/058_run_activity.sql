ALTER TABLE assistant.runs ADD COLUMN activity text CHECK (activity IN ('computer')), ADD COLUMN activity_at timestamptz;
