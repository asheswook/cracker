import { z } from "zod";
import { Id } from "./index";

export const TaskNavigation = z.object({
  task_id: Id,
  conversation_id: Id,
  request_message_id: Id.nullable(),
  reply_message_id: Id.nullable(),
}).readonly();
export type TaskNavigation = z.infer<typeof TaskNavigation>;
