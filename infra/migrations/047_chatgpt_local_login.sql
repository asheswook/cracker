ALTER TABLE assistant.chatgpt_accounts
  ADD COLUMN login_location text NOT NULL DEFAULT 'vm' CHECK(login_location IN ('vm','local')),
  ADD COLUMN redirect_uri text,
  ADD COLUMN authorization_url text,
  ADD COLUMN callback_cipher text;
ALTER TABLE assistant.chatgpt_accounts ADD CONSTRAINT chatgpt_local_redirect
  CHECK(login_location <> 'local' OR redirect_uri IS NOT NULL);
