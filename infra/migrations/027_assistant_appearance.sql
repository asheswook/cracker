ALTER TABLE assistant.workspaces
  ADD COLUMN appearance jsonb NOT NULL DEFAULT '{"version":1,"shape":"flower","color":"coral","eyes":"oval","eyewear":"monocle","accessory":"none"}'::jsonb,
  ADD COLUMN appearance_revision uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD CONSTRAINT appearance_v1 CHECK ((
    jsonb_typeof(appearance) = 'object'
    AND appearance ?& ARRAY['version','shape','color','eyes','eyewear','accessory']
    AND appearance - ARRAY['version','shape','color','eyes','eyewear','accessory'] = '{}'::jsonb
    AND appearance->'version' = '1'::jsonb
    AND appearance->>'shape' IN ('circle','capsule','flower','heart','diamond','rounded-triangle')
    AND appearance->>'color' IN ('coral','pink','orchid','violet','blue','cyan','teal','lime','yellow')
    AND appearance->>'eyes' IN ('oval','dots','sleepy','sparkle')
    AND appearance->>'eyewear' IN ('none','monocle','round','sunglasses')
    AND appearance->>'accessory' IN ('none','headphones','bow','beanie','crown')
  ) IS TRUE);
