/**
 * Phase 6C, changes 2 and 3: a town's draw, its inns, and the visitors' quarter.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type City,
  type SettingPack,
  type SettlementBrief,
  CATEGORY_IDS,
  CONDITIONS,
  GENERATOR_VERSION,
  PackError,
  arrivalRate,
  checkCity,
  checkLayout,
  drawOf,
  expectedTravellers,
  generateCity,
  generateLayout,
  parsePack,
  placeFlagsOf,
  resolveCount,
} from '../src/index.ts';
import { lomiaWorld, medievalPack, medievalPackBefore6C, rawMedievalPack, settlement } from './pack.ts';

const pack = medievalPack();
const rules = pack.travellers!;
const quarter = pack.districts.kinds.find((kind) => kind.whenDraw !== undefined)!;
const read = (name: string) => JSON.parse(readFileSync(new URL(`./baselines/${name}`, import.meta.url), 'utf8'));
const edited = (edit: (raw: any) => void): SettingPack => {
  const raw = rawMedievalPack();
  edit(raw);
  return parsePack(raw);
};
/** A made-up settlement: Vereceldo's brief with some of it replaced. */
const madeUp = (changes: Partial<SettlementBrief>): SettlementBrief => ({
  ...settlement('settlement-455'),
  flags: { capital: false, port: false, citadel: false, walls: false, plaza: false, temple: false, shantyTown: false },
  isProvinceSeat: false,
  specialtyTags: [],
  ...changes,
});
const tourist = rules.kinds.find((kind) => kind.id === 'tourist')!;
const countOf = (city: City, type: string) => city.buildings.filter((building) => building.type === type).length;

describe('a settlement\'s draw', () => {
  it('is the sum of its terms, which say why', () => {
    const pombal = drawOf(settlement('settlement-5'), pack);
    expect(pombal.terms.map((term) => term.term)).toEqual(['capital', 'port', 'citadel', 'walls', 'plaza', 'temple', 'provinceSeat', 'population', 'specialties']);
    expect(pombal.total).toBeCloseTo(pombal.terms.reduce((sum, term) => sum + term.value, 0), 10);
    expect(pombal.terms.find((term) => term.term === 'capital')!.value).toBe(rules.draw.conditions.capital);
    // 47,603 residents: 0.25 a thousand.
    expect(pombal.terms.find((term) => term.term === 'population')!.value).toBeCloseTo(47.603 * rules.draw.population.perThousand, 10);
    expect(pombal).toMatchObject({ floor: rules.draw.floor, attracts: true });
    // A term that adds nothing is left out.
    expect(drawOf(madeUp({ population: 100 }), pack).terms.map((term) => term.term)).toEqual(['population']);
  });

  it('puts a village of 100 with no flags and no specialty below the floor, where no tourist is expected', () => {
    const village = madeUp({ population: 100 });
    expect(drawOf(village, pack)).toMatchObject({ attracts: false });
    expect(drawOf(village, pack).total).toBeLessThan(rules.draw.floor);
    for (let weekday = 0; weekday < pack.calendar.week.length; weekday++) expect(arrivalRate(tourist, village, pack, weekday)).toBe(0);
  });

  it('puts a town of 40,000 with no flags above the floor, by its population alone, where tourists are expected', () => {
    const town = madeUp({ population: 40_000 });
    expect(drawOf(town, pack)).toMatchObject({ attracts: true });
    expect(drawOf(town, pack).terms.map((term) => term.term)).toEqual(['population']);
    expect(arrivalRate(tourist, town, pack, 0)).toBeGreaterThan(0);
  });

  it('is never lowered by adding a flag, in any settlement of Lomia', () => {
    for (const brief of lomiaWorld().settlements) {
      const base = drawOf(brief, pack).total;
      for (const condition of CONDITIONS) {
        const more = condition === 'provinceSeat' ? { ...brief, isProvinceSeat: true } : { ...brief, flags: { ...brief.flags, [condition]: true } };
        expect(drawOf(more, pack).total, `${brief.id} with ${condition}`).toBeGreaterThanOrEqual(base);
      }
    }
  });

  it('is higher for Pombal than for Badanos, and higher for Badanos than for Vereceldo', () => {
    const [pombal, badanos, vereceldo] = ['settlement-5', 'settlement-641', 'settlement-455'].map((id) => drawOf(settlement(id), pack).total) as [number, number, number];
    console.log(`Draw: Pombal ${pombal.toFixed(1)}, Badanos ${badanos.toFixed(1)}, Vereceldo ${vereceldo.toFixed(1)}; the floor is ${rules.draw.floor} and a visitors' quarter needs ${quarter.whenDraw}`);
    expect(pombal).toBeGreaterThan(badanos);
    expect(badanos).toBeGreaterThan(vereceldo);
  });

  it('is nothing under a pack with no travellers file', () => {
    expect(drawOf(settlement('settlement-5'), medievalPackBefore6C())).toEqual({ total: 0, floor: 0, attracts: false, terms: [] });
    expect(expectedTravellers(settlement('settlement-5'), medievalPackBefore6C())).toBe(0);
  });
});

