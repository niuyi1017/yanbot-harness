import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);

/** Reap only abandoned creates; never force-remove a container that raced into running. */
export async function reapUnstartedContainers(dockerPath: string, minimumAgeMs = 60_000): Promise<number> {
  if (
    !path.isAbsolute(dockerPath) ||
    dockerPath.includes('\0') ||
    !Number.isSafeInteger(minimumAgeMs) ||
    minimumAgeMs < 1000
  ) {
    throw new Error('Invalid sandbox reaper configuration.');
  }
  const command = async (args: string[]) =>
    (
      await execute(dockerPath, args, { env: { PATH: '/usr/bin:/bin' }, timeout: 15_000, maxBuffer: 256 * 1024 })
    ).stdout.trim();
  try {
    const listing = await command([
      'ps',
      '--all',
      '--no-trunc',
      '--filter',
      'label=io.yanbot.harness.sandbox=1',
      '--filter',
      'status=created',
      '--format',
      '{{.ID}}',
    ]);
    const ids = listing ? listing.split('\n') : [];
    if (ids.length > 256 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid container listing');
    let removed = 0;
    for (const cid of ids) {
      let infos: unknown;
      try {
        infos = JSON.parse(await command(['inspect', cid]));
      } catch {
        continue;
      }
      if (!Array.isArray(infos) || infos.length !== 1) continue;
      const info = infos[0];
      if (
        info.Id !== cid ||
        info.State?.Status !== 'created' ||
        info.Config?.Labels?.['io.yanbot.harness.sandbox'] !== '1' ||
        !/^\/harness-sandbox-[a-f0-9-]{36}$/.test(info.Name) ||
        !Number.isFinite(Date.parse(info.Created)) ||
        Date.now() - Date.parse(info.Created) < minimumAgeMs
      )
        continue;
      if (
        await command(['rm', cid]).then(
          () => true,
          () => false,
        )
      )
        removed += 1;
    }
    return removed;
  } catch {
    throw new Error('Sandbox abandoned-create cleanup failed.');
  }
}
