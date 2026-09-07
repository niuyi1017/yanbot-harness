import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'yanbot_harness_local';
const DEFAULT_TTL_MS = 12 * 60 * 60_000;

type SecretRecord = {
  secretHash: Buffer;
  origin: string;
  expiresAt: number;
};

export type LocalAuthOptions = {
  accessToken?: string;
  allowedOrigins?: readonly string[];
  now?: () => number;
  generateId?: () => string;
  generateSecret?: () => string;
  accessTokenTtlMs?: number;
};

export type LocalAuthRequest = {
  authorization?: string;
  cookie?: string;
  origin?: string;
};

export type LocalAuthPrincipal = { kind: 'bearer' } | { kind: 'browser'; origin: string };

export class LocalAuthError extends Error {
  readonly code: 'UNAUTHORIZED' | 'FORBIDDEN';

  constructor(code: LocalAuthError['code'], message: string) {
    super(message);
    this.name = 'LocalAuthError';
    this.code = code;
  }
}

export class LocalAuthManager {
  readonly #accessToken: string;
  readonly #accessTokenHash: Buffer;
  readonly #accessTokenExpiresAt: number;
  readonly #allowedOrigins: Set<string>;
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #generateSecret: () => string;
  readonly #bindings = new Map<string, SecretRecord>();
  readonly #browserSessions = new Map<string, SecretRecord>();

  constructor(options: LocalAuthOptions = {}) {
    const now = options.now ?? Date.now;
    this.#now = now;
    this.#generateId = options.generateId ?? randomUUID;
    this.#generateSecret = options.generateSecret ?? (() => randomBytes(32).toString('base64url'));
    this.#accessToken = options.accessToken ?? this.#generateSecret();
    this.#accessTokenHash = hashSecret(this.#accessToken);
    this.#accessTokenExpiresAt = now() + (options.accessTokenTtlMs ?? DEFAULT_TTL_MS);
    this.#allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin));
  }

  getAccessToken(): string {
    return this.#accessToken;
  }

  authenticate(request: LocalAuthRequest): LocalAuthPrincipal {
    const bearer = parseBearer(request.authorization);
    if (bearer && this.#now() < this.#accessTokenExpiresAt && secretMatches(bearer, this.#accessTokenHash)) {
      if (request.origin !== undefined && !this.#allowedOrigins.has(normalizeOrigin(request.origin))) {
        throw new LocalAuthError('FORBIDDEN', 'The request origin is not allowed.');
      }
      return { kind: 'bearer' };
    }

    const cookieToken = parseCookies(request.cookie)[COOKIE_NAME];
    const [sessionId, secret] = splitOpaqueToken(cookieToken);
    const session = sessionId ? this.#browserSessions.get(sessionId) : undefined;
    if (!session || !secret || this.#now() >= session.expiresAt || !secretMatches(secret, session.secretHash)) {
      throw new LocalAuthError('UNAUTHORIZED', 'Local runtime authentication is required.');
    }
    if (request.origin === undefined || normalizeOrigin(request.origin) !== session.origin) {
      throw new LocalAuthError('FORBIDDEN', 'The browser session origin does not match the request.');
    }
    return { kind: 'browser', origin: session.origin };
  }

  issueBrowserBinding(origin: string, ttlMs = 60_000): { token: string; origin: string; expiresAt: string } {
    const normalized = normalizeOrigin(origin);
    const bindingId = this.#generateId();
    const secret = this.#generateSecret();
    const expiresAt = this.#now() + boundedTtl(ttlMs, 1_000, 5 * 60_000);
    this.#bindings.set(bindingId, { secretHash: hashSecret(secret), origin: normalized, expiresAt });
    return { token: `${bindingId}.${secret}`, origin: normalized, expiresAt: new Date(expiresAt).toISOString() };
  }

  exchangeBrowserBinding(token: string, origin: string): { cookie: string; cookieValue: string; expiresAt: string } {
    const normalized = normalizeOrigin(origin);
    const [bindingId, secret] = splitOpaqueToken(token);
    if (!bindingId || !secret) {
      throw new LocalAuthError('UNAUTHORIZED', 'The browser binding is invalid, expired, or already used.');
    }
    const binding = this.#bindings.get(bindingId);
    if (!binding || this.#now() >= binding.expiresAt || !secretMatches(secret, binding.secretHash)) {
      throw new LocalAuthError('UNAUTHORIZED', 'The browser binding is invalid, expired, or already used.');
    }
    if (binding.origin !== normalized)
      throw new LocalAuthError('FORBIDDEN', 'The browser binding origin does not match.');
    this.#bindings.delete(bindingId);

    const sessionId = this.#generateId();
    const sessionSecret = this.#generateSecret();
    const expiresAt = Math.min(this.#accessTokenExpiresAt, this.#now() + DEFAULT_TTL_MS);
    this.#browserSessions.set(sessionId, {
      secretHash: hashSecret(sessionSecret),
      origin: normalized,
      expiresAt,
    });
    const cookieValue = `${sessionId}.${sessionSecret}`;
    return {
      cookieValue,
      cookie: `${COOKIE_NAME}=${encodeURIComponent(cookieValue)}; Path=/local; HttpOnly; SameSite=Strict; Max-Age=${Math.max(
        0,
        Math.floor((expiresAt - this.#now()) / 1_000),
      )}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value.replace(/\/$/, ''))
      throw new Error();
    return url.origin;
  } catch {
    throw new LocalAuthError('FORBIDDEN', 'The request origin is invalid.');
  }
}

function parseBearer(value: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/i.exec(value ?? '');
  return match?.[1];
}

function parseCookies(value: string | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    value.split(';').map((part) => {
      const separator = part.indexOf('=');
      if (separator < 0) return [part.trim(), ''];
      const key = part.slice(0, separator).trim();
      try {
        return [key, decodeURIComponent(part.slice(separator + 1).trim())];
      } catch {
        return [key, ''];
      }
    }),
  );
}

function splitOpaqueToken(token: string | undefined): [string | undefined, string | undefined] {
  if (!token) return [undefined, undefined];
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1 || token.indexOf('.', separator + 1) >= 0) {
    return [undefined, undefined];
  }
  return [token.slice(0, separator), token.slice(separator + 1)];
}

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function secretMatches(value: string, expected: Buffer): boolean {
  const actual = hashSecret(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function boundedTtl(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
