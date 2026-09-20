#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SCENARIOS, TARGETS, writeJsonAtomic } from './lib/dual-runtime-evidence.mjs';

const expectedScenarioIds = SCENARIOS.map((scenario) => scenario.id);
const expectedTargets = Object.keys(TARGETS).sort();

export function aggregatePlatformEvidence(reports) {
  if (!Array.isArray(reports) || reports.length !== expectedTargets.length) {
    throw new Error(`Expected exactly ${expectedTargets.length} platform reports.`);
  }
  const validated = reports.map(validatePlatformReport);
  const actualTargets = validated.map((report) => report.runner.target).sort();
  if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) {
    throw new Error(`Expected targets ${expectedTargets.join(', ')}; received ${actualTargets.join(', ')}.`);
  }
  const commits = new Set(validated.map((report) => report.source.commit));
  if (commits.size !== 1) throw new Error('Platform reports must reference the same source commit.');
  const versions = new Set(validated.map((report) => `${report.versions.release}\0${report.versions.protocol}`));
  if (versions.size !== 1) throw new Error('Platform reports must reference the same release and protocol versions.');
  return {
    schemaVersion: 1,
    evidenceKind: 'dual-runtime-matrix',
    sourceCommit: validated[0].source.commit,
    versions: { ...validated[0].versions },
    targets: validated
      .sort((left, right) => left.runner.target.localeCompare(right.runner.target))
      .map((report) => ({
        target: report.runner.target,
        platform: report.runner.platform,
        arch: report.runner.arch,
        node: report.runner.node,
        sourceDirty: report.source.dirty,
        localReference: summarizeRuntime(report.runtimes[0]),
        remoteReferenceFixture: summarizeRuntime(report.runtimes[1]),
      })),
    remoteService: { status: 'not-run', reason: 'formal-remote-service-not-implemented' },
    status: 'incomplete',
  };
}

export function validatePlatformReport(report) {
  assertRecord(report, 'report');
  assertExactKeys(report, [
    'schemaVersion',
    'evidenceKind',
    'source',
    'generatedAt',
    'runner',
    'versions',
    'runtimes',
    'remoteService',
    'status',
  ]);
  assertEqual(report.schemaVersion, 1, 'schemaVersion');
  assertEqual(report.evidenceKind, 'dual-runtime-platform', 'evidenceKind');
  assertEqual(report.status, 'passed', 'status');
  if (!Number.isFinite(Date.parse(report.generatedAt))) throw new Error('generatedAt must be an ISO timestamp.');

  assertRecord(report.source, 'source');
  assertExactKeys(report.source, ['commit', 'dirty']);
  if (!/^[0-9a-f]{40}$/u.test(report.source.commit)) throw new Error('source.commit must be a full Git commit.');
  if (typeof report.source.dirty !== 'boolean') throw new Error('source.dirty must be boolean.');

  assertRecord(report.runner, 'runner');
  assertExactKeys(report.runner, ['target', 'platform', 'arch', 'node']);
  const target = TARGETS[report.runner.target];
  if (!target) throw new Error(`Unknown runner target: ${String(report.runner.target)}`);
  assertEqual(report.runner.platform, target.platform, 'runner.platform');
  assertEqual(report.runner.arch, target.arch, 'runner.arch');
  if (!/^v22\./u.test(report.runner.node)) throw new Error('runner.node must identify Node 22.');

  assertRecord(report.versions, 'versions');
  assertExactKeys(report.versions, ['release', 'protocol']);
  if (typeof report.versions.release !== 'string' || typeof report.versions.protocol !== 'string') {
    throw new Error('versions must contain string release and protocol values.');
  }

  if (!Array.isArray(report.runtimes) || report.runtimes.length !== 2) {
    throw new Error('runtimes must contain Local Reference and Remote Reference Fixture exactly once.');
  }
  validateRuntime(report.runtimes[0], {
    runtimeKind: 'local-reference',
    executionMode: 'local',
    transport: 'loopback-http-sse',
  });
  validateRuntime(report.runtimes[1], {
    runtimeKind: 'remote-reference-fixture',
    executionMode: 'remote',
    transport: 'injected-fetch',
  });

  assertRecord(report.remoteService, 'remoteService');
  assertExactKeys(report.remoteService, ['status', 'reason']);
  assertEqual(report.remoteService.status, 'not-run', 'remoteService.status');
  assertEqual(report.remoteService.reason, 'formal-remote-service-not-implemented', 'remoteService.reason');
  return report;
}

async function main() {
  const [output, ...files] = process.argv.slice(2);
  if (!output || files.length === 0) {
    throw new Error('Use aggregate-dual-runtime-matrix.mjs <output.json> <platform-report...>.');
  }
  const reports = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.resolve(file), 'utf8'))));
  const result = aggregatePlatformEvidence(reports);
  await writeJsonAtomic(output, result);
  process.stdout.write(`${JSON.stringify({ output: path.resolve(output), status: result.status })}\n`);
}

function validateRuntime(runtime, identity) {
  assertRecord(runtime, identity.runtimeKind);
  assertExactKeys(runtime, ['runtimeKind', 'executionMode', 'transport', 'serviceEvidence', 'scenarios', 'status']);
  assertEqual(runtime.runtimeKind, identity.runtimeKind, 'runtimeKind');
  assertEqual(runtime.executionMode, identity.executionMode, `${identity.runtimeKind}.executionMode`);
  assertEqual(runtime.transport, identity.transport, `${identity.runtimeKind}.transport`);
  assertEqual(runtime.serviceEvidence, false, `${identity.runtimeKind}.serviceEvidence`);
  assertEqual(runtime.status, 'passed', `${identity.runtimeKind}.status`);
  if (!Array.isArray(runtime.scenarios) || runtime.scenarios.length !== expectedScenarioIds.length) {
    throw new Error(`${identity.runtimeKind} must contain all conformance scenarios.`);
  }
  const ids = runtime.scenarios.map((scenario) => {
    assertRecord(scenario, 'scenario');
    assertExactKeys(scenario, ['id', 'status', 'durationMs']);
    assertEqual(scenario.status, 'passed', `${identity.runtimeKind}.${String(scenario.id)}.status`);
    if (!Number.isInteger(scenario.durationMs) || scenario.durationMs < 0) {
      throw new Error('scenario.durationMs must be a non-negative integer.');
    }
    return scenario.id;
  });
  if (JSON.stringify(ids) !== JSON.stringify(expectedScenarioIds)) {
    throw new Error(`${identity.runtimeKind} scenarios must be complete, unique and ordered.`);
  }
}

function summarizeRuntime(runtime) {
  return {
    status: runtime.status,
    transport: runtime.transport,
    serviceEvidence: runtime.serviceEvidence,
    scenarios: runtime.scenarios.map(({ id, status, durationMs }) => ({ id, status, durationMs })),
  };
}

function assertRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
}

function assertExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected fields: expected ${expected.join(', ')}; received ${actual.join(', ')}.`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} must be ${String(expected)}.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
