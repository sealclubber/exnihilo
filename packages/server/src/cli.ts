/**
 * Usage: npm run import -- <export.json> [--db <world.sqlite>]
 */
import { parseArgs } from 'node:util';
import { storePathFromEnv } from './config.ts';
import { formatReport, importFile } from './import-command.ts';

const USAGE = 'Usage: npm run import -- <export.json> [--db <world.sqlite>]';

function main(): number {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { db: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.values.help) {
    console.log(USAGE);
    return 0;
  }
  const [exportPath, ...extra] = args.positionals;
  if (!exportPath || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const storePath = args.values.db ?? storePathFromEnv();
  try {
    const report = importFile(exportPath, storePath);
    console.log(formatReport(report));
    console.log(`\nStored in ${storePath}`);
    return 0;
  } catch (error) {
    console.error(`Import failed: ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = main();
