/**
 * Phase 6B.5: how a town is divided into districts. Everyday buildings in
 * every district, housing near work, each tier where it prefers to live, and
 * trades gathered along streets. Buildings are moved, never made.
 *
 * These tests hold exact figures for Badanos as it was generated before phase 6C gave settlements inns, a gaming
 * house and a visitors' quarter, so they run on the pack with those taken out (`medievalPackBefore6C`), which
 * `baselines/city-v4.json` proves gives the same cities. What phase 6C moved is in `visitors.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Building,
  type City,
  type Layout,
  type Lot,
  type SettingPack,
  GENERATOR_VERSION,
  LAYOUT_VERSION,
  LIFE_VERSION,
  checkCity,
  checkLayout,
  createPathFinder,
  generateCity,
  generateLayout,
  geometry,
  parsePack,
} from '../src/index.ts';
import { BEFORE_6B5, lomiaWorld, medievalPackBefore6C as medievalPack, medievalPackBefore6B5, rawMedievalPackBefore6C as rawMedievalPack, settlement } from './pack.ts';

const pack = medievalPack();
const before = medievalPackBefore6B5();
const edited = (edit: (raw: any) => void): SettingPack => {
  const raw = rawMedievalPack();
  edit(raw);
  return parsePack(raw);
};
const spreadTypes = new Set([...pack.workplaces, ...pack.landmarks].filter((type) => type.spread).map((type) => type.id));
const everyday = pack.workplaces.filter((type) => type.spread).map((type) => type.id);
const dwellingTier = new Map(pack.dwellings.map((type) => [type.id, type.status]));
const tierLists = pack.districts.tierDistricts!;

/** A city without the versions its summary records, for comparing what was generated. */
const fingerprint = (city: City) => {
  const { generatorVersion: _version, pack: _pack, ...summary } = city.summary;
  return JSON.stringify({ ...city, summary });
};
/** The pairs of lots that stand side by side or back to back: they share a stretch of boundary. */
function neighbours(layout: Layout): Map<string, Lot[]> {
  const found = new Map<string, Lot[]>(layout.lots.map((lot) => [lot.id, []]));
  const boxed = layout.lots.map((lot) => ({ lot, box: geometry.boxOf(lot.polygon, 0.01) })).sort((a, b) => a.box.minX - b.box.minX);
  for (let i = 0; i < boxed.length; i++) {
    for (let j = i + 1; j < boxed.length && boxed[j]!.box.minX <= boxed[i]!.box.maxX; j++) {
      const a = boxed[i]!;
      const b = boxed[j]!;
      if (a.box.maxY < b.box.minY || b.box.maxY < a.box.minY) continue;
      if (geometry.sharedBoundaryLength(a.lot.polygon, b.lot.polygon) > 0.5) {
        found.get(a.lot.id)!.push(b.lot);
        found.get(b.lot.id)!.push(a.lot);
      }
    }
  }
  return found;
}
/** The district a dwelling's first household's head works in, if they work somewhere other than home. */
function workDistrictOf(city: City) {
  const people = new Map(city.people.map((person) => [person.id, person]));
  const households = new Map(city.households.map((household) => [household.id, household]));
  const buildings = new Map(city.buildings.map((building) => [building.id, building]));
  return (dwelling: Building): string | undefined => {
    const head = people.get(households.get(dwelling.householdIds[0]!)!.headId)!;
    return head.workplaceId === undefined || head.workplaceId === dwelling.id ? undefined : buildings.get(head.workplaceId)!.districtId;
  };
}
/** What a lot is, apart from which building holds it. */
const shape = (lot: Lot) => JSON.stringify([lot.polygon, lot.districtId, lot.entrance, lot.footprints]);

