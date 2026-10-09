import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { GuestCheckpointChannel, HostCheckpointChannel } from '../src/state.js';

describe('Private session checkpoint channel', () => {
  it('waits for durable save, removes state from public output and rejects duplicate saves', async () => {
    let saved: unknown;
    let publicOutput = '';
    const host = new HostCheckpointChannel(
      async (snapshot) => {
        saved = snapshot;
      },
      async (frame) => guest.accept(frame),
    );
    host.on('data', (chunk) => {
      publicOutput += String(chunk);
    });
    const guest = new GuestCheckpointChannel(async (frame) => {
      host.write(`${JSON.stringify(frame)}\n`);
    });
    await guest.save({ manifest: {}, files: [] });
    expect(saved).toEqual({ manifest: {}, files: [] });
    expect(publicOutput).toBe('');
    host.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(publicOutput).toContain('jsonrpc');
    await expect(guest.save({})).rejects.toThrow('already');
    host.end();
  });

  it('propagates failed persistence and rejects forged state frames', async () => {
    const host = new HostCheckpointChannel(
      async () => {
        throw new Error('private storage error');
      },
      async (frame) => guest.accept(frame),
    );
    host.resume();
    const guest = new GuestCheckpointChannel(async (frame) => {
      host.write(`${JSON.stringify(frame)}\n`);
    });
    await expect(guest.save({})).rejects.toThrow('Checkpoint save failed');
    const error = once(host, 'error');
    host.write('{"method":"state.invalid"}\n');
    expect((await error)[0].message).toBe('Invalid checkpoint channel frame.');
  });

  it('cancels acknowledgement waits on close', async () => {
    const guest = new GuestCheckpointChannel(async () => undefined);
    const pending = guest.save({});
    guest.close();
    await expect(pending).rejects.toThrow('closed');
  });
});
