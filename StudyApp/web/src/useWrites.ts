import { useCallback, useEffect, useRef, useState } from "react";

export interface PendingWrites {
  persist: (key: string, run: () => Promise<unknown>) => void;
  retry: () => void;
  failedCount: number;
}
// Serialize writes to the same field. Retain only the newest failed intent for explicit retry.
export function useWrites(): PendingWrites {
  const pending = useRef(new Map<string, { run: () => Promise<unknown>; failed: boolean }>());
  const chains = useRef(new Map<string, Promise<void>>());
  const alive = useRef(true);
  const [failedCount, setFailedCount] = useState(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const report = useCallback(() => {
    if (alive.current) setFailedCount([...pending.current.values()].filter((value) => value.failed).length);
  }, []);
  const persist = useCallback((key: string, run: () => Promise<unknown>) => {
    const intent = { run, failed: false };
    pending.current.set(key, intent);
    report();
    const chain = (chains.current.get(key) ?? Promise.resolve()).then(async () => {
      try {
        await run();
        if (pending.current.get(key) === intent) pending.current.delete(key);
      } catch {
        if (pending.current.get(key) === intent) intent.failed = true;
      }
      report();
    });
    chains.current.set(key, chain);
    void chain.finally(() => { if (chains.current.get(key) === chain) chains.current.delete(key); });
  }, [report]);
  const retry = useCallback(() => {
    for (const [key, intent] of pending.current) if (intent.failed) persist(key, intent.run);
  }, [persist]);
  return { persist, retry, failedCount };
}
