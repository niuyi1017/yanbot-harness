import { z } from 'zod';
import type { AdapterEvent, InteractionResponse, PermissionPolicy } from '@yanbot-harness/contracts';

export const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion'] as const;
type Emit = (type: AdapterEvent['type'], payload: unknown) => Promise<void>;
export type ClaudeInteractionBridge = { respond?: (response: InteractionResponse) => Promise<void> };
const control = z.object({
  type: z.literal('control_request'),
  request_id: z.string().min(1).max(256),
  request: z.object({
    subtype: z.literal('can_use_tool'),
    tool_name: z.enum(tools),
    input: z.record(z.string(), z.unknown()),
    tool_use_id: z.string().min(1).max(256),
  }),
});
const questions = z
  .array(
    z.object({
      question: z.string().min(1).max(4096),
      options: z
        .array(z.object({ label: z.string().min(1).max(256), description: z.string().optional() }))
        .max(32)
        .optional(),
      multiSelect: z.boolean().optional(),
    }),
  )
  .min(1)
  .max(16);

export class ClaudeInteractions {
  readonly #pending = new Map<
    string,
    { input: Record<string, unknown>; questions?: Array<{ id: string; prompt: string }>; resolve(value: object): void }
  >();
  constructor(
    private readonly policy: PermissionPolicy,
    private readonly emit: Emit,
    private readonly signal: AbortSignal,
  ) {}
  async request(value: unknown): Promise<object> {
    const frame = control.parse(value);
    const requestId = frame.request_id;
    const input = frame.request.input;
    if (this.signal.aborted || this.policy === 'read-only')
      return this.#response(requestId, { behavior: 'deny', message: 'Tool execution is denied.' });
    if (this.#pending.has(requestId) || this.#pending.size >= 16) throw new Error('Interaction limit.');
    const mapped =
      frame.request.tool_name === 'AskUserQuestion'
        ? questions.parse(input.questions).map((question, index) => ({
            id: `${requestId}:${index + 1}`,
            prompt: question.question,
            ...(question.options
              ? { options: question.options.map((option) => ({ label: option.label, value: option.label })) }
              : {}),
            ...(question.multiSelect === undefined ? {} : { multiple: question.multiSelect }),
          }))
        : undefined;
    const decision = new Promise<object>((resolve) =>
      this.#pending.set(requestId, { input, ...(mapped ? { questions: mapped } : {}), resolve }),
    );
    const cancel = () => {
      const pending = this.#pending.get(requestId);
      this.#pending.delete(requestId);
      pending?.resolve({ behavior: 'deny', message: 'Run cancelled.' });
    };
    this.signal.addEventListener('abort', cancel, { once: true });
    try {
      await this.emit(
        'interaction.requested',
        mapped
          ? { kind: 'question', requestId, questions: mapped }
          : {
              kind: 'permission',
              requestId,
              toolName: frame.request.tool_name,
              risk: frame.request.tool_name === 'Bash' ? 'high' : 'medium',
              inputSummary: input,
            },
      );
      if (this.signal.aborted) cancel();
      return this.#response(requestId, await decision);
    } finally {
      this.signal.removeEventListener('abort', cancel);
      this.#pending.delete(requestId);
    }
  }
  async respond(response: InteractionResponse): Promise<void> {
    const pending = this.#pending.get(response.requestId);
    if (!pending) throw new Error('Unknown interaction.');
    if (pending.questions) {
      if (response.action !== 'submit' && response.action !== 'deny') throw new Error('Question requires an answer.');
      if (response.action === 'submit') {
        const answers: Record<string, string | string[]> = {};
        for (const question of pending.questions) {
          const answer = response.answers?.[question.id];
          if (answer === undefined) throw new Error('Missing answer.');
          answers[question.prompt] = answer;
        }
        await this.emit('interaction.resolved', { requestId: response.requestId, outcome: 'answered' });
        pending.resolve({ behavior: 'allow', updatedInput: { ...pending.input, answers } });
      } else {
        await this.emit('interaction.resolved', { requestId: response.requestId, outcome: 'cancelled' });
        pending.resolve({ behavior: 'deny', message: 'Question cancelled.' });
      }
    } else {
      if (response.action !== 'allow' && response.action !== 'deny')
        throw new Error('Permission requires allow or deny.');
      await this.emit('interaction.resolved', {
        requestId: response.requestId,
        outcome: response.action === 'allow' ? 'allowed' : 'denied',
      });
      pending.resolve(
        response.action === 'allow'
          ? { behavior: 'allow', updatedInput: pending.input }
          : { behavior: 'deny', message: 'Permission denied.' },
      );
    }
    this.#pending.delete(response.requestId);
  }
  #response(request_id: string, response: object): object {
    return { type: 'control_response', response: { subtype: 'success', request_id, response } };
  }
}
