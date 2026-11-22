/**
 * Build step: bundle the workflow code once (webpack) and write dist/temporal/workflow-bundle.js.
 * The worker loads this file instead of bundling at start-up (see resolvePrebuiltBundle in worker.ts).
 * Run after tsc: `node dist/temporal/bundleWorkflows.js` (part of the build script).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

async function main(): Promise<void> {
  const { code } = await bundleWorkflowCode({
    workflowsPath: require.resolve('./workflows'),
  });
  const outPath = path.join(__dirname, 'workflow-bundle.js');
  await writeFile(outPath, code);
  process.stdout.write(`wrote ${outPath} (${Math.round(code.length / 1024)} KiB)\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`workflow bundling failed: ${String(err)}\n`);
  process.exit(1);
});
