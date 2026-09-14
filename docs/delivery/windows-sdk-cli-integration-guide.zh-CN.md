# Yanbot Harness Windows SDK/CLI 内测接入手册

本文可直接交给 Windows 测试或接入同事。目标是在不安装源码仓库、不使用 pnpm、也不把 CodeBuddy Key 写入业务代码的前提下，完成 `0.1.0-preview.2` 的制品校验、离线安装、Reference 基线测试、CodeBuddy 真实调用、SDK/CLI 接入和结果回传。

## 1. 支持范围和当前状态

本次 Windows 交付目标是：

- Windows 10/11 x64；
- Node.js `>=22.22.0 <23`；
- PowerShell 5.1 或更高版本；
- `@yanbot-harness/contracts`、`@yanbot-harness/sdk`、`@yanbot-harness/cli` 和 Local Runtime 均为 `0.1.0-preview.2`；
- Harness protocol `1.0.0`；
- CodeBuddy 使用中国内网路由 `internal`，Key 由每位测试者自行配置。

GitHub-hosted Windows Server 2022 已通过构建、完整性检查和 Reference clean-room 测试。Windows 10/11 桌面实机与 Windows 上的真实 CodeBuddy 调用必须按本文完成后才算验收通过，不能以前述 CI 结果代替。

本 Preview 不包含 Node.js、MSI/EXE 安装器、系统服务、自动升级或公共 npm 发布，也不支持 Windows arm64、浏览器直接使用 SDK、CodeBuddy 模型列表、MCP、skills、agents 和 hooks。

## 2. 安全边界

组件关系如下：

```text
Windows 应用 / CLI
        │  loopback HTTP + SSE，使用短期 Runtime access token
        ▼
Yanbot Harness Local Runtime
        │  仅 Runtime 读取测试者的凭据文件
        ▼
CodeBuddy internal service
```

请遵守以下约束：

1. CodeBuddy Key 不得写入业务源码、命令参数、`.env`、`package.json`、截图、工单或测试报告。
2. 推荐只设置 `CODEBUDDY_API_KEY_FILE`。不要同时设置 `CODEBUDDY_API_KEY`，否则 Runtime 会拒绝启动。
3. `runtime.json` 含 Runtime access token，只能由当前 Windows 用户访问，不要复制或回传。
4. SDK/CLI 只连接本机 Runtime，不直接调用 CodeBuddy；业务请求中没有 CodeBuddy Key 字段。
5. 内测结束后删除凭据文件；如果 Key 曾出现在聊天、日志或截图中，应立即轮换。

## 3. 准备环境

以普通 Windows 用户打开 PowerShell，不需要管理员权限。建议使用短路径，以下示例统一放在 `C:\YanbotHarnessTest`。

先检查环境：

```powershell
$PSVersionTable.PSVersion
node --version
npm --version
[Environment]::Is64BitOperatingSystem
```

预期：

- PowerShell 主版本不低于 5；
- Node 为 `v22.22.0` 或更高的 Node 22，不能是 Node 23；
- 操作系统返回 `True`。

如果 Node 不符合要求，请先通过公司批准的软件渠道安装 Node 22。交付包本身不修改系统 Node，也不需要全局安装 Yanbot 包。

## 4. 接收文件并做双层校验

交付方应提供两个文件：

```text
yanbot-harness-0.1.0-preview.2-win32-x64.zip
yanbot-harness-0.1.0-preview.2-win32-x64.zip.sha256
```

把它们放到同一目录，例如 `C:\YanbotHarnessDelivery`。先校验外层 ZIP：

```powershell
Set-Location C:\YanbotHarnessDelivery

$version = '0.1.0-preview.2'
$archiveName = "yanbot-harness-$version-win32-x64.zip"
$archive = Join-Path $PWD $archiveName
$outerChecksum = "$archive.sha256"

if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Missing $archiveName" }
if (-not (Test-Path -LiteralPath $outerChecksum -PathType Leaf)) { throw "Missing $archiveName.sha256" }

$checksumLine = (Get-Content -LiteralPath $outerChecksum -Raw).Trim()
if ($checksumLine -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Invalid outer checksum file.' }
$expected = $Matches[1]
$listedName = $Matches[2]
if ($listedName -ne $archiveName) { throw "Unexpected checksum target: $listedName" }
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Outer ZIP checksum mismatch. Stop and request a new delivery.' }
'Outer ZIP checksum: PASS'
```

