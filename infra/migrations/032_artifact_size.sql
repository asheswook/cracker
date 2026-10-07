ALTER TABLE assistant.artifacts DROP CONSTRAINT artifacts_bytes_check;
ALTER TABLE assistant.artifacts ADD CONSTRAINT artifacts_bytes_check CHECK(bytes >= 0 AND bytes <= 100000000);
