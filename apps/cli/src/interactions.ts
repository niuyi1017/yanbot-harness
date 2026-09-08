import { createInterface } from 'node:readline/promises';

import type { AdapterEvent, InteractionResponse } from '@yanbot-harness/sdk';

import type { CliIo } from './output.js';

export async function promptForInteraction(
  io: CliIo,
  event: Extract<AdapterEvent, { type: 'interaction.requested' }>,
): Promise<InteractionResponse | undefined> {
  if (!io.stdin.isTTY) return undefined;
  const readline = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream });
  try {
    if (event.payload.kind === 'permission') {
      const answer = await readline.question(`Allow ${event.payload.toolName} (${event.payload.risk} risk)? [y/N] `);
      return {
        requestId: event.payload.requestId,
        action: /^y(?:es)?$/iu.test(answer.trim()) ? 'allow' : 'deny',
      };
    }
    const answers: Record<string, string> = {};
    for (const question of event.payload.questions) {
      const options = question.options?.map((item) => item.label).join('/') ?? '';
      answers[question.id] = await readline.question(`${question.prompt}${options ? ` [${options}]` : ''} `);
    }
    return { requestId: event.payload.requestId, action: 'submit', answers };
  } finally {
    readline.close();
  }
}
