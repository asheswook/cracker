import { z } from "zod";

export const documentMediaTypes = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] as const;
export function documentFormat(mediaType: string, name: string): "pdf" | "docx" | null {
  if (mediaType === documentMediaTypes[0]) return "pdf";
  if (mediaType === documentMediaTypes[1]) return "docx";
  if (mediaType !== "application/octet-stream") return null;
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.docx$/i.test(name)) return "docx";
  return null;
}
export const DocumentLease = z.object({
  artifact_id: z.uuid(), lease_id: z.uuid(), version: z.literal(1),
  format: z.enum(["pdf", "docx"]), bytes: z.coerce.number().int().nonnegative().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const DocumentLeaseIdentity = z.object({ lease_id: z.uuid(), version: z.literal(1) }).strict();
export const DocumentResult = z.discriminatedUnion("kind", [
  DocumentLeaseIdentity.extend({ kind: z.literal("complete"), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().max(200000).nullable(), truncated: z.boolean(),
    code: z.enum(["text", "empty", "signature_mismatch", "encrypted_or_malformed", "encrypted", "malformed", "unsupported", "resource_limit", "input_limit"]),
  }).strict(),
  DocumentLeaseIdentity.extend({ kind: z.literal("retry"), code: z.enum(["transport", "storage", "integrity", "parser_unavailable"]) }).strict(),
  DocumentLeaseIdentity.extend({ kind: z.literal("yield") }).strict(),
]);
