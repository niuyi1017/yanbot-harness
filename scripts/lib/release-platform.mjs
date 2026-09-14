import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export function runtimeArchiveSuffix(platform = process.platform) {
  return platform === 'win32' ? '.zip' : '.tar.gz';
}

export function isRuntimeArchive(name) {
  return name.endsWith('.tar.gz') || name.endsWith('.zip');
}

export async function findRuntimeArchive(directory) {
  const matches = (await readdir(directory)).filter(isRuntimeArchive);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Runtime archive, found ${matches.length}.`);
  }
  return path.join(directory, matches[0]);
}

export async function createRuntimeArchive(sourceDirectory, archivePath) {
  if (archivePath.endsWith('.zip')) {
    await executeFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& { param($source, $destination) Compress-Archive -LiteralPath $source -DestinationPath $destination -Force }',
        sourceDirectory,
        archivePath,
      ],
      { maxBuffer: 50 * 1024 * 1024 },
    );
    return;
  }

  await executeFile('tar', ['-czf', archivePath, '-C', path.dirname(sourceDirectory), path.basename(sourceDirectory)], {
    maxBuffer: 50 * 1024 * 1024,
  });
}

export async function extractRuntimeArchive(archivePath, destinationDirectory) {
  if (archivePath.endsWith('.zip')) {
    await executeFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& { param($source, $destination) Expand-Archive -LiteralPath $source -DestinationPath $destination -Force }',
        archivePath,
        destinationDirectory,
      ],
      { maxBuffer: 50 * 1024 * 1024 },
    );
    return;
  }

  await executeFile('tar', ['-xzf', archivePath, '-C', destinationDirectory], { maxBuffer: 50 * 1024 * 1024 });
}

export function runtimeLauncherPath(bundleDirectory, platform = process.platform) {
  const base = path.join(bundleDirectory, 'bin', 'yanbot-harness-runtime');
  return platform === 'win32' ? `${base}.js` : base;
}

export function runtimeInvocation(launcherPath, arguments_ = []) {
  return /\.[cm]?js$/iu.test(launcherPath)
    ? { command: process.execPath, arguments: [launcherPath, ...arguments_] }
    : { command: launcherPath, arguments: arguments_ };
}

export async function terminateRuntimeProcess(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return waitForExit(child, timeoutMs);

  if (process.platform === 'win32') {
    const pid = child.pid;
    if (!pid) throw new Error('Cannot terminate a Runtime process without a PID.');
    try {
      await executeFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error;
    }
    return waitForExit(child, timeoutMs);
  }

  child.kill('SIGTERM');
  return waitForExit(child, timeoutMs);
}

export async function directChildProcessIds(parentPid) {
  if (process.platform === 'win32') {
    const { stdout } = await executeFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& { param($parentPid) (Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq $parentPid).ProcessId -join "," }',
        String(parentPid),
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim() === '' ? [] : stdout.trim().split(',');
  }

  try {
    const { stdout } = await executeFile('pgrep', ['-P', String(parentPid)]);
    return stdout.trim() === '' ? [] : stdout.trim().split(/\s+/u);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) return [];
    throw error;
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  let timer;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      }),
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error(`Process ${child.pid ?? 'unknown'} exceeded ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}
