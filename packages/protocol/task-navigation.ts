import { z } from "zod";
import { Id } from "./index";

export const TaskNavigation = z.object({
  task_id: Id,
  conversation_id: Id,
  request_message_id: Id.nullable(),
  reply_message_id: Id.nullable(),
  /** For a scheduled or routine run: the user's message that asked for it (it may be in another conversation). */
  source: z.object({ conversation_id: Id, message_id: Id }).nullable().default(null),
}).readonly();
export type TaskNavigation = z.infer<typeof TaskNavigation>;
