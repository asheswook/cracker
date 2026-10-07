import type {SocketDiagnostic} from "./diagnostic.ts";
export class ProviderError extends Error {
  constructor(readonly code: "configuration" | "incomplete" | "oauth", message: string, readonly diagnostic?:SocketDiagnostic) { super(message); this.name = "ProviderError"; }
}