describe('travellers expected in a day', () => {
  it('follow the residents, the exits by kind of route, the draw and the day of the week', () => {
    const merchant = rules.kinds.find((kind) => kind.id === 'merchant')!;
    const badanos = settlement('settlement-641');
    // Badanos: 9,607 residents and two trail exits.
    expect(arrivalRate(merchant, badanos, pack, 0)).toBeCloseTo(9.607 * merchant.arrivals.perThousandResidents! + 2 * merchant.arrivals.perExit!.trail!, 10);
    const marketday = pack.calendar.week.findIndex((entry) => entry.name === 'Marketday');
    expect(arrivalRate(merchant, badanos, pack, marketday)).toBeCloseTo(arrivalRate(merchant, badanos, pack, 0) * merchant.arrivals.weekdays!.Marketday!, 10);
    // A road brings more than a trail.
    expect(arrivalRate(merchant, { ...badanos, routes: badanos.routes.map((exit) => ({ ...exit, kind: 'road' as const })) }, pack, 0)).toBeGreaterThan(arrivalRate(merchant, badanos, pack, 0));
    // Nobody arrives where no route leads.
    expect(arrivalRate(merchant, { ...badanos, routes: [] }, pack, 0)).toBe(0);
    expect(expectedTravellers(settlement('settlement-5'), pack)).toBeGreaterThan(expectedTravellers(badanos, pack));
  });

  it('give a count that is nothing where none are expected, whatever its least', () => {
    expect(resolveCount({ perTravellers: 12, min: 1 }, 5000, 0)).toBe(0);
    expect(resolveCount({ perTravellers: 12, min: 1 }, 5000, 2)).toBe(1);
    expect(resolveCount({ perTravellers: 12, min: 1 }, 5000, 60)).toBe(5);
    expect(resolveCount({ perTravellers: 12, max: 3 }, 5000, 60)).toBe(3);
    // The counts by residents are as they were.
    expect(resolveCount({ perResidents: 250, min: 1 }, 9607)).toBe(38);
  });
});

