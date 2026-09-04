import { adapterEventSchema, type AdapterEvent, type RunRequest } from '@yanbot-harness/contracts';
import {
  HarnessAdapterError,
  assertRuntimeMatchesCapabilities,
  type AdapterRuntimeContext,
  type HarnessAdapter,
} from '@yanbot-harness/adapter-api';

const terminalEventTypes = new Set<AdapterEvent['type']>(['run.completed', 'run.failed', 'run.cancelled']);

export async function* executeAdapterRun(
  adapter: HarnessAdapter,
  context: AdapterRuntimeContext,
  request: RunRequest,
): AsyncIterable<AdapterEvent> {
  const runtime = await adapter.createRuntime(context);
  let expectedSequence = 1;
  let terminalSeen = false;

  try {
    await assertRuntimeMatchesCapabilities(runtime);
    const source = request.adapterSessionId
      ? runtime.resumeRun?.({ ...request, adapterSessionId: request.adapterSessionId })
      : runtime.startRun(request);
    if (!source) {
      throw new HarnessAdapterError({
        code: 'CAPABILITY_UNSUPPORTED',
        message: `Adapter ${adapter.manifest.adapterId} cannot resume sessions.`,
        retryable: false,
      });
    }

    for await (const rawEvent of source) {
      const event = adapterEventSchema.parse(rawEvent);
      if (event.runId !== request.runId || event.sessionId !== request.sessionId) {
        throw protocolError('Adapter emitted an event for a different run or session.');
      }
      if (event.sequence !== expectedSequence) {
        throw protocolError(`Expected event sequence ${expectedSequence}, received ${event.sequence}.`);
      }
      if (expectedSequence === 1 && event.type !== 'run.started') {
        throw protocolError('The first event must be run.started.');
      }
      if (terminalSeen) throw protocolError('Adapter emitted an event after a terminal event.');

      expectedSequence += 1;
      terminalSeen = terminalEventTypes.has(event.type);
      yield event;
    }

    if (!terminalSeen) throw protocolError('Adapter stream ended without a terminal event.');
  } finally {
    await runtime.dispose();
  }
}

function protocolError(message: string): HarnessAdapterError {
  return new HarnessAdapterError({ code: 'HARNESS_PROTOCOL_ERROR', message, retryable: false });
}
