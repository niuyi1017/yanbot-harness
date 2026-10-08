import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type SandboxDeployment = { dockerPath: string; image: string; snapshotRoot: string; workspacePath: string };
export async function createArguments(
  deployment: SandboxDeployment,
  name: string,
): Promise<{ args: string[]; workspace: string }> {
  if (
    !path.isAbsolute(deployment.dockerPath) ||
    deployment.dockerPath.includes('\0') ||
    !/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64})$/.test(deployment.image) ||
    !/^harness-sandbox-[a-f0-9-]{36}$/.test(name)
  )
    throw new Error('Invalid sandbox deployment.');
  const root = await realpath(deployment.snapshotRoot);
  const workspace = await realpath(deployment.workspacePath);
  const relative = path.relative(root, workspace);
  if (
    root === path.parse(root).root ||
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    /[,\r\n\0]/.test(workspace) ||
    !(await stat(workspace)).isDirectory()
  )
    throw new Error('Invalid sandbox workspace.');
  return {
    workspace,
    args: [
      'create',
      '--pull=never',
      '--rm',
      '--interactive',
      '--name',
      name,
      '--label',
      'io.yanbot.harness.sandbox=1',
      '--network=none',
      '--read-only',
      '--user=65532:65532',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges=true',
      '--pids-limit=256',
      '--memory=512m',
      '--memory-swap=512m',
      '--cpus=1',
      '--ipc=private',
      '--cgroupns=private',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
      '--tmpfs',
      '/home/sandbox:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=700',
      '--workdir=/home/sandbox',
      '--env=HOME=/home/sandbox',
      '--env=TMPDIR=/tmp',
      '--entrypoint=node',
      deployment.image,
      '/app/apps/sandbox-runtime/dist/main.js',
    ],
  };
}