校验失败时不要继续解压，也不要让交付方只在聊天中重新发送一个 hash；应重新取得 ZIP 和配套的 `.sha256` 文件。

接着解压，并校验 ZIP 内的每个文件：

```powershell
$testRoot = 'C:\YanbotHarnessTest'
if (Test-Path -LiteralPath $testRoot) {
  throw "$testRoot already exists. Rename it or archive the previous test before continuing."
}
New-Item -ItemType Directory -Path $testRoot | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $testRoot

$releaseRoot = Join-Path $testRoot "yanbot-harness-$version-win32-x64"
$innerChecksum = Join-Path $releaseRoot 'SHA256SUMS'
if (-not (Test-Path -LiteralPath $innerChecksum -PathType Leaf)) { throw 'Missing inner SHA256SUMS.' }

Get-Content -LiteralPath $innerChecksum | ForEach-Object {
  if ($_ -notmatch '^([a-f0-9]{64})  (.+)$') { throw "Invalid SHA256SUMS line: $_" }
  $expectedHash = $Matches[1]
  $relativePath = $Matches[2].Replace('/', '\')
  $target = Join-Path $releaseRoot $relativePath
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Missing file: $relativePath" }
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw "Checksum mismatch: $relativePath" }
}
'Inner SHA256SUMS: PASS'

$manifest = Get-Content -LiteralPath (Join-Path $releaseRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $version) { throw 'Manifest version mismatch.' }
if ($manifest.target -ne 'win32-x64') { throw 'Manifest target mismatch.' }
if ($manifest.gitDirty -ne $false) { throw 'Manifest was assembled from a dirty tree.' }
$manifest | Select-Object version, protocolVersion, gitCommit, gitDirty, target, node
```

把 `gitCommit` 记入验收报告。不要自行替换已经通过校验的 tgz 或 Runtime 文件。

## 5. 离线安装 SDK 和 CLI

以下命令会把所有公开包安装到解压目录下的 `consumer`，不会做全局安装，也不访问 npm Registry：

```powershell
$consumerRoot = Join-Path $releaseRoot 'consumer'
New-Item -ItemType Directory -Force -Path $consumerRoot | Out-Null
npm init -y --prefix $consumerRoot

$packageArchives = (Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'packages') -Filter '*.tgz').FullName
& npm install --offline --prefix $consumerRoot --ignore-scripts --no-audit --no-fund --no-package-lock $packageArchives
if ($LASTEXITCODE -ne 0) { throw "Offline npm install failed with exit code $LASTEXITCODE" }

$cli = Join-Path $consumerRoot 'node_modules\@yanbot-harness\cli\dist\main.js'
node $cli --version
if ($LASTEXITCODE -ne 0) { throw 'CLI version check failed.' }
```

预期版本为 `0.1.0-preview.2`。`packages\zod-4.4.3.tgz` 是离线依赖，必须和另外三个 tgz 一起安装。

解压 Runtime：

```powershell
$runtimeArchive = Join-Path $releaseRoot "runtime\yanbot-harness-runtime-$version-win32-x64.zip"
$runtimeInstallRoot = Join-Path $releaseRoot 'runtime-installed'
New-Item -ItemType Directory -Force -Path $runtimeInstallRoot | Out-Null
Expand-Archive -LiteralPath $runtimeArchive -DestinationPath $runtimeInstallRoot

$runtimeHome = Join-Path $runtimeInstallRoot "yanbot-harness-runtime-$version-win32-x64"
$runtimeLauncher = Join-Path $runtimeHome 'bin\yanbot-harness-runtime.js'
if (-not (Test-Path -LiteralPath $runtimeLauncher -PathType Leaf)) { throw 'Runtime launcher not found.' }
```

Windows 包同时带有 `.cmd` 便捷启动器，但 SDK/CLI 托管模式建议传入上面的 `.js` 文件，以便精确管理 Node 进程树。

