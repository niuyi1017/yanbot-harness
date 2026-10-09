import { z } from 'zod';
import { anthropicRequest, bridgeToolNames, wireObject, wireToolUse } from './wire.js';
import { RESPONSE_LIMIT } from './protocol.js';

const textBlock = z.object({ type: z.literal('text'), text: z.string().max(65536) }).strict();
const content = z.union([z.string().max(65536), z.array(textBlock).max(128)]);
const call = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal('function'),
    function: z.object({ name: z.enum(bridgeToolNames), arguments: z.string().max(65536) }).strict(),
  })
  .strict();
const request = z
  .object({
    model: z.string().min(1).max(128),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant', 'tool']),
            content: content.nullable().optional(),
            tool_calls: z.array(call).max(32).optional(),
            tool_call_id: z.string().min(1).max(256).optional(),
            name: z.string().max(128).optional(),
            rawUsage: wireObject.optional(),
            usage: wireObject.optional(),
            argumentsDisplayText: z.string().max(65536).optional(),
            skipRun: z.boolean().optional(),
            error: z.string().max(65536).optional(),
            messageId: z.string().max(256).optional(),
            model: z.string().max(256).optional(),
            requestModelId: z.string().max(256).optional(),
            requestModelName: z.string().max(256).optional(),
            traceId: z.string().max(256).optional(),
            queuePosition: z.number().int().min(0).max(1024).optional(),
            queueTotal: z.number().int().min(0).max(1024).optional(),
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
    tools: z
      .array(
        z
          .object({
            type: z.literal('function'),
            function: z
              .object({
                name: z.enum(bridgeToolNames),
                description: z.string().max(65536).optional(),
                parameters: wireObject,
                strict: z.boolean().optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
  })
  .strict();

export function normalizeCodeBuddyText(value: unknown): Record<string, unknown> {
  const body = request.parse(value);
  const system: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const m of body.messages) {
    if (m.role === 'system') {
      if (messages.length || m.tool_calls || m.tool_call_id || m.content == null)
        throw new Error('Invalid system message.');
      system.push(typeof m.content === 'string' ? m.content : m.content.map((c) => c.text).join('\n'));
    } else if (m.role === 'tool') {
      if (!m.tool_call_id || m.tool_calls || m.content == null) throw new Error('Invalid tool result.');
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content,
            ...(m.error || m.skipRun ? { is_error: true } : {}),
          },
        ],
      });
    } else {
      if (m.tool_call_id || (m.tool_calls && m.role !== 'assistant')) throw new Error('Invalid tool call role.');
      if (m.content == null && !m.tool_calls?.length) throw new Error('Missing content.');
      const blocks: unknown[] =
        m.content == null ? [] : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      messages.push({
        role: m.role,
        content: m.tool_calls?.length
          ? [
              ...blocks,
              ...m.tool_calls.map((tool) => ({
                type: 'tool_use',
                id: tool.id,
                name: tool.function.name,
                input: wireObject.parse(JSON.parse(tool.function.arguments)),
              })),
            ]
          : m.content,
      });
    }
  }
  if (!messages.length) throw new Error('Missing conversation.');
  return anthropicRequest.parse({
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    ...(body.tools?.length
      ? {
          tools: body.tools.map((tool) => ({
            name: tool.function.name,
            ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
            input_schema: tool.function.parameters,
          })),
        }
      : {}),
    ...(system.length ? { system: system.join('\n') } : {}),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(body.stream === undefined ? {} : { stream: body.stream }),
  });
}

const usage = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() });
const reason = z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']);
const message = z.object({
  type: z.literal('message'),
  id: z.string(),
  role: z.literal('assistant'),
  model: z.string(),
  content: z.array(z.union([textBlock, wireToolUse])),
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
  delta: z.union([
    z.object({ type: z.literal('text_delta'), text: z.string() }).strict(),
    z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }).strict(),
  ]),
});
const messageDelta = z.object({
  delta: z.object({ stop_reason: reason }),
  usage: z.object({ output_tokens: z.number().int().nonnegative() }),
});
const eventEnvelope = z.object({ type: z.string() }).passthrough();
const blockStart = z.object({ index: z.number().int(), content_block: z.union([textBlock, wireToolUse]) });
const finishReason = (value: z.infer<typeof reason>) =>
  value === 'max_tokens' ? 'length' : value === 'tool_use' ? 'tool_calls' : 'stop';

/** Validates text and function calls; completion is emitted only after a complete upstream EOF. */
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
  #tools = 0;
  #tool: { index: number; input: string } | undefined;
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
      if ((body.stop_reason === 'tool_use') !== body.content.some((c) => c.type === 'tool_use'))
        throw new Error('Invalid tool completion.');
      return JSON.stringify({
        id: body.id,
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: body.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join(''),
              ...(body.content.some((c) => c.type === 'tool_use')
                ? {
                    tool_calls: body.content
                      .filter((c) => c.type === 'tool_use')
                      .map((c) => ({
                        id: c.id,
                        type: 'function',
                        function: { name: c.name, arguments: JSON.stringify(c.input) },
                      })),
                  }
                : {}),
            },
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
  #chunk(delta: Record<string, unknown>, finish_reason: string | null = null): string {
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
        if (block.content_block.type === 'tool_use') {
          this.#tool = {
            index: this.#tools++,
            input: Object.keys(block.content_block.input).length ? JSON.stringify(block.content_block.input) : '',
          };
          output += this.#chunk({
            tool_calls: [
              {
                index: this.#tool.index,
                id: block.content_block.id,
                type: 'function',
                function: { name: block.content_block.name, arguments: '' },
              },
            ],
          });
        } else output += this.#chunk({ content: block.content_block.text });
      } else if (event.type === 'content_block_delta') {
        const delta = textDelta.parse(event);
        if (delta.index !== this.#block) throw new Error();
        if (delta.delta.type === 'input_json_delta') {
          if (!this.#tool || this.#tool.input.length + delta.delta.partial_json.length > 65536)
            throw new Error('Invalid tool arguments.');
          this.#tool.input += delta.delta.partial_json;
        } else {
          if (this.#tool) throw new Error('Invalid tool delta.');
          output += this.#chunk({ content: delta.delta.text });
        }
      } else if (event.type === 'content_block_stop') {
        if (this.#block === undefined || event.index !== this.#block) throw new Error();
        if (this.#tool) {
          const input = wireObject.parse(JSON.parse(this.#tool.input || '{}'));
          output += this.#chunk({
            tool_calls: [{ index: this.#tool.index, function: { arguments: JSON.stringify(input) } }],
          });
          this.#tool = undefined;
        }
        this.#block = undefined;
      } else if (event.type === 'message_delta') {
        const delta = messageDelta.parse(event);
        if (this.#block !== undefined || this.#finish) throw new Error();
        if ((delta.delta.stop_reason === 'tool_use') !== this.#tools > 0) throw new Error('Invalid tool completion.');
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
