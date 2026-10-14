import type { VmLock } from './daemon-session';

// Shared by the request guard and direct event transactions. Heartbeats write a
// non-key VM column, so acquire NO KEY UPDATE before any run lock. Never upgrade
// KEY SHARE after taking the run: composing takes VM → run in that order.
export function eventVmLock(kind:unknown):VmLock{
  return kind==='command_ack'?'update':kind==='heartbeat'?'no-key-update':'key-share';
}