## 6. 先跑 Reference 基线

Reference Adapter 不访问 CodeBuddy，也不需要 Key。先通过它确认解压、Node、Runtime、SDK/CLI 和本机回环网络工作正常。

### 6.1 启动共享 Runtime

在 PowerShell 窗口 A 中执行：

```powershell
$version = '0.1.0-preview.2'
$releaseRoot = "C:\YanbotHarnessTest\yanbot-harness-$version-win32-x64"
$runtimeLauncher = Join-Path $releaseRoot "runtime-installed\yanbot-harness-runtime-$version-win32-x64\bin\yanbot-harness-runtime.js"
$env:YANBOT_HARNESS_STATE_DIR = Join-Path $releaseRoot 'reference-runtime-state'
node $runtimeLauncher --reference
```

Runtime 只应监听 loopback 地址并输出一个本机 origin。保持窗口 A 运行。

### 6.2 用 CLI 验证

在 PowerShell 窗口 B 中执行：

```powershell
$version = '0.1.0-preview.2'
$releaseRoot = "C:\YanbotHarnessTest\yanbot-harness-$version-win32-x64"
$consumerRoot = Join-Path $releaseRoot 'consumer'
$cli = Join-Path $consumerRoot 'node_modules\@yanbot-harness\cli\dist\main.js'
$env:YANBOT_HARNESS_RUNTIME_DESCRIPTOR = Join-Path $releaseRoot 'reference-runtime-state\runtime.json'

node $cli adapters --json
if ($LASTEXITCODE -ne 0) { throw 'Reference adapters check failed.' }

$lines = @(node $cli run 'Reply with exactly: windows-reference-ok' --adapter cn.yanbot.reference --workspace $releaseRoot --permission read-only --json --log-level silent)
if ($LASTEXITCODE -ne 0) { throw 'Reference CLI run failed.' }
$lines

$created = $lines[0] | ConvertFrom-Json
$sessionId = $created.run.sessionId
$runId = $created.run.runId
node $cli run-status $runId --json
node $cli run 'Continue with exactly: windows-reference-resume-ok' --session $sessionId --resume --workspace $releaseRoot --permission read-only --json --log-level silent
if ($LASTEXITCODE -ne 0) { throw 'Reference CLI resume failed.' }
```

JSON 模式为 JSONL：每一行都是一个独立 JSON 对象。首行通常是 `cli.run-created`，成功结束必须出现 `run.completed`。请按行解析，不要把全部 stdout 当成一个 JSON 文档。

可以查看命令面：

```powershell
node $cli --help
node $cli sessions --json
node $cli cancel '<run-id>' --reason 'Windows acceptance cancellation' --json
```

`cancel` 需要一个仍在执行的 run ID；对已经完成的 run 重复取消不能作为取消能力验收。

### 6.3 用 SDK 验证并作为接入样例

在 `$consumerRoot` 下新建 `sdk-integration.mjs`，内容如下：

