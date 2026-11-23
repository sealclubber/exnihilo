/**
 * Usage: npm run render -- <settlement-id> [--generator grid] [--seed <number>] [--out <file.svg>] [--db <world.sqlite>] [--pack <folder>]
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { packPathFromEnv, storePathFromEnv } from './config.ts';
import { renderSettlement } from './render-command.ts';

const USAGE = 'Usage: npm run render -- <settlement-id> [--generator grid] [--seed <number>] [--out <file.svg>] [--db <world.sqlite>] [--pack <folder>]';

function main(): number {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: { generator: { type: 'string' }, seed: { type: 'string' }, out: { type: 'string' }, db: { type: 'string' }, pack: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
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
  const { generator } = args.values;
  if (generator !== undefined && generator !== 'grid') {
    console.error('--generator must be grid');
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
    const outPath = args.values.out ?? join('data', 'renders', `${settlementId}${generator ? `-${generator}` : ''}.svg`);
    const result = renderSettlement({ settlementId, storePath: args.values.db ?? storePathFromEnv(), packPath: args.values.pack ?? packPathFromEnv(), outPath, ...(generator && { generator }), ...(seed !== undefined && { seed }) });
    console.log(`Drew ${settlementId} with the ${result.generator} generator, ${result.lots.toLocaleString('en-US')} lots: ${outPath}`);
    return 0;
  } catch (error) {
    console.error(`Could not draw the settlement: ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = main();
