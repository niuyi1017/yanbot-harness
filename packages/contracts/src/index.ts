import { z } from 'zod';

export const HARNESS_PROTOCOL_VERSION = '1.0.0' as const;

export const protocolVersionSchema = z.literal(HARNESS_PROTOCOL_VERSION);
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
export const adapterIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
export const opaqueIdSchema = z.string().min(1).max(512);
export const uuidSchema = z.string().uuid();

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const runtimeKindSchema = z.enum(['in-process', 'sidecar', 'remote']);
export const adapterManifestSchema = z.object({
  protocolVersion: protocolVersionSchema,
  adapterId: adapterIdSchema,
  adapterVersion: semverSchema,
  displayName: z.string().trim().min(1).max(128),
  harness: z.object({
    name: z.string().trim().min(1).max(128),
    version: z.string().trim().min(1).max(128).optional(),
  }),
  runtimeKinds: z.array(runtimeKindSchema).min(1),
  configSchema: jsonObjectSchema.optional(),
});

export const capabilityIdSchema = z.enum([
  'sessions.resume',
  'runs.cancel',
  'streaming.text',
  'streaming.tool-events',
  'interactions.permissions',
  'interactions.questions',
  'extensions.mcp',
  'extensions.skills',
  'extensions.agents',
  'extensions.hooks',
  'workspace.worktrees',
  'workspace.sandbox',
  'models.list',
  'usage.tokens',
  'usage.cost',
  'computer-use',
]);
export const capabilityLevelSchema = z.enum(['native', 'emulated', 'unsupported']);
export const capabilitySupportSchema = z.object({
  level: capabilityLevelSchema,
  version: z.string().trim().min(1).max(64).optional(),
  limits: jsonObjectSchema.optional(),
  reason: z.string().trim().min(1).max(512).optional(),
});
export const harnessCapabilitiesSchema = z.partialRecord(capabilityIdSchema, capabilitySupportSchema);

export const adapterSummarySchema = z
  .object({
    manifest: adapterManifestSchema,
    capabilities: harnessCapabilitiesSchema,
  })
  .strict();

export const modelRefSchema = z.object({
  adapterId: adapterIdSchema,
  modelId: z.string().trim().min(1).max(256),
});
export const modelDescriptorSchema = z.object({
  ref: modelRefSchema,
  name: z.string().trim().min(1).max(256),
  description: z.string().trim().max(1_024).optional(),
  metadata: jsonObjectSchema.optional(),
});

export const permissionPolicySchema = z.enum(['interactive', 'auto-edit', 'read-only']);
export const configScopeSchema = z.enum(['user', 'organization', 'project', 'local']);
export const extensionSelectionSchema = z.object({
  extensionId: z.string().trim().min(1).max(256),
  version: semverSchema.optional(),
  enabled: z.boolean().default(true),
  config: jsonObjectSchema.optional(),
});
export const extensionDescriptorSchema = z
  .object({
    extensionId: z
      .string()
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
      .max(256),
    kind: z.enum(['mcp', 'skill', 'agent', 'hook']),
    version: semverSchema,
    displayName: z.string().trim().min(1).max(256),
    description: z.string().trim().max(1_024).optional(),
    source: z.enum(['bundled', 'user', 'project']),
    configSchema: jsonObjectSchema.optional(),
    requiredCapabilities: z.array(capabilityIdSchema).default([]),
    credentialRefs: z.array(z.string().trim().min(1).max(128)).default([]),
  })
  .strict();

export const extensionSummarySchema = z
  .object({
    descriptor: extensionDescriptorSchema,
    supported: z.boolean().optional(),
  })
  .strict();
export const runRequestSchema = z.object({
  runId: uuidSchema,
  sessionId: uuidSchema,
  adapterSessionId: opaqueIdSchema.optional(),
  prompt: z.string().min(1).max(1_000_000),
  cwd: z.string().min(1).max(4_096).optional(),
  model: modelRefSchema.optional(),
  maxTurns: z.number().int().positive().max(1_000).optional(),
  permissionPolicy: permissionPolicySchema.default('interactive'),
  configScopes: z.array(configScopeSchema).default([]),
  extensions: z.array(extensionSelectionSchema).default([]),
});

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
});

export const harnessErrorCodeSchema = z.enum([
  'ADAPTER_UNAVAILABLE',
  'ADAPTER_INCOMPATIBLE',
  'CAPABILITY_UNSUPPORTED',
  'AUTHENTICATION_FAILED',
  'CONFIGURATION_INVALID',
  'PERMISSION_DENIED',
  'INTERACTION_EXPIRED',
  'RUN_CANCELLED',
  'RUN_TIMEOUT',
  'HARNESS_FAILED',
  'HARNESS_PROTOCOL_ERROR',
  'INTERNAL_ERROR',
]);
export const harnessErrorSchema = z.object({
  code: harnessErrorCodeSchema,
  message: z.string().trim().min(1).max(2_048),
  retryable: z.boolean().default(false),
  adapterCode: z.string().trim().min(1).max(256).optional(),
  details: jsonObjectSchema.optional(),
});

