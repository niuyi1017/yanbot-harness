import { describe, expect, it } from 'vitest';
import { CodeBuddyResponse, normalizeCodeBuddyText } from '../src/codebuddy.js';
const body = {
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  stream: true,
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
  ],
};
const msg = {
  id: 'msg-test',
  type: 'message',
  role: 'assistant',
  model: body.model,
  content: [],
  usage: { input_tokens: 5, output_tokens: 0 },
};
const events = [
  { type: 'message_start', message: msg },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好🌍' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];
const encode = (values: unknown[]) => Buffer.from(values.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
describe('CodeBuddy certified text protocol', () => {
  it('maps the actual SDK request and rejects unknown capabilities', () => {
    expect(
      normalizeCodeBuddyText({
        ...body,
        stream_options: { include_usage: true },
        tools: [],
        messages: body.messages.map((m) => ({ ...m, agent: 'cli', conversationRequestId: 'id' })),
      }),
    ).toEqual({
      model: body.model,
      max_tokens: 1024,
      stream: true,
      system: 'sys',
      messages: body.messages.slice(1),
    });
    for (const extra of [
      { url: 'http://evil' },
      { tools: [{}] },
      { max_tokens: 128000 },
      { temperature: 2 },
      { stream_options: { other: true } },
      { messages: [{ role: 'tool', content: 'x' }] },
      { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'x' }] }] },
      { messages: [...body.messages, body.messages[0]] },
      { messages: [body.messages[0]] },
    ])
      expect(() => normalizeCodeBuddyText({ ...body, ...extra })).toThrow();
  });
  it('preserves UTF8 at every byte boundary, usage and exactly one validated completion', () => {
    const bytes = encode(events);
    for (let split = 0; split <= bytes.length; split++) {
      const converter = new CodeBuddyResponse(true);
      const early = converter.push(bytes.subarray(0, split)) + converter.push(bytes.subarray(split));
      expect(early).not.toContain('[DONE]');
      const result = early + converter.finish();
      expect(result).toContain('你好🌍');
      expect(result).toContain('"total_tokens":7');
      expect(result.match(/\[DONE\]/g)).toHaveLength(1);
    }
  });
  it.each([
    events.slice(0, -1),
    events.slice(1),
    [...events, events[0]],
    [events[0], events[2]],
    [events[0], { type: 'error', error: 'sensitive' }],
    [events[0], { type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } }],
  ])('rejects incomplete, reordered and unsupported streams', (values) => {
    expect(() => {
      const c = new CodeBuddyResponse(true);
      c.push(encode(values));
      c.finish();
    }).toThrow();
  });
  it('converts JSON and length termination but refuses tool responses', () => {
    const c = new CodeBuddyResponse(false);
    expect(
      c.push(
        Buffer.from(JSON.stringify({ ...msg, content: [{ type: 'text', text: 'hello' }], stop_reason: 'max_tokens' })),
      ),
    ).toBe('');
    expect(JSON.parse(c.finish()).choices[0]).toMatchObject({ message: { content: 'hello' }, finish_reason: 'length' });
    const bad = new CodeBuddyResponse(false);
    bad.push(Buffer.from(JSON.stringify({ ...msg, stop_reason: 'tool_use' })));
    expect(() => bad.finish()).toThrow();
  });
});
