import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256 } from '../packages/runtime/lib/archive.mjs';
import { manifestBytes } from '../packages/runtime/lib/manifest.mjs';

const args = process.argv.slice(2).filter((item) => item !== '--');
assert(
  args.length === 4 && args[0] === '--common' && args[2] === '--platform',
  'Use --common COMMON_DIRECTORY --platform PLATFORM_BUILD_DIRECTORY.',
);
const commonRoot = path.resolve(args[1]);
const platformRoot = path.resolve(args[3]);
const common = JSON.parse(await readFile(path.join(commonRoot, 'common-manifest.json'), 'utf8'));
const platform = JSON.parse(await readFile(path.join(platformRoot, 'build-report.json'), 'utf8'));
assert.equal(platform.status, 'passed');
assert.equal(common.version, platform.version);
assert.equal(common.sourceCommit, platform.sourceCommit, 'Common and platform source commits must match.');
assert.equal(common.sourceLockSha256, platform.sourceLockSha256, 'Common and platform locks must match.');
const root = await mkdtemp(path.join(tmpdir(), 'harness-offline-kit-'));
await mkdir(path.join(root, 'packages'));
const artifacts = [
  ...common.artifacts,
  {
    name: platform.manifest.packageName,
    version: platform.version,
    ...platform.artifact,
  },
];
for (const artifact of artifacts) {
  const source =
    artifact === artifacts.at(-1)
      ? path.join(platformRoot, artifact.file)
      : path.join(commonRoot, 'packages', artifact.file);
  const content = await readFile(source);
  assert(content.length === artifact.size && sha256(content) === artifact.sha256, 'Input artifact changed.');
  assert(/^[A-Za-z0-9._-]+\.tgz$/u.test(artifact.file));
  await copyFile(source, path.join(root, 'packages', artifact.file));
}
const installerFile = 'install-local.mjs';
const installerBytes = await readFile(path.join(import.meta.dirname, 'templates', installerFile));
await writeFile(path.join(root, installerFile), installerBytes, { flag: 'wx' });
let key;
let keyId;
let trustedKeys = {};
if (platform.testSigning) {
  key = generateKeyPairSync('ed25519').privateKey;
  keyId = 'offline-kit-test-only';
  trustedKeys = JSON.parse(await readFile(path.join(platformRoot, 'test-trust.json'), 'utf8'));
} else {
  assert(
    process.env.HARNESS_RELEASE_KEY_FILE && process.env.HARNESS_RELEASE_KEY_ID,
    'Authorized release signer required.',
  );
  key = createPrivateKey(await readFile(process.env.HARNESS_RELEASE_KEY_FILE));
  keyId = process.env.HARNESS_RELEASE_KEY_ID;
}
assert.equal(key.asymmetricKeyType, 'ed25519');
const manifest = {
  schemaVersion: 1,
  version: common.version,
  sourceCommit: common.sourceCommit,
  sourceLockSha256: common.sourceLockSha256,
  target: platform.target.os + '-' + platform.target.cpu,
  keyId,
  testSigning: platform.testSigning,
  installer: { file: installerFile, size: installerBytes.length, sha256: sha256(installerBytes) },
  artifacts,
};
const bytes = manifestBytes(manifest);
await writeFile(path.join(root, 'kit-manifest.json'), bytes, { flag: 'wx' });
await writeFile(path.join(root, 'kit-manifest.sig'), sign(null, bytes, key), { flag: 'wx' });
if (platform.testSigning) {
  // Outside the kit: this is a testing convenience, never an in-kit self-authenticating root.
  const externalTrust = root + '-test-trust.json';
  trustedKeys[keyId] = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  await writeFile(externalTrust, manifestBytes(trustedKeys), { flag: 'wx' });
  console.log(JSON.stringify({ directory: root, externalTestTrust: externalTrust, productionRelease: false }));
} else console.log(JSON.stringify({ directory: root, productionRelease: false }));