let badanos: City;
let layout: Layout;
beforeAll(() => {
  const brief = settlement('settlement-641');
  badanos = generateCity(brief, pack);
  layout = generateLayout(badanos, brief, pack);
});
const districtTable = (city: City) => {
  const buildings = new Map(city.buildings.map((building) => [building.id, building]));
  return city.districts.map((district) => {
    const types = district.buildingIds.map((id) => buildings.get(id)!.type);
    const count = (...wanted: string[]) => types.filter((type) => wanted.includes(type)).length;
    return {
      name: district.name,
      kind: district.kind,
      residents: city.summary.districtTotals[district.id]!.residents,
      workers: city.summary.districtTotals[district.id]!.workers,
      taverns: count('tavern'),
      bakeries: count('bakery'),
      shops: count('general-shop'),
      chapels: count('chapel'),
      grand: count('mansion', 'noble-house'),
      forgesAndLeather: count('forge', 'leather-shop'),
      tanneries: count('tannery'),
    };
  });
};

describe('the medieval pack\'s districts', () => {
  it('spreads what people use every day, lists where each tier lives, and puts a share of housing near work', () => {
    expect(everyday.sort()).toEqual(['bakery', 'butchery', 'chapel', 'general-shop', 'healers-house', 'tavern']);
    expect(pack.workplaces.find((type) => type.id === 'tannery')).toMatchObject({ district: 'outskirts' });
    expect(pack.workplaces.find((type) => type.id === 'tannery')!.spread).toBeUndefined();
    // The wealthy and the noble: an upper quarter, then the centre, and nowhere else.
    expect(tierLists.wealthy).toEqual(['upper', 'centre']);
    expect(tierLists.noble).toEqual(['upper', 'centre']);
    // The poor: the lower and common quarters before the outskirts.
    expect(tierLists.poor![0]).toEqual(expect.arrayContaining(['lower', 'common']));
    expect(tierLists.poor!.flat().indexOf('outskirts')).toBeGreaterThan(tierLists.poor!.flat().indexOf('common'));
    expect(Object.keys(tierLists).sort()).toEqual(pack.pack.statusTiers.map((tier) => tier.id).sort());
    expect(pack.districts.housingNearWork).toMatchObject({ share: 0.35, kinds: { upper: 0 } });
    expect(pack.pack.homeAndWorkLabel).toBe('{workplace} and home');
    expect([GENERATOR_VERSION, LAYOUT_VERSION, LIFE_VERSION]).toEqual([6, 6, 5]);
  });
});

