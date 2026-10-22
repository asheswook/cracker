-- Per-tool switches for MCP servers: the daemon reports the offered catalogue, the user turns tools off by their server-side name.
ALTER TABLE assistant.extension_servers ADD COLUMN IF NOT EXISTS tools jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE assistant.extension_servers ADD COLUMN IF NOT EXISTS disabled_tools jsonb NOT NULL DEFAULT '[]'::jsonb;
