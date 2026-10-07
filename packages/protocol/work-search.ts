import { z } from "zod";
import { Artifact, Message, Task } from "./index";

const SearchCursor = z.object({ created_at: z.iso.datetime(), id: z.uuid(), kind: z.enum(["message", "artifact"]) });
export const WorkSearchRequest = z.object({ query: z.string().trim().min(2).max(200), cursor: SearchCursor.nullable(), conversation_id: z.uuid().nullable(), state: z.enum(["all", "active", "finished"]), limit: z.number().int().min(1).max(30) }).strict();
export const WorkSearchHit = z.object({ kind: z.enum(["message", "artifact"]), id: z.uuid(), created_at: z.string(), conversation_id: z.uuid(), conversation_title: z.string(), source_message_id: z.uuid(), source_role: Message.shape.role, snippet: z.string().max(1000), task: Task.nullable(), artifact: Artifact.nullable(), file_text_truncated: z.boolean() });
export const WorkSearchPage = z.object({ hits: z.array(WorkSearchHit), next_cursor: SearchCursor.nullable(), unindexed_text_files: z.number().int().nonnegative(), pending_document_files: z.number().int().nonnegative().default(0), failed_document_files: z.number().int().nonnegative().default(0) });
export const PriorSourceRequest = z.object({ source_message_id: z.uuid() }).strict();
export const PriorSourcePage = z.object({ message: Message, conversation_id: z.uuid() });
