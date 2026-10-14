ALTER TABLE assistant.workspaces DROP CONSTRAINT appearance_v1;

UPDATE assistant.workspaces SET appearance = jsonb_build_object(
  'version', 2,
  'biscuit', CASE appearance->>'shape'
    WHEN 'circle' THEN 'butter' WHEN 'capsule' THEN 'graham' WHEN 'flower' THEN 'butter'
    WHEN 'heart' THEN 'ring' WHEN 'diamond' THEN 'wafer' ELSE 'saltine' END,
  'color', CASE appearance->>'color'
    WHEN 'coral' THEN 'honey' WHEN 'pink' THEN 'berry' WHEN 'orchid' THEN 'berry' WHEN 'violet' THEN 'cocoa'
    WHEN 'blue' THEN 'charcoal' WHEN 'cyan' THEN 'matcha' WHEN 'teal' THEN 'matcha' WHEN 'lime' THEN 'matcha'
    ELSE 'butter' END,
  'eyes', CASE appearance->>'eyes'
    WHEN 'oval' THEN 'ovals' WHEN 'sleepy' THEN 'sleepy' WHEN 'sparkle' THEN 'smile' ELSE 'dots' END,
  'blush', false,
  'accessory', CASE appearance->>'accessory'
    WHEN 'headphones' THEN 'headphones' WHEN 'bow' THEN 'bow' WHEN 'beanie' THEN 'beret' ELSE 'none' END
)
WHERE appearance->'version' = '1'::jsonb;

ALTER TABLE assistant.workspaces
  ALTER COLUMN appearance SET DEFAULT '{"version":2,"biscuit":"saltine","color":"honey","eyes":"dots","blush":false,"accessory":"none"}'::jsonb,
  ADD CONSTRAINT appearance_v2 CHECK ((
    jsonb_typeof(appearance) = 'object'
    AND appearance ?& ARRAY['version','biscuit','color','eyes','blush','accessory']
    AND appearance - ARRAY['version','biscuit','color','eyes','blush','accessory'] = '{}'::jsonb
    AND appearance->'version' = '2'::jsonb
    AND appearance->>'biscuit' IN ('saltine','butter','graham','sandwich','wafer','ring')
    AND appearance->>'color' IN ('wheat','butter','honey','cinnamon','cocoa','matcha','berry','charcoal')
    AND appearance->>'eyes' IN ('dots','ovals','sleepy','smile')
    AND jsonb_typeof(appearance->'blush') = 'boolean'
    AND appearance->>'accessory' IN ('none','headphones','beret','bow')
  ) IS TRUE);

ALTER TABLE assistant.workspaces ALTER COLUMN persona_name SET DEFAULT '크래커';
UPDATE assistant.workspaces SET persona_name = '크래커' WHERE persona_name = 'Assistant';
