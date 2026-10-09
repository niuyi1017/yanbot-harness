import { z } from 'zod';
export const REQUEST_LIMIT = 256 * 1024;
export const RESPONSE_LIMIT = 8 * 1024 * 1024;
export const CHUNK_LIMIT = 32 * 1024;
export const TIMEOUT_MS = 35_000;
const id = z.string().uuid();
export const guestFrame = z.discriminatedUnion('method', [
  z.object({ method: z.literal('model.request'), id, body: z.unknown() }).strict(),
  z.object({ method: z.literal('model.ack'), id, sequence: z.number().int().nonnegative() }).strict(),
  z.object({ method: z.literal('model.cancel'), id }).strict(),
]);
export const responseFrame = z
  .object({
    method: z.literal('model.response'),
    id,
    sequence: z.number().int().nonnegative(),
    contentType: z.enum(['application/json', 'text/event-stream']).optional(),
    data: z
      .string()
      .max(Math.ceil(CHUNK_LIMIT / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .optional(),
    end: z.literal(true).optional(),
    failed: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => [v.contentType, v.data, v.end, v.failed].filter((x) => x !== undefined).length === 1);
export type ResponseFrame = z.infer<typeof responseFrame>;
export type ModelRequest = (body: unknown, signal: AbortSignal) => Promise<Response>;
export type SendFrame = (frame: unknown) => Promise<void>;
