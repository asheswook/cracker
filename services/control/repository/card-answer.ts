import { z } from "zod";
import { DomainError, MessageBlocks } from "../../../packages/protocol";
import type { Query } from "../db";
import { appendMessage } from "./common";
import { nextBriefAt } from "../../../packages/attention/coordinator";
import { draftSendContext, draftStillValid, startSend } from "../../../packages/attention/sources";

/**
 * A button pressed on a draft or choice card.
 * - send / edit / a choice option: appended as an ordinary user message that replies to the card (text for the model,
 *   an `answer` block for the client), so it reaches the active task or starts one; the card becomes `accepted` and is
 *   linked to that task until the task finishes (`resolved` / `failed`, see settleCardsForTask).
 * - later: a snooze. No message, no work; the card returns to 챙길 것 and the next brief at snoozed_until.
 * - dismiss: the user does not want it; it is not shown again.
 * A card takes one decisive answer; snoozing can be followed by an answer. The same client id returns the first result.
 */
export const CardAnswerRequest = z.object({
  client_message_id: z.uuid(),
  block_id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  option: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  body: z.string().max(8000).optional(),
  snooze_hours: z.number().int().min(1).max(24 * 14).optional(),
}).strict();

const CardState = z.object({ state: z.string(), answer_message_id: z.uuid().nullable(), option: z.string().nullable() });