```js
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { HarnessClient, HarnessSdkError } from '@yanbot-harness/sdk';

const [descriptorPath, workspace, adapterId = 'cn.yanbot.reference'] = process.argv.slice(2);
if (!descriptorPath || !workspace) {
  throw new Error('Usage: node sdk-integration.mjs <descriptor> <workspace> [adapter-id]');
}

const client = await HarnessClient.fromDaemon({ descriptorPath });
let grant;

async function execute(sessionId, prompt, resume) {
  // 对同一个逻辑请求重试时，应复用同一个 idempotencyKey。
  const idempotencyKey = randomUUID();
  const handle = await client.createRun(
    sessionId,
    {
      prompt,
      workspaceGrant: grant.grant,
      permissionPolicy: 'read-only',
      configScopes: [],
      extensions: [],
      resume,
    },
    { idempotencyKey },
  );

  let terminalEvent;
  let output = '';
  for await (const event of handle.events()) {
    if (event.type === 'assistant.delta' && event.payload.channel === 'output') {
      output += event.payload.text;
    }
    if (event.type === 'interaction.requested') {
      // 示例默认拒绝交互。正式应用应暂停 UI，取得用户决定后再 respond。
      await handle.respond({
        requestId: event.payload.requestId,
        action: 'deny',
        message: 'The integration sample does not approve interactions.',
      });
    }
    if (event.type === 'run.failed') {
      throw new Error(`${event.payload.error.code}: ${event.payload.error.message}`);
    }
    if (event.type === 'run.completed' || event.type === 'run.cancelled') {
      terminalEvent = event.type;
    }
  }
  if (!terminalEvent) throw new Error('Event stream ended without a terminal event.');
  return { runId: handle.run.runId, terminalEvent, output };
}

try {
  const health = await client.health();
  const adapters = await client.listAdapters();
  if (!adapters.some((item) => item.manifest.adapterId === adapterId)) {
    throw new Error(`Adapter unavailable: ${adapterId}`);
  }

  grant = await client.grantWorkspace({ path: workspace, ttlMs: 60 * 60 * 1000 });
  const session = await client.createSession({ adapterId, title: 'Windows SDK acceptance' });
  const initial = await execute(session.sessionId, 'Reply with exactly: windows-sdk-ok', false);
  const resumed = await execute(session.sessionId, 'Reply with exactly: windows-sdk-resume-ok', true);
  console.log(JSON.stringify({ health: health.status, adapterId, sessionId: session.sessionId, initial, resumed }));
} catch (error) {
  if (error instanceof HarnessSdkError) {
    console.error(JSON.stringify({ kind: error.kind, status: error.status, code: error.harnessError?.code }));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
} finally {
  if (grant) await client.revokeWorkspaceGrant(grant.grantId).catch(() => undefined);
}
```

运行：

```powershell
Set-Location $consumerRoot
node .\sdk-integration.mjs $env:YANBOT_HARNESS_RUNTIME_DESCRIPTOR $releaseRoot cn.yanbot.reference
if ($LASTEXITCODE -ne 0) { throw 'Reference SDK integration failed.' }
```

预期 `health` 为 `ok`，initial 和 resumed 的终态均为 `run.completed`。正式接入时应保存 `sessionId` 用于续跑，保存最后一个 `eventId` 用于 SSE 断线后的显式续订：

```js
let lastEventId;
for await (const event of handle.events()) lastEventId = event.eventId;
for await (const event of handle.events({ afterEventId: lastEventId })) {
  // 继续处理未消费的事件
}
```

`AbortSignal` 只停止读取 SSE，不会取消远端 run。取消执行必须调用 `await handle.cancel(reason)` 或 `await client.cancelRun(runId, reason)`。

Reference 基线通过后，在窗口 A 按 Ctrl-C。确认 descriptor 已删除：

```powershell
Test-Path -LiteralPath $env:YANBOT_HARNESS_RUNTIME_DESCRIPTOR
```

预期为 `False`。

## 7. 配置测试者自己的 CodeBuddy Key

在新的 PowerShell 窗口中执行以下脚本。它通过隐藏输入取得 Key，以 UTF-8 无 BOM 的单行文件保存，并移除继承权限，只授权当前 Windows 身份：

```powershell
$secureKey = Read-Host 'CodeBuddy API key' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'YanbotHarness'
$credentialFile = Join-Path $credentialDirectory 'codebuddy.key'
New-Item -ItemType Directory -Force -Path $credentialDirectory | Out-Null

try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ([string]::IsNullOrWhiteSpace($plainKey)) { throw 'Key cannot be empty.' }
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($credentialFile, $plainKey, $utf8WithoutBom)
} finally {
  $plainKey = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $credentialFile /inheritance:r /grant:r "${identity}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict the credential file ACL.' }
& icacls.exe $credentialFile
```

不要运行 `Get-Content $credentialFile`，也不要把 Key 放到命令行中。更换 Key 时重新执行上述步骤即可，无需重建或重装 SDK/CLI/Runtime。

## 8. 启动 CodeBuddy Runtime

推荐使用共享 Daemon 模式，因为凭据边界最清楚：只有单独的 Runtime 进程读取 Key 文件，SDK/CLI 应用只拿到 descriptor 路径。

在 PowerShell 窗口 A 中执行：