export const permissionInteractionSchema = z.object({
  kind: z.literal('permission'),
  requestId: opaqueIdSchema,
  toolName: z.string().trim().min(1).max(256),
  risk: z.enum(['low', 'medium', 'high']),
  inputSummary: jsonObjectSchema.optional(),
});
export const questionInteractionSchema = z.object({
  kind: z.literal('question'),
  requestId: opaqueIdSchema,
  questions: z
    .array(
      z.object({
        id: opaqueIdSchema,
        prompt: z.string().trim().min(1).max(2_048),
        options: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(256),
              value: z.string().max(2_048),
            }),
          )
          .optional(),
        multiple: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(16),
});
export const interactionRequestSchema = z.discriminatedUnion('kind', [
  permissionInteractionSchema,
  questionInteractionSchema,
]);
export const interactionResponseSchema = z.object({
  requestId: opaqueIdSchema,
  action: z.enum(['allow', 'deny', 'submit']),
  answers: z.record(z.string(), z.string()).optional(),
  message: z.string().trim().min(1).max(1_024).optional(),
});

const eventBase = {
  protocolVersion: protocolVersionSchema,
  eventId: uuidSchema,
  runId: uuidSchema,
  sessionId: uuidSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime({ offset: true }),
  adapterMetadata: jsonObjectSchema.optional(),
};

export const runStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal('run.started'),
  payload: z.object({ adapterId: adapterIdSchema, model: modelRefSchema.optional() }),
});
export const sessionInitializedEventSchema = z.object({
  ...eventBase,
  type: z.literal('session.initialized'),
  payload: z.object({
    adapterSessionId: opaqueIdSchema.optional(),
    capabilities: harnessCapabilitiesSchema,
  }),
});
export const assistantDeltaEventSchema = z.object({
  ...eventBase,
  type: z.literal('assistant.delta'),
  payload: z.object({ channel: z.enum(['output', 'thinking']), text: z.string().min(1) }),
});
export const assistantMessageEventSchema = z.object({
  ...eventBase,
  type: z.literal('assistant.message'),
  payload: z.object({ text: z.string() }),
});
export const toolStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal('tool.started'),
  payload: z.object({
    toolUseId: opaqueIdSchema,
    name: z.string().trim().min(1).max(256),
    inputSummary: jsonObjectSchema.optional(),
  }),
});
export const toolCompletedEventSchema = z.object({
  ...eventBase,
  type: z.literal('tool.completed'),
  payload: z.object({ toolUseId: opaqueIdSchema, outputSummary: jsonValueSchema.optional() }),
});
export const toolFailedEventSchema = z.object({
  ...eventBase,
  type: z.literal('tool.failed'),
  payload: z.object({ toolUseId: opaqueIdSchema, error: harnessErrorSchema }),
});
export const interactionRequestedEventSchema = z.object({
  ...eventBase,
  type: z.literal('interaction.requested'),
  payload: interactionRequestSchema,
});
export const interactionResolvedEventSchema = z.object({
  ...eventBase,
  type: z.literal('interaction.resolved'),
  payload: z.object({
    requestId: opaqueIdSchema,
    outcome: z.enum(['allowed', 'denied', 'answered', 'expired', 'cancelled']),
  }),
});
export const usageUpdatedEventSchema = z.object({
  ...eventBase,
  type: z.literal('usage.updated'),
  payload: usageSchema,
});
export const runCompletedEventSchema = z.object({
  ...eventBase,
  type: z.literal('run.completed'),
  payload: z.object({ usage: usageSchema.optional() }),
});
export const runFailedEventSchema = z.object({
  ...eventBase,
  type: z.literal('run.failed'),
  payload: z.object({ error: harnessErrorSchema }),
});
export const runCancelledEventSchema = z.object({
  ...eventBase,
  type: z.literal('run.cancelled'),
  payload: z.object({ reason: z.string().trim().min(1).max(1_024).optional() }),
});

export const adapterEventSchema = z.discriminatedUnion('type', [
  runStartedEventSchema,
  sessionInitializedEventSchema,
  assistantDeltaEventSchema,
  assistantMessageEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  toolFailedEventSchema,
  interactionRequestedEventSchema,
  interactionResolvedEventSchema,
  usageUpdatedEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runCancelledEventSchema,
]);

export const localSessionStatusSchema = z.enum(['idle', 'running', 'failed']);
export const localRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
export const terminalEventTypeSchema = z.enum(['run.completed', 'run.failed', 'run.cancelled']);

export const localSessionSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    sessionId: uuidSchema,
    adapterId: adapterIdSchema,
    adapterSessionId: opaqueIdSchema.optional(),
    title: z.string().trim().min(1).max(256).optional(),
    status: localSessionStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    lastRunId: uuidSchema.optional(),
    workspaceRef: uuidSchema.optional(),
  })
  .strict();

