/**
 * Phase 6B: civic buildings that a settlement has by its size.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { type City, type Landmark, type SettingPack, GENERATOR_VERSION, allOccupations, checkCity, generateCity, generateLayout, parsePack, placeFlagsOf, resolveCount } from '../src/index.ts';
import { BEFORE_6B5, lomiaWorld, medievalPack, medievalPackBefore6B, rawMedievalPack, settlement } from './pack.ts';

const SLOW = 180_000;
const pack = medievalPack();
/** The civic buildings: those no flag grants. */
const civic = pack.landmarks.filter((landmark) => landmark.when === undefined);
const edited = (edit: (raw: any) => void): SettingPack => {
  const raw = rawMedievalPack();
  edit(raw);
  return parsePack(raw);
};
/** The pack as it was before phase 6B: no civic buildings, and nothing that sends anyone to one. */
const before = medievalPackBefore6B();
const countOf = (city: City, type: string) => city.buildings.filter((building) => building.type === type).length;
const staffOf = (city: City, landmark: Landmark) => landmark.posts.reduce((sum, post) => sum + (city.summary.occupations[post.occupation] ?? 0), 0);

let badanos: City;
beforeAll(() => {
  badanos = generateCity(settlement('settlement-641'), pack);
});

describe('the medieval pack\'s civic buildings', () => {
  it('are the first set: wells, an oven, a bathhouse, a granary, an infirmary, a town hall, a guild hall and an adventurers\' guild hall', () => {
    expect(civic.map((landmark) => landmark.id).sort()).toEqual(['adventurers-guild', 'bathhouse', 'granary', 'guild-hall', 'infirmary', 'public-oven', 'town-hall', 'well']);
    const well = civic.find((landmark) => landmark.id === 'well')!;
    expect(well).toMatchObject({ spread: true, posts: [] });
    expect(placeFlagsOf('well', pack)).toEqual({ openAir: true, alwaysOpen: true });
    // Every staffed one has occupations of its own, and a lot size.
    for (const landmark of civic) {
      expect(pack.layout.lots[landmark.id], landmark.id).toBeDefined();
      for (const post of landmark.posts) expect(allOccupations(pack).find((occupation) => occupation.id === post.occupation)!.workplace).toBe(landmark.id);
    }
    expect(GENERATOR_VERSION).toBe(4);
  });
});

describe('civic buildings in Badanos', () => {
  it('appear in the numbers the pack\'s rules give for 9,607 residents', () => {
    expect(Object.fromEntries(civic.map((landmark) => [landmark.id, countOf(badanos, landmark.id)]))).toEqual({
      well: 38,
      'public-oven': 6,
      bathhouse: 2,
      granary: 1,
      infirmary: 1,
      'town-hall': 1,
      'guild-hall': 1,
      'adventurers-guild': 1,
    });
    for (const landmark of civic) expect(countOf(badanos, landmark.id), landmark.id).toBe(resolveCount(landmark.count, 9607));
  });

  it('are staffed from their own posts, and a well by nobody', () => {
    for (const building of badanos.buildings.filter((entry) => entry.type === 'well')) expect(building.workerIds).toEqual([]);
    for (const landmark of civic.filter((entry) => entry.posts.length > 0)) {
      const buildings = badanos.buildings.filter((entry) => entry.type === landmark.id);
      expect(buildings.reduce((sum, building) => sum + building.workerIds.length, 0), landmark.id).toBe(staffOf(badanos, landmark));
      expect(buildings.every((building) => building.workerIds.length > 0), landmark.id).toBe(true);
      for (const post of landmark.posts) expect(badanos.summary.occupations[post.occupation], post.occupation).toBe(resolveCount(post.count, 9607));
    }
  });

  it('spread wells and ovens across the districts in proportion to their residents', () => {
    const typeOf = new Map(badanos.buildings.map((building) => [building.id, building.type]));
    const residents = badanos.districts.map((district) => badanos.summary.districtTotals[district.id]!.residents);
    for (const type of ['well', 'public-oven']) {
      const counts = badanos.districts.map((district) => district.buildingIds.filter((id) => typeOf.get(id) === type).length);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(countOf(badanos, type));
      // Every district has one, and none has them all.
      expect(Math.min(...counts), type).toBeGreaterThanOrEqual(1);
      expect(Math.max(...counts), type).toBeLessThan(countOf(badanos, type));
      // A district with more residents never has fewer.
      badanos.districts.forEach((_, a) => badanos.districts.forEach((__, b) => {
        if (residents[a]! > residents[b]!) expect(counts[a]!, type).toBeGreaterThanOrEqual(counts[b]!);
      }));
    }
    // About one well for every 250 residents, district by district.
    const wells = badanos.districts.map((district) => district.buildingIds.filter((id) => typeOf.get(id) === 'well').length);
    wells.forEach((count, index) => expect(Math.abs(count - residents[index]! / 250)).toBeLessThan(1.5));
    // Each district lists its buildings in ID order still.
    for (const district of badanos.districts) expect([...district.buildingIds].sort()).toEqual(district.buildingIds);
  });

  it('follow the pack: one well for very many residents leaves one, and a higher minimum takes the bathhouse away', () => {
    const few = generateCity(settlement('settlement-641'), edited((raw) => (raw.landmarks.find((entry: any) => entry.id === 'well').count = { perResidents: 1_000_000 })));
    expect(countOf(few, 'well')).toBe(0);
    const none = generateCity(settlement('settlement-641'), edited((raw) => (raw.landmarks.find((entry: any) => entry.id === 'bathhouse').minPopulation = 20_000)));
    expect(countOf(none, 'bathhouse')).toBe(0);
    expect(none.summary.occupations['bath-keeper']).toBeUndefined();
    expect(none.summary.categories).toEqual(badanos.summary.categories);
    const many = generateCity(settlement('settlement-641'), edited((raw) => (raw.landmarks.find((entry: any) => entry.id === 'well').count = { perResidents: 100, min: 1 })));
    expect(countOf(many, 'well')).toBe(96);
  });
});

