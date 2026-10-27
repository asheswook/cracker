/**
 * Read-only runs (assistant-owned looks and reply-draft jobs): the control plane marks the assignment with
 * run_policy='read_only' and the daemon enforces it in code. Such a run gets no general browser, shell, desktop or MCP
 * tool at all: only the fixed source readers (source-adapters.ts), whose arguments are ids, never scripts, URLs or
 * selectors. A mail or message saying "send this now" has nothing to act with.
 *
 * Send jobs do not run the model: the daemon executes the approved send itself (see runtime: run_policy send_once).
 */
export const READ_ONLY_TOOLS = new Set([
  'source_gmail_list', 'source_gmail_thread', 'source_slack_read',
  'load_skill', 'read_attention', 'report_observation', 'ask_user', 'search_prior_work', 'retrieve_prior_work', 'read_prior_source',
]);

export function readOnlyRefusal(name: string): string | null {
  if (READ_ONLY_TOOLS.has(name)) return null;
  return JSON.stringify({ refused: true, tool: name, reason: 'This is a read-only run (an assistant-owned look or reply draft). Read only with source_gmail_list / source_gmail_thread / source_slack_read and report; a reply is prepared as an ask_user draft card for the user to approve.' });
}

/** The morning brief: it reads what it reports from and may ask with a card; it has nothing to send, post or browse with. */
export const BRIEF_TOOLS = new Set(['read_attention', 'read_artifact', 'ask_user', 'load_skill', 'search_prior_work', 'retrieve_prior_work', 'read_prior_source', 'list_future_work', 'plan_meeting_prep']);
export type RunPolicy = 'read_only' | 'send_once' | 'brief';
/**
 * Today's schedule for the brief: an MCP tool whose real method (as the server registered it, not the display name)
 * is exactly one of these calendar reads. The caller passes that method; anything else, or no method, is refused.
 */
const CALENDAR_READS = new Set(['list_calendars', 'get_events', 'list_events', 'get_event', 'search_events']);
/** The daemon's namespace for an extension server id (the same as extensions.ts). */
export const serverNamespace = (id: string) => `cfg_${Bun.hash(id).toString(16)}`;
export type McpOrigin = { server: string | null; method: string | null } | null | undefined;
/** A calendar read: an exact read method, on one of the brief's trusted calendar servers. */
export function briefCalendarRead(origin: McpOrigin, servers: readonly string[] = []) {
  return !!origin?.method && CALENDAR_READS.has(origin.method) && !!origin.server && servers.some(id => serverNamespace(id) === origin.server);
}

export function applyPolicy(policy: RunPolicy, name: string, args: string, scope?: { kind: 'gmail' | 'slack'; account: string }, origin?: McpOrigin, calendarServers?: readonly string[]): { refused: string } | { args: string } {
  if (policy === 'send_once') return { refused: JSON.stringify({ refused: true, tool: name, reason: 'A send job is executed by the daemon, not by the model.' }) };
  if (policy === 'brief') return BRIEF_TOOLS.has(name) || (name.startsWith('mcp_') && briefCalendarRead(origin, calendarServers)) ? { args } : { refused: JSON.stringify({ refused: true, tool: name, reason: 'The morning brief reports from what it was given (read_attention) and asks with ask_user; it does not browse, send or post.' }) };
  const refusal = readOnlyRefusal(name);
  if (refusal) return { refused: refusal };
  // Readers read only the job's own account (Gmail) or workspace (Slack): another one is refused before anything runs,
  // and with no scope at all nothing is read.
  if (name.startsWith('source_gmail_') || name === 'source_slack_read') {
    if (!scope) return { refused: JSON.stringify({ refused: true, tool: name, reason: 'This job has no account to read.' }) };
    const parsed = (() => { try { return JSON.parse(args) as Record<string, unknown>; } catch { return null; } })();
    const want = scope.account.toLowerCase();
    const wrongKind = name === 'source_slack_read' ? scope.kind !== 'slack' : scope.kind !== 'gmail';
    const given = String((name === 'source_slack_read' ? parsed?.['workspace'] : parsed?.['account']) ?? '').toLowerCase();
    if (!parsed || wrongKind || given !== want)
      return { refused: JSON.stringify({ refused: true, tool: name, reason: `This job reads only ${scope.kind === 'slack' ? 'workspace' : 'account'} ${scope.account}.` }) };
  }
  return { args };
}
export function policyTools(policy: RunPolicy): ReadonlySet<string> { return policy === 'read_only' ? READ_ONLY_TOOLS : policy === 'brief' ? BRIEF_TOOLS : new Set(); }
/** Whether a tool is offered to a run under this policy (the same rule as applyPolicy, for the tool list). */
export function offered(policy: RunPolicy, name: string, origin?: McpOrigin, calendarServers?: readonly string[]) { return policyTools(policy).has(name) || (policy === 'brief' && name.startsWith('mcp_') && briefCalendarRead(origin, calendarServers)); }