describe('Badanos, before and after', () => {
  it('has a tavern, a bakery, a shop and a chapel in every district that has residents', () => {
    const table = districtTable(badanos);
    console.table(table);
    for (const district of table) {
      expect(district.residents).toBeGreaterThan(0);
      for (const type of ['taverns', 'bakeries', 'shops', 'chapels'] as const) expect(district[type], `${district.name}: ${type}`).toBeGreaterThanOrEqual(1);
    }
    // They were all in two or three districts before.
    const was = districtTable(generateCity(settlement('settlement-641'), before));
    expect(was.filter((district) => district.taverns === 0 || district.bakeries === 0 || district.shops === 0 || district.chapels === 0)).toHaveLength(6);
    expect(was.filter((district) => district.taverns === 0)).toHaveLength(4);
  });

  it('has no mansion or noble house in the lower quarter or the outskirts', () => {
    const table = districtTable(badanos);
    expect(table.find((district) => district.kind === 'lower')!.grand).toBe(0);
    expect(table.find((district) => district.kind === 'outskirts')!.grand).toBe(0);
    // All ten are in the centre, there being no upper quarter.
    expect(table.filter((district) => district.kind === 'centre').reduce((sum, district) => sum + district.grand, 0)).toBe(10);
    const was = districtTable(generateCity(settlement('settlement-641'), before));
    expect(was.find((district) => district.kind === 'lower')!.grand).toBe(10);
  });

  it('has more work where people live, and more people living where they work', () => {
    const table = districtTable(badanos);
    const fordStreet = table.find((district) => district.name === 'Ford Street')!;
    const upperFields = table.find((district) => district.name === 'Upper Fields')!;
    console.log(`Ford Street: ${fordStreet.workers} people work there, for ${fordStreet.residents} residents (it was 58 for 2,164). Upper Fields: ${upperFields.residents} residents for ${upperFields.workers} jobs (it was 623 for 1,597)`);
    expect(fordStreet.workers).toBeGreaterThan(58 * 2);
    expect(upperFields.residents).toBeGreaterThan(623);
    // No district is a pure dormitory or a pure workshop zone.
    for (const district of table) {
      expect(district.workers / district.residents, district.name).toBeGreaterThan(0.08);
      expect(district.residents / district.workers, district.name).toBeGreaterThan(0.4);
    }
    const living = (city: City) => {
      const building = new Map(city.buildings.map((entry) => [entry.id, entry.districtId]));
      const home = new Map(city.households.map((household) => [household.id, household.dwellingId]));
      const workers = city.people.filter((person) => person.workplaceId !== undefined);
      return workers.filter((person) => building.get(person.workplaceId!) === building.get(home.get(person.householdId)!)).length / workers.length;
    };
    const now = living(badanos);
    const then = living(generateCity(settlement('settlement-641'), before));
    console.log(`Workers living in the district they work in: ${(now * 100).toFixed(1)}% (it was ${(then * 100).toFixed(1)}%)`);
    expect(then).toBeCloseTo(0.303, 2);
    expect(now).toBeGreaterThan(then + 0.03);
  });

  it('reports the average walk to work', () => {
    const walk = (city: City, made: Layout) => {
      const finder = createPathFinder(made);
      const lotOf = new Map(made.lots.map((lot) => [lot.buildingId, lot.id]));
      const home = new Map(city.households.map((household) => [household.id, household.dwellingId]));
      const commuters = city.people.filter((person) => person.workplaceId !== undefined && person.workplaceId !== home.get(person.householdId));
      return commuters.reduce((sum, person) => sum + finder.path(lotOf.get(home.get(person.householdId)!)!, lotOf.get(person.workplaceId!)!).length, 0) / commuters.length;
    };
    const brief = settlement('settlement-641');
    const was = generateCity(brief, before);
    const then = walk(was, generateLayout(was, brief, before, BEFORE_6B5));
    const now = walk(badanos, layout);
    console.log(`Average walk to work in Badanos: ${now.toFixed(0)} m (it was ${then.toFixed(0)} m)`);
    expect(then).toBeCloseTo(670, -1);
    expect(now).toBeLessThan(then * 1.05);
  });

  it('keeps each quarter\'s character: forges and leather shops in the craft quarter, tanneries on the outskirts', () => {
    const table = districtTable(badanos);
    const all = table.reduce((sum, district) => sum + district.forgesAndLeather, 0);
    const craft = table.find((district) => district.kind === 'craft')!;
    console.log(`Forges and leather shops in the craft quarter: ${craft.forgesAndLeather} of the town's ${all}`);
    expect(craft.forgesAndLeather / all).toBeGreaterThan(0.9);
    expect(table.filter((district) => district.kind !== 'outskirts').reduce((sum, district) => sum + district.tanneries, 0)).toBe(0);
    expect(table.find((district) => district.kind === 'outskirts')!.tanneries).toBe(53);
    // The craft quarter is still mostly workshops with homes over them.
    const buildings = badanos.districts.find((district) => district.kind === 'craft')!.buildingIds.map((id) => badanos.buildings.find((building) => building.id === id)!);
    expect(buildings.filter((building) => building.kind === 'both').length / buildings.length).toBeGreaterThan(0.7);
  });

  it('gathers a trade along a street: most working buildings have one of their own type on a neighbouring lot', () => {
    const type = new Map(badanos.buildings.map((building) => [building.id, building]));
    const share = (made: Layout) => {
      const beside = neighbours(made);
      // Working buildings of types that are not spread; a dwelling where a servant works is not a trade.
      const working = made.lots.filter((lot) => ['workplace', 'both'].includes(type.get(lot.buildingId)!.kind) && !spreadTypes.has(type.get(lot.buildingId)!.type) && !dwellingTier.has(type.get(lot.buildingId)!.type));
      const together = working.filter((lot) => beside.get(lot.id)!.some((other) => type.get(other.buildingId)!.type === type.get(lot.buildingId)!.type));
      // The most that could be: those with any neighbouring lot of the same size and cover, to change places with.
      const alike = (lot: Lot) => JSON.stringify([geometry.boxOf(lot.polygon).maxX - geometry.boxOf(lot.polygon).minX, geometry.polygonArea(lot.polygon), lot.footprints.map(geometry.polygonArea)].map((value) => JSON.stringify(value).replace(/\.\d+/g, '')));
      const could = working.filter((lot) => beside.get(lot.id)!.some((other) => alike(other) === alike(lot)));
      return { share: together.length / working.length, cap: could.length / working.length, working: working.length };
    };
    const now = share(layout);
    const then = share(generateLayout(badanos, settlement('settlement-641'), pack, BEFORE_6B5));
    console.log(`Working buildings in Badanos beside one of their own type: ${(now.share * 100).toFixed(1)}% of ${now.working} (it was ${(then.share * 100).toFixed(1)}%; at most ${(now.cap * 100).toFixed(1)}% have a like lot beside them at all)`);
    // The gameplan's estimate was 70%. With the lots themselves held as they were, a building can only change
    // places with one whose lot is alike, and types with lots of their own size (tanneries, yards, stalls) stand
    // scattered among other lots. The figure reached is reported; see the README.
    expect(now.share).toBeGreaterThan(0.55);
    expect(now.share).toBeGreaterThan(then.share * 2);
    expect(now.share).toBeGreaterThan(now.cap * 0.9);
  });
});

