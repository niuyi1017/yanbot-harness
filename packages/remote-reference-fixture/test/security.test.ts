import { readFile, stat, writeFile } from 'node:fs/promises';

import type { AdapterEvent } from '@yanbot-harness/contracts';
import { HarnessClient } from '@yanbot-harness/sdk';
import { collectAsync, createTemporaryStateRoot } from '@yanbot-harness/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRemoteReferenceFixture,
  fixtureStatePath,
  RemoteFixturePreparationError,
  RemoteFixtureStateError,
  type RemoteReferenceFixture,
} from '../src/index.js';

const fixtures: RemoteReferenceFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Remote Reference P3.7 safety negatives', () => {
  it('replays persisted events after fixture reconstruction without persisting credentials or cwd', async () => {
    const temporary = await createTemporaryStateRoot('yanbot-remote-durable-');
    cleanups.push(temporary.cleanup);
    const first = await trackedFixture({
      stateRoot: temporary.path,
      scenario: { kind: 'text', chunks: ['durable'] },
    });
    const firstToken = first.issueToken({ tenantId: 'tenant-a', subjectId: 'user-a' });
    const workspace = await first.prepareSnapshot({ tenantId: 'tenant-a' });
    const firstClient = await connect(first, firstToken);
    expect(firstClient.profile().profile.capabilities.eventReplay).toEqual({
      durability: 'durable',
      retentionSeconds: 3_600,
    });
    const session = await firstClient.createSession({ adapterId: 'cn.yanbot.reference' });
    const runInput = { prompt: 'Persistent replay', workspace } as const;
    const handle = await firstClient.createRun(session.sessionId, runInput, { idempotencyKey: 'durable-key' });
    const original = await collectAsync(handle.events());
    expect(original.at(-1)?.type).toBe('run.completed');
    expect(JSON.stringify(original)).not.toContain(firstToken);
    await first.close();
    fixtures.splice(fixtures.indexOf(first), 1);

    const statePath = fixtureStatePath(temporary.path);
    const persisted = await readFile(statePath, 'utf8');
    expect(persisted).not.toContain(firstToken);
    expect(persisted).not.toContain(temporary.path);
    if (process.platform !== 'win32') expect((await stat(statePath)).mode & 0o777).toBe(0o600);

    const second = await trackedFixture({ stateRoot: temporary.path });
    const secondToken = second.issueToken({ tenantId: 'tenant-a', subjectId: 'user-a' });
    const secondClient = await connect(second, secondToken);
    await expect(secondClient.getRun(handle.run.runId)).resolves.toMatchObject({ status: 'completed' });
    const replay = await collectAsync(secondClient.events(handle.run.runId, { afterEventId: original[0]!.eventId }));
    expect(replay).toEqual(original.slice(1));
    const duplicate = await secondClient.createRun(session.sessionId, runInput, { idempotencyKey: 'durable-key' });
    expect(duplicate.reused).toBe(true);
    expect(duplicate.run.runId).toBe(handle.run.runId);
  });

  it('fails closed for unknown or malformed persisted state', async () => {
    const temporary = await createTemporaryStateRoot('yanbot-remote-corrupt-');
    cleanups.push(temporary.cleanup);
    await writeFile(fixtureStatePath(temporary.path), '{"schemaVersion":2,"sessions":[]}', { mode: 0o600 });
    await expect(createRemoteReferenceFixture({ stateRoot: temporary.path })).rejects.toBeInstanceOf(
      RemoteFixtureStateError,
    );
  });

  it('marks a persisted non-terminal run interrupted instead of fabricating execution recovery', async () => {
    const temporary = await createTemporaryStateRoot('yanbot-remote-interrupted-');
    cleanups.push(temporary.cleanup);
    const first = await trackedFixture({ stateRoot: temporary.path, scenario: { kind: 'wait-for-cancel' } });
    const token = first.issueToken({ tenantId: 'tenant-a', subjectId: 'user-a' });
    const workspace = await first.prepareSnapshot({ tenantId: 'tenant-a' });
    const client = await connect(first, token);
    const session = await client.createSession({ adapterId: 'cn.yanbot.reference' });
    const handle = await client.createRun(session.sessionId, { prompt: 'Interrupted persistence', workspace });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const started = await iterator.next();
    expect(started.value?.type).toBe('run.started');
    await iterator.return?.();
    const nonTerminalState = await readFile(fixtureStatePath(temporary.path), 'utf8');
    expect(nonTerminalState).toContain('"run.started"');
    await first.close();
    fixtures.splice(fixtures.indexOf(first), 1);
    await writeFile(fixtureStatePath(temporary.path), nonTerminalState, { mode: 0o600 });

    const second = await trackedFixture({ stateRoot: temporary.path });
    const secondToken = second.issueToken({ tenantId: 'tenant-a', subjectId: 'user-a' });
    const secondClient = await connect(second, secondToken);
    await expect(secondClient.getRun(handle.run.runId)).resolves.toMatchObject({ status: 'interrupted' });
    const replay = await collectAsync(secondClient.events(handle.run.runId));
    expect(replay[0]?.type).toBe('run.started');
    expect(replay.some((event) => event.type === 'run.completed')).toBe(false);
  });

  it('rejects cross-tenant access to every prepared or active resource', async () => {
    const fixture = await trackedFixture({
      scenario: { kind: 'question', prompt: 'Choose?', answerResult: 'answered' },
    });
    const tokenA = fixture.issueToken({ tenantId: 'tenant-a', subjectId: 'user-a' });
    const tokenB = fixture.issueToken({ tenantId: 'tenant-b', subjectId: 'user-b' });
    const workspaceA = await fixture.prepareSnapshot({ tenantId: 'tenant-a' });
    const [clientA, clientB] = await Promise.all([connect(fixture, tokenA), connect(fixture, tokenB)]);
    const sessionA = await clientA.createSession({ adapterId: 'cn.yanbot.reference' });
    const handleA = await clientA.createRun(sessionA.sessionId, {
      prompt: 'Tenant A interaction',
      workspace: workspaceA,
    });
    const iterator = handleA.events()[Symbol.asyncIterator]();
    const requested = await readUntilInteraction(iterator);
    await iterator.return?.();

    await expect(clientB.getSession(sessionA.sessionId)).rejects.toMatchObject(missingResource());
    await expect(clientB.getRun(handleA.run.runId)).rejects.toMatchObject(missingResource());
    await expect(clientB.cancelRun(handleA.run.runId)).rejects.toMatchObject(missingResource());
    await expect(collectAsync(clientB.events(handleA.run.runId))).rejects.toMatchObject(missingResource());
    await expect(
      clientB.respondToInteraction({ requestId: requested.payload.requestId, action: 'deny' }),
    ).rejects.toMatchObject(missingResource());

    const sessionB = await clientB.createSession({ adapterId: 'cn.yanbot.reference' });
    await expect(
      clientB.createRun(sessionB.sessionId, { prompt: 'Foreign workspace', workspace: workspaceA }),
    ).rejects.toMatchObject(missingResource());

    const question = requested.payload.questions[0]!;
    await clientA.respondToInteraction({
      requestId: requested.payload.requestId,
      action: 'submit',
      answers: { [question.id]: 'yes' },
    });
    const remainder = await collectAsync(clientA.events(handleA.run.runId, { afterEventId: requested.eventId }));
    expect(remainder.at(-1)?.type).toBe('run.completed');
  });

  it('reauthenticates every request after an initially valid token expires', async () => {
    let current = new Date('2026-09-20T08:00:00.000Z');
    const fixture = await trackedFixture({ now: () => current });
    const token = fixture.issueToken({
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      expiresAt: new Date(current.getTime() + 1_000),
    });
    const client = await connect(fixture, token);
    await client.createSession({ adapterId: 'cn.yanbot.reference' });
    current = new Date(current.getTime() + 2_000);

    await expect(client.listSessions()).rejects.toMatchObject({
      kind: 'authentication',
      status: 401,
      harnessError: { code: 'AUTHENTICATION_FAILED' },
    });
    const rawFailure = await fixture.fetch(`${fixture.origin}/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rawFailure.status).toBe(401);
    expect(await rawFailure.text()).not.toContain(token);
    expect(JSON.stringify(fixture.auditEntries())).not.toContain(token);
    expect(fixture.auditEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'session.list',
          outcome: 'rejected',
          status: 401,
          errorCode: 'AUTHENTICATION_FAILED',
        }),
      ]),
    );
  });

  it('keeps tokens, bodies, paths, manifest input, and resource IDs out of structured audit entries', async () => {
    const temporary = await createTemporaryStateRoot('yanbot-remote-audit-marker-');
    cleanups.push(temporary.cleanup);
    const fixture = await trackedFixture({ stateRoot: temporary.path, scenario: { kind: 'text', chunks: ['safe'] } });
    const token = fixture.issueToken({ tenantId: 'tenant-a', subjectId: 'user-a' });
    const maliciousPath = '../../audit-secret-path';
    await expect(
      fixture.prepareSnapshot({
        tenantId: 'tenant-a',
        manifest: { schemaVersion: 1, entries: [file(maliciousPath)] },
      }),
    ).rejects.toBeInstanceOf(RemoteFixturePreparationError);
    const workspace = await fixture.prepareSnapshot({ tenantId: 'tenant-a' });
    const client = await connect(fixture, token);
    const session = await client.createSession({ adapterId: 'cn.yanbot.reference' });
    const promptSecret = 'prompt-secret-ck_1234567890123456789012345678901234567890';
    const handle = await client.createRun(session.sessionId, { prompt: promptSecret, workspace });
    await collectAsync(handle.events());
    await fixture.fetch(`${fixture.origin}/v1/unknown/${encodeURIComponent('url-secret-marker')}`, {
      headers: { authorization: `Bearer ${token}` },
    });

    const serialized = JSON.stringify(fixture.auditEntries());
    for (const marker of [
      token,
      `Bearer ${token}`,
      maliciousPath,
      'audit-secret-path',
      promptSecret,
      temporary.path,
      workspace.uploadId,
      workspace.digest,
      session.sessionId,
      handle.run.runId,
      'url-secret-marker',
    ]) {
      expect(serialized).not.toContain(marker);
    }
    expect(fixture.auditEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'workspace.prepare', outcome: 'rejected', status: 400 }),
        expect.objectContaining({ action: 'workspace.prepare', outcome: 'succeeded', status: 201 }),
        expect.objectContaining({ action: 'runtime.health', outcome: 'succeeded', status: 200 }),
        expect.objectContaining({ action: 'run.create', outcome: 'succeeded', status: 202 }),
        expect.objectContaining({ action: 'run.events', outcome: 'succeeded', status: 200 }),
        expect.objectContaining({ action: 'route.unknown', outcome: 'rejected', status: 404 }),
      ]),
    );
    for (const entry of fixture.auditEntries()) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.errorCode === undefined
          ? ['action', 'outcome', 'requestId', 'status', 'timestamp']
          : ['action', 'errorCode', 'outcome', 'requestId', 'status', 'timestamp'],
      );
    }
  });
});

async function trackedFixture(options: Parameters<typeof createRemoteReferenceFixture>[0] = {}) {
  const fixture = await createRemoteReferenceFixture(options);
  fixtures.push(fixture);
  return fixture;
}

function connect(fixture: RemoteReferenceFixture, accessToken: string) {
  return HarnessClient.connect({
    mode: 'remote',
    origin: fixture.origin,
    tokenProvider: async () => ({ accessToken }),
    fetch: fixture.fetch,
  });
}

async function readUntilInteraction(
  iterator: AsyncIterator<AdapterEvent>,
): Promise<Extract<AdapterEvent, { type: 'interaction.requested' }>> {
  while (true) {
    const item = await iterator.next();
    if (item.done) throw new Error('The run ended before requesting interaction.');
    if (item.value.type === 'interaction.requested') return item.value;
  }
}

function missingResource() {
  return { status: 404, harnessError: { code: 'HARNESS_FAILED' } };
}

function file(relativePath: string) {
  return { path: relativePath, type: 'file' as const, size: 0, sha256: '0'.repeat(64), executable: false };
}
