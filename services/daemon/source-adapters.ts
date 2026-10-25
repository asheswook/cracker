/**
 * Fixed source adapters: code that reads Gmail / Slack and sends one approved Gmail reply through the signed-in
 * browser session. The model never supplies a script, URL, HTTP method or selector: tools take ids and windows, and the
 * code here decides what runs. Every call goes through the shared desktop lease (tools.ts classifies source_* as
 * shared browser work).
 *
 * Gmail
 * - Account: the account menu's label ("Google 계정: 이름 (address)") of the tab, with its /u/<n> index; any mismatch
 *   or missing index stops (never a /u/0 fallback).
 * - List: a Gmail search over a date window (in:anywhere, not spam/trash) with paging; the adapter reports coverage
 *   (complete only when every page of the window was read) and distinguishes "no results" from "did not load".
 * - Thread: the print view, parsed per message (sender, time, recipients, body); revision = message count + the last
 *   message's sender and time. Non-print-view responses (login, error) are errors, not text.
 * - Send: one fixed sequence in the reply composer of that thread (all locators scoped to that one composer), exact
 *   recipients (To/Cc/Bcc) and full body checked before the single Send click, then a per-message read-back: a new
 *   message from the account, after the click, whose body equals the approved text.
 */
import type { Locator, Page } from "playwright-core";

const GMAIL = "https://mail.google.com";
export class AdapterError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "AdapterError"; } }
const isHex = (s: string) => /^[0-9a-f]{8,20}$/i.test(s);
const norm = (s: string) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const plain = (html: string) => decode(html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|tr|table)>/gi, "\n").replace(/<[^>]+>/g, " "))
  .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

/** The signed-in address of a Gmail tab, from the account menu label (not the page title). */
async function signedInAccount(page: Page): Promise<string | null> {
  const label = await page.locator('a[aria-label^="Google 계정"], a[aria-label^="Google Account"]').first().getAttribute("aria-label", { timeout: 5000 }).catch(() => null);
  return label?.match(/\(([\w.+-]+@[\w.-]+)\)/)?.[1]?.toLowerCase() ?? null;
}
/** The Gmail tab of exactly this account, with its /u/<n> base. Never another account, never a guessed index. */
export async function gmailPage(pages: readonly Page[], open: () => Promise<Page>, account: string): Promise<{ page: Page; base: string }> {
  const want = account.toLowerCase();
  for (const page of pages) {
    const base = page.url().match(/^https:\/\/mail\.google\.com\/mail\/u\/\d+/)?.[0];
    if (!base) continue;
    if (await signedInAccount(page) === want) return { page, base };
  }
  const page = await open();
  for (let n = 0; n < 4; n++) {
    await page.goto(`${GMAIL}/mail/u/${n}/#inbox`, { timeout: 20000 });
    await page.waitForTimeout(2500);
    const base = page.url().match(/^https:\/\/mail\.google\.com\/mail\/u\/\d+/)?.[0];
    if (!base) throw new AdapterError("login_required", "Gmail is not signed in");
    const signed = await signedInAccount(page);
    if (signed === want) return { page, base };
    if (!signed) throw new AdapterError("login_required", "Gmail account could not be identified");
  }
  throw new AdapterError("account_mismatch", `${account} is not signed in in this browser`);
}

