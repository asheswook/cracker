const encoder = new TextEncoder();

export function plainPreview(content: string): string {
  return content
    .replace(/^\s*(```|~~~)[^\n]*$/gm, "")
    .replace(/!?\[([^\]]+)\]\([^\n)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

// Budget JSON-escaped UTF-8, not UTF-16 units. Room remains for routing and FCM/APNs keys.
export function boundedPreview(value: string, maxBytes = 2400): string {
  if (encoder.encode(JSON.stringify(value)).length <= maxBytes) return value;
  let result = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    value,
  )) {
    if (encoder.encode(JSON.stringify(`${result}${segment}…`)).length > maxBytes) break;
    result += segment;
  }
  return `${result}…`;
}

/** The lock screen says why to open the app; the conversation holds the details. */
export function notificationSummary(content: string, max = 140): string {
  const plain = plainPreview(content);
  if (plain.length <= max) return plain;
  // First sentence(s) up to the budget, ending on a sentence boundary when one is close.
  const sentences = plain.match(/[^.!?。…]+[.!?。…]+|[^.!?。…]+$/gu) ?? [plain];
  let out = "";
  for (const sentence of sentences) {
    if ((out + sentence).trim().length > max) break;
    out += sentence;
  }
  out = out.trim();
  if (out.length >= 20) return out;
  return `${[...plain].slice(0, max - 1).join("").trimEnd()}…`;
}

type Card = { readonly kind: string; readonly channel?: string | undefined; readonly target?: string | null | undefined; readonly question?: string | undefined };
export function notificationPresentation(source: {
  readonly persona_name: string;
  readonly notification_show_content: boolean;
  readonly content: string;
  readonly attachment_names: readonly string[];
  readonly blocks?: readonly Card[] | null;
}) {
  const card = source.blocks?.find(b => b.kind === "draft" || b.kind === "choice");
  if (!source.notification_show_content) return { title: source.persona_name, body: card ? "확인이 필요한 일이 있어요" : "새 메시지" };
  if (card) {
    const what = card.kind === "draft" ? `${card.channel ?? "메시지"}${card.target ? ` ${card.target}` : ""} 보낼까요?` : (card.question ?? plainPreview(source.content));
    return { title: `${source.persona_name} · 확인 필요`, body: boundedPreview(notificationSummary(what)) };
  }
  return {
    title: source.persona_name,
    body: boundedPreview(notificationSummary(source.content) || source.attachment_names.join(", ") || "새 메시지"),
  };
}
