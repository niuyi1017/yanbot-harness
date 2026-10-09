import { describe, expect, it } from 'vitest';
import { ClaudeInteractions } from '../src/interactions.js';
const request = (name = 'Write', input: object = { file_path: '/work/test', content: 'test' }) => ({
  type: 'control_request',
  request_id: 'permission-1',
  request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: 'tool-1' },
});
describe('pinned CLI control protocol', () => {
  it.each(['allow', 'deny'] as const)('resolves a permission exactly once: %s', async (action) => {
    const events: unknown[] = [];
    const bridge = new ClaudeInteractions(
      'interactive',
      async (type, payload) => {
        events.push({ type, payload });
      },
      new AbortController().signal,
    );
    const result = bridge.request(request());
    await bridge.respond({ requestId: 'permission-1', action });
    expect(await result).toMatchObject({
      type: 'control_response',
      response: { request_id: 'permission-1', response: { behavior: action } },
    });
    await expect(bridge.respond({ requestId: 'permission-1', action })).rejects.toThrow('Unknown');
    expect(events).toHaveLength(2);
  });
  it('cancels an unanswered request and rejects unknown tool types', async () => {
    const controller = new AbortController();
    const bridge = new ClaudeInteractions('interactive', async () => undefined, controller.signal);
    const result = bridge.request(request());
    controller.abort();
    expect(await result).toMatchObject({ response: { response: { behavior: 'deny' } } });
    await expect(bridge.request(request('UnknownTool'))).rejects.toThrow();
  });
  it('keeps a question pending after missing answers and maps a valid answer to the vendor prompt', async () => {
    const bridge = new ClaudeInteractions('interactive', async () => undefined, new AbortController().signal);
    const result = bridge.request(request('AskUserQuestion', { questions: [{ question: 'Color?' }] }));
    await expect(bridge.respond({ requestId: 'permission-1', action: 'submit', answers: {} })).rejects.toThrow(
      'Missing',
    );
    await bridge.respond({ requestId: 'permission-1', action: 'submit', answers: { 'permission-1:1': 'Blue' } });
    expect(await result).toMatchObject({ response: { response: { updatedInput: { answers: { 'Color?': 'Blue' } } } } });
  });
});