/** Thread rows of one Gmail search over a date window, all pages; coverage is computed here, not by the model. */
export async function gmailList(page: Page, base: string, window: { after: string; before: string | null }, maxPages = 6) {
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(window.after) || (window.before && !/^\d{4}\/\d{2}\/\d{2}$/.test(window.before))) throw new AdapterError("bad_window", "dates must be YYYY/MM/DD");
  const query = `in:anywhere -in:spam -in:trash after:${window.after}${window.before ? ` before:${window.before}` : ""}`;
  await page.goto(`${base}/#search/${encodeURIComponent(query).replace(/%20/g, "+")}`, { timeout: 20000 });
  const rows: { id: string; from: string; subject: string; snippet: string; when: string; unread: boolean }[] = [];
  let complete = false, total: number | null = null;
  for (let p = 0; p < maxPages; p++) {
    const loaded = await Promise.race([
      page.waitForSelector('div[role="main"] tr.zA', { timeout: 15000 }).then(() => "rows" as const),
      page.waitForSelector('div[role="main"] td.TC', { timeout: 15000 }).then(() => "empty" as const),
    ]).catch(() => "timeout" as const);
    if (loaded === "timeout") throw new AdapterError("not_loaded", "the search results did not load");
    if (loaded === "empty") { complete = true; break; }
    await page.waitForTimeout(800);
    const rowCount = await page.locator('div[role="main"] tr.zA').count();
    const pageRows = await page.locator('div[role="main"] tr.zA').evaluateAll(els => els.map(r => {
      const text = (el: Element | null) => ((el as HTMLElement | null)?.innerText || "").replace(/\s+/g, " ").trim();
      return { id: r.querySelector("[data-legacy-thread-id]")?.getAttribute("data-legacy-thread-id") ?? "", from: text(r.querySelector(".yW")), subject: text(r.querySelector(".bog")),
        snippet: text(r.querySelector(".y2")).slice(0, 160), when: r.querySelector(".xW span[title]")?.getAttribute("title") || text(r.querySelector(".xW")), unread: r.classList.contains("zE") };
    }).filter(r => r.id));
    if (pageRows.length !== rowCount) return { window, query, rows, total, complete: false, reason: "some rows had no thread id" };
    for (const r of pageRows) if (!rows.some(x => x.id === r.id)) rows.push(r);
    const range = await page.locator('div[role="main"] span.Dj').first().innerText({ timeout: 3000 }).catch(() => "");
    const m = /([\d,]+)\D+([\d,]+)\D+([\d,]+)/.exec(range.replace(/\s/g, " "));
    if (m) total = Number(m[1]!.replace(/,/g, ""));
    // Last page only when the Next button is found and says disabled; a missing button is not proof.
    const next = page.locator('div[role="button"][aria-label="다음 결과"], div[role="button"][aria-label="Older"]').first();
    if (!(await next.count())) return { window, query, rows, total, complete: false, reason: "paging control not found" };
    if (await next.getAttribute("aria-disabled", { timeout: 2000 }) === "true") { complete = true; break; }
    const firstId = pageRows[0]?.id;
    await next.click();
    const moved = await page.waitForFunction((id) => { const first = document.querySelector('div[role="main"] tr.zA [data-legacy-thread-id]'); return !!first && first.getAttribute("data-legacy-thread-id") !== id; }, firstId, { timeout: 15000 }).then(() => true, () => false);
    if (!moved) return { window, query, rows, total, complete: false, reason: "next page did not load" };
  }
  return { window, query, rows, total, complete, reason: complete ? null : "more pages than read" };
}

export type GmailMessage = { from: string; from_address: string | null; at: string; to: string; body: string };
/** One thread, per message, through the print view. revision = count + last sender + last time. */
export async function gmailThread(page: Page, base: string, threadId: string) {
  if (!isHex(threadId)) throw new AdapterError("bad_thread", "thread id must be a Gmail hex thread id");
  const decimal = BigInt(`0x${threadId}`).toString();
  const response = await page.evaluate(async (url) => { const r = await fetch(url, { credentials: "include" }); return { status: r.status, url: r.url, html: await r.text() }; },
    `${base}/?ui=2&view=pt&search=all&permthid=thread-f:${decimal}`);
  if (response.status !== 200 || !response.url.startsWith(`${base}/`)) throw new AdapterError("not_loaded", `print view returned ${response.status}`);
  const blocks = response.html.split(/<table[^>]*class="message"[^>]*>/).slice(1);
  if (!blocks.length) throw new AdapterError("not_loaded", "no messages in the print view (login page or changed layout)");
  const messages: GmailMessage[] = blocks.map(block => {
    const head = /<b>([\s\S]*?)<\/b>\s*(?:&lt;([^&<]+)&gt;)?[\s\S]*?<td align=right><font size=-1>([\s\S]*?)<\/font>/.exec(block);
    const to = /class="recipient"[^>]*>([\s\S]*?)<\/font>/.exec(block);
    // The body is the cellpadding=12 table's cell, without the quoted earlier mail (gmail_quote) and the print script.
    const cell = /<table width=100% cellpadding=12[^>]*>\s*<tr>\s*<td>([\s\S]*)/.exec(block)?.[1] ?? null;
    const body = cell ? [null, cell.split(/<div class="gmail_quote"|<blockquote|<script/i)[0]] : null;
    if (!head || !body) throw new AdapterError("not_loaded", "a message in the print view could not be parsed");
    return { from: norm(plain(head[1] ?? "")), from_address: head[2] ? norm(decode(head[2])).toLowerCase() : null, at: norm(plain(head[3] ?? "")),
      to: norm(plain(to?.[1] ?? "")), body: plain(body[1] ?? "") };
  });
  const last = messages.at(-1)!;
  // Revision and send checks need the whole text; a thread too long to read whole is reported as such, never cut.
  const complete = messages.every(m => m.body.length <= 20000);
  // Revision: count | last sender | hash of every message's sender, time and body (a changed or replaced message changes it).
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(messages.map(m => [m.from_address, m.at, norm(m.body)])))));
  const hash = Array.from(digest.slice(0, 8), b => b.toString(16).padStart(2, "0")).join("");
  return { thread_id: threadId, messages, complete, revision: complete ? `${messages.length}|${last.from_address ?? last.from}|${hash}` : null,
    text: messages.map(m => `${m.from}${m.from_address ? ` <${m.from_address}>` : ""} ${m.at}\n${m.to}\n${m.body}`).join("\n---\n").slice(-12000) };
}

