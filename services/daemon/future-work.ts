import { HTTPError, type KyInstance } from "ky";
import { z } from "zod";
import {
  FutureWorkCancelInput,
  FutureWorkCompleteInput,
  FutureWorkListInput,
  FutureWorkListResult,
  FutureWorkMutationResult,
  FutureWorkUpdateInput,
} from "../../packages/proactive/schema.ts";
import type { Tool } from "../../packages/provider/index.ts";
import { proactiveActionKey, ProactiveError } from "./proactive.ts";

const names = ["list_future_work", "update_future_work", "cancel_future_work", "complete_future_work"] as const;
type FutureWorkToolName = (typeof names)[number];
function parameters(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: "input",
    override: context => {
      if (context.jsonSchema.type === "object") context.jsonSchema.additionalProperties = false;
      if (context.zodSchema instanceof z.ZodDiscriminatedUnion && context.jsonSchema.oneOf) {
        context.jsonSchema.anyOf = context.jsonSchema.oneOf;
        delete context.jsonSchema.oneOf;
      }
    },
  });
}
export function isFutureWorkTool(name: string): name is FutureWorkToolName {
  return names.some(candidate => candidate === name);
}

export const futureWorkTools: readonly Tool[] = [
  {
    type: "function", name: "list_future_work", strict: true,
    description: "Read existing reminders, schedules, and ongoing responsibilities on this computer without triggering them. Search by a literal phrase or set query null; start cursor null, include_inactive false. Follow next_cursor when present. Before changing or cancelling existing work, list it to obtain its ID, version and complete configuration. Do not create a second routine to amend an existing one.",
    parameters: parameters(FutureWorkListInput),
  },
  {
    type: "function", name: "update_future_work", strict: true,
    description: "Update an existing pending reminder or active responsibility in place, preserving its ID and skill binding. First use list_future_work; copy its latest version and complete configuration, changing only what the current user requested. Preserve all other objective requirements, timing, notification and quiet-hours settings. Quote the current user's request with its source_message_id. A version conflict requires re-listing and reconsidering the edit. Success confirms the stored change; already dispatched tasks are not modified.",
    parameters: parameters(FutureWorkUpdateInput),
  },
  {
    type: "function", name: "complete_future_work", strict: true,
    description: "Use when the held work is finished (the awaited thing arrived and the work is done); cancel_future_work is only for the user calling it off. Only responsibilities support completion, not schedules. First list_future_work for its exact ID and latest version. Quote the current user message with source_message_id and give short evidence of completion. Pending actions and notifications are cancelled; already dispatched tasks are not stopped. Do not claim completion unless this tool confirms it.",
    parameters: parameters(FutureWorkCompleteInput),
  },
  {
    type: "function", name: "cancel_future_work", strict: true,
    description: "Cancel future dispatch of an existing schedule or responsibility explicitly requested by the current user. First list_future_work for the exact ID and latest version, and quote the current user's request with its source_message_id. This does not stop already dispatched tasks; report any returned task IDs accurately. Do not claim cancellation unless this tool confirms it.",
    parameters: parameters(FutureWorkCancelInput),
  },
];

type WorkScope = { readonly runId: string; readonly actionId: string };
type WorkCall = { readonly name: FutureWorkToolName; readonly args: string; readonly signal: AbortSignal };

export async function runFutureWork(http: KyInstance, scope: WorkScope, call: WorkCall): Promise<string> {
  let request: { readonly path: string; readonly json: object };
  try {
    const args: unknown = JSON.parse(call.args);
    switch (call.name) {
      case "list_future_work":
        request = { path: "list", json: { ...FutureWorkListInput.parse(args), run_id: scope.runId } };
        break;
      case "update_future_work":
        request = { path: "update", json: { ...FutureWorkUpdateInput.parse(args), run_id: scope.runId, client_action_id: proactiveActionKey(scope.actionId) } };
        break;
      case "cancel_future_work":
        request = { path: "cancel", json: { ...FutureWorkCancelInput.parse(args), run_id: scope.runId, client_action_id: proactiveActionKey(scope.actionId) } };
        break;
      case "complete_future_work":
        request = { path: "complete", json: { ...FutureWorkCompleteInput.parse(args), run_id: scope.runId, client_action_id: proactiveActionKey(scope.actionId) } };
        break;
      default: return assertNever(call.name);
    }
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return JSON.stringify({ kind: "future_work_rejected", code: "invalid_request", persisted: false, next_step: "Correct the tool arguments using the tool schema and the current user's exact request. This call made no changes." });
    throw error;
  }

  try {
    const result: unknown = await http.post(`v1/daemon/proactive-work/${request.path}`, { json: request.json, signal: call.signal, retry: 0 }).json();
    return JSON.stringify(call.name === "list_future_work" ? FutureWorkListResult.parse(result) : FutureWorkMutationResult.parse(result));
  } catch (error) {
    if (error instanceof HTTPError) {
      let raw: unknown;
      try { raw = await error.response.json(); }
      catch (parseError) {
        if (parseError instanceof SyntaxError) raw = null;
        else throw parseError;
      }
      const body = z.object({ error: z.object({ code: z.string().regex(/^[a-z_]{1,80}$/) }) }).safeParse(raw);
      const code = body.success ? body.data.error.code : "unclassified_rejection";
      const rejected = new Set(["invalid_request", "invalid_source", "source_mismatch", "invalid_timezone", "invalid_until", "stale_version", "not_found", "inactive", "idempotency_conflict"]);
      if ([400, 404, 409].includes(error.response.status) && rejected.has(code))
        return JSON.stringify({ kind: "future_work_rejected", code, persisted: false, next_step: "Read the latest matching work with list_future_work and correct the arguments using the exact current user request. Do not create a replacement routine or claim this rejected change succeeded." });
      throw new ProactiveError(`future_work_http_${error.response.status}_${code}`);
    }
    if (error instanceof Error) throw new ProactiveError("future_work_outcome_unconfirmed");
    throw error;
  }
}

function assertNever(value: never): never {
  throw new ProactiveError(`unsupported_future_work_tool:${String(value)}`);
}
