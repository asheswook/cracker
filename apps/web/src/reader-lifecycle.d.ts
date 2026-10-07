export {};
declare global {
  interface Window { __assistantReaderLifecycle?: (kind: number, details: readonly number[]) => void }
}
