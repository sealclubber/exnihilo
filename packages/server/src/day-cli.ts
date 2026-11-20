/**
 * Usage: npm run day -- <settlement-id> [--day <number>] [--db <world.sqlite>] [--pack <folder>]
 */
import { parseArgs } from 'node:util';
import { packPathFromEnv, storePathFromEnv } from './config.ts';
import { describeSettlementDay } from './day-command.ts';

const USAGE = 'Usage: npm run day -- <settlement-id> [--day <number>] [--db <world.sqlite>] [--pack <folder>]';

function main(): number {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: { day: { type: 'string' }, db: { type: 'string' }, pack: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
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
  const day = args.values.day === undefined ? 1 : Number(args.values.day);
  if (!Number.isInteger(day) || day < 1) {
    console.error('--day must be a whole number, 1 or more');
    return 2;
  }
  try {
    console.log(describeSettlementDay({ settlementId, day, storePath: args.values.db ?? storePathFromEnv(), packPath: args.values.pack ?? packPathFromEnv() }));
    return 0;
  } catch (error) {
    console.error(`Could not describe the day: ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = main();
