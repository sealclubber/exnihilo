/**
 * Usage: npm run world -- --seed <seed> --template <id> --points <number> [--db <world.sqlite>]
 */
import { parseArgs } from 'node:util';
import { loadGenerator } from '@worldsim/worldgen';
import { storePathFromEnv } from './config.ts';
import { formatReport } from './import-command.ts';
import { createWorldFile } from './world-command.ts';

const USAGE = 'Usage: npm run world -- --seed <seed> --template <id> --points <number> [--db <world.sqlite>]';

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        seed: { type: 'string' },
        template: { type: 'string' },
        points: { type: 'string' },
        db: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const { seed, template, points, db, help } = args.values;
  if (help) {
    console.log(`${USAGE}\nTemplates: ${(await (await loadGenerator()).templateIds()).join(', ')}`);
    return 0;
  }
  if (!seed || !template || !points) {
    console.error(USAGE);
    return 2;
  }
  const count = Number(points);
  if (!Number.isInteger(count) || count <= 0) {
    console.error(`--points must be a whole number above 0, but is "${points}"\n${USAGE}`);
    return 2;
  }
  const storePath = db ?? storePathFromEnv();
  try {
    const started = performance.now();
    const report = await createWorldFile({ seed, template, points: count }, storePath);
    console.log(formatReport(report));
    console.log(`\nMade from seed ${seed}, template ${template}, ${count} points in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    console.log(`Stored in ${storePath}`);
    return 0;
  } catch (error) {
    console.error(`Making the world failed: ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = await main();
