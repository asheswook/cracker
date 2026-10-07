CREATE TABLE notification_viewing (
  subscription_id uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  page_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK(sequence >= 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(subscription_id, page_id)
);