export async function answerCard(sql: Query, input: { readonly workspace: string; readonly conversation: string; readonly message: string } & z.infer<typeof CardAnswerRequest>) {
  const row = (await sql`SELECT id,role,blocks,hidden FROM assistant.messages WHERE workspace_id=${input.workspace} AND conversation_id=${input.conversation} AND id=${input.message} FOR UPDATE`)[0];
  if (!row || row["role"] !== "assistant" || row["hidden"]) throw new DomainError("not_found", "Card not found", 404);
  const blocks = MessageBlocks.nullable().parse(row["blocks"] ?? null) ?? [];
  const block = blocks.find(b => (b.kind === "draft" || b.kind === "choice") && b.id === input.block_id);
  if (!block || (block.kind !== "draft" && block.kind !== "choice")) throw new DomainError("not_found", "Card not found", 404);
  await sql`INSERT INTO assistant.card_states(workspace_id,message_id,block_id) VALUES(${input.workspace},${input.message},${input.block_id}) ON CONFLICT DO NOTHING`;
  const state = CardState.parse((await sql`SELECT state,answer_message_id,option FROM assistant.card_states WHERE workspace_id=${input.workspace} AND message_id=${input.message} AND block_id=${input.block_id} FOR UPDATE`)[0]);

  // Idempotent retry of the same press.
  const prior = (await sql`SELECT id FROM assistant.messages WHERE workspace_id=${input.workspace} AND conversation_id=${input.conversation} AND client_message_id=${input.client_message_id}`)[0];
  if (prior) {
    const message = (await sql`SELECT * FROM assistant.messages WHERE id=${prior["id"]}`)[0];
    const current = (await sql`SELECT state,to_jsonb(snoozed_until)#>>'{}' AS snoozed_until FROM assistant.card_states WHERE workspace_id=${input.workspace} AND message_id=${input.message} AND block_id=${input.block_id}`)[0];
    return { card: { state: String(current?.["state"] ?? state.state), snoozed_until: (current?.["snoozed_until"] as string | null) ?? null }, message, task: null };
  }
  if (input.option === "later" || input.option === "dismiss") {
    if (!["pending", "snoozed"].includes(state.state)) throw new DomainError("already_answered", "This card was already answered", 409);
    // 나중에 = until the next brief, where it comes back with everything else (or an explicit number of hours).
    const until = input.snooze_hours ? new Date(Date.now() + input.snooze_hours * 3_600_000) : await nextBriefAt(sql, input.workspace);
    if (input.option === "later") await sql`UPDATE assistant.card_states SET state='snoozed',option='later',snoozed_until=${until},snooze_next_brief=${!input.snooze_hours},updated_at=now() WHERE workspace_id=${input.workspace} AND message_id=${input.message} AND block_id=${input.block_id}`;
    else await sql`UPDATE assistant.attention_source_items i SET state='dismissed',updated_at=now() FROM assistant.attention_source_drafts d WHERE d.card_message_id=${input.message} AND d.item_id=i.id AND i.state='open'`;
    if (input.option === "dismiss") await sql`UPDATE assistant.card_states SET state='dismissed',option='dismiss',snoozed_until=NULL,snooze_next_brief=false,updated_at=now() WHERE workspace_id=${input.workspace} AND message_id=${input.message} AND block_id=${input.block_id}`;
    // Remember the press so a retry with the same id is a no-op.
    await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,role,content,client_message_id,origin,hidden,reply_to_message_id,blocks)
      VALUES(${input.workspace},${input.conversation},'user',${input.option === "later" ? "나중에" : "필요 없음"},${input.client_message_id},'user',true,${input.message},
      ${JSON.stringify([{ kind: "answer", message_id: input.message, block_id: input.block_id, option: input.option, label: input.option === "later" ? "나중에" : "필요 없음", body: null }])}::text::jsonb)`;
    return { card: input.option === "later" ? { state: "snoozed", snoozed_until: until.toISOString() } : { state: "dismissed", snoozed_until: null }, message: null, task: null };
  }
  // A send proved not to have happened (verified not_sent) may be approved again from the same card; any other failed
  // card might have gone out, so it is not re-sendable.
  const retry = state.state === "failed" && (await sql`SELECT retry_ok FROM assistant.card_states WHERE workspace_id=${input.workspace} AND message_id=${input.message} AND block_id=${input.block_id}`)[0]?.["retry_ok"] === true;
  if (!["pending", "snoozed"].includes(state.state) && !retry) throw new DomainError("already_answered", "This card was already answered", 409);
  // A reply draft for a watched thread is sendable only while that thread is open at the version it was written for.
  const linked = block.kind === "draft" && input.option !== "edit" ? await draftStillValid(sql, input.workspace, input.message) : { linked: false as const };
  if (linked.linked && !linked.ok) {
    await sql`UPDATE assistant.card_states SET state='replaced',updated_at=now() WHERE workspace_id=${input.workspace} AND message_id=${input.message} AND block_id=${input.block_id}`;
    // Not an error to retry: the card is closed and says why (the state change must be kept, so no throw).
    return { card: { state: "replaced", snoozed_until: null, reason: "이 메일 스레드가 바뀌었거나 이미 처리돼서 이 초안은 보낼 수 없어요" }, message: null, task: null };
  }
  const sendContext = linked.linked ? await draftSendContext(sql, input.workspace, input.message) : null;
  let label: string, text: string, body: string | null = null;
  if (block.kind === "choice") {
    const option = block.options.find(o => o.id === input.option);
    if (!option) throw new DomainError("invalid_answer", "Unknown option", 400);
    label = option.label;
    text = `「${block.question}」 → ${option.label}`;
  } else {
    if (!["send", "edit"].includes(input.option)) throw new DomainError("invalid_answer", "Unknown option", 400);
    body = input.body ?? block.body;
    // Placeholders ("[가능 여부 / 시간]") are for the user to fill; a draft with one left must not go out as is.
    if (input.option === "send" && PLACEHOLDER.test(body)) throw new DomainError("draft_placeholder", "초안에 [ ]로 비워 둔 부분이 있어요. 수정에서 채운 뒤 보내 주세요.", 400);
    label = input.option === "send" ? (body === block.body ? "보내기" : "수정해서 보내기") : "수정 요청";
    text = input.option === "edit"
      ? `${block.channel}${block.target ? ` ${block.target}` : ""} 초안을 이렇게 고쳐 줘:\n${body}`
      : `${block.channel}${block.target ? ` ${block.target}` : ""}에 이 내용으로 보내 줘(승인, 카드 ${input.message}:${input.block_id}):\n${body}${sendContext ? `\n\n${sendContext}` : ""}`;
  }
  const answer = { kind: "answer" as const, message_id: input.message, block_id: input.block_id, option: input.option, label, body };
  // An approved reply to a watched thread goes to the dedicated sender (fixed body, account, thread), not to a chat task.
  if (linked.linked && input.option === "send" && body !== null) {
    const send = await startSend(sql, { workspace: input.workspace, card: input.message, block: input.block_id, body, recipient: block.kind === "draft" ? block.target : null });
    if (send && "blocked" in send) throw new DomainError("send_pending", send.blocked ?? "", 409);
    if (send) {
      const note = await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,role,content,client_message_id,origin,hidden,reply_to_message_id,blocks)
        VALUES(${input.workspace},${input.conversation},'user',${label},${input.client_message_id},'user',true,${input.message},${JSON.stringify([answer])}::text::jsonb) RETURNING *`;
      await sql`UPDATE assistant.card_states SET state='accepted',option=${input.option},approved_body=${body},retry_ok=false,snoozed_until=NULL,snooze_next_brief=false,answer_message_id=${note[0]?.["id"] ?? null},task_id=${send.task.id},updated_at=now()
        WHERE workspace_id=${input.workspace} AND message_id=${input.message} AND block_id=${input.block_id}`;
      return { card: { state: "accepted", snoozed_until: null }, message: null, task: send.task };
    }
  }
  const result = await appendMessage(sql, {
    workspace: input.workspace, conversation: input.conversation, content: text, clientId: input.client_message_id,
    replyTo: input.message, returnControl: true,
  });
  await sql`UPDATE assistant.messages SET blocks=${JSON.stringify([answer])}::text::jsonb WHERE workspace_id=${input.workspace} AND id=${result.message.id} AND blocks IS NULL`;
  await sql`UPDATE assistant.card_states SET state='accepted',option=${input.option},approved_body=${body},retry_ok=false,snoozed_until=NULL,snooze_next_brief=false,answer_message_id=${result.message.id},task_id=${result.task.id},updated_at=now()
    WHERE workspace_id=${input.workspace} AND message_id=${input.message} AND block_id=${input.block_id}`;
  return { card: { state: "accepted", snoozed_until: null }, ...result, message: { ...result.message, blocks: [answer] } };
}

