/**
 * The render command: draws a settlement's layout to an SVG file, with no people, for judging it by eye.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type LayoutGenerator, generateCity, generateLayout, renderLayoutSvg } from '@worldsim/core';
import { loadPack } from './pack-loader.ts';
import { WorldStore } from './storage.ts';

export interface RenderRequest {
  settlementId: string;
  storePath: string;
  packPath: string;
  /** Left out, the generator the pack names. */
  generator?: LayoutGenerator;
  seed?: number;
  /** Where the picture is written. Left out, nothing is written and the text is only returned. */
  outPath?: string;
}

export function renderSettlement(request: RenderRequest): { svg: string; generator: string; lots: number } {
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
  // The seed, where one is given, is for the layout alone: the city is the one the settlement has.
  const city = generateCity(brief, pack);
  const layout = generateLayout(city, brief, pack, { ...(request.generator && { generator: request.generator }), ...(request.seed !== undefined && { seed: request.seed }) });
  const svg = renderLayoutSvg(layout, { brief, districtNames: Object.fromEntries(city.districts.map((district) => [district.id, district.name])) });
  if (request.outPath !== undefined) {
    mkdirSync(dirname(request.outPath), { recursive: true });
    writeFileSync(request.outPath, svg);
  }
  return { svg, generator: layout.summary.generator, lots: layout.lots.length };
}