export const localRunSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    runId: uuidSchema,
    sessionId: uuidSchema,
    adapterId: adapterIdSchema,
    status: localRunStatusSchema,
    prompt: z.string().min(1).max(1_000_000),
    model: modelRefSchema.optional(),
    permissionPolicy: permissionPolicySchema,
    adapterSessionId: opaqueIdSchema.optional(),
    firstSequence: z.number().int().positive().optional(),
    lastSequence: z.number().int().positive().optional(),
    terminalEventType: terminalEventTypeSchema.optional(),
    createdAt: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }).optional(),
    completedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const createLocalSessionRequestSchema = z
  .object({
    adapterId: adapterIdSchema,
    title: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const relativeWorkspacePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes('\0'), 'Relative workspace paths cannot contain null bytes.')
  .refine(
    (value) => !value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:[\\/]/.test(value),
    'The workspace path must be relative.',
  )
  .refine(
    (value) => !value.split(/[\\/]+/u).includes('..'),
    'The workspace path cannot traverse outside the granted root.',
  );

export const createLocalRunRequestSchema = z
  .object({
    prompt: z.string().min(1).max(1_000_000),
    workspaceGrant: opaqueIdSchema,
    relativeCwd: relativeWorkspacePathSchema.optional(),
    model: modelRefSchema.optional(),
    maxTurns: z.number().int().positive().max(1_000).optional(),
    permissionPolicy: permissionPolicySchema.default('interactive'),
    configScopes: z.array(configScopeSchema).default([]),
    extensions: z.array(extensionSelectionSchema).default([]),
    resume: z.boolean().default(false),
  })
  .strict();

export const createWorkspaceGrantRequestSchema = z
  .object({
    path: z.string().trim().min(1).max(4_096),
    ttlMs: z.number().int().min(1_000).max(86_400_000).optional(),
  })
  .strict();

export const workspaceGrantSchema = z
  .object({
    grantId: uuidSchema,
    grant: opaqueIdSchema,
    workspaceRef: uuidSchema,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const eventCursorSchema = z
  .object({
    afterEventId: uuidSchema.optional(),
  })
  .strict();

export const localApiErrorSchema = z
  .object({
    error: harnessErrorSchema,
    requestId: uuidSchema,
  })
  .strict();

export const runtimeHealthSchema = z
  .object({
    service: z.string().trim().min(1).max(128),
    protocolVersion: protocolVersionSchema,
    status: z.literal('ok'),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const effectiveConfigSummarySchema = z
  .object({
    scopes: z.array(z.union([configScopeSchema, z.literal('enforced')])),
    adapterKeys: z.array(z.string().min(1).max(256)),
    extensionIds: z.array(z.string().min(1).max(256)),
    credentialKeys: z.array(z.string().min(1).max(256)),
  })
  .strict();

export const createLocalRunResultSchema = z
  .object({
    run: localRunSchema,
    reused: z.boolean(),
  })
  .strict();

export type AdapterEvent = z.infer<typeof adapterEventSchema>;
export type AdapterManifest = z.infer<typeof adapterManifestSchema>;
export type AdapterSummary = z.infer<typeof adapterSummarySchema>;
export type CapabilityId = z.infer<typeof capabilityIdSchema>;
export type CapabilityLevel = z.infer<typeof capabilityLevelSchema>;
export type CapabilitySupport = z.infer<typeof capabilitySupportSchema>;
export type ConfigScope = z.infer<typeof configScopeSchema>;
export type ExtensionSelection = z.infer<typeof extensionSelectionSchema>;
export type ExtensionDescriptor = z.infer<typeof extensionDescriptorSchema>;
export type ExtensionSummary = z.infer<typeof extensionSummarySchema>;
export type EffectiveConfigSummary = z.infer<typeof effectiveConfigSummarySchema>;
export type HarnessCapabilities = z.infer<typeof harnessCapabilitiesSchema>;
export type HarnessError = z.infer<typeof harnessErrorSchema>;
export type HarnessErrorCode = z.infer<typeof harnessErrorCodeSchema>;
export type InteractionRequest = z.infer<typeof interactionRequestSchema>;
export type InteractionResponse = z.infer<typeof interactionResponseSchema>;
export type CreateLocalRunRequest = z.infer<typeof createLocalRunRequestSchema>;
export type CreateLocalRunResult = z.infer<typeof createLocalRunResultSchema>;
export type CreateLocalSessionRequest = z.infer<typeof createLocalSessionRequestSchema>;
export type CreateWorkspaceGrantRequest = z.infer<typeof createWorkspaceGrantRequestSchema>;
export type EventCursor = z.infer<typeof eventCursorSchema>;
export type LocalApiError = z.infer<typeof localApiErrorSchema>;
export type LocalRun = z.infer<typeof localRunSchema>;
export type LocalRunStatus = z.infer<typeof localRunStatusSchema>;
export type LocalSession = z.infer<typeof localSessionSchema>;
export type LocalSessionStatus = z.infer<typeof localSessionStatusSchema>;
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;
export type ModelRef = z.infer<typeof modelRefSchema>;
export type PermissionPolicy = z.infer<typeof permissionPolicySchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;
export type RuntimeHealth = z.infer<typeof runtimeHealthSchema>;
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;
export type TerminalEventType = z.infer<typeof terminalEventTypeSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type WorkspaceGrant = z.infer<typeof workspaceGrantSchema>;