describe('the Badanos baseline for generator version 4', () => {
  const saved = JSON.parse(readFileSync(new URL('./baselines/badanos-districts-v4.json', import.meta.url), 'utf8'));
  const counts = JSON.parse(readFileSync(new URL('./baselines/badanos-counts-v3.json', import.meta.url), 'utf8'));

  it('records where every kind of building stands now, and where it stood before', () => {
    expect(saved).toMatchObject({ settlementId: 'settlement-641', generatorVersion: 4, seed: badanos.summary.seed });
    expect(saved.note).toMatch(/No person, household, job or building was added, removed or changed/);
    const pick = ({ name, kind, residents, workers, taverns, bakeries, shops, chapels, grand, forgesAndLeather, tanneries }: ReturnType<typeof districtTable>[number]) => ({ name, kind, residents, workers, taverns, bakeries, shops, chapels, mansionsAndNobleHouses: grand, forgesAndLeatherShops: forgesAndLeather, tanneries });
    const strip = ({ buildings: _buildings, ...row }: Record<string, unknown>) => row;
    expect(districtTable(badanos).map(pick)).toEqual(saved.districts.map(strip));
    expect(districtTable(generateCity(settlement('settlement-641'), before)).map(pick)).toEqual(saved.before.map(strip));
    expect(badanos.buildings.filter((building, index) => building.districtId !== generateCity(settlement('settlement-641'), before).buildings[index]!.districtId)).toHaveLength(saved.buildingsThatChangedDistrict);
  });

  it('leaves population, workforce, categories and every occupation count as the version 3 baseline has them', () => {
    expect(badanos.summary.population).toBe(counts.population);
    expect(badanos.summary.workforce.working).toBe(counts.workforce);
    expect(badanos.summary.categories).toEqual(counts.categories);
    expect(badanos.summary.occupations).toEqual(counts.occupations);
    expect(badanos.buildings).toHaveLength(counts.buildings);
  });
});

