/**
 * Starts the server. Environment: WORLDSIM_DB (world file), WORLDSIM_PACK
 * (setting pack folder), HOST, PORT.
 */
import { PackError } from '@worldsim/core';
import { buildApp } from './app.ts';
import { packPathFromEnv, storePathFromEnv } from './config.ts';
import { loadPack } from './pack-loader.ts';
import { WorldStore, WorldStoreError } from './storage.ts';

const storePath = storePathFromEnv();
const packPath = packPathFromEnv();
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3001);

try {
  // The pack is read once, here. Restart the server to pick up edits to it.
  const pack = loadPack(packPath);
  const store = new WorldStore(storePath);
  const world = store.loadWorld();
  const report = store.loadReport();
  store.close();

  const app = buildApp(world, report, pack);
  await app.listen({ host, port });
  console.log(`Serving ${world.info.name} (${world.settlements.length} settlements) from ${storePath}`);
  console.log(`Setting pack ${pack.pack.name} ${pack.pack.version} from ${packPath}`);
  console.log(`API at http://${host}:${port}/api/world`);
} catch (error) {
  console.error(`Cannot start: ${(error as Error).message}`);
  if (error instanceof WorldStoreError) {
    console.error('Import the world: npm run import -- fixtures/afmg/lomia.json');
  } else if (error instanceof PackError) {
    console.error(`Fix the setting pack in ${packPath} and start again.`);
  }
  process.exitCode = 1;
}
