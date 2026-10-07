import { lock } from "proper-lockfile";
export async function withCredentialLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const release = await lock(path, { realpath: false, stale: 120000, update: 10000, retries: { retries: 40, minTimeout: 50, maxTimeout: 1000 } });
  try { return await operation(); } finally { await release(); }
}
