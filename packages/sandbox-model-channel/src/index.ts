export { HostModelChannel } from './host.js';
export { GuestModelChannel, normalizeClaudeText } from './guest.js';
export type { ModelRequest } from './protocol.js';
export { HostCheckpointChannel, GuestCheckpointChannel, type SaveCheckpoint } from './state.js';

export { anthropicRequest, normalizeAnthropicRequest } from './wire.js';
