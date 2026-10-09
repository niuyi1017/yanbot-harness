import { z } from 'zod';

export const bridgeToolNames = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion'] as const;
const toolName = z.enum(bridgeToolNames);
const cache = z.object({ type: z.literal('ephemeral'), ttl: z.enum(['5m', '1h']).optional() }).strict();
export const wireObject = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 8192 || item.depth > 24) {
      context.addIssue({ code: 'custom', message: 'JSON structure limit.' });
      return;
    }
    if (item.value !== null && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    } else if (
      (typeof item.value === 'number' && !Number.isFinite(item.value)) ||
      (!['string', 'number', 'boolean'].includes(typeof item.value) && item.value !== null)
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid JSON value.' });
      return;
    }
  }
});
export const wireText = z
  .object({ type: z.literal('text'), text: z.string().max(65536), cache_control: cache.optional() })
  .strict()
  .transform(({ type, text }) => ({ type, text }));
export const wireToolUse = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().min(1).max(256),
    name: toolName,
    input: wireObject,
    cache_control: cache.optional(),
  })
  .strict()
  .transform(({ type, id, name, input }) => ({ type, id, name, input }));
const wireToolResult = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().min(1).max(256),
    content: z.union([z.string().max(65536), z.array(wireText).max(128)]),
    is_error: z.boolean().optional(),
    cache_control: cache.optional(),
  })
  .strict()
  .transform((value) => {
    const result = { ...value };
    delete result.cache_control;
    return result;
  });
const content = z.union([z.string().max(65536), z.array(z.union([wireText, wireToolUse, wireToolResult])).max(128)]);
export const wireTool = z
  .object({
    name: toolName,
    description: z.string().max(65536).optional(),
    input_schema: wireObject,
    cache_control: cache.optional(),
  })
  .strict()
  .transform((value) => {
    const result = { ...value };
    delete result.cache_control;
    return result;
  });
export const anthropicRequest = z
  .object({
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content }).strict())
      .min(1)
      .max(128),
    system: z.union([z.string().max(65536), z.array(wireText).max(128)]).optional(),
    max_tokens: z.number().int().min(1).max(4096),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(1).optional(),
    tools: z.array(wireTool).max(32).optional(),
  })
  .strict()
  .superRefine((body, context) => {
    const ids = new Set<string>();
    const pending = new Set<string>();
    const names = body.tools?.map((tool) => tool.name) ?? [];
    if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: 'Duplicate tools.' });
    for (const message of body.messages) {
      if (typeof message.content === 'string') continue;
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          if (message.role !== 'assistant' || ids.has(block.id))
            context.addIssue({ code: 'custom', message: 'Invalid tool call.' });
          ids.add(block.id);
          pending.add(block.id);
        } else if (block.type === 'tool_result') {
          if (message.role !== 'user' || !pending.delete(block.tool_use_id))
            context.addIssue({ code: 'custom', message: 'Unmatched tool result.' });
        }
      }
    }
    if (pending.size) context.addIssue({ code: 'custom', message: 'Missing tool result.' });
  });

/** Vendor-only metadata is stripped; provider control fields cannot cross the boundary. */
export function normalizeAnthropicRequest(value: unknown): z.infer<typeof anthropicRequest> {
  const envelope = z
    .object({
      metadata: z
        .object({ user_id: z.string().max(4096).optional() })
        .strict()
        .optional(),
      thinking: z
        .object({ type: z.literal('disabled') })
        .strict()
        .optional(),
      output_config: z
        .object({ effort: z.enum(['low', 'medium', 'high']).optional() })
        .strict()
        .optional(),
    })
    .passthrough()
    .parse(value);
  const body = { ...envelope };
  delete body.metadata;
  delete body.thinking;
  delete body.output_config;
  const parsed = anthropicRequest.parse(body);
  if (!parsed.tools?.length) delete parsed.tools;
  return parsed;
}
