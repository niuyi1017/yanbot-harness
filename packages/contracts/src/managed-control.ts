import { z } from 'zod';

const base = { managedProtocolVersion: z.literal(1), launchId: z.uuid() };
export const managedControlMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('hello') }).strict(),
  z
    .object({
      ...base,
      type: z.literal('ready'),
      pid: z.number().int().positive(),
      instanceId: z.uuid(),
      runtimeVersion: z.string().max(80),
      protocolVersion: z.literal('1.0.0'),
    })
    .strict(),
  z.object({ ...base, type: z.literal('shutdown'), requestId: z.uuid() }).strict(),
  z
    .object({
      ...base,
      type: z.literal('shutdown-complete'),
      requestId: z.uuid(),
      pid: z.number().int().positive(),
      instanceId: z.uuid(),
    })
    .strict(),
]);
export type ManagedControlMessage = z.infer<typeof managedControlMessageSchema>;