```powershell
$version = '0.1.0-preview.2'
$releaseRoot = "C:\YanbotHarnessTest\yanbot-harness-$version-win32-x64"
$runtimeLauncher = Join-Path $releaseRoot "runtime-installed\yanbot-harness-runtime-$version-win32-x64\bin\yanbot-harness-runtime.js"
$credentialFile = Join-Path $env:LOCALAPPDATA 'YanbotHarness\codebuddy.key'

Remove-Item Env:CODEBUDDY_API_KEY -ErrorAction SilentlyContinue
$env:CODEBUDDY_API_KEY_FILE = $credentialFile
$env:CODEBUDDY_INTERNET_ENVIRONMENT = 'internal'
$env:YANBOT_HARNESS_STATE_DIR = Join-Path $releaseRoot 'codebuddy-runtime-state'
node $runtimeLauncher
```

如果 Runtime 立即退出：

- 确认文件存在、非空且只有一行；
- 确认没有同时继承 `CODEBUDDY_API_KEY`；
- 确认路由值严格为 `internal`；
- 不要设置自定义 `CODEBUDDY_BASE_URL`。

在 PowerShell 窗口 B 中只设置 descriptor，不设置 Key：

```powershell
$version = '0.1.0-preview.2'
$releaseRoot = "C:\YanbotHarnessTest\yanbot-harness-$version-win32-x64"
$consumerRoot = Join-Path $releaseRoot 'consumer'
$cli = Join-Path $consumerRoot 'node_modules\@yanbot-harness\cli\dist\main.js'
$env:YANBOT_HARNESS_RUNTIME_DESCRIPTOR = Join-Path $releaseRoot 'codebuddy-runtime-state\runtime.json'
Remove-Item Env:CODEBUDDY_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:CODEBUDDY_API_KEY_FILE -ErrorAction SilentlyContinue

node $cli adapters --json
node $cli run 'Reply with exactly: windows-codebuddy-cli-ok' --adapter cn.tencent.codebuddy --workspace $releaseRoot --permission read-only --json --log-level silent
if ($LASTEXITCODE -ne 0) { throw 'CodeBuddy CLI run failed.' }
```

成功结果必须包含 `run.completed`。随后运行 SDK 示例：

```powershell
Set-Location $consumerRoot
node .\sdk-integration.mjs $env:YANBOT_HARNESS_RUNTIME_DESCRIPTOR $releaseRoot cn.tencent.codebuddy
if ($LASTEXITCODE -ne 0) { throw 'CodeBuddy SDK integration failed.' }
```

这一步覆盖 SDK 首次运行和同一 Session 的 resume。当前 CodeBuddy Adapter 的 `models` 命令会返回 `CAPABILITY_UNSUPPORTED`，这是 Preview 的已知降级，不是安装故障。

## 9. 取消执行的 SDK 接入方式

业务系统应保存 `runId`。下面的核心逻辑在收到 `run.started` 后主动取消，并等待 `run.cancelled`：

```js
const cancelSession = await client.createSession({ adapterId: 'cn.tencent.codebuddy' });
const cancelRun = await client.createRun(cancelSession.sessionId, {
  prompt: 'Wait briefly, then reply.',
  workspaceGrant: grant.grant,
  permissionPolicy: 'read-only',
  configScopes: [],
  extensions: [],
  resume: false,
});

let cancelled = false;
for await (const event of cancelRun.events()) {
  if (event.type === 'run.started') await cancelRun.cancel('Windows cancellation acceptance');
  if (event.type === 'run.cancelled') cancelled = true;
}
if (!cancelled) throw new Error('Run did not reach run.cancelled.');
```

SDK、CLI 和 Runtime 的真实交付门槛要求取消后不残留 CodeBuddy 子进程。停止 Runtime 后可做一次非敏感检查：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*yanbot-harness*' } |
  Select-Object ProcessId, Name, CommandLine
```

预期没有属于本次 Runtime 的进程。不要通过强制结束所有 `node.exe` 来制造通过结果，因为这会影响其他应用且无法证明正常清理路径有效。

## 10. 托管 Runtime 模式

共享 Daemon 适合桌面应用长期运行和多个调用者复用。单次任务也可以让 SDK 或 CLI 启动并拥有一个 Runtime；调用完成后必须关闭，托管方会清理进程树和临时 descriptor。

SDK Reference 示例：

```js
import { startManagedRuntime } from '@yanbot-harness/sdk';

