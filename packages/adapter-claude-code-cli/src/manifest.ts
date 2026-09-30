import { HARNESS_PROTOCOL_VERSION, type AdapterManifest, type HarnessCapabilities } from '@yanbot-harness/contracts';

export const CLAUDE_CODE_VERSION = '2.1.284';
export const manifest: AdapterManifest = {
  protocolVersion: HARNESS_PROTOCOL_VERSION,
  adapterId: 'com.anthropic.claude-code-cli',
  adapterVersion: '0.1.0',
  displayName: 'Claude Code CLI (Experimental)',
  harness: { name: 'Claude Code', version: CLAUDE_CODE_VERSION },
  runtimeKinds: ['sidecar'],
};
export const capabilities: HarnessCapabilities = {
  'runs.cancel': { level: 'emulated' },
  'streaming.text': { level: 'native' },
  'usage.tokens': { level: 'native' },
  'usage.cost': { level: 'native' },
  'sessions.resume': { level: 'unsupported', reason: 'Ephemeral text-only experimental execution.' },
  'streaming.tool-events': { level: 'unsupported', reason: 'Tools are disabled.' },
  'interactions.permissions': { level: 'unsupported', reason: 'Only read-only text execution is accepted.' },
  'interactions.questions': { level: 'unsupported', reason: 'Interactive execution is disabled.' },
  'models.list': { level: 'unsupported', reason: 'No certified discovery interface.' },
};
