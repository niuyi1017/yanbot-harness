#!/usr/bin/env node
import path from 'node:path';

import { generatePlatformEvidence, writeJsonAtomic } from './lib/dual-runtime-evidence.mjs';

const options = parseArguments(process.argv.slice(2));
const report = await generatePlatformEvidence({
  target: options.target,
  repositoryRoot: path.resolve(import.meta.dirname, '..'),
});
await writeJsonAtomic(options.output, report);
process.stdout.write(`${JSON.stringify({ output: path.resolve(options.output), status: report.status })}\n`);
if (report.status !== 'passed') process.exitCode = 1;

function parseArguments(args) {
  let target;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--target') target = args[++index];
    else if (argument === '--output') output = args[++index];
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (!target || !output) throw new Error('Use --target <darwin-arm64|win32-x64> --output <report.json>.');
  return { target, output };
}
