/**
 * Usage: npm run generate -- <settlement-id> [--seed <number>] [--out <folder>] [--db <world.sqlite>] [--pack <folder>]
 */
import { parseArgs } from 'node:util';
import { DEFAULT_CITIES_FOLDER, packPathFromEnv, storePathFromEnv } from './config.ts';
import { generateToDisk } from './generate-command.ts';

const USAGE =
  'Usage: npm run generate -- <settlement-id> [--seed <number>] [--out <folder>] [--db <world.sqlite>] [--pack <folder>]';

function main(): number {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        seed: { type: 'string' },
        out: { type: 'string' },
        db: { type: 'string' },
        pack: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.values.help) {
    console.log(USAGE);
    return 0;
  }
  const [settlementId, ...extra] = args.positionals;
  if (!settlementId || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }
  let seed: number | undefined;
  if (args.values.seed !== undefined) {
    seed = Number(args.values.seed);
    if (!/^\d+$/.test(args.values.seed) || seed > 0xffffffff) {
      console.error('--seed must be a whole number from 0 to 4294967295');
      return 2;
    }
  }
  try {
    const result = generateToDisk({
      settlementId,
      storePath: args.values.db ?? storePathFromEnv(),
      packPath: args.values.pack ?? packPathFromEnv(),
      outFolder: args.values.out ?? DEFAULT_CITIES_FOLDER,
      ...(seed !== undefined && { seed }),
    });
    console.log(result.summaryText);
    console.log(`Records: ${result.recordsPath}`);
    console.log(`Summary: ${result.summaryPath}`);
    return 0;
  } catch (error) {
    console.error(`Generation failed: ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = main();
