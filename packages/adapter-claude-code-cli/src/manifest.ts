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
  'sessions.resume': {
    level: 'unsupported',
    reason: 'Vendor-native resume is unavailable; Remote checkpoint resume is provided by the control plane.',
  },
  'streaming.tool-events': { level: 'native' },
  'interactions.permissions': { level: 'native' },
  'interactions.questions': { level: 'native' },
  'models.list': { level: 'unsupported', reason: 'No certified discovery interface.' },
};
