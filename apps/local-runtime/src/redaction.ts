import { adapterEventSchema, type AdapterEvent, type JsonValue } from '@yanbot-harness/contracts';

export type RedactionOptions = {
  secrets?: readonly string[];
  workspaceRoots?: readonly string[];
};

const sensitiveKey =
  /^(?:api[-_]?key|authorization|cookie|credentials?|password|secret|(?:access|auth|refresh)?[-_]?token)$/i;
const absolutePath = /(?:[A-Za-z]:[\\/][^\s"']+|\/(?:Users|home|private|tmp|var)\/[^\s"']+)/g;

export function redactEventForPersistence(event: AdapterEvent, options: RedactionOptions = {}): AdapterEvent {
  return adapterEventSchema.parse(redactValue(event as unknown as JsonValue, options));
}

export function redactValue(value: JsonValue, options: RedactionOptions = {}): JsonValue {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? '[REDACTED]' : redactValue(item, options),
      ]),
    );
  }
  if (typeof value !== 'string') return value;

  let safe = value;
  for (const secret of options.secrets ?? []) {
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }
  for (const root of options.workspaceRoots ?? []) {
    if (root) safe = safe.split(root).join('[WORKSPACE]');
  }
  return safe.replace(absolutePath, '[REDACTED_PATH]');
}
