import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  CHECKSUM_FILE,
  fileSha256,
  formatChecksums,
  inventoryFiles,
  validateArchiveEntries,
} from './lib/internal-delivery.mjs';
import { createZipArchive } from './lib/release-platform.mjs';

const execute = promisify(execFile);
const args = process.argv.slice(2).filter((item) => item !== '--');
assert(
  args.length === 6 && args[0] === '--common' && args[2] === '--platform' && args[4] === '--output-dir',
  'Use --common COMMON_DIRECTORY --platform PLATFORM_BUILD_DIRECTORY --output-dir OUTPUT_DIRECTORY.',
);
const commonRoot = path.resolve(args[1]);
const platformRoot = path.resolve(args[3]);
const outputRoot = path.resolve(args[5]);
const common = JSON.parse(await readFile(path.join(commonRoot, 'common-manifest.json'), 'utf8'));
const platform = JSON.parse(await readFile(path.join(platformRoot, 'build-report.json'), 'utf8'));
assert.equal(platform.status, 'passed');
assert.equal(platform.target.os, 'darwin');
assert.equal(platform.target.cpu, 'arm64');
assert.equal(platform.target.libc, null);
assert.equal(platform.testSigning, true, 'Internal delivery requires an explicitly test-signed platform input.');
assert.equal(platform.publishAuthorized, false, 'Internal delivery cannot use a production-authorized input.');
assert.equal(common.version, platform.version);
assert.equal(common.sourceCommit, platform.sourceCommit);
assert.equal(common.sourceLockSha256, platform.sourceLockSha256);
assert(/^[a-f0-9]{40}$/u.test(common.sourceCommit));
assert(/^[a-f0-9]{64}$/u.test(common.sourceLockSha256));

await mkdir(outputRoot, { recursive: true });
const name = `yanbot-harness-${common.version}-darwin-arm64-internal-test`;
const archive = path.join(outputRoot, name + '.zip');
try {
  await lstat(archive);
  assert.fail('Output archive already exists.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const temporary = await mkdtemp(path.join(tmpdir(), 'harness-internal-delivery-'));
try {
  const kitResult = JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(import.meta.dirname, 'build-offline-kit.mjs'), '--common', commonRoot, '--platform', platformRoot],
        { timeout: 120000, maxBuffer: 1024 * 1024 },
      )
    ).stdout,
  );
  assert.equal(kitResult.productionRelease, false);
  assert(typeof kitResult.externalTestTrust === 'string');
  const root = path.join(temporary, name);
  await mkdir(root);
  await cp(kitResult.directory, path.join(root, 'offline-kit'), { recursive: true, errorOnExist: true, force: false });
  await cp(kitResult.externalTestTrust, path.join(root, 'internal-test-trust.json'), {
    errorOnExist: true,
    force: false,
  });
  await cp(path.join(import.meta.dirname, 'templates/internal-delivery-install.mjs'), path.join(root, 'install.mjs'), {
    errorOnExist: true,
    force: false,
  });
  const kitManifestFile = path.join(root, 'offline-kit/kit-manifest.json');
  const kitManifest = JSON.parse(await readFile(kitManifestFile, 'utf8'));
  assert.equal(kitManifest.version, common.version);
  assert.equal(kitManifest.sourceCommit, common.sourceCommit);
  assert.equal(kitManifest.target, 'darwin-arm64');
  assert.equal(kitManifest.testSigning, true);
  assert(kitManifest.artifacts.some((item) => item.name === '@yanbot-harness/local'));
  const manifest = {
    schemaVersion: 1,
    kind: 'yanbot-harness-internal-test-delivery',
    version: common.version,
    target: 'darwin-arm64',
    sourceCommit: common.sourceCommit,
    sourceLockSha256: common.sourceLockSha256,
    rootPackage: '@yanbot-harness/local',
    testSigning: true,
    productionAuthorized: false,
    requirements: { node: '>=22.22.0 <23', npm: '10.9.8' },
    offlineKit: {
      manifestSha256: await fileSha256(kitManifestFile),
      signatureSha256: await fileSha256(path.join(root, 'offline-kit/kit-manifest.sig')),
      packageCount: kitManifest.artifacts.length,
    },
  };
  await writeFile(path.join(root, 'delivery-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const readme = `# Yanbot Harness ${common.version} Apple Silicon Mac 内测包

这是一个测试签名、完全离线的内部候选，不是正式生产发布。它只支持 macOS arm64（Apple Silicon），要求 Node >=22.22.0 <23 和 npm 10.9.8。

## 安装

在本目录打开终端，执行：

\`\`\`bash
shasum -a 256 -c SHA256SUMS
node install.mjs
\`\`\`

默认安装到当前目录下的 \`yanbot-harness-local-consumer\`；也可指定一个尚不存在的目录：

\`\`\`bash
node install.mjs --prefix "/绝对路径/新的测试目录"
\`\`\`

安装器在空 npm cache、禁用外网和禁用安装脚本的条件下安装完整离线闭包，并自动运行 Reference smoke。成功输出包含 \`"terminal":"run.completed"\`。

业务代码只需从统一入口导入：

\`\`\`js
import { startManagedRuntime } from '@yanbot-harness/local';
\`\`\`

ZIP 内的多个 tgz 是 \`@yanbot-harness/local\` 的离线依赖闭包，不是需要分别交付或手工安装的产品包。请勿把 \`internal-test-trust.json\` 当作生产信任根，也不要将本候选用于生产环境。Windows、Linux 和 Intel Mac 需要各自重新构建的平台交付物。

源提交：\`${common.sourceCommit}\`
`;
  await writeFile(path.join(root, 'README.zh-CN.md'), readme, { flag: 'wx' });
  const inventory = await inventoryFiles(root);
  await writeFile(path.join(root, CHECKSUM_FILE), formatChecksums(inventory), { flag: 'wx' });
  await createZipArchive(root, archive);
  const listed = (
    await execute('/usr/bin/unzip', ['-Z1', archive], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
  ).stdout
    .trimEnd()
    .split('\n');
  validateArchiveEntries(listed, name);
  console.log(
    JSON.stringify({
      status: 'passed',
      archive,
      name,
      version: common.version,
      target: 'darwin-arm64',
      sourceCommit: common.sourceCommit,
      rootPackage: '@yanbot-harness/local',
      packageCount: kitManifest.artifacts.length,
      size: (await lstat(archive)).size,
      sha256: await fileSha256(archive),
      productionAuthorized: false,
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
