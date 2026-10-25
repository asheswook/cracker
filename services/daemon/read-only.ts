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

export function applyPolicy(policy: 'read_only' | 'send_once', name: string, args: string): { refused: string } | { args: string } {
  if (policy === 'send_once') return { refused: JSON.stringify({ refused: true, tool: name, reason: 'A send job is executed by the daemon, not by the model.' }) };
  const refusal = readOnlyRefusal(name);
  return refusal ? { refused: refusal } : { args };
}
export function policyTools(policy: 'read_only' | 'send_once'): ReadonlySet<string> { return policy === 'read_only' ? READ_ONLY_TOOLS : new Set(); }
