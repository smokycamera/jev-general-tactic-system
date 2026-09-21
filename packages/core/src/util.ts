export function clone<T>(value: T): T {
  return structuredClone(value);
}
export function clamp(n: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, n));
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}
export async function deadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: (reason?: unknown) => void = () => {};
  const abort = () => {
    controller.abort();
    rejectDeadline(new Error('cancelled'));
  };
  const limit = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new Error('timeout'));
      },
      Math.max(1, timeoutMs),
    );
  });
  parent?.addEventListener('abort', abort, { once: true });
  try {
    if (parent?.aborted) throw new Error('cancelled');
    return await Promise.race([operation(controller.signal), limit]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}
export function distance(
  map: { locations: { id: string; neighbors: string[]; blocked: boolean }[] },
  from: string,
  to: string,
): number {
  if (from === to) return 0;
  const locations = new Map(map.locations.map((l) => [l.id, l]));
  const queue: [[string, number]] = [[from, 0]];
  const seen = new Set([from]);
  for (let i = 0; i < queue.length; i++) {
    const [id, d] = queue[i]!;
    for (const next of locations.get(id)?.neighbors ?? []) {
      if (seen.has(next) || locations.get(next)?.blocked) continue;
      if (next === to) return d + 1;
      seen.add(next);
      queue.push([next, d + 1]);
    }
  }
  return Infinity;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** A lookup belongs to one immutable observation snapshot, never to a mutable host map. */
export function createDistanceLookup(map: {
  locations: { id: string; neighbors: string[]; blocked: boolean }[];
}) {
  const locations = new Map(
    map.locations.map((l) => [l.id, { neighbors: [...l.neighbors], blocked: l.blocked }]),
  );
  const cache = new Map<string, Map<string, number>>();
  return (from: string, to: string): number => {
    let distances = cache.get(from);
    if (!distances) {
      distances = new Map([[from, 0]]);
      const queue = [from];
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i]!;
        for (const next of locations.get(id)?.neighbors ?? []) {
          if (distances.has(next) || !locations.has(next) || locations.get(next)!.blocked) continue;
          distances.set(next, distances.get(id)! + 1);
          queue.push(next);
        }
      }
      cache.set(from, distances);
    }
    return distances.get(to) ?? Infinity;
  };
}