describe('inns and the gaming house in Badanos', () => {
  let badanos: City;
  beforeAll(() => {
    badanos = generateCity(settlement('settlement-641'), pack);
  });

  it('are landmarks the pack counts by travellers and by size, with posts of their own', () => {
    const inn = pack.landmarks.find((landmark) => landmark.id === 'inn')!;
    expect(inn).toMatchObject({ proprietorLivesIn: true, count: { perTravellers: 12, min: 1 } });
    expect(inn.posts.map((post) => post.occupation)).toEqual(['innkeeper', 'inn-servant', 'chambermaid']);
    // A guest comes and goes at any hour.
    expect(placeFlagsOf('inn', pack)).toEqual({ openAir: false, alwaysOpen: true });
    expect(quarter).toMatchObject({ id: 'visitors', types: ['inn', 'players-hall', 'gaming-house'] });
    expect(GENERATOR_VERSION).toBe(6);
  });

  it('number two inns for the 20 travellers a day its rules expect, each kept by an innkeeper whose household lives in it', () => {
    const expected = expectedTravellers(settlement('settlement-641'), pack);
    expect(countOf(badanos, 'inn')).toBe(resolveCount({ perTravellers: 12, min: 1 }, 9607, expected));
    expect(countOf(badanos, 'inn')).toBe(2);
    const people = new Map(badanos.people.map((person) => [person.id, person]));
    const households = new Map(badanos.households.map((household) => [household.id, household]));
    for (const inn of badanos.buildings.filter((building) => building.type === 'inn')) {
      expect(inn.kind).toBe('landmark');
      const keepers = inn.workerIds.map((id) => people.get(id)!).filter((person) => person.occupationId === 'innkeeper');
      expect(keepers).toHaveLength(1);
      expect(inn.householdIds).toEqual([keepers[0]!.householdId]);
      expect(households.get(keepers[0]!.householdId)!.dwellingId).toBe(inn.id);
    }
    expect(countOf(badanos, 'gaming-house')).toBe(1);
  });

  it('match the version 5 baseline, which lists what moved and leaves population, workforce and categories where they were', () => {
    const baseline = read('badanos-counts-v5.json');
    const first = read('badanos-counts.json');
    expect(baseline).toMatchObject({ settlementId: 'settlement-641', generatorVersion: 5, seed: badanos.summary.seed });
    expect(baseline.note).toMatch(/inns/);
    expect(badanos.summary.occupations).toEqual(baseline.occupations);
    expect(badanos.buildings).toHaveLength(baseline.buildings);
    expect(badanos.summary.population).toBe(9607);
    expect(badanos.summary.workforce.working).toBe(4419);
    expect(badanos.summary.categories).toEqual(first.categories);
    expect(baseline.categories).toEqual(first.categories);
    // Only what the baseline says moved did, and what the new posts gained the rest of their categories gave up.
    const was = generateCity(settlement('settlement-641'), medievalPackBefore6C());
    const moved = baseline.moved as Record<string, [number, number]>;
    for (const id of new Set([...Object.keys(was.summary.occupations), ...Object.keys(badanos.summary.occupations)])) {
      const pair = [was.summary.occupations[id] ?? 0, badanos.summary.occupations[id] ?? 0];
      if (id in moved) expect(pair, id).toEqual(moved[id]);
      else expect(pair[1], id).toBe(pair[0]);
    }
    expect(Object.values(moved).reduce((sum, [before, after]) => sum + after - before, 0)).toBe(0);
    expect(Object.entries(moved).filter(([, [before]]) => before === 0).map(([id]) => id).sort()).toEqual(['chambermaid', 'gaming-keeper', 'inn-servant', 'table-keeper']);
    // Thirteen innkeepers worked in the taverns; two keep the inns.
    expect(moved.innkeeper).toEqual([13, 2]);
  });

  it('has no visitors\' quarter, its draw being below the threshold: the inns, the players\' halls and the gaming house stand in the centre', () => {
    expect(drawOf(settlement('settlement-641'), pack).total).toBeLessThan(quarter.whenDraw!);
    expect(badanos.districts.map((district) => district.kind)).not.toContain('visitors');
    const kindOf = new Map(badanos.districts.map((district) => [district.id, district.kind]));
    for (const building of badanos.buildings.filter((entry) => quarter.types!.includes(entry.type))) expect(kindOf.get(building.districtId), building.type).toBe('centre');
  });
});

