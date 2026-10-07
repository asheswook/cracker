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

export function notificationPresentation(source: {
  readonly persona_name: string;
  readonly notification_show_content: boolean;
  readonly content: string;
  readonly attachment_names: readonly string[];
}) {
  return {
    title: source.persona_name,
    body: source.notification_show_content
      ? boundedPreview(
          plainPreview(source.content) || source.attachment_names.join(", ") || "새 메시지",
        )
      : "새 메시지",
  };
}
