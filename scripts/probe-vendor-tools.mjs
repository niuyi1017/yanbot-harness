import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

if (process.argv[2] !== '--child') {
  if (!process.env.CLAUDE_CODE_EXECUTABLE) throw new Error('Pinned CLAUDE_CODE_EXECUTABLE is required.');
  for (const vendor of ['claude', 'codebuddy'])
    for (const decision of ['allow', 'deny']) {
      const root = await mkdtemp(path.join(tmpdir(), 'harness-vendor-tools-'));
      try {
        const result = await promisify(execFile)(
          process.execPath,
          [import.meta.filename, '--child', vendor, root, decision],
          {
            env: {
              PATH: process.env.PATH,
              HOME: root,
              USERPROFILE: root,
              TMPDIR: root,
              ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
              CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE,
              ...(process.env.HARNESS_CLI_JOB_HOST ? { HARNESS_CLI_JOB_HOST: process.env.HARNESS_CLI_JOB_HOST } : {}),
            },
            timeout: 90_000,
            maxBuffer: 64 * 1024,
          },
        );
        console.log(result.stdout.trim());
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
} else {
  const vendor = process.argv[3];
  const root = process.argv[4];
  const decision = process.argv[5] ?? 'allow';
  const { GuestModelChannel, HostModelChannel } = await import('../packages/sandbox-model-channel/dist/index.js');
  let calls = 0;
  const requests = [];
  const host = new HostModelChannel(
    async (body) => {
      requests.push(body);
      calls++;
      const block =
        calls === 1
          ? {
              type: 'tool_use',
              id: 'tool_write_1',
              name: 'Write',
              input: { file_path: path.join(root, 'result.txt'), content: 'TOOL_OK' },
            }
          : calls === 2
            ? {
                type: 'tool_use',
                id: 'tool_question_1',
                name: 'AskUserQuestion',
                input: {
                  questions: [
                    {
                      question: 'Choose a color?',
                      header: 'Color',
                      options: [
                        { label: 'Blue', description: 'Blue color' },
                        { label: 'Red', description: 'Red color' },
                      ],
                      multiSelect: false,
                    },
                  ],
                },
              }
            : { type: 'text', text: 'TOOLS_DONE' };
      const message = {
        id: `msg_${calls}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      };
      const stop = calls < 3 ? 'tool_use' : 'end_turn';
      if (!body.stream)
        return globalThis.Response.json({
          ...message,
          content: [block],
          stop_reason: stop,
          usage: { input_tokens: 5, output_tokens: 10 },
        });
      const events = [
        { type: 'message_start', message },
        {
          type: 'content_block_start',
          index: 0,
          content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta:
            block.type === 'text'
              ? { type: 'text_delta', text: block.text }
              : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      return new globalThis.Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    },
    async (frame) => guest.accept(frame),
  );
  const errors = [];
  host.on('error', (error) => errors.push(error.message));
  host.resume();
  const guest = new GuestModelChannel(
    async (frame) => {
      host.write(`${JSON.stringify(frame)}\n`);
    },
    vendor === 'claude' ? 'claude' : 'codebuddy',
  );
  const origin = await guest.listen();
  guest.setEnabled(true);
  const events = [];
  const response = (event) =>
    event.payload.kind === 'permission'
      ? { requestId: event.payload.requestId, action: decision }
      : {
          requestId: event.payload.requestId,
          action: 'submit',
          answers: Object.fromEntries(event.payload.questions.map((q) => [q.id, 'Blue'])),
        };
  const input = {
    runId: randomUUID(),
    sessionId: randomUUID(),
    prompt: 'Write a test file, ask a question and finish.',
    cwd: root,
    permissionPolicy: 'interactive',
    configScopes: [],
    extensions: [],
    maxTurns: 4,
  };
  try {
    if (vendor === 'claude') {
      const { executeClaudeRun } = await import('../packages/adapter-claude-code-cli/dist/execute.js');
      const bridge = {};
      await executeClaudeRun(
        {
          executablePath: process.env.CLAUDE_CODE_EXECUTABLE,
          apiKey: guest.token,
          loopbackOrigin: origin,
          ...(process.env.HARNESS_CLI_JOB_HOST ? { windowsJobHost: process.env.HARNESS_CLI_JOB_HOST } : {}),
        },
        { ...input, model: { adapterId: 'com.anthropic.claude-code-cli', modelId: 'claude-sonnet-4-6' } },
        globalThis.AbortSignal.timeout(60_000),
        async (event) => {
          events.push(event);
          if (event.type === 'interaction.requested')
            globalThis.queueMicrotask(() => {
              void bridge.respond(response(event));
            });
        },
        bridge,
      );
    } else {
      const { CodeBuddyAdapter } = await import('../packages/adapter-codebuddy/dist/index.js');
      const runtime = await new CodeBuddyAdapter({
        modelBridge: { loopbackOrigin: origin, token: guest.token },
      }).createRuntime({});
      try {
        for await (const event of runtime.startRun({
          ...input,
          abortSignal: globalThis.AbortSignal.timeout(60_000),
          model: { adapterId: 'cn.tencent.codebuddy', modelId: 'claude-sonnet-4-6' },
        })) {
          events.push(event);
          if (event.type === 'interaction.requested') await runtime.respondToInteraction(response(event));
        }
      } finally {
        await runtime.dispose();
      }
    }
    assert.equal(events.at(-1)?.type, 'run.completed', JSON.stringify({ events, errors, calls }));
    if (decision === 'allow') assert.equal(await readFile(path.join(root, 'result.txt'), 'utf8'), 'TOOL_OK');
    else await assert.rejects(readFile(path.join(root, 'result.txt')), { code: 'ENOENT' });
    assert(
      events.some(
        (event) =>
          event.type === 'interaction.resolved' &&
          event.payload.outcome === (decision === 'allow' ? 'allowed' : 'denied'),
      ),
    );
    assert(events.some((event) => event.type === 'tool.completed'));
    assert(events.some((event) => event.type === 'interaction.requested' && event.payload.kind === 'permission'));
    assert(events.some((event) => event.type === 'interaction.resolved' && event.payload.outcome === 'answered'));
    assert.equal(calls, 3);
    assert(JSON.stringify(requests[2]).includes('Blue'));
    console.log(
      JSON.stringify({
        vendor,
        decision,
        status: 'passed',
        modelRequests: calls,
        eventTypes: events.map((event) => event.type),
        realProvider: false,
      }),
    );
  } finally {
    await guest.close();
    host.destroy();
  }
}
