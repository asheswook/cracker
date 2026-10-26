-- "It can't wait for the next brief": one alert per (item, request, stage) for a watched item that needs the user and
-- is due before the next brief. Code decides; the line is the item's own reason. Never re-sent for the same stage.
CREATE TABLE attention_due_alerts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 item_id uuid NOT NULL,
 anchor text NOT NULL,
 stage text NOT NULL CHECK (stage IN ('before_brief','overdue')),
 message_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (item_id, anchor, stage)
);