/** A blank the assistant left for the user: "[가능 여부 / 시간]", "[ ]", "[날짜]" — not "[공지]" or a Markdown link. */
export const PLACEHOLDER = /\[(?:\s*|[^\]\n]{0,80}(?:\/|여부|시간|날짜|이름|금액|확인|입력|선택|가능)[^\]\n]{0,80})\](?!\()/;
const Raw = z.array(z.object({ kind: z.string() }).passthrough()).catch([]);

/**
 * A sent/posted result names the approved card it carries out (result.card = "<message>:<block>"); only that card is
 * resolved, and only if it was approved and is carried by this task. A result
 * without the reference resolves nothing: without evidence a draft is never shown as 보냄.
 */
export async function resolveCardsForResult(sql: Query, workspace: string, task: string, message: string, blocks: readonly unknown[]) {
  for (const result of Raw.parse(blocks)) {
    if (result.kind !== "result" || !["sent", "posted"].includes(String(result["action"])) || typeof result["card"] !== "string") continue;
    const [card, block] = String(result["card"]).split(":");
    if (!card || !block || !z.uuid().safeParse(card).success) continue;
    // The receipt must carry the approved text: a send of something else does not complete this approval.
    const approved = (await sql`SELECT a.blocks FROM assistant.card_states c JOIN assistant.messages a ON a.workspace_id=c.workspace_id AND a.id=c.answer_message_id
      WHERE c.workspace_id=${workspace} AND c.message_id=${card} AND c.block_id=${block} AND c.task_id=${task} AND c.state='accepted'`)[0];
    if (!approved) continue;
    const body = Raw.parse(approved["blocks"]).find(b => b.kind === "answer")?.["body"];
    const norm = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
    if (typeof body === "string" && norm(result["body"]) !== norm(body)) continue;
    await sql`UPDATE assistant.card_states SET state='resolved',result_message_id=${message},updated_at=now()
      WHERE workspace_id=${workspace} AND message_id=${card} AND block_id=${block} AND task_id=${task} AND state='accepted'`;
  }
}

/**
 * When the task carrying an accepted card ends: a choice is resolved if the task succeeded; a draft that no sent result
 * resolved did not go out (e.g. "로그인이 필요해요"), so it is failed — never shown as 보냄 without evidence.
 * Failed and cancelled runs fail what is still open. `unknown` is not terminal (the run can be reconciled and resumed).
 */
export async function settleCardsForTask(sql: Query, workspace: string, task: string, state: string) {
  if (!["succeeded", "failed", "cancelled"].includes(state)) return;
  if ((await sql`SELECT 1 FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND task_id=${task}`)[0]) return; // the sender settles its own card
  const cards = await sql`SELECT c.message_id,c.block_id,m.blocks FROM assistant.card_states c JOIN assistant.messages m ON m.workspace_id=c.workspace_id AND m.id=c.message_id
    WHERE c.workspace_id=${workspace} AND c.task_id=${task} AND c.state='accepted' FOR UPDATE OF c`;
  if (!cards.length) return;
  const last = (await sql`SELECT id FROM assistant.messages WHERE workspace_id=${workspace} AND task_id=${task} AND role='assistant' AND NOT hidden ORDER BY sequence DESC LIMIT 1`)[0];
  for (const card of cards) {
    const draft = Raw.parse(card["blocks"]).some(b => b.kind === "draft" && b["id"] === card["block_id"]);
    const ok = state === "succeeded" && !draft;
    await sql`UPDATE assistant.card_states SET state=${ok ? "resolved" : "failed"},result_message_id=${last?.["id"] ?? null},updated_at=now()
      WHERE workspace_id=${workspace} AND message_id=${card["message_id"]} AND block_id=${card["block_id"]}`;
  }
}

/** A new card starts pending. Called when an assistant message with draft/choice blocks is stored. */
export async function registerCards(sql: Query, workspace: string, message: string, blocks: readonly { kind: string; id?: string }[]) {
  for (const b of blocks) if ((b.kind === "draft" || b.kind === "choice") && b.id)
    await sql`INSERT INTO assistant.card_states(workspace_id,message_id,block_id) VALUES(${workspace},${message},${b.id}) ON CONFLICT DO NOTHING`;
}
