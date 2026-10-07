CREATE TABLE browser_sessions(token_hash text PRIMARY KEY,credential_hash text NOT NULL REFERENCES credentials(token_hash) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,revoked_at timestamptz);
CREATE INDEX browser_sessions_parent ON browser_sessions(credential_hash);
CREATE INDEX browser_sessions_expiry ON browser_sessions(expires_at);
CREATE TABLE session_login_limits(bucket_hash text PRIMARY KEY,window_started_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL CHECK(attempts>0));