describe('civic buildings in every settlement of Lomia', () => {
  it('leave population, workforce and category counts as they were, appear by the pack\'s rules, and are spread', { timeout: SLOW }, () => {
    const failures: string[] = [];
    let wells = 0;
    let withBathhouse = 0;
    let checkedSpread = 0;
    // The layout of each city as it was before civic buildings, to compare with a fingerprint of layout version 1.
    const versionOne = createHash('sha256');
    for (const brief of lomiaWorld().settlements) {
      const city = generateCity(brief, pack);
      const was = generateCity(brief, before);
      const { summary: _summary, ...rest } = generateLayout(was, brief, before, BEFORE_6B5);
      versionOne.update(JSON.stringify({ ...rest, lots: rest.lots.map(({ footprints: _footprints, ...lot }) => lot) }));
      const fail = (text: string) => failures.push(`${brief.id} (${brief.population}): ${text}`);
      // Unchanged by the civic buildings: who lives here, how many work, and in which categories.
      if (city.summary.population !== was.summary.population || city.people.length !== was.people.length) fail('the population moved');
      if (JSON.stringify(city.summary.workforce) !== JSON.stringify(was.summary.workforce)) fail('the workforce moved');
      if (JSON.stringify(city.summary.categories) !== JSON.stringify(was.summary.categories)) fail('the category counts moved');
      failures.push(...checkCity(city, brief, pack).map((problem) => `${brief.id}: ${problem}`));
      for (const landmark of civic) {
        const count = countOf(city, landmark.id);
        if ((landmark.minPopulation ?? 0) > brief.population) {
          if (count !== 0) fail(`has ${count} ${landmark.id} below its minimum population of ${landmark.minPopulation}`);
          continue;
        }
        // The count the rule gives; a staffed building exists if it has any staff at all.
        const expected = Math.max(resolveCount(landmark.count, brief.population), staffOf(city, landmark) > 0 ? 1 : 0);
        if (count !== expected) fail(`has ${count} ${landmark.id}, not the ${expected} its rule gives`);
      }
      wells += countOf(city, 'well');
      if (countOf(city, 'bathhouse') > 0) withBathhouse++;
      // Spread: where there are at least as many as districts with residents, every such district has one.
      const typeOf = new Map(city.buildings.map((building) => [building.id, building.type]));
      const lived = city.districts.filter((district) => city.summary.districtTotals[district.id]!.residents > 0);
      for (const landmark of civic.filter((entry) => entry.spread)) {
        const total = countOf(city, landmark.id);
        if (total < lived.length || total === 0) continue;
        checkedSpread++;
        for (const district of lived) {
          if (!district.buildingIds.some((id) => typeOf.get(id) === landmark.id)) fail(`${district.id} has residents but no ${landmark.id}, though the settlement has ${total}`);
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    // Without civic buildings every city is the one generator version 2 made, laid out as at layout version 1.
    const baseline = JSON.parse(readFileSync(new URL('./baselines/layout-v1.json', import.meta.url), 'utf8')) as { all: string };
    expect(versionOne.digest('hex')).toBe(baseline.all);
    expect(wells).toBeGreaterThan(10_000);
    expect(withBathhouse).toBeGreaterThan(100);
    expect(withBathhouse).toBeLessThan(682);
    expect(checkedSpread).toBeGreaterThan(682);
  });

  it('give even the smallest settlement a well, and lay it out', () => {
    const smallest = [...lomiaWorld().settlements].sort((a, b) => a.population - b.population)[0]!;
    const city = generateCity(smallest, pack);
    expect(countOf(city, 'well')).toBe(1);
    expect(countOf(city, 'town-hall')).toBe(0);
    const layout = generateLayout(city, smallest, pack);
    expect(layout.lots).toHaveLength(city.buildings.length);
  });
});
