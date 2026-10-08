import type { Store } from "./logic.ts";

type Wake = () => void;

const waiters = new Map<string, Set<Wake>>();

export function poke(key: string) {
  const set = waiters.get(key);
  if (!set) return;
  for (const wake of [...set]) wake();
}

export function waitInbox(
  store: Store,
  agentId: string,
  after: number,
  timeoutMs: number,
): Promise<ReturnType<Store["inboxAfter"]>> {
  store.touchSeen(agentId);
  const ready = store.inboxAfter(agentId, after);
  if (ready.length > 0) return Promise.resolve(ready);

  const key = `agent:${agentId}`;
  const timeout = Math.min(Math.max(timeoutMs, 1000), 25_000);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (rows: ReturnType<Store["inboxAfter"]>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      set?.delete(onPoke);
      if (set && set.size === 0) waiters.delete(key);
      resolve(rows);
    };
    const onPoke = () => {
      const rows = store.inboxAfter(agentId, after);
      if (rows.length > 0) finish(rows);
    };
    let set = waiters.get(key);
    if (!set) {
      set = new Set();
      waiters.set(key, set);
    }
    set.add(onPoke);
    const timer = setTimeout(() => finish([]), timeout);
  });
}