describe('every settlement of Lomia', () => {
  it('has nothing created or destroyed, every tier where it prefers, and everyday buildings in every district', () => {
    const failures: string[] = [];
    const versionThree = createHash('sha256');
    let badanosBefore = '';
    let moved = 0;
    let nearWork = 0;
    let spreadChecked = 0;
    let besideEachOther = 0;
    let spreadBuildings = 0;
    let wells = 0;
    let wellsInARow = 0;
    for (const brief of lomiaWorld().settlements) {
      const fail = (text: string) => failures.push(`${brief.id} (${brief.population}): ${text}`);
      const was = generateCity(brief, before);
      const city = generateCity(brief, pack);
      const text = fingerprint(was);
      versionThree.update(text);
      if (brief.id === 'settlement-641') badanosBefore = createHash('sha256').update(text).digest('hex');

      // ---- Nothing created or destroyed: only districts differ.
      if (JSON.stringify(city.people) !== JSON.stringify(was.people)) fail('a person changed');
      if (JSON.stringify(city.households) !== JSON.stringify(was.households)) fail('a household changed, or moved to another building');
      if (city.buildings.length !== was.buildings.length) fail('the number of buildings changed');
      city.buildings.forEach((building, index) => {
        const { districtId, ...rest } = building;
        const { districtId: old, ...restBefore } = was.buildings[index]!;
        if (JSON.stringify(rest) !== JSON.stringify(restBefore)) fail(`${building.id} changed in more than its district`);
        if (districtId !== old) moved++;
      });
      for (const key of ['population', 'workforce', 'categories', 'occupations', 'statusTiers', 'households', 'buildings', 'districts'] as const) {
        if (JSON.stringify(city.summary[key]) !== JSON.stringify(was.summary[key])) fail(`the summary's ${key} changed`);
      }
      if (JSON.stringify(city.districts.map(({ buildingIds: _ids, ...district }) => district)) !== JSON.stringify(was.districts.map(({ buildingIds: _ids, ...district }) => district))) fail('a district changed in more than its buildings');
      failures.push(...checkCity(city, brief, pack).map((problem) => `${brief.id}: ${problem}`));

      // ---- Tiers: no dwelling in a kind of district its tier's list ranks below one the settlement has.
      const kindOf = new Map(city.districts.map((district) => [district.id, district.kind]));
      const has = new Set(kindOf.values());
      const workDistrict = workDistrictOf(city);
      for (const building of city.buildings) {
        const tier = dwellingTier.get(building.type);
        if (tier === undefined || building.householdIds.length === 0) continue;
        const kind = kindOf.get(building.districtId)!;
        const list = tierLists[tier]!.map((entry) => (typeof entry === 'string' ? [entry] : entry));
        const best = list.find((entry) => entry.some((wanted) => has.has(wanted)));
        if (!best || best.includes(kind)) continue;
        // Unless it stands where the head of its first household works, in a kind the tier lives in at all.
        if (workDistrict(building) === building.districtId && list.flat().includes(kind)) {
          nearWork++;
          continue;
        }
        fail(`${building.id}, a ${building.type}, is in a ${kind} district though the settlement has ${best.join(' or ')}`);
      }

      // ---- Spread: each everyday type in every district that has residents, where there are enough to go round.
      const typeOf = new Map(city.buildings.map((building) => [building.id, building.type]));
      const lived = city.districts.filter((district) => city.summary.districtTotals[district.id]!.residents > 0);
      for (const type of spreadTypes) {
        const total = city.buildings.filter((building) => building.type === type).length;
        if (total === 0 || total < lived.length) continue;
        spreadChecked++;
        for (const district of lived) {
          if (!district.buildingIds.some((id) => typeOf.get(id) === type)) fail(`${district.id} has residents but no ${type}, though the settlement has ${total}`);
        }
      }

      // ---- Layout: the same streets, lots and footprints as layout version 2; only which building holds which lot differs.
      const made = generateLayout(city, brief, pack);
      const plain = generateLayout(city, brief, pack, BEFORE_6B5);
      const { lots, summary, ...rest } = made;
      const { lots: plainLots, summary: plainSummary, ...plainRest } = plain;
      if (JSON.stringify(rest) !== JSON.stringify(plainRest)) fail('the street graph, the water or the district areas differ from layout version 2');
      if (JSON.stringify({ ...summary, layoutVersion: 0 }) !== JSON.stringify({ ...plainSummary, layoutVersion: 0 })) fail('the layout summary differs');
      if (JSON.stringify(lots.map(shape).sort()) !== JSON.stringify(plainLots.map(shape).sort())) fail('the lots or their footprints differ from layout version 2');
      if (JSON.stringify(lots.map((lot) => [lot.id, lot.buildingId])) !== JSON.stringify(plainLots.map((lot) => [lot.id, lot.buildingId]))) fail('a lot is numbered differently');
      failures.push(...checkLayout(made, city, brief, pack).map((problem) => `${brief.id}: ${problem}`));
      // Within a district, no two buildings of a spread type on neighbouring lots.
      const beside = neighbours(made);
      for (const lot of lots) {
        const type = typeOf.get(lot.buildingId)!;
        if (!spreadTypes.has(type)) continue;
        const together = beside.get(lot.id)!.some((other) => typeOf.get(other.buildingId) === type && other.districtId === lot.districtId);
        // Wells are counted apart: see below.
        if (type === 'well') {
          wells++;
          if (together) wellsInARow++;
          continue;
        }
        spreadBuildings++;
        if (together) besideEachOther++;
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    // Without spread types, housing near work or tier lists, every city is the one generator version 3 made.
    const baseline = JSON.parse(readFileSync(new URL('./baselines/city-v3.json', import.meta.url), 'utf8')) as { badanos: string; all: string };
    expect(badanosBefore).toBe(baseline.badanos);
    expect(versionThree.digest('hex')).toBe(baseline.all);
    console.log(
      `Across Lomia ${moved.toLocaleString('en-US')} buildings changed district; ${nearWork.toLocaleString('en-US')} dwellings stand near work outside their tier's first choice; ` +
        `${besideEachOther} of ${spreadBuildings.toLocaleString('en-US')} taverns, bakeries, butcheries, shops, chapels, healers' houses and public ovens have one of their own type on a neighbouring lot; ` +
        `so do ${wellsInARow.toLocaleString('en-US')} of ${wells.toLocaleString('en-US')} wells`,
    );
    expect(moved).toBeGreaterThan(50_000);
    expect(nearWork).toBeGreaterThan(5000);
    expect(spreadChecked).toBeGreaterThan(2000);
    expect(spreadBuildings).toBeGreaterThan(30_000);
    // Everyday buildings stand apart from their own type wherever a lot that would allow it exists. The few that do
    // not are chapels, whose lots are of a size no other building has, so that a district's chapels can only change
    // places with each other, and the odd butcher or tavern in a district with hardly any like lots.
    expect(besideEachOther / spreadBuildings).toBeLessThan(0.015);
    // Wells stood in a row until layout version 4 (phase 6C), because landmarks took their lots first and only a
    // well has a lot of a well's size. They are now placed at even steps as the district grows, each on a street
    // that has none yet: outsiders.test.ts holds that rule for every settlement.
    expect(wellsInARow).toBe(0);
  });
});

describe('pack behaviour', () => {
  const brief = () => settlement('settlement-641');
  /** The dwellings that housing near work can move: plain ones whose first household's head works somewhere else. */
  const eligible = (city: City) => {
    const workDistrict = workDistrictOf(city);
    return city.buildings.filter((building) => dwellingTier.has(building.type) && building.householdIds.length > 0 && building.workerIds.length === 0 || (dwellingTier.has(building.type) && building.householdIds.length > 0)).filter((building) => workDistrict(building) !== undefined);
  };

  it('moves no dwelling for the sake of work when the share is 0', () => {
    const none = generateCity(brief(), edited((raw) => (raw.districts.housingNearWork = { share: 0 })));
    const absent = generateCity(brief(), edited((raw) => delete raw.districts.housingNearWork));
    expect(fingerprint(none)).toBe(fingerprint(absent));
    // Every dwelling is then where its tier prefers.
    const kindOf = new Map(none.districts.map((district) => [district.id, district.kind]));
    const has = new Set(kindOf.values());
    for (const building of none.buildings) {
      const tier = dwellingTier.get(building.type);
      if (tier === undefined || building.householdIds.length === 0) continue;
      const best = tierLists[tier]!.map((entry) => (typeof entry === 'string' ? [entry] : entry)).find((entry) => entry.some((wanted) => has.has(wanted)))!;
      expect(best, building.id).toContain(kindOf.get(building.districtId));
    }
  });

  it('moves every eligible dwelling when the share is 1', () => {
    const all = generateCity(brief(), edited((raw) => (raw.districts.housingNearWork = { share: 1 })));
    const kindOf = new Map(all.districts.map((district) => [district.id, district.kind]));
    const workDistrict = workDistrictOf(all);
    let moved = 0;
    let barred = 0;
    for (const building of eligible(all)) {
      const kind = kindOf.get(workDistrict(building)!)!;
      // Eligible: the tier lives in that kind of district at all.
      if (!tierLists[dwellingTier.get(building.type)!]!.flat().includes(kind)) {
        barred++;
        expect(building.districtId).not.toBe(workDistrict(building));
        continue;
      }
      expect(building.districtId, building.id).toBe(workDistrict(building));
      moved++;
    }
    expect(moved).toBeGreaterThan(500);
    // The wealthy are never moved to the outskirts or the lower quarter for the sake of work.
    expect(barred).toBeGreaterThan(0);
    // With the pack's own share, some are and some are not.
    const some = eligible(badanos).filter((building) => building.districtId === workDistrictOf(badanos)(building)).length;
    expect(some).toBeGreaterThan(moved * 0.25);
    expect(some).toBeLessThan(moved * 0.8);
  });

  it('closes a kind of district to housing near work when its share is 0', () => {
    const closed = generateCity(brief(), edited((raw) => (raw.districts.housingNearWork = { share: 1, kinds: { outskirts: 0 } })));
    const open = generateCity(brief(), edited((raw) => (raw.districts.housingNearWork = { share: 1 })));
    const residents = (city: City) => city.summary.districtTotals[city.districts.find((district) => district.kind === 'outskirts')!.id]!.residents;
    expect(residents(closed)).toBeLessThan(residents(open));
    // Nobody is in the outskirts but those whose tier puts them there, or who live in their workplace.
    const kindOf = new Map(closed.districts.map((district) => [district.id, district.kind]));
    const has = new Set(kindOf.values());
    for (const building of closed.buildings.filter((entry) => kindOf.get(entry.districtId) === 'outskirts' && dwellingTier.has(entry.type) && entry.householdIds.length > 0)) {
      const best = tierLists[dwellingTier.get(building.type)!]!.map((entry) => (typeof entry === 'string' ? [entry] : entry)).find((entry) => entry.some((wanted) => has.has(wanted)))!;
      expect(best, building.id).toContain('outskirts');
    }
  });

  it('puts a spread type back in the kind of district it prefers when it is no longer spread', () => {
    const gathered = generateCity(brief(), edited((raw) => delete raw.workplaces.find((type: any) => type.id === 'tavern').spread));
    const kindOf = new Map(gathered.districts.map((district) => [district.id, district.kind]));
    expect(new Set(gathered.buildings.filter((building) => building.type === 'tavern').map((building) => kindOf.get(building.districtId)))).toEqual(new Set(['centre']));
    const bakers = new Set(gathered.buildings.filter((building) => building.type === 'bakery').map((building) => kindOf.get(building.districtId)));
    expect(bakers.size).toBeGreaterThan(4);
  });

  it('follows a tier list: the noble go to the outskirts if the pack says so', () => {
    const odd = generateCity(brief(), edited((raw) => {
      raw.districts.tierDistricts.noble = ['outskirts'];
      raw.districts.tierDistricts.wealthy = ['outskirts'];
      delete raw.districts.housingNearWork;
    }));
    const kindOf = new Map(odd.districts.map((district) => [district.id, district.kind]));
    expect(new Set(odd.buildings.filter((building) => ['mansion', 'noble-house'].includes(building.type)).map((building) => kindOf.get(building.districtId)))).toEqual(new Set(['outskirts']));
  });
});

describe('determinism', () => {
  it('gives byte-identical cities and layouts for the same inputs', () => {
    const brief = settlement('settlement-641');
    const again = generateCity(brief, pack);
    expect(JSON.stringify(again)).toBe(JSON.stringify(badanos));
    expect(JSON.stringify(generateLayout(again, brief, pack))).toBe(JSON.stringify(layout));
    // A different seed draws different dwellings to live near work.
    const other = generateCity(brief, pack, { seed: 7 });
    expect(JSON.stringify(other.buildings.map((building) => building.districtId))).not.toBe(JSON.stringify(badanos.buildings.map((building) => building.districtId)));
  });
});
