import { describe, expect, it } from 'vitest';
import { ClaudeEventParser } from '../src/parser.js';

const session_id = 'vendor-session';
const init = { type: 'system', subtype: 'init', session_id, tools: [], claude_code_version: '2.1.284' };
const result = {
  type: 'result',
  session_id,
  subtype: 'success',
  is_error: false,
  usage: { input_tokens: 5, output_tokens: 2 },
  total_cost_usd: 0.001,
  num_turns: 1,
};
function setup() {
  const events: unknown[] = [];
  const parser = new ClaudeEventParser(async (type, payload) => {
    events.push({ type, payload });
  });
  return { parser, events, line: (frame: unknown) => parser.line(JSON.stringify(frame)) };
}

describe('Claude Code stream normalization', () => {
  it('maps incremental text once and retains usage until process cleanup', async () => {
    const { line, parser, events } = setup();
    await line(init);
    await line({
      type: 'stream_event',
      session_id,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } },
    });
    await line({ type: 'assistant', session_id, message: { content: [{ type: 'text', text: 'OK' }] } });
    await line(result);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: 'assistant.delta', payload: { channel: 'output', text: 'OK' } });
    expect(parser.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, costUsd: 0.001 });
    expect(parser.finished).toBe(true);
    expect(parser.vendorFailed).toBe(false);
  });
  it('handles observed success-subtype authentication failures without diagnostic leakage', async () => {
    const { line, parser, events } = setup();
    await line(init);
    await line({
      type: 'assistant',
      session_id,
      error: 'authentication_failed',
      is_api_error_message: true,
      message: { content: [{ type: 'text', text: 'secret-marker' }] },
    });
    await line({ ...result, is_error: true, terminal_reason: 'api_error' });
    expect(parser.authenticationFailed).toBe(true);
    expect(parser.vendorFailed).toBe(true);
    expect(JSON.stringify(events)).not.toContain('secret-marker');
  });
  it.each([
    { ...init, tools: ['Read'] },
    { type: 'stream_event', session_id: 'wrong', event: {} },
    { type: 'assistant', session_id, message: { content: [{ type: 'tool_use' }] } },
    { ...result, usage: { input_tokens: -1 } },
    { type: 'unknown', session_id },
  ])('rejects invalid or unsupported vendor output %#', async (frame) => {
    const { line } = setup();
    if (frame !== init) await line(init);
    await expect(line(frame)).rejects.toThrow();
  });
  it.each([
    ['completed', false, false],
    ['completed', true, true],
    ['api_error', false, true],
    ['max_turns', false, true],
    ['budget_exceeded', false, true],
  ])('checks observed terminal reason %s with is_error=%s', async (terminal_reason, is_error, expected) => {
    const { line, parser } = setup();
    await line(init);
    await line({ ...result, terminal_reason, is_error });
    expect(parser.vendorFailed).toBe(expected);
  });
  it('rejects duplicate results', async () => {
    const { line } = setup();
    await line(init);
    await line(result);
    await expect(line(result)).rejects.toThrow();
  });
});
