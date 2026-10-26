-- The brief's calendar is a binding, not a name match: one trusted extension server at the configuration revision it
-- was trusted at (a changed configuration is not trusted until bound again). Bound here to the iCloud calendar
-- extension that briefs already used (@icloud-calendar-mcp/server).
ALTER TABLE attention_settings ADD COLUMN brief_calendar_server uuid, ADD COLUMN brief_calendar_revision integer;
UPDATE attention_settings a SET brief_calendar_server=e.id,brief_calendar_revision=e.revision
  FROM extension_servers e WHERE e.workspace_id=a.workspace_id AND e.enabled AND e.config::text LIKE '%@icloud-calendar-mcp/server%';
