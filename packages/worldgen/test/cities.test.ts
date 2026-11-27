/**
 * Phase 7A, step 5: the city generator and the pack's layout on five settlements of a world made from a seed
 * (`fixtures/worlds/continents-20000.json`): its largest capital, a port, a river town, a village and a walled
 * town, each the largest of its kind. Every one keeps every layout invariant.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { type SettlementBrief, type World, checkLayout, generateCity, generateLayout } from '@worldsim/core';
import { medievalPack } from '../../core/test/pack.ts';
import { createWorld, newWorldOptions } from '../src/index.ts';

const pack = medievalPack();
const below = pack.layout.village?.below ?? 0;
const saved = JSON.parse(readFileSync(new URL('../../../fixtures/worlds/continents-20000.json', import.meta.url), 'utf8'));

const KINDS: Array<[string, (brief: SettlementBrief) => boolean]> = [
  ['capital', (brief) => brief.flags.capital],
  ['port', (brief) => brief.flags.port && !brief.flags.capital],
  ['river town', (brief) => brief.river !== undefined && !brief.flags.port && !brief.flags.capital],
  ['village', (brief) => brief.population < below],
  ['walled town', (brief) => brief.flags.walls && !brief.flags.capital],
];

let world: World;
const chosen = new Map<string, SettlementBrief>();

beforeAll(async () => {
  world = await createWorld(...newWorldOptions(saved.options));
  const largestFirst = [...world.settlements].sort((a, b) => b.population - a.population || a.id.localeCompare(b.id));
  for (const [kind, fits] of KINDS) {
    const brief = largestFirst.find((entry) => fits(entry) && ![...chosen.values()].includes(entry));
    if (brief) chosen.set(kind, brief);
  }
});

describe('towns of a world made from a seed', () => {
  it('has a settlement of each kind', () => {
    expect([...chosen.keys()]).toEqual(KINDS.map(([kind]) => kind));
  });

  it.each(KINDS.map(([kind]) => kind))('lays out its %s keeping every layout invariant', (kind) => {
    const brief = chosen.get(kind)!;
    const city = generateCity(brief, pack);
    const layout = generateLayout(city, brief, pack, { check: false });
    expect(layout.summary.generator).toBe(kind === 'village' ? 'village' : 'staged');
    expect(checkLayout(layout, city, brief, pack), `${brief.name} (${brief.id})`).toEqual([]);
  });
});