describe('every settlement of Lomia', () => {
  it('keeps its population and category counts, has an inn where travellers are expected, a visitors\' quarter exactly when its draw reaches the threshold, and every invariant', { timeout: 400_000 }, () => {
    const before = medievalPackBefore6C();
    const failures: string[] = [];
    const versionFour = createHash('sha256');
    let inns = 0;
    const withQuarter: string[] = [];
    const draws: Array<{ name: string; draw: number }> = [];
    for (const brief of lomiaWorld().settlements) {
      const fail = (text: string) => failures.push(`${brief.id} (${brief.population}): ${text}`);
      const was = generateCity(brief, before);
      const { generatorVersion: _version, pack: _pack, ...summary } = was.summary;
      versionFour.update(JSON.stringify({ ...was, summary }));
      const city = generateCity(brief, pack);
      if (city.people.length !== brief.population || city.summary.population !== was.summary.population) fail('the population moved');
      if (JSON.stringify(city.summary.workforce) !== JSON.stringify(was.summary.workforce)) fail('the workforce moved');
      for (const category of CATEGORY_IDS) if (city.summary.categories[category] !== was.summary.categories[category]) fail(`the ${category} count moved`);
      failures.push(...checkCity(city, brief, pack).map((problem) => `${brief.id}: ${problem}`));
      failures.push(...checkLayout(generateLayout(city, brief, pack), city, brief, pack).map((problem) => `${brief.id}: ${problem}`));
      // An inn wherever travellers are expected, in the number the rule gives.
      const expected = expectedTravellers(brief, pack);
      const count = countOf(city, 'inn');
      inns += count;
      if (expected > 0 && count < 1) fail(`expects ${expected.toFixed(1)} travellers a day but has no inn`);
      if (count !== Math.max(resolveCount({ perTravellers: 12, min: 1 }, brief.population, expected), city.summary.occupations.innkeeper ? 1 : 0)) fail(`has ${count} inns, not the number its rule gives`);
      // The quarter, exactly when the draw reaches the threshold; and then everything that belongs to it stands there.
      const draw = drawOf(brief, pack).total;
      draws.push({ name: brief.name, draw });
      const quarters = city.districts.filter((district) => district.kind === quarter.id);
      if (quarters.length !== (draw >= quarter.whenDraw! ? 1 : 0)) fail(`has ${quarters.length} visitors' quarters with a draw of ${draw.toFixed(1)}`);
      const kindOf = new Map(city.districts.map((district) => [district.id, district.kind]));
      for (const building of city.buildings) {
        const belongs = quarter.types!.includes(building.type);
        const there = kindOf.get(building.districtId) === quarter.id;
        if (quarters.length > 0 && belongs && !there) fail(`${building.id}, a ${building.type}, stands outside the visitors' quarter`);
        // Besides what belongs to it, the quarter has only what is spread to every district with residents.
        if (there && !belongs && ![...pack.workplaces, ...pack.landmarks].find((type) => type.id === building.type)?.spread) fail(`${building.id}, a ${building.type}, stands in the visitors' quarter`);
      }
      if (quarters.length > 0) withQuarter.push(brief.name);
    }
    expect(failures.slice(0, 10)).toEqual([]);
    // Without what phase 6C added, every city is the one generator version 4 made.
    expect(versionFour.digest('hex')).toBe(read('city-v4.json').all);
    draws.sort((a, b) => b.draw - a.draw);
    console.log(`Highest draw: ${draws.slice(0, 10).map((entry) => `${entry.name} ${entry.draw.toFixed(1)}`).join(', ')}`);
    console.log(`${withQuarter.length} of 682 settlements have a visitors' quarter; Lomia has ${inns.toLocaleString('en-US')} inns`);
    expect(withQuarter).toContain('Pombal');
    expect(withQuarter).not.toContain('Badanos');
    expect(withQuarter.length).toBeGreaterThan(5);
    expect(withQuarter.length).toBeLessThan(100);
    expect(inns).toBeGreaterThanOrEqual(682);
  });
});

