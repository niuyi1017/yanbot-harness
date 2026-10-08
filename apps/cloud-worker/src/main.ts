import { DockerSandboxAdapter } from '@yanbot-harness/sandbox-docker';
import { ClaudeCodeCliAdapter } from '@yanbot-harness/adapter-claude-code-cli';
import type { Run } from '@yanbot-harness/contracts';
import { ReferenceAdapter, type ReferenceScenario } from '@yanbot-harness/adapter-reference';

import { parseWorkerConfig } from './config.js';
import { RunCoordinator } from './run-coordinator.js';
import { CloudWorkerService } from './worker.service.js';

const config = parseWorkerConfig(process.env);
const scenario: ReferenceScenario | undefined =
  config.testScenario === 'question'
    ? { kind: 'question', prompt: 'Choose?', answerResult: 'answered' }
    : config.testScenario === 'wait-for-cancel'
      ? { kind: 'wait-for-cancel' }
      : config.testScenario === 'text'
        ? { kind: 'text', chunks: ['Reference response.'] }
        : undefined;
const coordinator = new RunCoordinator(
  config,
  undefined,
  config.sandbox
    ? (run: Run, cwd?: string) => {
        if (!cwd) throw new Error('Sandbox requires a prepared snapshot.');
        const adapter =
          run.adapterId === 'cn.yanbot.reference'
            ? new ReferenceAdapter()
            : run.adapterId === 'com.anthropic.claude-code-cli'
              ? new ClaudeCodeCliAdapter({ executablePath: '/opt/claude/claude' })
              : undefined;
        if (!adapter) throw new Error('Unsupported sandbox Adapter.');
        return new DockerSandboxAdapter(
          { ...config.sandbox!, snapshotRoot: config.sharedWorkspaceRoot, workspacePath: cwd },
          adapter.manifest,
        );
      }
    : scenario === undefined
      ? undefined
      : () => new ReferenceAdapter({ scenario }),
);
const worker = new CloudWorkerService(config, coordinator);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await worker.close();
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
await worker.start();