const SLACK_READ: Record<string, readonly string[]> = {
  "auth.test": [], "users.info": ["user"], "users.conversations": ["types", "exclude_archived", "limit", "cursor"],
  "conversations.history": ["channel", "oldest", "latest", "limit", "cursor"], "conversations.replies": ["channel", "ts", "limit", "cursor"], "conversations.info": ["channel"],
};
/**
 * One Slack read API call for exactly one workspace: the team whose domain or name equals the given workspace (an
 * ambiguous or missing match is refused), checked with auth.test. Only fixed read methods and their params.
 */
export async function slackRead(pages: readonly Page[], workspace: string, method: string, params: Record<string, string | number | boolean>) {
  const allowed = SLACK_READ[method];
  if (!allowed) throw new AdapterError("bad_method", `not a read method: ${method}`);
  const extra = Object.keys(params).filter(k => !allowed.includes(k));
  if (extra.length) throw new AdapterError("bad_params", `not allowed: ${extra.join(", ")}`);
  const page = pages.find(p => p.url().startsWith("https://app.slack.com/"));
  if (!page) throw new AdapterError("login_required", "Slack is not open in the browser");
  const out = await page.evaluate(async ({ workspace, method, params }) => {
    const cfg = JSON.parse(localStorage.getItem("localConfig_v2") || "{}");
    const want = workspace.toLowerCase();
    const teams = Object.entries(cfg.teams || {}) as [string, { token?: string; name?: string; domain?: string }][];
    const matches = teams.filter(([, t]) => (t.domain ?? "").toLowerCase() === want || (t.name ?? "").toLowerCase() === want);
    if (matches.length !== 1 || !matches[0]![1].token) return { ok: false, error: matches.length ? "workspace_ambiguous" : "workspace_not_signed_in" };
    const [teamId, team] = matches[0]!;
    const call = async (m: string, p: Record<string, unknown>) => {
      const form = new FormData(); form.append("token", team.token!);
      for (const [k, v] of Object.entries(p)) form.append(k, String(v));
      return (await fetch(`/api/${m}`, { method: "POST", body: form, credentials: "include" })).json();
    };
    const auth = await call("auth.test", {});
    if (!auth.ok || auth.team_id !== teamId) return { ok: false, error: "workspace_mismatch" };
    const r = method === "auth.test" ? auth : await call(method, params);
    return { ...r, _team_id: teamId };
  }, { workspace, method, params });
  return out as Record<string, unknown>;
}

/** The reply composer of the open thread: one region that holds the body box and the Send button. */
async function replyComposer(page: Page): Promise<Locator | null> {
  const composers = page.locator('div[role="main"] div[role="region"]:has(div[role="textbox"][contenteditable="true"]):has([role="button"][aria-label="보내기"], [role="button"][aria-label="Send"])');
  const n = await composers.count();
  return n === 1 ? composers.first() : null;
}
async function composerRecipients(composer: Locator) {
  // Recipient chips only (To/Cc/Bcc), not the From line: Gmail renders them with an email attribute inside the form.
  return (await composer.locator('[role="option"][data-hovercard-id], span[email][data-hovercard-id]:not([data-name="from"])').evaluateAll(els => [...new Set(els.map(e => (e.getAttribute("email") || e.getAttribute("data-hovercard-id") || "").toLowerCase()).filter(Boolean))]));
}

export type SendEnvelope = { account: string; thread_id: string; body: string; recipient_address: string; revision: string };
/**
 * Send one approved Gmail reply. Before Send: the thread's revision equals the approved one, no other composer is open,
 * the reply composer's recipients are exactly the approved address, and it holds exactly the approved body. Then one
 * click, and a per-message read-back. attempted=true from the click on: after that, failures are unknown.
 */