describe('pack behaviour', () => {
  it('puts a building type of the user\'s own in the visitors\' quarter by a pack edit alone, and in the centre where there is no quarter', () => {
    const withOne = edited((raw) => {
      raw.landmarks.push({ id: 'menagerie', name: 'Menagerie', minPopulation: 5000, district: 'centre', count: { fixed: 1 }, posts: [] });
      raw.layout.lots.menagerie = { frontage: 20, depth: 22 };
      raw.districts.kinds.find((kind: any) => kind.id === 'visitors').types.push('menagerie');
    });
    for (const [id, kind] of [['settlement-5', 'visitors'], ['settlement-641', 'centre']] as const) {
      const brief = settlement(id);
      const city = generateCity(brief, withOne);
      const menagerie = city.buildings.find((building) => building.type === 'menagerie')!;
      expect(city.districts.find((district) => district.id === menagerie.districtId)!.kind, id).toBe(kind);
      expect(checkLayout(generateLayout(city, brief, withOne), city, brief, withOne)).toEqual([]);
    }
  });

  it('gives every settlement a quarter at a threshold of nearly nothing, and none at one beyond any draw', () => {
    const low = edited((raw) => (raw.districts.kinds.find((kind: any) => kind.id === 'visitors').whenDraw = 0.001));
    const high = edited((raw) => (raw.districts.kinds.find((kind: any) => kind.id === 'visitors').whenDraw = 1000));
    for (const id of ['settlement-455', 'settlement-641', 'settlement-5']) {
      expect(generateCity(settlement(id), low).districts.filter((district) => district.kind === 'visitors'), id).toHaveLength(1);
      expect(generateCity(settlement(id), high).districts.filter((district) => district.kind === 'visitors'), id).toHaveLength(0);
    }
  });

  it('has more inns where one serves fewer travellers, and none in a pack whose rules expect nobody', () => {
    const more = generateCity(settlement('settlement-641'), edited((raw) => (raw.landmarks.find((entry: any) => entry.id === 'inn').count = { perTravellers: 4, min: 1 })));
    expect(countOf(more, 'inn')).toBe(resolveCount({ perTravellers: 4, min: 1 }, 9607, expectedTravellers(settlement('settlement-641'), pack)));
    expect(countOf(more, 'inn')).toBeGreaterThan(4);
    const nobody = generateCity(settlement('settlement-641'), edited((raw) => {
      raw.travellers.kinds = [];
      raw.display.travellers = {};
    }));
    expect(countOf(nobody, 'inn')).toBe(0);
    expect(nobody.summary.occupations.innkeeper).toBeUndefined();
  });

  it('rejects a quarter or a count by travellers in a pack with no travellers file, and a type listed under two kinds', () => {
    const problems = (edit: (raw: any) => void): string[] => {
      try {
        edited(edit);
        return [];
      } catch (error) {
        return (error as PackError).problems;
      }
    };
    expect(problems((raw) => delete raw.travellers).join('\n')).toMatch(/districts: "visitors" depends on the settlement's draw, so the pack needs a travellers file/);
    expect(problems((raw) => delete raw.travellers).join('\n')).toMatch(/landmarks: "inn" is counted by travellers, so the pack needs a travellers file/);
    expect(problems((raw) => (raw.districts.kinds.find((kind: any) => kind.id === 'centre').types = ['inn'])).join('\n')).toMatch(/lists the building type "inn", which "centre" lists too|which "visitors" lists too/);
    expect(problems((raw) => raw.districts.kinds.find((kind: any) => kind.id === 'visitors').types.push('castle')).join('\n')).toMatch(/districts: "visitors" lists the building type "castle", which does not exist/);
    expect(problems((raw) => (raw.districts.kinds.find((kind: any) => kind.id === 'visitors').weight = 1)).join('\n')).toMatch(/more than one of a weight, a condition and a draw/);
  });
});
