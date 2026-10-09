import { z } from 'zod';
import { type AdapterEvent, type Usage, usageSchema } from '@yanbot-harness/contracts';
import { tools } from './interactions.js';
import { capabilities, CLAUDE_CODE_VERSION } from './manifest.js';

type Emit = (type: AdapterEvent['type'], payload: unknown) => Promise<void>;
const record = z.record(z.string(), z.unknown());
const text = z.string().max(4 * 1024 * 1024);

/** Vendor metadata and diagnostic strings are never forwarded. */
export class ClaudeEventParser {
  initialized = false;
  finished = false;
  authenticationFailed = false;
  vendorFailed = false;
  usage: Usage | undefined;
  #sessionId: string | undefined;
  #streamedText = '';
  readonly #toolIds = new Set<string>();
  constructor(
    private readonly emit: Emit,
    private readonly toolMode = false,
  ) {}

  async line(line: string): Promise<void> {
    const frame = record.parse(JSON.parse(line));
    if (this.finished) throw new Error('Output after result');
    if (frame.type === 'system') {
      if (frame.subtype === 'init') {
        if (this.initialized) throw new Error('Duplicate init');
        if (frame.claude_code_version !== CLAUDE_CODE_VERSION) throw new Error('Unexpected version');
        this.#sessionId = z.string().min(1).max(1024).parse(frame.session_id);
        if (
          !Array.isArray(frame.tools) ||
          frame.tools.some(
            (tool) => typeof tool !== 'string' || !this.toolMode || !(tools as readonly string[]).includes(tool),
          )
        )
          throw new Error('Unexpected tools');
        this.initialized = true;
        await this.emit('session.initialized', { adapterSessionId: this.#sessionId, capabilities });
      } else if (!['commands_changed', 'status'].includes(String(frame.subtype))) {
        throw new Error('Unsupported system frame');
      }
      return;
    }
    if (!this.initialized || frame.session_id !== this.#sessionId) throw new Error('Invalid session');
    if (frame.type === 'stream_event') {
      const event = record.parse(frame.event);
      if (event.type === 'content_block_delta') {
        const delta = record.parse(event.delta);
        if (delta.type === 'input_json_delta' && this.toolMode) {
          text.parse(delta.partial_json);
          return;
        }
        if (delta.type !== 'text_delta') throw new Error('Unsupported delta');
        const value = text.parse(delta.text);
        if (this.#streamedText.length + value.length > 4 * 1024 * 1024) throw new Error('Text limit');
        this.#streamedText += value;
        if (value) await this.emit('assistant.delta', { channel: 'output', text: value });
      } else if (event.type === 'content_block_start') {
        const type = record.parse(event.content_block).type;
        if (type !== 'text' && !(this.toolMode && type === 'tool_use')) throw new Error('Unsupported content block');
      } else if (
        !['message_start', 'message_delta', 'message_stop', 'content_block_stop', 'ping'].includes(String(event.type))
      ) {
        throw new Error('Unsupported stream event');
      }
      return;
    }
    if (frame.type === 'assistant') {
      if (frame.error !== undefined || frame.is_api_error_message === true) {
        this.authenticationFailed ||= frame.error === 'authentication_failed';
        this.vendorFailed = true;
        return;
      }
      const blocks = z
        .array(
          z.union([
            z.object({ type: z.literal('text'), text }),
            z.object({
              type: z.literal('tool_use'),
              id: z.string().min(1).max(256),
              name: z.enum(tools),
              input: record,
            }),
          ]),
        )
        .parse(record.parse(frame.message).content);
      for (const block of blocks)
        if (block.type === 'tool_use') {
          if (!this.toolMode || this.#toolIds.has(block.id)) throw new Error('Invalid tool call.');
          this.#toolIds.add(block.id);
          await this.emit('tool.started', { toolUseId: block.id, name: block.name, inputSummary: block.input });
        }
      const value = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (value.length > 4 * 1024 * 1024) throw new Error('Text limit');
      if (this.#streamedText && value !== this.#streamedText) throw new Error('Text stream mismatch');
      if (!this.#streamedText && value) await this.emit('assistant.delta', { channel: 'output', text: value });
      this.#streamedText = '';
      return;
    }
    if (frame.type === 'user' && this.toolMode) {
      const blocks = z
        .array(
          z.object({
            type: z.literal('tool_result'),
            tool_use_id: z.string().min(1).max(256),
            content: z.union([text, z.array(z.object({ type: z.literal('text'), text }))]),
            is_error: z.boolean().optional(),
          }),
        )
        .parse(record.parse(frame.message).content);
      for (const block of blocks) {
        if (!this.#toolIds.delete(block.tool_use_id)) throw new Error('Unmatched tool result.');
        if (block.is_error)
          await this.emit('tool.failed', {
            toolUseId: block.tool_use_id,
            error: { code: 'HARNESS_FAILED', message: 'The vendor tool failed or was denied.', retryable: false },
          });
        else await this.emit('tool.completed', { toolUseId: block.tool_use_id, outputSummary: block.content });
      }
      return;
    }
    if (frame.type !== 'result') throw new Error('Unsupported vendor frame');
    if (this.#toolIds.size) throw new Error('Unfinished tools.');
    this.finished = true;
    this.vendorFailed ||= z.boolean().parse(frame.is_error) || frame.subtype !== 'success';
    if (
      frame.terminal_reason !== undefined &&
      frame.terminal_reason !== 'success' &&
      frame.terminal_reason !== 'end_turn' &&
      frame.terminal_reason !== 'completed'
    ) {
      this.vendorFailed = true;
    }
    const usage = record.parse(frame.usage);
    this.usage = usageSchema.parse({
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedInputTokens: usage.cache_read_input_tokens,
      costUsd: frame.total_cost_usd,
      durationMs: frame.duration_ms,
      turns: frame.num_turns,
    });
  }
}
