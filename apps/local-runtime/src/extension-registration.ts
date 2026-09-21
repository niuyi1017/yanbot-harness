import { stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { discoverSkills, discoverMcpServers, type DiscoveredExtension } from '@yanbot-harness/extension-kit';

/** Host-side trusted configuration. This directory never comes from a public run request. */
export async function loadRegisteredExtensions(directory: string | undefined): Promise<DiscoveredExtension[]> {
  if (directory === undefined) return [];
  try {
    if (!directory || !path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error();
    const exists = async (file: string) =>
      lstat(file)
        .then((info) => {
          if (info.isSymbolicLink()) throw new Error();
          return true;
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
    const skills = path.join(directory, 'skills');
    const mcp = path.join(directory, 'mcp.json');
    const extensions = [
      ...((await exists(skills)) ? await discoverSkills([{ path: skills, source: 'bundled' }]) : []),
      ...((await exists(mcp))
        ? await discoverMcpServers({ file: mcp, allowedRoot: directory, source: 'bundled' })
        : []),
    ];
    if (new Set(extensions.map((item) => item.descriptor.extensionId)).size !== extensions.length) throw new Error();
    return extensions;
  } catch {
    throw new Error('The trusted extension directory is invalid.');
  }
}
