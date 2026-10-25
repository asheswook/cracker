import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { z } from "zod";
import { AdapterError, gmailFindSent, gmailList, gmailPage, gmailSendReply, gmailThread, slackRead } from "./source-adapters";

/** Closes page targets whose renderer does not evaluate `1` within `waitMs`; returns their URLs. */
export async function closeFrozenPages(endpoint: string, waitMs = 3000): Promise<string[]> {
  const version = z.object({ webSocketDebuggerUrl: z.string() }).parse(await (await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(5000) })).json());
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  let next = 0;
  socket.onmessage = event => {
    const message = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional() }).parse(JSON.parse(String(event.data)));
    if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id); }
  };
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new TypeError("CDP socket failed")); });
  const send = (method: string, params: object = {}, sessionId?: string, ms = waitMs) => new Promise<{ result?: unknown; error?: unknown } | null>(resolve => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, ms);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const closed: string[] = [];
  try {
    const listed = await send("Target.getTargets", {}, undefined, 5000);
    const pages = z.object({ targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })) }).parse(listed?.result).targetInfos.filter(target => target.type === "page");
    for (const page of pages) {
      const attached = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const sessionId = z.object({ sessionId: z.string() }).safeParse(attached?.result).data?.sessionId;
      if (!sessionId) continue;
      const answered = await send("Runtime.evaluate", { expression: "1", returnByValue: true }, sessionId);
      if (answered) { await send("Target.detachFromTarget", { sessionId }); continue; }
      await send("Target.closeTarget", { targetId: page.targetId });
      closed.push(page.url);
    }
  } finally { socket.close(); }
  if (closed.length) console.error(JSON.stringify({ event: "browser.frozen_pages_closed", count: closed.length, hosts: closed.map(url => URL.parse(url)?.host ?? "") }));
  return closed;
}

