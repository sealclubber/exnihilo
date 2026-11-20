/**
 * The day command: prints one day in a settlement as text, with the hourly
 * counts of what people are doing and the busiest street segments.
 */
import { createLife, describeDay, generateCity, generateLayout } from '@worldsim/core';
import { loadPack } from './pack-loader.ts';
import { WorldStore } from './storage.ts';

export interface DayRequest {
  settlementId: string;
  day: number;
  storePath: string;
  packPath: string;
}

export function describeSettlementDay(request: DayRequest): string {
  const pack = loadPack(request.packPath);
  const store = new WorldStore(request.storePath);
  let world;
  try {
    world = store.loadWorld();
  } finally {
    store.close();
  }
  const brief = world.settlements.find((entry) => entry.id === request.settlementId);
  if (!brief) throw new Error(`no settlement has the ID "${request.settlementId}"; IDs look like settlement-641`);
  const city = generateCity(brief, pack);
  const layout = generateLayout(city, brief, pack);
  return describeDay(createLife({ city, layout, pack }), request.day, { layout, pack, settlementName: brief.name });
}
