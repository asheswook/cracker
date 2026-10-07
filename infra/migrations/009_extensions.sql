CREATE TABLE extension_skills (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, vm_id uuid NOT NULL,
 name text NOT NULL, description text NOT NULL, content text NOT NULL, enabled boolean NOT NULL,
 revision integer NOT NULL DEFAULT 1, observed_revision integer, state text NOT NULL DEFAULT 'pending',
 tool_count integer NOT NULL DEFAULT 0, error_code text, observed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,vm_id) REFERENCES vms(workspace_id,id)
);
CREATE TABLE extension_servers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, vm_id uuid NOT NULL,
 name text NOT NULL, config jsonb NOT NULL, enabled boolean NOT NULL, secret_cipher text,
 secret_keys jsonb NOT NULL DEFAULT '[]', revision integer NOT NULL DEFAULT 1, observed_revision integer,
 state text NOT NULL DEFAULT 'pending', tool_count integer NOT NULL DEFAULT 0, error_code text,
 observed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,vm_id) REFERENCES vms(workspace_id,id)
);
