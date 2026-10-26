import { z } from "zod";
import type { Tool } from "../../packages/provider/index.ts";
import { ChoiceBlock, DraftBlock, ResultBlock, type MessageBlock } from "../../packages/protocol/index.ts";

/**
 * show_result: after an action the user instructed has actually happened (message sent, post published, event created,
 * room booked), show it as a card without buttons. It reports facts from the receipt; it never performs the action.
 */
// Wire schema kept simple for strict tool calling; the stored block is validated by ResultBlock afterwards.
const Input = z.object({
  action: ResultBlock.shape.action,
  channel: z.string().min(1).max(80),
  target: z.string().max(200).nullable(),
  title: z.string().max(200).nullable(),
  body: z.string().max(4000).nullable(),
  url: z.string().max(2000).nullable(),
  at: z.string().max(40).nullable(),
  card: z.string().max(80).nullable(),
  summary: z.string().min(1).max(300),
}).strict();
export const showResultTool: Tool = {
  type: "function",
  name: "show_result",
  description:
    "Show the user a card for an external action that has ALREADY happened on their instruction (sent a message or email, posted, created or changed a calendar event, booked or cancelled a room). " +
    "Call it once per completed action, right after you have the actual receipt or have observed the result; never before, and never for drafts or for things still to be decided. " +
    "channel = where it happened (e.g. 'Slack #general', 'Gmail', 'Google Calendar (회사)', '3층 회의실'). target = recipient, attendee or room, or null. " +
    "title = subject, event title or post title, or null. body = the exact text that was sent or posted, or the key details, or null. url = a link to the sent item if you have one, else null. " +
    "at = ISO time of the action or the event, or null. card = when this action carries out a draft the user approved, that card's reference \"<message id>:<block id>\" exactly as given in the approval message, else null; then body must be exactly the approved text you sent. summary = one short sentence for people who cannot see the card.",
  strict: true,
  parameters: z.toJSONSchema(Input) as Record<string, unknown>,
};
export function resultBlock(args: string): { block: MessageBlock; summary: string } {
  const input = Input.parse(JSON.parse(args));
  const { summary, ...rest } = input;
  const url = rest.url && /^https?:\/\//.test(rest.url) && z.url().safeParse(rest.url).success ? rest.url : null;
  const at = rest.at && z.iso.datetime({ offset: true }).safeParse(rest.at).success ? rest.at : null;
  const card = rest.card && /^[0-9a-f-]{36}:[a-z0-9_-]{1,32}$/.test(rest.card) ? rest.card : null;
  return { block: ResultBlock.parse({ kind: "result", ...rest, card, url, at, channel: rest.channel.trim(), target: rest.target?.trim() || null, title: rest.title?.trim() || null }), summary: summary.trim() };
}

/**
 * ask_user: put a decision in front of the user as a card instead of prose, then end the turn.
 * - draft: text the user must approve before it is sent or posted (the assistant wrote the wording).
 * - choice: a short question with 2-4 options.
 * The user's button press arrives as a normal user message replying to the card.
 */
const AskInput = z.object({
  kind: z.enum(["draft", "choice"]),
  summary: z.string().min(1).max(300),
  channel: z.string().max(80).nullable(),
  target: z.string().max(200).nullable(),
  title: z.string().max(200).nullable(),
  body: z.string().max(8000).nullable(),
  question: z.string().max(300).nullable(),
  options: z.array(z.string().min(1).max(40)).max(4).nullable(),
}).strict();
export const askUserTool: Tool = {
  type: "function",
  name: "ask_user",
  description:
    "Ask the user to approve or decide something through a card with buttons, then stop and wait (end your turn with at most one short sentence). " +
    "kind=draft when you wrote a message, email or post that must not go out until the user approves it: set channel (e.g. 'Gmail', 'Slack #개발'), target (recipient or channel), title (subject or null) and body (the exact text); buttons are 보내기/수정/나중에. " +
    "kind=choice for a short decision: set question and 2-4 short options (e.g. ['17-B로 잡기','다른 층 보기']); a '나중에' option is added automatically. " +
    "Do not use it when the user already gave the exact content and target; then act and call show_result. summary = one sentence for notifications and people who cannot see the card. Unused fields are null.",
  strict: true,
  parameters: z.toJSONSchema(AskInput) as Record<string, unknown>,
};
export function askBlock(args: string, callId: string): { block: MessageBlock; summary: string } {
  const input = AskInput.parse(JSON.parse(args));
  const id = `c${new Bun.CryptoHasher("sha256").update(callId).digest("hex").slice(0, 12)}`;
  if (input.kind === "draft") {
    if (!input.channel?.trim() || !input.body?.trim()) throw new TypeError("draft needs channel and body");
    return { block: DraftBlock.parse({ kind: "draft", id, channel: input.channel.trim(), target: input.target?.trim() || null, title: input.title?.trim() || null, body: input.body }), summary: input.summary.trim() };
  }
  const labels = [...new Set((input.options ?? []).map(o => o.trim()).filter(Boolean))].slice(0, 3);
  if (!input.question?.trim() || labels.length < 1) throw new TypeError("choice needs a question and options");
  const options = [...labels.map((label, i) => ({ id: `o${i + 1}`, label })), { id: "later", label: "나중에" }];
  return { block: ChoiceBlock.parse({ kind: "choice", id, question: input.question.trim(), options }), summary: input.summary.trim() };
}

/** read_attention: what needs the user, what is in progress, what finished — the source for a briefing. */
export const readAttentionTool: Tool = {
  type: "function",
  name: "read_attention",
  description:
    "Read the user's 피드 list: needs_you (unanswered cards, stopped tasks), in_progress (running tasks, standing responsibilities, pending schedules) and done (results of the last 48 hours). " +
    "Use it to write a morning brief or to answer 'what's going on'. Each item has a topic, title, detail and time. It reads only; it changes nothing.",
  strict: true,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};

