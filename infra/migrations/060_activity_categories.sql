ALTER TABLE assistant.runs DROP CONSTRAINT IF EXISTS runs_activity_check;
ALTER TABLE assistant.runs ADD CONSTRAINT runs_activity_check CHECK (activity IN ('computer','web','code','memory'));

ALTER TABLE assistant.extension_servers ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE assistant.extension_servers DROP CONSTRAINT IF EXISTS extension_servers_category_check;
ALTER TABLE assistant.extension_servers ADD CONSTRAINT extension_servers_category_check CHECK (category IN ('web','computer','code','memory','other'));
