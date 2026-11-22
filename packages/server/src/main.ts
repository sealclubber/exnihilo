/**
 * Starts the server. Environment: WORLDSIM_DB (world file), WORLDSIM_PACK
 * (setting pack folder), HOST, PORT.
 */
import { PackError } from '@worldsim/core';
import { buildApp } from './app.ts';
import { AvatarKeeper, fromStore, toStore } from './avatar.ts';
import { WorldClock } from './clock.ts';
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
  // The store stays open: the clock is written to it whenever it is paused, re-anchored or set.
  const store = new WorldStore(storePath);
  const world = store.loadWorld();
  const report = store.loadReport();
  const clock = new WorldClock({
    now: () => Date.now(),
    rates: pack.time.rates,
    defaultRate: pack.time.defaultRate,
    stored: store.loadClock(),
    save: (state) => store.saveClock(state),
  });

  // The avatar is written to the store whenever it changes, and restored here.
  const avatar = new AvatarKeeper({ stored: fromStore(store.loadAvatar(), pack), save: (state) => store.saveAvatar(toStore(state, pack)) });

  const app = buildApp(world, report, pack, { clock, avatar });
  await app.listen({ host, port });
  console.log(`Serving ${world.info.name} (${world.settlements.length} settlements) from ${storePath}`);
  console.log(`Setting pack ${pack.pack.name} ${pack.pack.version} from ${packPath}`);
  console.log(`The clock is paused at game time ${Math.floor(clock.read().gameTime)}, rate ${clock.read().rate}`);
  const present = avatar.read();
  console.log(present ? `The avatar is in ${present.settlementId}` : 'There is no avatar yet');
  console.log(`API at http://${host}:${port}/api/world`);

  let stopping = false;
  const shutDown = () => {
    if (stopping) return;
    stopping = true;
    clock.stop();
    void app.close().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutDown);
  process.on('SIGTERM', shutDown);
} catch (error) {
  console.error(`Cannot start: ${(error as Error).message}`);
  if (error instanceof WorldStoreError) {
    console.error('Import the world: npm run import -- fixtures/afmg/lomia.json');
  } else if (error instanceof PackError) {
    console.error(`Fix the setting pack in ${packPath} and start again.`);
  }
  process.exitCode = 1;
}
