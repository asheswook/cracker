ALTER TABLE push_subscriptions ADD COLUMN transport text NOT NULL DEFAULT 'web'
  CHECK (transport IN ('web','fcm'));
ALTER TABLE push_subscriptions ADD COLUMN subscription_hash text;
