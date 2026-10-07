import { z } from "zod";
import type { Tool } from "../../packages/provider/index.ts";
export const SpawnChild = z.object({ task: z.string().min(1).max(16000) });
export const ChildTarget = z.object({ agent_id: z.string().min(1) });
export const MessageChild = ChildTarget.extend({ message: z.string().min(1).max(16000) });
export const WaitChild = ChildTarget.extend({ timeout_ms: z.number().int().min(0).max(10000) });
const id = { type: "string" };
export const delegationTools: Tool[] = [
  {
    type: "function",
    name: "spawn_agent",
    description:
      "Start an independent subagent for a concrete task. Returns immediately. Inherits this run’s model and credentials. Give the necessary context, expected result and file ownership explicitly; children do not inherit this conversation. Children have their own output directory, blocking shell and MCP tools, but no shared desktop, background shells or nested agents. Independent reads overlap; mutations serialize. Review child results before concluding.",
    strict: true,
    parameters: {
      type: "object",
      properties: { task: { type: "string", minLength: 1, maxLength: 16000 } },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "agent_status",
    description:
      "Read one child’s current status and completed result. Reading a terminal result acknowledges it; include relevant findings and failures in your answer.",
    strict: true,
    parameters: {
      type: "object",
      properties: { agent_id: id },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "wait_agent",
    description:
      "Wait up to 10 seconds for a child result. Returns pending promptly at the deadline; continue other work instead of repeatedly polling. Terminal results are acknowledged.",
    strict: true,
    parameters: {
      type: "object",
      properties: { agent_id: id, timeout_ms: { type: "integer", minimum: 0, maximum: 10000 } },
      required: ["agent_id", "timeout_ms"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "message_agent",
    description:
      "Send scoped follow-up or steering to a child. Running children read it before their next model turn; completed children continue from their existing history. Unknown effects require reconciliation, not resubmission.",
    strict: true,
    parameters: {
      type: "object",
      properties: { agent_id: id, message: { type: "string", minLength: 1, maxLength: 16000 } },
      required: ["agent_id", "message"],
      additionalProperties: false,
    },
  },
];
export function isDelegationTool(name: string): boolean {
  return delegationTools.some((tool) => tool.type === "function" && tool.name === name);
}
