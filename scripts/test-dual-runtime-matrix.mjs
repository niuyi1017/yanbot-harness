import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

import { aggregatePlatformEvidence, validatePlatformReport } from './aggregate-dual-runtime-matrix.mjs';

const commit = 'a'.repeat(40);
const scenarioIds = ['discovery-resources', 'run-idempotency', 'interaction-replay', 'cancellation'];

test('aggregates distinct macOS and Windows reports without promoting fixture evidence', () => {
  const result = aggregatePlatformEvidence([report('darwin-arm64'), report('win32-x64')]);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.sourceCommit, commit);
  assert.deepEqual(result.versions, { release: '0.1.0-preview.3', protocol: '1.0.0' });
  assert.deepEqual(
    result.targets.map((target) => target.target),
    ['darwin-arm64', 'win32-x64'],
  );
  assert.ok(result.targets.every((target) => target.remoteReferenceFixture.serviceEvidence === false));
  assert.deepEqual(result.remoteService, {
    status: 'not-run',
    reason: 'formal-remote-service-not-implemented',
  });
});

test('rejects missing, duplicate and mixed-commit targets', () => {
  assert.throws(() => aggregatePlatformEvidence([report('darwin-arm64')]), /exactly 2/u);
  assert.throws(() => aggregatePlatformEvidence([report('darwin-arm64'), report('darwin-arm64')]), /Expected targets/u);
  const windows = report('win32-x64');
  windows.source.commit = 'b'.repeat(40);
  assert.throws(() => aggregatePlatformEvidence([report('darwin-arm64'), windows]), /same source commit/u);

  const otherVersion = report('win32-x64');
  otherVersion.versions.protocol = '1.1.0';
  assert.throws(() => aggregatePlatformEvidence([report('darwin-arm64'), otherVersion]), /same release/u);
});

test('rejects runner mismatch, failed scenarios and fixture service promotion', () => {
  const wrongRunner = report('darwin-arm64');
  wrongRunner.runner.arch = 'x64';
  assert.throws(() => validatePlatformReport(wrongRunner), /runner.arch/u);

  const failed = report('darwin-arm64');
  failed.runtimes[0].scenarios[0].status = 'failed';
  assert.throws(() => validatePlatformReport(failed), /status must be passed/u);

  const promoted = report('darwin-arm64');
  promoted.runtimes[1].serviceEvidence = true;
  assert.throws(() => validatePlatformReport(promoted), /serviceEvidence must be false/u);
});

test('workflow binds the two targets to independent native runners', async () => {
  const workflow = await readFile(new URL('../.github/workflows/dual-runtime-matrix.yml', import.meta.url), 'utf8');
  assert.match(workflow, /runner: macos-15\s+target: darwin-arm64/u);
  assert.match(workflow, /runner: windows-2022\s+target: win32-x64/u);
  assert.match(workflow, /dual-runtime-evidence-\$\{\{ matrix\.target \}\}/u);
  assert.doesNotMatch(workflow, /secrets\./u);
});

function report(target) {
  const platform = target === 'darwin-arm64' ? 'darwin' : 'win32';
  const arch = target === 'darwin-arm64' ? 'arm64' : 'x64';
  return {
    schemaVersion: 1,
    evidenceKind: 'dual-runtime-platform',
    source: { commit, dirty: false },
    generatedAt: '2026-09-20T00:00:00.000Z',
    runner: { target, platform, arch, node: 'v22.22.0' },
    versions: { release: '0.1.0-preview.3', protocol: '1.0.0' },
    runtimes: [
      runtime('local-reference', 'local', 'loopback-http-sse'),
      runtime('remote-reference-fixture', 'remote', 'injected-fetch'),
    ],
    remoteService: { status: 'not-run', reason: 'formal-remote-service-not-implemented' },
    status: 'passed',
  };
}

function runtime(runtimeKind, executionMode, transport) {
  return {
    runtimeKind,
    executionMode,
    transport,
    serviceEvidence: false,
    scenarios: scenarioIds.map((id) => ({ id, status: 'passed', durationMs: 1 })),
    status: 'passed',
  };
}
