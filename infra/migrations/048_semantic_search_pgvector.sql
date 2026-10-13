CREATE EXTENSION IF NOT EXISTS vector;
-- bge-m3 and ContextVector validate exactly 1024 dimensions.
ALTER TABLE semantic_search_documents DROP CONSTRAINT semantic_search_documents_vector_check;
ALTER TABLE semantic_search_documents ALTER COLUMN vector TYPE vector(1024) USING vector::text::vector(1024);
CREATE INDEX semantic_search_vector_cosine ON semantic_search_documents USING hnsw(vector vector_cosine_ops);
-- Documents and search state commit together; there is no external delivery to retry.
DROP TABLE semantic_search_outbox;
-- This version only tracked external workspace namespace republishing.
ALTER TABLE semantic_search_state DROP COLUMN namespace_version;
