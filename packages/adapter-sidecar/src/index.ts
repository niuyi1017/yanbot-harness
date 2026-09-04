import { z } from 'zod';

import {
  adapterEventSchema,
  adapterManifestSchema,
  harnessCapabilitiesSchema,
  interactionResponseSchema,
  jsonObjectSchema,
  modelDescriptorSchema,
  opaqueIdSchema,
  protocolVersionSchema,
  runRequestSchema,
} from '@yanbot-harness/contracts';

export const SIDECAR_PROTOCOL_VERSION = '1.0.0' as const;

const requestIdSchema = z.union([z.string().min(1), z.number().int()]);
const requestBase = { jsonrpc: z.literal('2.0'), id: requestIdSchema };

export const initializeRequestSchema = z.object({
  ...requestBase,
  method: z.literal('initialize'),
  params: z.object({
    protocolVersion: protocolVersionSchema,
    clientName: z.string().trim().min(1).max(128),
    clientVersion: z.string().trim().min(1).max(128),
  }),
});
export const probeRequestSchema = z.object({
  ...requestBase,
  method: z.literal('probe'),
  params: jsonObjectSchema.default({}),
});
export const capabilitiesRequestSchema = z.object({
  ...requestBase,
  method: z.literal('capabilities'),
  params: z.object({}),
});
export const listModelsRequestSchema = z.object({
  ...requestBase,
  method: z.literal('listModels'),
  params: z.object({ refresh: z.boolean().optional() }),
});
export const startRunRequestSchema = z.object({
  ...requestBase,
  method: z.literal('startRun'),
  params: runRequestSchema,
});
export const resumeRunRequestSchema = z.object({
  ...requestBase,
  method: z.literal('resumeRun'),
  params: runRequestSchema.extend({ adapterSessionId: opaqueIdSchema }),
});
export const respondToInteractionRequestSchema = z.object({
  ...requestBase,
  method: z.literal('respondToInteraction'),
  params: interactionResponseSchema,
});
export const cancelRequestSchema = z.object({
  ...requestBase,
  method: z.literal('cancel'),
  params: z.object({ runId: z.string().uuid(), reason: z.string().trim().min(1).max(1_024).optional() }),
});
export const shutdownRequestSchema = z.object({ ...requestBase, method: z.literal('shutdown'), params: z.object({}) });

export const sidecarRequestSchema = z.discriminatedUnion('method', [
  initializeRequestSchema,
  probeRequestSchema,
  capabilitiesRequestSchema,
  listModelsRequestSchema,
  startRunRequestSchema,
  resumeRunRequestSchema,
  respondToInteractionRequestSchema,
  cancelRequestSchema,
  shutdownRequestSchema,
]);

export const initializeResultSchema = z.object({
  protocolVersion: protocolVersionSchema,
  manifest: adapterManifestSchema,
  capabilities: harnessCapabilitiesSchema,
});
export const probeResultSchema = z.object({
  available: z.boolean(),
  harnessVersion: z.string().trim().min(1).max(128).optional(),
  diagnostics: z.array(z.string().max(1_024)).optional(),
});
export const modelsResultSchema = z.object({ models: z.array(modelDescriptorSchema) });

export const sidecarResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: requestIdSchema, result: jsonObjectSchema }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: requestIdSchema.nullable(),
    error: z.object({ code: z.number().int(), message: z.string().min(1), data: jsonObjectSchema.optional() }),
  }),
]);
export const eventNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('event'),
  params: adapterEventSchema,
});
export const logNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('log'),
  params: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string().max(4_096) }),
});
export const sidecarNotificationSchema = z.discriminatedUnion('method', [
  eventNotificationSchema,
  logNotificationSchema,
]);

export type SidecarRequest = z.infer<typeof sidecarRequestSchema>;
export type SidecarResponse = z.infer<typeof sidecarResponseSchema>;
export type SidecarNotification = z.infer<typeof sidecarNotificationSchema>;