/** set_brief: the user changes the morning brief by asking ("브리핑 8시에", "브리핑 꺼줘", "알아서 해"). */
export const setBriefTool: Tool = {
  type: "function",
  name: "set_brief",
  description:
    "Change the assistant-owned morning brief when the user asks. enabled=false turns it off; time='HH:MM' fixes the time (local); time=null returns to the assistant choosing a time from the user's own morning pattern. " +
    "The brief is on by default and the assistant picks the time; do not ask the user to set one. Quote the user's words in source_quote.",
  strict: true,
  parameters: { type: "object", properties: { enabled: { type: "boolean" }, time: { type: ["string", "null"], pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }, source_quote: { type: "string", maxLength: 300 } }, required: ["enabled", "time", "source_quote"], additionalProperties: false },
};

/** report_observation: an assistant-owned watch run (e.g. Gmail) reports what it saw, once, in structured form. */
export const reportObservationTool: Tool = {
  type: "function",
  name: "report_observation",
  description:
    "Only in a watch/observation run: report what you observed, exactly once, then reply NO_REPORT. account = the signed-in account you actually saw. " +
    "coverage: complete if you read the whole window, partial if you stopped early (set oldest_read = the oldest message time you fully read), failed if you could not look (error_kind login_required / account_choice / browser_unavailable / ui_changed / other; then items and resolved must be empty). " +
    "items = threads that still need the user: thread_key (Gmail thread id, or Slack '<channel id>:<thread ts>'), url (thread link or null), subject, counterpart (who), category (request = asked of the user; deadline = date ahead; overdue = a date passed undone; waiting = the user asked and the reply is late; alert = cost/security/expiry), " +
    "action (reply = someone asked the user directly and expects their answer; review = e.g. code review; act = something to do elsewhere; none = just to know), reason (one Korean line why), evidence (a short quote showing the request, no secrets), due_at (ISO or null), version (last message time + message count). " +
    "resolved = previously open threads now handled, each with how (replied / done / withdrawn) and evidence from the thread. A passed deadline, being read, archived or missing from a search is NOT resolved. If the tool returns retry, fix and call again.",
  strict: true,
  parameters: {
    type: "object", additionalProperties: false,
    required: ["account", "coverage", "error_kind", "error", "oldest_read", "items", "resolved"],
    properties: {
      account: { type: "string" },
      coverage: { type: "string", enum: ["complete", "partial", "failed"] },
      error_kind: { type: ["string", "null"], enum: ["login_required", "account_choice", "browser_unavailable", "ui_changed", "other", null] },
      error: { type: ["string", "null"] },
      oldest_read: { type: ["string", "null"] },
      items: { type: "array", items: { type: "object", additionalProperties: false, required: ["thread_key", "url", "subject", "counterpart", "category", "action", "reason", "evidence", "due_at", "version", "request_anchor", "waiting_since"], properties: {
        thread_key: { type: "string" }, url: { type: ["string", "null"] }, subject: { type: "string" }, counterpart: { type: ["string", "null"] },
        category: { type: "string", enum: ["request", "deadline", "overdue", "waiting", "alert", "promise"] }, action: { type: "string", enum: ["reply", "review", "act", "none"] },
        reason: { type: "string" }, evidence: { type: ["string", "null"] }, due_at: { type: ["string", "null"] }, version: { type: "string" }, request_anchor: { type: ["string", "null"] }, waiting_since: { type: ["string", "null"] } } } },
      resolved: { type: "array", items: { type: "object", additionalProperties: false, required: ["thread_key", "how", "evidence", "answered_by"], properties: {
        thread_key: { type: "string" }, how: { type: "string", enum: ["replied", "done", "withdrawn"] }, evidence: { type: "string" }, answered_by: { type: ["string", "null"] } } } },
    },
  },
};

/** watch_source: the user asks the assistant to keep an eye on a source, to stop, or to look just once. */
export const watchSourceTool: Tool = {
  type: "function",
  name: "watch_source",
  description:
    "Watching the user's Gmail or Slack on their behalf through the VM browser (kind gmail / slack; account = the Gmail address or the Slack workspace, e.g. acme). mode=watch: keep looking every couple of hours outside quiet hours (findings go to 피드 and the morning brief; reply drafts are prepared for mail that needs the user's answer; no periodic reports). " +
    "mode=stop: stop watching. mode=once: look a single time now without turning the watch on. Call it only when the user asks in this turn ('Gmail 챙겨줘', '메일 한 번 봐줘', 'Gmail 그만 봐'); source_quote = the user's exact words. " +
    "When the user asks you to check, read or go through their Gmail or Slack for things to handle (e.g. '메일 확인해줘', '슬랙 답할 거 있나 봐줘'), use mode=once instead of reading it yourself: the look is tracked in 피드, reply drafts are prepared, and its result is posted in this conversation. Then end your turn with one short sentence; do not also read it in this turn. " +
    "You may suggest a single look when it clearly helps the conversation, but never turn the standing watch on (or back on after the user stopped it) without the user saying so. account = the Gmail address. interval_minutes = null unless the user said how often.",
  strict: true,
  parameters: { type: "object", additionalProperties: false, required: ["kind", "account", "mode", "source_quote", "interval_minutes"], properties: {
    kind: { type: "string", enum: ["gmail", "slack"] }, account: { type: "string" }, mode: { type: "string", enum: ["watch", "stop", "once"] }, source_quote: { type: "string", maxLength: 300 }, interval_minutes: { type: ["integer", "null"], minimum: 30, maximum: 1440 } } },
};
