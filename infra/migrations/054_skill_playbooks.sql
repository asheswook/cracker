ALTER TABLE skill_versions ADD COLUMN agent_authored boolean NOT NULL DEFAULT false;
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_agent_source CHECK (NOT agent_authored OR origin_message_id IS NOT NULL);