const runtime = await startManagedRuntime({
  executablePath:
    'C:\\YanbotHarnessTest\\yanbot-harness-0.1.0-preview.2-win32-x64\\runtime-installed\\yanbot-harness-runtime-0.1.0-preview.2-win32-x64\\bin\\yanbot-harness-runtime.js',
  reference: true,
});
try {
  console.log(await runtime.client.listAdapters());
} finally {
  await runtime.close();
}
```

CLI Reference 示例：

```powershell
$env:YANBOT_HARNESS_ADAPTER = 'reference'
node $cli adapters --managed-runtime $runtimeLauncher --json
Remove-Item Env:YANBOT_HARNESS_ADAPTER -ErrorAction SilentlyContinue
```

CodeBuddy 托管模式可以把 `CODEBUDDY_API_KEY_FILE` 和 `CODEBUDDY_INTERNET_ENVIRONMENT=internal` 作为子进程环境传给 Runtime。Key 内容仍不得成为 SDK 参数。对于生产接入，若主应用不应接触任何凭据配置，使用单独的共享 Runtime 服务进程更合适。

## 11. CLI 命令和退出码

命令面：

```text
adapters
models --adapter <adapter-id>
sessions
run-status <run-id>
cancel <run-id> [--reason <text>]
run <prompt> [--adapter <id>] [--session <id>] [--workspace <path>]
             [--cwd <relative-path>] [--model <id>]
             [--permission interactive|auto-edit|read-only]
             [--config-scope user|organization|project|local] [--resume] [--json]
