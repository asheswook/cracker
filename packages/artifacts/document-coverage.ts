import { z } from "zod";
import type { Query } from "../../services/control/db.ts";
import type { WorkSearchRequest } from "../protocol/work-search.ts";

export async function documentCoverage(
  sql: Query,
  workspace: string,
  request: z.infer<typeof WorkSearchRequest>,
) {
  const rows =
    await sql`SELECT count(*) FILTER(WHERE a.search_indexed=false) AS pending_document_files,
    count(*) FILTER(WHERE j.status='failed' OR (j.status='done' AND j.outcome NOT IN ('text','empty'))) AS failed_document_files
    FROM assistant.artifacts a
    JOIN LATERAL(SELECT m.task_id FROM assistant.message_artifacts ma JOIN assistant.messages m ON m.id=ma.message_id AND m.workspace_id=a.workspace_id WHERE ma.artifact_id=a.id ORDER BY m.sequence LIMIT 1) source ON true
    LEFT JOIN assistant.tasks t ON t.id=source.task_id AND t.workspace_id=a.workspace_id
    LEFT JOIN assistant.artifact_search_jobs j ON j.artifact_id=a.id AND j.extractor_version=1
    WHERE a.workspace_id=${workspace} AND a.state='ready'
    AND (a.media_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document') OR (a.media_type='application/octet-stream' AND (lower(a.name) LIKE '%.pdf' OR lower(a.name) LIKE '%.docx')))
    AND (${request.conversation_id}::uuid IS NULL OR a.conversation_id=${request.conversation_id}::uuid)
    AND (${request.state}='all' OR (${request.state}='active' AND t.state NOT IN ('cancelled','succeeded','failed')) OR (${request.state}='finished' AND t.state IN ('cancelled','succeeded','failed')))`;
  return z
    .object({ pending_document_files: z.coerce.number(), failed_document_files: z.coerce.number() })
    .parse(rows[0]);
}
