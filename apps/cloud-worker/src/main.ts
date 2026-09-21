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
  scenario === undefined ? undefined : () => new ReferenceAdapter({ scenario }),
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