```

连接方式三选一：

- `--descriptor <path>` 或 `YANBOT_HARNESS_RUNTIME_DESCRIPTOR`：推荐的共享 Daemon 模式；
- `--managed-runtime <launcher>`：CLI 启动并关闭本次专用 Runtime；
- `--runtime <loopback-url>` 与 `YANBOT_HARNESS_ACCESS_TOKEN`：显式连接，高级用法；不要把 token 写入命令参数。

`--runtime`、`--descriptor` 和 `--managed-runtime` 互斥。退出码：

| 退出码 | 含义                          |
| -----: | ----------------------------- |
|    `0` | 成功                          |
|    `2` | 命令或参数错误                |
|   `10` | 取消或超时                    |
|   `11` | 需要交互或权限被拒绝          |
|   `20` | Runtime 或 CodeBuddy 认证失败 |
|   `30` | Adapter 或上游失败            |
|   `40` | Runtime、网络或协议失败       |

JSON/非 TTY 模式遇到 `interaction.requested` 会以 `11` 退出，避免 CLI 擅自批准工具。需要权限或问答交互的产品应通过 SDK 展示 UI，再调用 `run.respond(...)`。

## 12. Windows 10/11 实机验收清单

请逐项记录 PASS/FAIL：

1. 外层 `.zip.sha256` 通过。
2. 内层 `SHA256SUMS` 全部通过。
3. manifest 为 `0.1.0-preview.2`、`win32-x64`、`gitDirty: false`。
4. Node 22 版本符合范围，离线 npm 安装成功。
5. Reference CLI 首次运行与 resume 均出现 `run.completed`。
6. Reference SDK 首次运行与 resume 均出现 `run.completed`。
7. Reference Runtime 正常 Ctrl-C 后 descriptor 消失。
8. CodeBuddy Key 文件仅当前 Windows 用户可访问。
9. SDK/CLI 进程不设置 `CODEBUDDY_API_KEY`，共享 Daemon 模式下也不设置 `CODEBUDDY_API_KEY_FILE`。
10. CodeBuddy CLI JSONL 出现 `run.completed`。
11. CodeBuddy SDK initial 和 resume 均为 `run.completed`。
12. CodeBuddy SDK cancel 为 `run.cancelled`。
13. Runtime 停止后 descriptor 消失，且没有本次 Yanbot Harness/CodeBuddy 子进程残留。
14. 日志、截图和回传文件不含 Key、Runtime access token、敏感 prompt 或业务数据。

建议至少在一台 Windows 10 x64 和一台 Windows 11 x64 上各跑一次。当前仅有一台时，先完成首位测试方验收，并明确记录系统版本。

## 13. 验收结果回传模板

只回传以下非敏感信息：

```text
Yanbot Harness Windows acceptance
Date:
Tester:
Windows product/version/build:
Architecture: x64
PowerShell version:
Node version:
Package version: 0.1.0-preview.2
Manifest gitCommit:
Outer checksum: PASS/FAIL
Inner checksums: PASS/FAIL
Reference CLI initial/resume: PASS/FAIL
Reference SDK initial/resume: PASS/FAIL
CodeBuddy CLI JSONL: PASS/FAIL
CodeBuddy SDK initial/resume/cancel: PASS/FAIL
Descriptor cleanup: PASS/FAIL
Remaining related child processes: 0/<count>
CLI exit code if failed:
Normalized error kind/code if failed:
Notes (no key, token, sensitive prompt, or full descriptor):
```

失败时优先提供：发生在哪一步、退出码、`HarnessSdkError.kind`、标准化 `harnessError.code`、Windows/Node 版本和 manifest commit。不要提供 Key、完整 `runtime.json`、未经检查的完整环境变量列表或包含敏感内容的原始日志。

## 14. 常见问题

`The local Runtime descriptor could not be read`

: Runtime 未启动、descriptor 路径不一致或 Runtime 已退出。确认窗口 A 正在运行，并检查 `YANBOT_HARNESS_RUNTIME_DESCRIPTOR`。

`Configure exactly one Runtime credential source`

: 同时设置了 `CODEBUDDY_API_KEY` 和 `CODEBUDDY_API_KEY_FILE`。删除前者后重新启动 Runtime。

`AUTHENTICATION_FAILED` 或 CLI 退出码 `20`

: Key 过期、无权限、文件内容错误或路由不匹配。只在 Runtime 窗口确认 Key 文件和 `internal` 路由，不要把 Key 发给 SDK/CLI。

`CAPABILITY_UNSUPPORTED`

: 先查看 `adapters --json`。CodeBuddy 模型列表在本 Preview 中明确不支持。

CLI JSON 模式退出码 `11`

: run 请求了权限或问题交互。JSON 模式不会自动批准；改用 SDK 处理 `interaction.requested`。

SSE 中断

: 保存最后一个 `eventId`，使用 `events({ afterEventId })` 显式恢复。不要直接创建第二个 run，除非确实要启动新的执行。

Runtime 无法启动或托管模式超时

: 确认传入的是校验过的 `yanbot-harness-runtime.js`、Node 版本正确、旧 Runtime 已退出，且指定 state 目录中没有另一个 `runtime.json`。

杀毒或终端策略拦截

: 保留产品名、策略提示和文件 hash，由公司 IT 安全流程放行。不要关闭整机安全软件，也不要换成未经校验的文件。

## 15. 停止、清理和回滚

在 Runtime 窗口按 Ctrl-C，等待进程退出。然后在使用过的 PowerShell 窗口执行：

```powershell
Remove-Item Env:CODEBUDDY_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:CODEBUDDY_API_KEY_FILE -ErrorAction SilentlyContinue
Remove-Item Env:CODEBUDDY_INTERNET_ENVIRONMENT -ErrorAction SilentlyContinue
Remove-Item Env:YANBOT_HARNESS_RUNTIME_DESCRIPTOR -ErrorAction SilentlyContinue
Remove-Item Env:YANBOT_HARNESS_STATE_DIR -ErrorAction SilentlyContinue
```

测试周期结束并确认不再需要该 Key 后：

```powershell
$credentialFile = Join-Path $env:LOCALAPPDATA 'YanbotHarness\codebuddy.key'
Remove-Item -LiteralPath $credentialFile -Force
```

如需回滚，停止分发当前候选，恢复上一份完整且校验通过的版本目录；不要在原目录内混用不同版本文件。制品回滚不会让已泄露的 Key 失效，凭据泄露必须在 CodeBuddy 侧单独撤销或轮换。
