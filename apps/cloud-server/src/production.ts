import { isIP } from 'node:net';

/** Validate transport policy without returning or reflecting credentials. */
export function assertProductionMongo(uri: string): void {
  const match = /^(mongodb(?:\+srv)?):\/\/([^/@]+)@([^/?]+)(?:\/[^?]*)?(?:\?(.*))?$/u.exec(uri);
  if (!match || !/^[^:]+:.+$/u.test(match[2]!))
    throw new Error('Production Mongo requires authenticated TLS replica-set configuration.');
  const options = new URLSearchParams(match[4] ?? '');
  const normalized = new Map<string, string>();
  for (const [key, value] of options) {
    const lower = key.toLowerCase();
    if (normalized.has(lower)) throw new Error('Duplicate Mongo transport options.');
    normalized.set(lower, value.toLowerCase());
  }
  const tls = normalized.get('tls') ?? normalized.get('ssl');
  if (
    (match[1] !== 'mongodb+srv' && tls !== 'true') ||
    tls === 'false' ||
    normalized.get('ssl') === 'false' ||
    normalized.get('tls') === 'false' ||
    (match[1] === 'mongodb' && !normalized.get('replicaset')) ||
    ['tlsinsecure', 'tlsallowinvalidcertificates', 'tlsallowinvalidhostnames'].some(
      (name) => normalized.has(name) && normalized.get(name) !== 'false',
    )
  )
    throw new Error('Production Mongo requires verified TLS and a replica set.');
}

export function productionProxyCidrs(host: string, value: string | undefined): string[] {
  if (!value) {
    if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return ['127.0.0.1/32', '::1/128'];
    throw new Error('Non-loopback production bindings require explicit trusted proxy CIDRs.');
  }
  const cidrs = value.split(',').map((part) => part.trim());
  if (cidrs.length > 32 || new Set(cidrs).size !== cidrs.length) throw new Error('Invalid trusted proxy CIDRs.');
  for (const cidr of cidrs) {
    const [address, prefix, extra] = cidr.split('/');
    const version = isIP(address ?? '');
    if (
      !version ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/u.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)))
    )
      throw new Error('Invalid trusted proxy CIDRs.');
  }
  return cidrs;
}
