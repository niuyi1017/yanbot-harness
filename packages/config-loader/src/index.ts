import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  configScopeSchema,
  extensionSelectionSchema,
  jsonObjectSchema,
  type ConfigScope,
  type ExtensionSelection,
  type JsonValue,
} from '@yanbot-harness/contracts';
import { Ajv } from 'ajv';
import { z } from 'zod';

const MAX_CONFIG_BYTES = 1_048_576;
const schemaValidator = new Ajv({ allErrors: false, strict: true });
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const sensitiveKeyPattern =
  /^(?:api[-_]?key|authorization|client[-_]?secret|cookie|credentials?|password|private[-_]?key|secret|(?:access|auth|refresh)?[-_]?token)$/i;
const credentialReferenceSchema = z.string().regex(/^(?:env|keychain|secret):[A-Za-z0-9._/-]+$/);
const layerScopeSchema = z.union([configScopeSchema, z.literal('enforced')]);
const layerValuesSchema = z
  .object({
    adapter: jsonObjectSchema.optional(),
    extensions: z.array(extensionSelectionSchema).optional(),
    credentialRefs: z.record(z.string().min(1).max(128), credentialReferenceSchema.nullable()).optional(),
  })
  .strict();

export const configLayerSchema = z
  .object({
    scope: layerScopeSchema,
    values: layerValuesSchema,
    sourceRef: z.string().trim().min(1).max(256),
  })
  .strict();

export type ConfigLayer = z.infer<typeof configLayerSchema>;
export type ConfigLayerScope = ConfigLayer['scope'];
export type EffectiveConfig = {
  adapterConfig: Record<string, JsonValue>;
  extensionSelections: ExtensionSelection[];
  credentialRefs: Record<string, string>;
  publicSummary: {
    scopes: ConfigLayerScope[];
    adapterKeys: string[];
    extensionIds: string[];
    credentialKeys: string[];
  };
};

export class ConfigLoaderError extends Error {
  readonly code: 'CONFIGURATION_INVALID' | 'CONFIGURATION_OUTSIDE_ROOT';

  constructor(code: ConfigLoaderError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigLoaderError';
    this.code = code;
  }
}

export function resolveConfigLayers(
  layers: readonly ConfigLayer[],
  selectedScopes: readonly ConfigScope[],
): EffectiveConfig {
  try {
    const scopes = z.array(configScopeSchema).parse(selectedScopes);
    const selected = new Set(scopes);
    const ordered = layers
      .map((layer) => {
        assertSafeObject(layer);
        return configLayerSchema.parse(layer);
      })
      .filter((layer) => layer.scope === 'enforced' || selected.has(layer.scope))
      .sort((left, right) => priority(left.scope) - priority(right.scope));

    let adapterConfig: Record<string, JsonValue> = {};
    const extensions = new Map<string, ExtensionSelection>();
    const credentialRefs = new Map<string, string>();
    for (const layer of ordered) {
      assertSafeObject(layer.values);
      if (layer.values.adapter) {
        assertNoInlineCredentialValues(layer.values.adapter);
        adapterConfig = mergeObjects(adapterConfig, layer.values.adapter);
      }
      for (const selection of layer.values.extensions ?? []) {
        if (selection.config) assertNoInlineCredentialValues(selection.config);
        extensions.set(selection.extensionId, selection);
      }
      for (const [key, reference] of Object.entries(layer.values.credentialRefs ?? {})) {
        if (reference === null) credentialRefs.delete(key);
        else credentialRefs.set(key, reference);
      }
    }

    const extensionSelections = [...extensions.values()];
    return {
      adapterConfig,
      extensionSelections,
      credentialRefs: Object.fromEntries(credentialRefs),
      publicSummary: {
        scopes: [...new Set(ordered.map((layer) => layer.scope))],
        adapterKeys: Object.keys(adapterConfig).sort(),
        extensionIds: extensionSelections.filter((item) => item.enabled).map((item) => item.extensionId),
        credentialKeys: [...credentialRefs.keys()].sort(),
      },
    };
  } catch (error) {
    if (error instanceof ConfigLoaderError) throw error;
    throw new ConfigLoaderError('CONFIGURATION_INVALID', 'The configuration is invalid.', { cause: error });
  }
}

