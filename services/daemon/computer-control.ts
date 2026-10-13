import type { Tool } from '../../packages/provider';
import type { ToolResult } from './tools';

export const computerControlTool: Tool = {
  type: 'function', name: 'request_computer_control', strict: true,
  description: 'Request mouse, keyboard and shared-browser input control of the dedicated computer when desktop interaction is necessary. Research, inference, files and shell commands can continue while the user controls the desktop. Explain why input control is needed. Check the returned status before issuing desktop actions.',
  parameters: { type: 'object', properties: { reason: { type: 'string', minLength: 1, maxLength: 800 } }, required: ['reason'], additionalProperties: false },
};

const denied: ToolResult = { text: JSON.stringify({ status: 'computer_control_required', executed: false, instruction: 'The user controls mouse, keyboard and the shared browser. Continue non-desktop work, or call request_computer_control with a reason before desktop input.' }) };
const changing: ToolResult = { text: JSON.stringify({ status: 'computer_control_changing', executed: false, instruction: 'Desktop input is being released. Continue non-desktop work and inspect a fresh screen before the next desktop action.' }) };

export class ComputerControl {
  private owner: 'agent' | 'user' = 'agent';
  private transferring = false;
  private readonly active = new Map<AbortController, Promise<ToolResult>>();
  setOwner(owner: 'agent' | 'user'): void { this.owner = owner; }
  async revoke(): Promise<void> {
    this.owner = 'user'; this.transferring = true;
    for (const abort of this.active.keys()) abort.abort();
    await Promise.allSettled(this.active.values());
  }
  released(): void { this.transferring = false; }
  async run(requiresInput: boolean, parent: AbortSignal, operation: (signal: AbortSignal) => Promise<ToolResult>): Promise<ToolResult> {
    parent.throwIfAborted();
    if (this.transferring) return changing;
    if (requiresInput && this.owner !== 'agent') return denied;
    const abort = new AbortController();
    const signal = AbortSignal.any([parent, abort.signal]);
    const work = Promise.resolve().then(async () => {
      try { signal.throwIfAborted(); return await operation(signal); }
      catch (error) {
        if (!parent.aborted && abort.signal.aborted)
          return { text: JSON.stringify({ status: 'computer_action_interrupted', effects_may_have_occurred: true, instruction: 'The user took desktop input control during this operation. Do not replay it. Continue non-desktop work; inspect current screen and files before any further desktop action.' }) };
        throw error;
      }
    });
    this.active.set(abort, work);
    try { return await work; } finally { this.active.delete(abort); }
  }
}
