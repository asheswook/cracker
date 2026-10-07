import { z } from 'zod';
import { Id, Resources } from './types';
import type { Vm } from './types';
import { http } from './api';
export type ControlKind = 'takeover' | 'return_control';
export const Command = z.object({
  id: Id, task_id: Id.nullable(), kind: z.enum(['takeover', 'return_control', 'stop']),
  created_at: z.string(), vm_id: Id, status: z.enum(['pending', 'applied', 'failed']),
  detail: z.string().nullable(), acked_at: z.string().nullable(),
});
export type ControlReceipt = {
  kind: ControlKind; commandId: Id;
  phase: 'pending' | 'unknown' | 'failed'; error: string;
};
export class ControlFailure extends Error {}
export const controlTransport = {
  async submit(vm: Id, kind: ControlKind, commandId: Id, signal: AbortSignal) {
    const id = z.object({ command: z.object({ id: Id }) }).parse(
      await http.post(`/v1/vms/${vm}/control`, { json: { kind, client_command_id: commandId }, signal, retry: 0 }).json<unknown>(),
    ).command.id;
    if (id !== commandId) throw new Error('Mismatched submitted command');
    return id;
  },
  async receipt(id: Id, signal: AbortSignal) {
    return z.object({ command: Command }).parse(await http.get(`/v1/commands/${id}`, {
      signal, retry: 0, timeout: 5000, cache: 'no-store',
    }).json<unknown>()).command;
  },
  async vms(signal: AbortSignal) {
    return Resources.vms.parse(await http.get('/v1/vms', {
      signal, retry: 0, timeout: 5000, cache: 'no-store',
    }).json<unknown>()).vms;
  },
};
function pause(signal: AbortSignal, ms: number) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function confirmControl(
  vm: Id, kind: ControlKind, commandId: Id, signal: AbortSignal,
  transport = controlTransport, interval = 350,
): Promise<Vm[]> {
  const expected = kind === 'takeover' ? 'user' : 'agent';
  let applied = false;
  while (true) {
    signal.throwIfAborted();
    if (!applied) {
      const receipt = await transport.receipt(commandId, signal);
      signal.throwIfAborted();
      if (receipt.id !== commandId || receipt.vm_id !== vm || receipt.kind !== kind)
        throw new Error('Mismatched control receipt');
      if (receipt.status === 'failed') throw new ControlFailure('컴퓨터가 제어권 요청을 적용하지 못했어요.');
      applied = receipt.status === 'applied' && receipt.acked_at !== null;
    }
    if (applied) {
      const vms = await transport.vms(signal);
      signal.throwIfAborted();
      if (vms.find((item) => item.id === vm)?.control_state === expected) return vms;
    }
    await pause(signal, interval);
  }
}
