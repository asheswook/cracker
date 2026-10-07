import type { DocumentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { ProviderError } from "./errors.ts";

export function anthropicDocument(file: {
  readonly filename?: string | undefined;
  readonly file_data?: string | undefined;
  readonly file_id?: string | undefined;
  readonly file_url?: string | undefined;
}): DocumentBlockParam {
  if (file.file_id) throw new ProviderError("configuration", "Claude cannot use OpenAI file IDs");
  const title = file.filename ? { title: file.filename } : {};
  if (
    file.file_url &&
    !file.file_data &&
    URL.canParse(file.file_url) &&
    ["http:", "https:"].includes(new URL(file.file_url).protocol) &&
    /\.pdf$/i.test(new URL(file.file_url).pathname)
  )
    return { type: "document", ...title, source: { type: "url", url: file.file_url } };
  const encoded = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.file_data ?? "");
  const mediaType = encoded?.[1],
    data = encoded?.[2];
  if (!mediaType || data === undefined || data.length % 4 !== 0)
    throw new ProviderError("configuration", "Claude document requires supported base64 file data");
  if (mediaType === "application/pdf")
    return {
      type: "document",
      ...title,
      source: { type: "base64", media_type: "application/pdf", data },
    };
  if (
    mediaType.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript"].includes(mediaType) ||
    /\.(?:txt|md|csv|tsv|json|html|xml|py|ts|js|go|rs)$/i.test(file.filename ?? "")
  ) {
    try {
      return {
        type: "document",
        ...title,
        source: {
          type: "text",
          media_type: "text/plain",
          data: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data, "base64")),
        },
      };
    } catch (error) {
      if (error instanceof Error)
        throw new ProviderError("configuration", "Claude text document is not UTF-8");
      throw error;
    }
  }
  throw new ProviderError(
    "configuration",
    "Unsupported Claude binary document; inspect the materialized local file with tools",
  );
}
