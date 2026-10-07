export type Source = { readonly id: string; readonly role: "user" | "assistant" | "system"; readonly content: string; readonly created_at: string };
export class MemoryError extends Error { constructor(readonly code: string) { super(code); this.name = "MemoryError"; } }
export async function inputHash(sources: readonly Source[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(sources.map(s => [s.id, s.role, s.content, s.created_at])));
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
}
