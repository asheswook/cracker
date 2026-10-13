-- Reset derived knowledge for ALL workspaces while preserving the conversation record.
-- Preserved: workspaces, conversations, tasks, runs, messages (+artifacts, replies, attribution columns),
--            user retention/suppression decisions, schedules, responsibilities, extensions, credentials.
-- Truncated: semantic contexts/notes/links/embeddings/search docs, structure exchanges/edges, claims,
--            and legacy general memories; all are derivable from messages.
-- Run after migrations 048-052 and with every daemon stopped:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/reset-knowledge.sql
BEGIN;
SET LOCAL search_path = assistant;
LOCK TABLE messages IN SHARE MODE;

TRUNCATE
  semantic_claim_supersessions, semantic_claim_evidence, semantic_claim_revisions, semantic_claim_operations, semantic_claims,
  semantic_exchange_edge_revisions, semantic_exchange_edges, semantic_structure_operations, semantic_exchange_members, semantic_exchanges,
  semantic_search_documents, semantic_search_state,
  semantic_context_embeddings, semantic_context_notes, semantic_context_link_revisions, semantic_context_links,
  semantic_context_sources, semantic_context_mutations, semantic_context_organizations, semantic_contexts,
  memory_corrections, memory_assertions, memory_commitments, memory_decisions, memory_derivations,
  memory_entities, memory_episodes, memory_contexts, memories;

SELECT 'messages' AS kept, count(*) FROM messages
UNION ALL SELECT 'conversations', count(*) FROM conversations
UNION ALL SELECT 'semantic_contexts', count(*) FROM semantic_contexts
UNION ALL SELECT 'memories', count(*) FROM memories;
COMMIT;
