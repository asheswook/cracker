/** Only operational metadata: never include SQL, parameters, rows, or error detail. */
export type BriefDiagnostics = { step: string; ms_by_step: Record<string, number>; run: string | null; task: string | null };

export function briefFailureFields(error: unknown, diagnostics: BriefDiagnostics) {
  const e = error instanceof Error ? error : null;
  return {
    ...diagnostics,
    name: e?.name ?? 'Error',
    code: e && 'code' in e && typeof e.code === 'string' ? e.code : null,
    routine: e && 'routine' in e && typeof e.routine === 'string' ? e.routine : null,
    message: (e?.message ?? String(error)).slice(0, 300),
  };
}