export async function gmailSendReply(page: Page, base: string, send: SendEnvelope) {
  const result = await sendReplyOnce(page, base, send);
  // Stopped before Send in the one composer we opened: discard that draft (only inside it).
  if (result.outcome === "not_sent" && result.composer) {
    const discard = result.composer.locator('[role="button"][aria-label^="임시보관"], [role="button"][aria-label^="Discard"]').first();
    if (await discard.count()) await discard.click().catch(() => undefined);
  }
  return { outcome: result.outcome, attempted: result.attempted, evidence: result.evidence };
}
async function sendReplyOnce(page: Page, base: string, send: SendEnvelope): Promise<{ outcome: "sent" | "not_sent" | "unknown" | "refused"; attempted: boolean; evidence: string; composer?: Locator }> {
  const before = await gmailThread(page, base, send.thread_id);
  if (!before.complete) return { outcome: "not_sent" as const, attempted: false, evidence: "the thread is too long to check exactly" };
  if (before.revision !== send.revision) return { outcome: "refused" as const, attempted: false, evidence: `thread changed: ${before.revision} (approved ${send.revision})` };
  await page.bringToFront();
  await page.goto(`${base}/#all/${send.thread_id}`, { timeout: 20000 });
  await page.waitForTimeout(2500);
  // Do not touch a composer we did not open: an existing one may hold the user's own draft.
  if (await page.locator('div[role="textbox"][contenteditable="true"][aria-label="메일 본문"], div[role="textbox"][contenteditable="true"][aria-label="Message Body"]').count())
    return { outcome: "not_sent" as const, attempted: false, evidence: "a compose or reply box is already open; not touching it" };
  const reply = page.locator('div[role="main"] button[aria-label="답장"], div[role="main"] button[aria-label="Reply"]').last();
  if (!(await reply.count())) return { outcome: "not_sent" as const, attempted: false, evidence: "no Reply button on the thread page" };
  try { await reply.click({ timeout: 10000 }); }
  catch { return { outcome: "not_sent" as const, attempted: false, evidence: "the Reply button could not be clicked" }; }
  await page.waitForTimeout(1500);
  const composer = await replyComposer(page);
  if (!composer) return { outcome: "not_sent" as const, attempted: false, evidence: "the reply composer did not open (or more than one); nothing touched" };
  const box = composer.locator('div[role="textbox"][contenteditable="true"]').first();
  // An empty Gmail box shows a hint ("글쓰기 도우미를 사용하려면 / 키를 누르세요"); real content is anything else.
  const existing = norm(await box.innerText()).replace(/^(글쓰기 도우미를 사용하려면 \/ 키를 누르세요|Press \/ to use Help me write)$/i, "");
  if (existing.length) return { outcome: "not_sent" as const, attempted: false, evidence: "the reply box already holds text (maybe a saved draft); not touching it" };
  await box.fill(send.body);
  if (norm(await box.innerText()) !== norm(send.body)) return { outcome: "not_sent" as const, attempted: false, evidence: "the reply box does not hold exactly the approved text", composer };
  const recipients = await composerRecipients(composer);
  const self = send.account.toLowerCase();
  // The composer shows From (self) and the recipients; the only other address must be exactly the approved one.
  const others = recipients.filter(r => r !== self);
  if (others.length !== 1 || others[0] !== send.recipient_address.toLowerCase()) return { outcome: "not_sent" as const, attempted: false, evidence: `recipients ${recipients.join(", ") || "(none found)"} are not exactly ${send.recipient_address}`, composer };
  if (await composer.locator('[aria-label*="첨부"], [aria-label*="ttachment"]').filter({ hasText: /\.\w{2,4}/ }).count()) return { outcome: "not_sent" as const, attempted: false, evidence: "the reply has attachments", composer };
  const sendButton = composer.locator('[role="button"][aria-label="보내기"], [role="button"][aria-label="Send"]').first();
  try { await sendButton.click({ timeout: 10000 }); }
  catch (error) { return { outcome: "unknown" as const, attempted: true, evidence: `send click failed: ${error instanceof Error ? error.message.slice(0, 120) : "?"}` }; }
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(2500);
    const after = await gmailThread(page, base, send.thread_id).catch(() => null);
    if (!after || !after.complete) continue;
    const fresh = after.messages.slice(before.messages.length);
    if (fresh.some(m => m.from_address === self && norm(m.body) === norm(send.body)))
      return { outcome: "sent" as const, attempted: true, evidence: `read back: new message ${after.messages.length} from ${self} with the approved text` };
  }
  return { outcome: "unknown" as const, attempted: true, evidence: "Send was clicked but the new message was not seen in the thread yet" };
}

/** For a check job: is there a message from the account, after the approved revision, with the approved text? */
export async function gmailFindSent(page: Page, base: string, check: { account: string; thread_id: string; body: string; revision: string }) {
  const thread = await gmailThread(page, base, check.thread_id);
  if (!thread.complete) return { found: null, evidence: "the thread is too long to check exactly" };
  const approvedCount = Number(check.revision.split("|")[0]) || 0;
  const fresh = thread.messages.slice(approvedCount);
  const self = check.account.toLowerCase();
  if (fresh.some(m => m.from_address === self && norm(m.body) === norm(check.body))) return { found: true, evidence: "a later message from the account has exactly the approved text" };
  // Not seeing it is never proof it was not sent (late indexing, a deleted message): the caller keeps it unknown.
  return { found: null, evidence: fresh.some(m => m.from_address === self) ? "a later message from the account exists but its text differs" : "no later message from the account seen yet" };
}
