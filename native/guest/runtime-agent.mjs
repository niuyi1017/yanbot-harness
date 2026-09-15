import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';

// Runs only in the private VM. Bootstrap is reachable through the owner's private vsock transport only.
let initialized = false;
let descriptor;
let runtime;
const allowed = new Set([
  'CODEBUDDY_API_KEY',
  'CODEBUDDY_INTERNET_ENVIRONMENT',
  'CODEBUDDY_BASE_URL',
  'YANBOT_HARNESS_REFERENCE_SCENARIO',
]);
const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.url === '/__harness/bootstrap' && incoming.method === 'POST' && !initialized) {
      initialized = true; // A malformed bootstrap poisons this instance, never races another launch.
      let body = Buffer.alloc(0);
      for await (const chunk of incoming) {
        body = Buffer.concat([body, chunk]);
        if (body.length > 65536) throw new Error();
      }
      const options = JSON.parse(body.toString());
      if (
        Object.keys(options).sort().join(',') !== 'environment,reference' ||
        typeof options.reference !== 'boolean' ||
        !options.environment ||
        Array.isArray(options.environment) ||
        typeof options.environment !== 'object'
      )
        throw new Error();
      for (const [key, value] of Object.entries(options.environment))
        if (!allowed.has(key) || typeof value !== 'string' || value.length > 16384 || value.includes('\0'))
          throw new Error();
      const state = (await stat('/harness-shares/state').catch(() => undefined))?.isDirectory()
        ? '/harness-shares/state'
        : '/harness-state';
      await mkdir(state, { recursive: true, mode: 0o700 });
      runtime = fork('/harness/runtime/dist/main.js', options.reference ? ['--reference'] : [], {
        env: {
          PATH: '/harness/bin:/bin:/sbin:/usr/bin',
          HOME: '/harness-home',
          ...options.environment,
          YANBOT_HARNESS_STATE_DIR: state,
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        detached: true,
      });
      runtime.once('exit', () => process.exit(1)); // PID 1 stops the entire VM, including detached descendants.
      const launchId = randomUUID();
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error()), 15000);
        runtime.once('error', reject);
        runtime.once('message', (message) => {
          clearTimeout(timer);
          if (message.type !== 'ready' || message.launchId !== launchId || message.pid !== runtime.pid)
            reject(new Error());
          else resolve(message);
        });
        runtime.send({ type: 'hello', managedProtocolVersion: 1, launchId });
      });
      descriptor = JSON.parse(await readFile(state + '/runtime.json', 'utf8'));
      if (
        descriptor.pid !== runtime.pid ||
        descriptor.instanceId !== ready.instanceId ||
        !/^http:\/\/127\.0\.0\.1:\d+$/u.test(descriptor.origin)
      )
        throw new Error();
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(
        JSON.stringify({ descriptor, runtimeVersion: ready.runtimeVersion, protocolVersion: ready.protocolVersion }),
      );
      return;
    }
    if (!descriptor || !incoming.url?.startsWith('/local/')) {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    const target = new URL(incoming.url, descriptor.origin);
    if (target.origin !== descriptor.origin) throw new Error();
    const proxy = request(target, { method: incoming.method, headers: incoming.headers }, (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
      outgoing.once('close', () => response.destroy());
    });
    proxy.once('error', () => outgoing.destroy());
    incoming.once('aborted', () => proxy.destroy());
    outgoing.once('close', () => proxy.destroy());
    incoming.pipe(proxy);
  } catch {
    outgoing.writeHead(500);
    outgoing.end();
    if (!descriptor) setTimeout(() => process.exit(1), 100);
  }
});
server.maxConnections = 64;
server.headersTimeout = 10000;
server.requestTimeout = 30000;
server.listen(3100, '127.0.0.1', () => process.stdout.write('HARNESS_GUEST_READY\n'));
