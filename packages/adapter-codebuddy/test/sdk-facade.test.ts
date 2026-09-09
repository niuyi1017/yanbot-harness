import { describe, expect, it, vi } from 'vitest';

import { createClosableQueryStream } from '../src/sdk-facade.js';

describe('CodeBuddy SDK facade', () => {
  it('closes the exact vendor iterator so its transport cleanup runs', async () => {
    let finalized = false;
    async function* messages(): AsyncGenerator<unknown, void> {
      try {
        yield { type: 'result', is_error: false };
        await new Promise<void>(() => undefined);
      } finally {
        finalized = true;
      }
    }

    const iterator = messages();
    const interrupt = vi.fn(async () => undefined);
    const stream = createClosableQueryStream({
      [Symbol.asyncIterator]: () => iterator,
      interrupt,
    });

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: false });
    await expect(stream.return?.()).resolves.toEqual({ done: true, value: undefined });
    expect(finalized).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();
  });
});
