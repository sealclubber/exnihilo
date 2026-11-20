/**
 * Starts the server. Environment: WORLDSIM_DB (world file), HOST, PORT.
 */
import { buildApp } from './app.ts';
import { storePathFromEnv } from './config.ts';
import { WorldStore } from './storage.ts';

const storePath = storePathFromEnv();
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3001);

try {
  const store = new WorldStore(storePath);
  const world = store.loadWorld();
  const report = store.loadReport();
  store.close();

  const app = buildApp(world, report);
  await app.listen({ host, port });
  console.log(`Serving ${world.info.name} (${world.settlements.length} settlements) from ${storePath}`);
  console.log(`API at http://${host}:${port}/api/world`);
} catch (error) {
  console.error(`Cannot start: ${(error as Error).message}`);
  console.error('Import a world first: npm run import -- fixtures/afmg/lomia.json');
  process.exitCode = 1;
}