export async function readConfigLayer(options: {
  file: string;
  allowedRoot: string;
  scope: ConfigLayerScope;
}): Promise<ConfigLayer> {
  try {
    const root = await realpath(path.resolve(options.allowedRoot));
    const fileBeforeRead = await realpath(path.resolve(options.file));
    assertWithin(root, fileBeforeRead);
    const info = await stat(fileBeforeRead);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
      throw new ConfigLoaderError('CONFIGURATION_INVALID', 'The configuration file is invalid or too large.');
    }
    const contents = await readFile(fileBeforeRead, 'utf8');
    const fileAfterRead = await realpath(path.resolve(options.file));
    assertWithin(root, fileAfterRead);
    if (fileAfterRead !== fileBeforeRead) {
      throw new ConfigLoaderError('CONFIGURATION_INVALID', 'The configuration file changed while it was read.');
    }
    const raw: unknown = JSON.parse(contents);
    assertSafeObject(raw);
    const values = layerValuesSchema.parse(raw);
    if (values.adapter) assertNoInlineCredentialValues(values.adapter);
    for (const selection of values.extensions ?? []) {
      if (selection.config) assertNoInlineCredentialValues(selection.config);
    }
    return { scope: options.scope, values, sourceRef: `${options.scope}:config` };
  } catch (error) {
    if (error instanceof ConfigLoaderError) throw error;
    throw new ConfigLoaderError('CONFIGURATION_INVALID', 'The configuration file is invalid.', { cause: error });
  }
}

export function validateAdapterConfig(
  adapterConfig: Record<string, JsonValue>,
  configSchema: Record<string, JsonValue> | undefined,
): void {
  if (configSchema === undefined) return;
  try {
    const validate = schemaValidator.compile(configSchema);
    if (!validate(adapterConfig)) {
      throw new ConfigLoaderError('CONFIGURATION_INVALID', 'The adapter configuration does not match its schema.');
    }
  } catch (error) {
    if (error instanceof ConfigLoaderError) throw error;
    throw new ConfigLoaderError('CONFIGURATION_INVALID', 'The adapter configuration schema is invalid.', {
      cause: error,
    });
  }
}

function mergeObjects(
  lower: Readonly<Record<string, JsonValue>>,
  higher: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  const merged: Record<string, JsonValue> = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    if (forbiddenKeys.has(key)) throw new ConfigLoaderError('CONFIGURATION_INVALID', 'Unsafe configuration key.');
    if (value === null) {
      delete merged[key];
    } else if (isObject(value) && isObject(merged[key])) {
      merged[key] = mergeObjects(merged[key], value);
    } else {
      if (merged[key] !== undefined && jsonKind(merged[key]) !== jsonKind(value)) {
        throw new ConfigLoaderError('CONFIGURATION_INVALID', `Configuration type conflict at ${key}.`);
      }
      merged[key] = cloneJson(value);
    }
  }
  return merged;
}

export function assertNoInlineCredentialValues(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoInlineCredentialValues(item);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key)) {
      throw new ConfigLoaderError(
        'CONFIGURATION_INVALID',
        'Credential values must be provided through credential references.',
      );
    }
    assertNoInlineCredentialValues(item);
  }
}

function assertSafeObject(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeObject(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new ConfigLoaderError('CONFIGURATION_INVALID', 'Unsafe configuration key.');
    assertSafeObject(item);
  }
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonKind(value: JsonValue): 'array' | 'object' | 'string' | 'number' | 'boolean' | 'null' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as 'object' | 'string' | 'number' | 'boolean';
}

function priority(scope: ConfigLayerScope): number {
  return { local: 0, user: 1, project: 2, organization: 3, enforced: 4 }[scope];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertWithin(root: string, candidate: string): void {
  if (!isWithin(root, candidate)) {
    throw new ConfigLoaderError('CONFIGURATION_OUTSIDE_ROOT', 'The configuration file is outside its allowed root.');
  }
}
