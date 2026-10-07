import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, read } from '../api';
import type { Id } from '../types';
import { Extensions } from './types';
export function useExtensions(vm: Id | undefined, includeArchived = false) {
  const [snapshot, setSnapshot] = useState<{ vm: Id; archived: boolean; data: Extensions } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const fetching = useRef<Id | null>(null);
  const refresh = useCallback(
    async (force = false) => {
      if (!vm || (!force && fetching.current === vm)) return;
      fetching.current = vm;
      const version = ++request.current;
      setLoading(true);
      try {
        const data = await read(`/v1/extensions?vm_id=${vm}${includeArchived ? '&include_archived=true' : ''}`, Extensions);
        if (request.current === version) {
          setSnapshot({ vm, archived: includeArchived, data });
          setError('');
        }
      } catch (failure) {
        if (request.current === version) setError(errorMessage(failure));
      } finally {
        if (request.current === version) {
          setLoading(false);
          fetching.current = null;
        }
      }
    },
    [vm, includeArchived],
  );
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      clearInterval(timer);
      request.current++;
      fetching.current = null;
    };
  }, [refresh]);
  return { data: snapshot && snapshot.vm === vm && snapshot.archived === includeArchived ? snapshot.data : null, loading, error, refresh };
}
