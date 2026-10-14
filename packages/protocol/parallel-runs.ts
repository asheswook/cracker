import { z } from 'zod';

// Set to zero to restore serial admission without changing the wire protocol.
export const BACKGROUND_SLOTS: number = 1;
export const SessionRegistration = z.object({
  session_id: z.uuid(),
  runs: z.array(z.object({
    run_id: z.uuid(),
    phase: z.enum(['accepted','executing','suspended','terminal-pending']),
    recoverable: z.boolean(),
  }).strict()).max(100),
}).strict();
export const SessionReconciliation = z.object({
  reconciled: z.literal(true), epoch: z.coerce.number().int().positive(),
  adopted: z.array(z.uuid()), quarantined: z.array(z.uuid()),
});
