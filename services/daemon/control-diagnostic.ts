import { HTTPError, TimeoutError } from "ky";
import { z } from "zod";

export const RetentionErrorCode = z.enum(["retention_context_unsupported", "retention_assessment_required", "retention_snapshot_stale", "retention_decisions_incomplete", "retention_unsupported_directive", "retention_decision_conflict", "retention_source_missing"]);
const ErrorCode = z.enum([
  "internal_error",
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "stale_run",
  "stale_session",
  "reconciliation_required",
  "stale_ack",
  "pending_input",
  "stop_pending",
  "idempotency_conflict",
  "invalid_transition",
  "invalid_event",
  "csrf_rejected",
]).or(RetentionErrorCode);
export function controlErrorSummary(error: Error) {
  const type =
    error instanceof HTTPError
      ? "HTTPError"
      : error instanceof TimeoutError
        ? "TimeoutError"
        : error instanceof z.ZodError
          ? "ZodError"
          : error instanceof TypeError
            ? "TypeError"
            : error instanceof SyntaxError
              ? "SyntaxError"
              : "Error";
  const status =
    error instanceof HTTPError
      ? z.number().int().min(100).max(599).safeParse(error.response.status)
      : undefined;
  return {
    event: "daemon.control.unavailable",
    type,
    ...(status?.success ? { status: status.data } : {}),
  };
}
export async function controlErrorCode(error: Error): Promise<string | undefined> {
  if (!(error instanceof HTTPError) || error.response.bodyUsed) return undefined;
  const reader = error.response.clone().body?.getReader();
  if (!reader) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 4096) return undefined;
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = z
      .object({ error: z.object({ code: ErrorCode }) })
      .safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data.error.code : undefined;
  };
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 150);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}
