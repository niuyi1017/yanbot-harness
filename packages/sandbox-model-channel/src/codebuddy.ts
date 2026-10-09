import { z } from 'zod';
import { RESPONSE_LIMIT } from './protocol.js';

const textBlock = z.object({ type: z.literal('text'), text: z.string().max(65536) }).strict();
const content = z.union([z.string().max(65536), z.array(textBlock).min(1).max(32)]);
const request = z
  .object({
    model: z.string().min(1).max(128),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant']),
            content,
            agent: z.string().max(256).optional(),
            conversationRequestId: z.string().max(256).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    max_tokens: z.number().int().min(1).max(4096),
    temperature: z.number().min(0).max(1).optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean() }).strict().optional(),
    tools: z.array(z.never()).max(0).optional(),
  })
  .strict();

export function normalizeCodeBuddyText(value: unknown): Record<string, unknown> {
  const body = request.parse(value);
  const system: string[] = [];
  let conversation = false;
  const messages = body.messages.filter((m) => {
    if (m.role !== 'system') {
      conversation = true;
      return true;
    }
    if (conversation) throw new Error('System messages must precede the conversation.');
    system.push(typeof m.content === 'string' ? m.content : m.content.map((c) => c.text).join('\n'));
    return false;
  });
  if (!messages.length) throw new Error('Missing conversation.');
  return {
    model: body.model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    max_tokens: body.max_tokens,
    ...(system.length ? { system: system.join('\n') } : {}),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(body.stream === undefined ? {} : { stream: body.stream }),
  };
}

const usage = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() });
const reason = z.enum(['end_turn', 'max_tokens', 'stop_sequence']);
const message = z.object({
  type: z.literal('message'),
  id: z.string(),
  role: z.literal('assistant'),
  model: z.string(),
  content: z.array(textBlock),
  stop_reason: reason,
  usage,
});
const startEvent = z.object({
  message: z.object({
    id: z.string(),
    model: z.string(),
    type: z.literal('message'),
    role: z.literal('assistant'),
    content: z.array(z.never()).max(0),
    usage,
  }),
});
const textDelta = z.object({
  index: z.number().int(),
  delta: z.object({ type: z.literal('text_delta'), text: z.string() }).strict(),
});
const messageDelta = z.object({
  delta: z.object({ stop_reason: reason }),
  usage: z.object({ output_tokens: z.number().int().nonnegative() }),
});
const eventEnvelope = z.object({ type: z.string() }).passthrough();
const blockStart = z.object({ index: z.number().int(), content_block: textBlock });
const finishReason = (value: z.infer<typeof reason>) => (value === 'max_tokens' ? 'length' : 'stop');

/** Converts only the certified text subset. Completion is emitted after a validated upstream EOF. */
export class CodeBuddyResponse {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #buffer = '';
  #id = '';
  #model = '';
  #started = false;
  #stopped = false;
  #finish: z.infer<typeof reason> | undefined;
  #block: number | undefined;
  #nextBlock = 0;
  #input = 0;
  #output = 0;
  #bytes = 0;
  constructor(private readonly stream: boolean) {}
  push(bytes: Uint8Array): string {
    this.#bytes += bytes.byteLength;
    if (this.#bytes > RESPONSE_LIMIT) throw new Error('Response limit.');
    this.#buffer += this.#decoder.decode(bytes, { stream: true });
    return this.stream ? this.#drain() : '';
  }
  finish(): string {
    this.#buffer += this.#decoder.decode();
    if (!this.stream) {
      const body = message.parse(JSON.parse(this.#buffer));
      return JSON.stringify({
        id: body.id,
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: body.content.map((c) => c.text).join('') },
            finish_reason: finishReason(body.stop_reason),
          },
        ],
        usage: {
          prompt_tokens: body.usage.input_tokens,
          completion_tokens: body.usage.output_tokens,
          total_tokens: body.usage.input_tokens + body.usage.output_tokens,
        },
      });
    }
    const output = this.#drain();
    if (this.#buffer.trim() || !this.#stopped || !this.#finish || this.#block !== undefined)
      throw new Error('Incomplete model stream.');
    return (
      output +
      this.#chunk({}, finishReason(this.#finish)) +
      `data: ${JSON.stringify({
        id: this.#id,
        object: 'chat.completion.chunk',
        created: 0,
        model: this.#model,
        choices: [],
        usage: {
          prompt_tokens: this.#input,
          completion_tokens: this.#output,
          total_tokens: this.#input + this.#output,
        },
      })}\n\ndata: [DONE]\n\n`
    );
  }
  #chunk(delta: Record<string, string>, finish_reason: string | null = null): string {
    return `data: ${JSON.stringify({ id: this.#id, object: 'chat.completion.chunk', created: 0, model: this.#model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  }
  #drain(): string {
    let output = '';
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(this.#buffer);
      if (!match) break;
      const raw = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      const lines = raw.split(/\r?\n/u);
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      const event = eventEnvelope.parse(JSON.parse(data));
      const names = lines.filter((l) => l.startsWith('event:')).map((l) => l.slice(6).trim());
      if (names.length > 1 || (names.length && names[0] !== event.type) || this.#stopped)
        throw new Error('Invalid model stream.');
      if (event.type === 'ping') continue;
      if (event.type === 'message_start') {
        if (this.#started) throw new Error();
        const start = startEvent.parse(event);
        this.#started = true;
        this.#id = start.message.id;
        this.#model = start.message.model;
        this.#input = start.message.usage.input_tokens;
        output += this.#chunk({ role: 'assistant', content: '' });
        continue;
      }
      if (!this.#started) throw new Error();
      if (event.type === 'content_block_start') {
        const block = blockStart.parse(event);
        if (this.#block !== undefined || this.#finish || block.index !== this.#nextBlock++) throw new Error();
        this.#block = block.index;
        output += this.#chunk({ content: block.content_block.text });
      } else if (event.type === 'content_block_delta') {
        const delta = textDelta.parse(event);
        if (delta.index !== this.#block) throw new Error();
        output += this.#chunk({ content: delta.delta.text });
      } else if (event.type === 'content_block_stop') {
        if (this.#block === undefined || event.index !== this.#block) throw new Error();
        this.#block = undefined;
      } else if (event.type === 'message_delta') {
        const delta = messageDelta.parse(event);
        if (this.#block !== undefined || this.#finish) throw new Error();
        this.#finish = delta.delta.stop_reason;
        this.#output = delta.usage.output_tokens;
      } else if (event.type === 'message_stop') {
        if (!this.#finish || this.#block !== undefined) throw new Error();
        this.#stopped = true;
      } else throw new Error('Unsupported model stream event.');
    }
    return output;
  }
}
