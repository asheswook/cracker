import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { z } from "zod";

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
    return { tools: listed.tools.filter(tool => !excluded.has(tool.name)).map(tool => ({ ...tool,
      description: `Built-in browser: the SAME visible Chrome, tabs and login session as computer use. No browser setup is needed. ${tool.description ?? ""}`,
      ...(tool.name === "browser_tabs" ? { description: "List, open, select or close tabs in the same visible Chrome. Use the stable tab_id returned by this tool for select/close; IDs survive reconnects. Never use numeric tab indexes.", inputSchema: { type: "object" as const, properties: { action: { type:"string", enum:["list","new","select","close"] }, tab_id:{type:"string"}, url:{type:"string"} }, required:["action"], additionalProperties:false } } : {}),
    })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    if (name === "assistant_browser_invalidate") {
      observed = undefined; observedUrl = undefined;
      return { content: [{ type: "text", text: "Browser references invalidated after computer use." }] };
    }
    if (excluded.has(name)) throw new TypeError("Use browser_tabs to close an individual tab");
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
