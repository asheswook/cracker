import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpHttpTarget } from "./mcp-url.ts";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export class McpTransportError extends Error {
  constructor(readonly code: "mcp_sse_start_timeout") { super(code); this.name = "McpTransportError"; }
}

// Adapt the SDK's optional sessionId typing; the SDK owns the session itself.
export function httpTransport(url: URL, headers: Record<string, string>): Transport {
  const target = mcpHttpTarget(url, headers);
  let transport: StreamableHTTPClientTransport | SSEClientTransport = new StreamableHTTPClientTransport(target.url, { requestInit: { headers: target.headers } });
  let initialized = false;
  const bind = () => {
    transport.onmessage = message => adapter.onmessage?.(message);
    transport.onerror = error => { if (initialized) adapter.onerror?.(error); };
    transport.onclose = () => adapter.onclose?.();
  };
  const adapter: Transport = {
    async start() { bind(); await transport.start(); },
    async send(message, options) {
      try {
        if (transport instanceof StreamableHTTPClientTransport) await transport.send(message, options);
        else await transport.send(message);
      }
      catch (error) {
        const canFallback = !initialized && "method" in message && message.method === "initialize"
          && transport instanceof StreamableHTTPClientTransport && error instanceof StreamableHTTPError
          && error.code !== undefined && [400, 404, 405].includes(error.code);
        if (!canFallback) throw error;
        // Closing the rejected candidate must not close the Client's pending initialize.
        transport.onclose = () => {};
        await transport.close();
        transport = new SSEClientTransport(target.url, { requestInit: { headers: target.headers } });
        bind();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            transport.start(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new McpTransportError("mcp_sse_start_timeout")), 8000); }),
          ]);
          await transport.send(message);
        } catch (failure) {
          // Preserve the initialization failure instead of replacing it with connection-closed.
          transport.onclose = () => {};
          await transport.close();
          throw failure;
        }
        finally { clearTimeout(timer); }
      }
      if ("method" in message && message.method === "initialize") initialized = true;
    },
    close: () => transport.close(),
    setProtocolVersion: version => transport.setProtocolVersion(version),
  };
  return adapter;
}
