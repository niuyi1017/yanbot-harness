export function createDeterministicIdGenerator(prefix = '00000000-0000-4000-8000-'): () => string {
  let counter = 0;
  return () => `${prefix}${String(++counter).padStart(12, '0')}`;
}

export function createDeterministicClock(start = '2026-01-01T00:00:00.000Z'): () => Date {
  let timestamp = new Date(start).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError('The deterministic clock requires a valid ISO timestamp.');
  return () => {
    const current = new Date(timestamp);
    timestamp += 1;
    return current;
  };
}

export async function collectAsync<T>(source: AsyncIterable<T>, limit = 1_000): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
    if (values.length > limit) throw new Error(`Async iterable exceeded the ${limit} item safety limit.`);
  }
  return values;
}
