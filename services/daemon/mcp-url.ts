function decoded(value: string): string {
  try { return decodeURIComponent(value); }
  catch (error) { if (error instanceof URIError) return value; throw error; }
}
export function mcpHttpTarget(input: URL, supplied: Readonly<Record<string, string>>) {
  const url = new URL(input.href);
  const headers = new Headers(supplied);
  if ((url.username || url.password) && !headers.has("Authorization")) {
    const credentials = `${decoded(url.username)}:${decoded(url.password)}`;
    headers.set("Authorization", `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`);
  }
  url.username = "";
  url.password = "";
  return { url, headers };
}
export function mcpUrlRedactions(value: string): string[] {
  const url = new URL(value);
  const values = [value];
  const password = decoded(url.password);
  if (password.length >= 8) values.push(url.password, password);
  for (const part of url.search.slice(1).split("&")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const parameter = [...new URLSearchParams(part).entries()][0];
    if (parameter && parameter[1].length >= 8 && /^(?:token|access[_-]?token|api[_-]?key|key|secret|password|auth|authorization|signature|sig|client[_-]?secret)$/i.test(parameter[0]))
      values.push(parameter[1], part.slice(equals + 1));
  }
  const authorization = mcpHttpTarget(url, {}).headers.get("Authorization");
  if (authorization) {
    values.push(authorization);
    if (authorization.slice(6).length >= 8) values.push(authorization.slice(6));
  }
  return values.filter(Boolean).sort((a, b) => b.length - a.length);
}