export async function browserServer(endpoint = "http://127.0.0.1:9222") {
  const server = new Server({ name: "assistant-browser", version: "1.0.0" }, { capabilities: { tools: {} } });
  let browser: Browser | undefined, context: BrowserContext | undefined, observed: Page | undefined;
  let selected: Page | undefined, observedUrl: string | undefined;
  let backendReady = false;
  const identities = new WeakMap<Page, string>();
  const tabs = async () => Promise.all((await getContext()).pages().map(async page => {
    let id = identities.get(page);
    if (!id) {
      const session = await page.context().newCDPSession(page);
      try { id = z.object({ targetInfo: z.object({ targetId: z.string() }) }).parse(await session.send("Target.getTargetInfo")).targetInfo.targetId; }
      finally { await session.detach(); }
      identities.set(page,id);
    }
    return { id, page, title: await page.title(), url: page.url() };
  }));
  let inner: { readonly client: Client; readonly server: Awaited<ReturnType<typeof createConnection>> } | undefined;
  const excluded = new Set(["browser_close", "browser_install"]);
  const getContext = async () => {
    if (!browser?.isConnected()) {
      try { browser = await chromium.connectOverCDP(endpoint, { timeout: 8000, noDefaults: true }); }
      catch (error) {
        // Playwright waits for every page to answer; one frozen tab blocks all browser tools.
        if (!(error instanceof Error) || !(await closeFrozenPages(endpoint)).length) throw error;
        browser = await chromium.connectOverCDP(endpoint, { timeout: 8000, noDefaults: true });
      }
      context = browser.contexts()[0];
    }
    if (!context) throw new TypeError("Managed Chrome has no default context");
    return context;
  };
  const connect = async () => {
    if (inner) return inner.client;
    const backend = await createConnection({
      browser: { cdpEndpoint: endpoint, cdpTimeout: 8000 }, webmcp: false, allowUnrestrictedFileAccess: true, filePaths: "absolute",
      timeouts: { action: 5000, navigation: 15000 },
      ...(process.env["OUTPUT_DIR"] ? { outputDir: process.env["OUTPUT_DIR"] } : {}),
    }, getContext);
    const client = new Client({ name: "assistant-browser-bridge", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await backend.connect(a); await client.connect(b);
    inner = { client, server: backend };
    return client;
  };
  const reset = async () => {
    const previous = inner; inner = undefined; observed = undefined; selected = undefined; observedUrl = undefined; backendReady = false;
    if (previous) { await previous.client.close(); await previous.server.close(); }
    if (browser) await browser.close();
    browser = undefined; context = undefined;
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = await (await connect()).listTools();
    return { tools: [...SOURCE_TOOLS, ...listed.tools.filter(tool => !excluded.has(tool.name)).map(tool => ({ ...tool,
      description: `Built-in browser: the SAME visible Chrome, tabs and login session as computer use. No browser setup is needed. ${tool.description ?? ""}`,
      ...(tool.name === "browser_tabs" ? { description: "List, open, select or close tabs in the same visible Chrome. Use the stable tab_id returned by this tool for select/close; IDs survive reconnects. Never use numeric tab indexes.", inputSchema: { type: "object" as const, properties: { action: { type:"string", enum:["list","new","select","close"] }, tab_id:{type:"string"}, url:{type:"string"} }, required:["action"], additionalProperties:false } } : {}),
    }))] };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    if (name === "assistant_browser_invalidate") {
      observed = undefined; observedUrl = undefined;
      return { content: [{ type: "text", text: "Browser references invalidated after computer use." }] };
    }
    if (excluded.has(name)) throw new TypeError("Use browser_tabs to close an individual tab");
    if (name.startsWith("source_")) {
      // Fixed adapters: the arguments are ids, never code, URLs or selectors.
      try {
        const ctx = await getContext();
        const open = () => ctx.newPage();
        const a = z.record(z.string(), z.unknown()).parse(args ?? {});
        let out: unknown;
        switch (name) {
          case "source_gmail_list": { const { page, base } = await gmailPage(ctx.pages(), open, String(a["account"])); out = await gmailList(page, base, { after: String(a["after"]), before: a["before"] ? String(a["before"]) : null }); break; }
          case "source_gmail_thread": { const { page, base } = await gmailPage(ctx.pages(), open, String(a["account"])); out = await gmailThread(page, base, String(a["thread_id"])); break; }
          case "source_slack_read": out = await slackRead(ctx.pages(), String(a["workspace"]), String(a["method"]), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).parse(a["params"] ?? {})); break;
          case "source_gmail_send_reply": {
            const send = z.object({ account: z.string(), thread_id: z.string(), body: z.string().min(1), recipient_address: z.string().email(), revision: z.string().min(3) }).strict().parse(a);
            const { page, base } = await gmailPage(ctx.pages(), open, send.account);
            out = await gmailSendReply(page, base, send);
            break;
          }
          case "source_gmail_find_sent": {
            const check = z.object({ account: z.string(), thread_id: z.string(), body: z.string().min(1), revision: z.string().min(3) }).strict().parse(a);
            const { page, base } = await gmailPage(ctx.pages(), open, check.account);
            out = await gmailFindSent(page, base, check);
            break;
          }
          default: throw new AdapterError("unknown_tool", name);
        }
        // Large results are cut structurally (valid JSON, marked), never mid-string.
        let text = JSON.stringify(out);
        // Display-size limit: shortened results say so (truncated / complete=false) and carry no revision.
        if (text.length > 60000 && out && typeof out === "object" && Array.isArray((out as { messages?: unknown }).messages)) {
          const o = out as Record<string, unknown> & { messages: Record<string, unknown>[] };
          const cut = (v: unknown) => typeof v === "string" ? v.slice(0, 1500) : v;
          text = JSON.stringify({ ...o, text: undefined, revision: null, complete: false, messages: o.messages.slice(-40).map(m => ({ ...m, body: cut(m["body"]), text: cut(m["text"]) })), truncated: true });
        }
        if (text.length > 60000 && out && typeof out === "object" && "rows" in (out as object)) {
          const o = out as { rows: unknown[] };
          text = JSON.stringify({ ...o, rows: o.rows.slice(0, 150), complete: false, reason: "result too large" });
        }
        if (text.length > 60000) text = JSON.stringify({ error: "too_large", message: "result too large" });
        return { content: [{ type: "text", text }] };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error instanceof AdapterError ? error.code : "failed", message: error.message.slice(0, 300) }) }] };
      }
    }
    try {
      if (browser && !browser.isConnected()) await reset();
      const client = await connect();
      if (name === "browser_tabs") {
        const request = z.object({action:z.enum(["list","new","select","close"]),tab_id:z.string().optional(),url:z.string().optional()}).strict().parse(args);
        let changed: Page | undefined;
        switch(request.action) {
          case "list": break;
          case "new": changed=await (await getContext()).newPage();if(request.url)await changed.goto(request.url,{timeout:15000});await changed.bringToFront();break;
          case "select":
          case "close": {
            const target=(await tabs()).find(tab=>tab.id===request.tab_id);
            if(!target)throw new TypeError("Unknown tab_id. List tabs and use their stable IDs.");
            if(request.action==="close")await target.page.close();else {changed=target.page;await changed.bringToFront();}
            break;
          }
          default: { const exhaustive:never=request.action;throw new TypeError(exhaustive); }
        }
        if(request.action!=="list"){selected=undefined;observed=undefined;observedUrl=undefined;}
        const rows=await tabs();
        return { content: [{ type: "text", text: JSON.stringify({
          tab_id: rows.find(tab => tab.page === changed)?.id,
          tabs: rows.map(({ id, title, url }) => ({ tab_id: id, title, url })),
        }) }] };
      }
      const pages = (await getContext()).pages();
      const unresponsive = { focused: false, visible: false };
      const states = await Promise.all(pages.map(async page => ({ page, ...await Promise.race([
        page.evaluate(() => ({ focused: document.hasFocus(), visible: document.visibilityState === "visible" })).catch(() => unresponsive),
        new Promise<typeof unresponsive>(resolve => setTimeout(() => resolve(unresponsive), 2000)),
      ]) })));
      const active = states.find(item => item.focused)?.page
        ?? states.find(item => item.page === observed && item.visible)?.page
        ?? states.find(item => item.visible)?.page;
      if (!backendReady) { await client.callTool({ name: "browser_tabs", arguments: { action: "list" } }); selected = pages[0];backendReady=true; }
      if (active) {
        if (selected !== active) { await client.callTool({ name: "browser_tabs", arguments: { action: "select", index: pages.indexOf(active) } }); selected = active; }
        const changed = observed !== active || observedUrl !== active.url();
        if (changed && /"(?:ref|target|[A-Za-z]+Ref|[A-Za-z]+Target)"\s*:/.test(JSON.stringify(args ?? {})))
          return { isError: true, content: [{ type: "text", text: "The visible browser page changed or was manipulated through computer use. Read browser_snapshot before reusing element references. No requested action was executed." }] };
      }
      const result = await client.callTool({ name, arguments: args ?? {} });
      if (!result.isError) { observed = active; observedUrl = active?.url(); }
      return result;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { isError: true, content: [{ type: "text", text: `Browser operation failed: ${error.message.slice(0,1500)}. Recheck the current page before retrying; the action may already have affected it.` }] };
    }
  });
  return { server, close: async () => { await reset(); await server.close(); } };
}

