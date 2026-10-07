import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Observation } from "../../packages/extensions/schema.ts";
import { McpTransportError } from "./mcp-http.ts";

export function mcpConnectionFailure(error: Error): NonNullable<z.infer<typeof Observation>["error_code"]> {
  if (error instanceof UnauthorizedError) return "authentication_failed";
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    switch (error.code) {
      case 401: return "authentication_failed";
      case 403: return "access_denied";
      case 404:
      case 405: return "endpoint_not_found";
      case 429: return "rate_limited";
    }
    if (error.code !== undefined && error.code >= 500 && error.code <= 599) return "server_unavailable";
  }
  if (error instanceof McpTransportError || (error instanceof McpError && error.code === ErrorCode.RequestTimeout)) return "connection_timeout";
  if ("code" in error && error.code === "ENOENT") return "command_not_found";
  return "connect_failed";
}