/** Fixed source tools (see source-adapters.ts). The send tool is never offered to the model: the daemon calls it. */
const SOURCE_TOOLS = [
  { name: "source_gmail_list", description: "List Gmail threads of the given account in a date window (after/before as YYYY/MM/DD; any folder except spam/trash), all result pages. Returns rows, total and complete (false when not every page could be read). Reads only.",
    inputSchema: { type: "object" as const, properties: { account: { type: "string" }, after: { type: "string" }, before: { type: ["string", "null"] } }, required: ["account", "after"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "source_gmail_thread", description: "Read one Gmail thread by its id: each message's sender, time, recipients and body, and the thread revision. Reads only.",
    inputSchema: { type: "object" as const, properties: { account: { type: "string" }, thread_id: { type: "string" } }, required: ["account", "thread_id"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "source_slack_read", description: "Call one Slack read API method (auth.test, users.info, users.conversations, conversations.history, conversations.replies, conversations.info) for the given workspace with the signed-in session. Reads only.",
    inputSchema: { type: "object" as const, properties: { workspace: { type: "string" }, method: { type: "string" }, params: { type: "object" } }, required: ["workspace", "method"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "source_gmail_send_reply", description: "Internal: send one approved reply. Not for the model.",
    inputSchema: { type: "object" as const, properties: { account: { type: "string" }, thread_id: { type: "string" }, body: { type: "string" }, recipient_address: { type: "string" }, revision: { type: "string" } }, required: ["account", "thread_id", "body", "recipient_address", "revision"], additionalProperties: false } },
  { name: "source_gmail_find_sent", description: "Internal: check whether an approved reply is in the thread. Not for the model.",
    inputSchema: { type: "object" as const, properties: { account: { type: "string" }, thread_id: { type: "string" }, body: { type: "string" }, revision: { type: "string" } }, required: ["account", "thread_id", "body", "revision"], additionalProperties: false } },
];
