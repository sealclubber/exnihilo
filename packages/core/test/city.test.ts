/**
 * Tests of the city generator on single settlements of Lomia.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type CategoryId,
  type City,
  type NameGeneratorFactory,
  type SettingPack,
  type SettlementBrief,
  CATEGORY_IDS,
  CityGenerationError,
  CitySchema,
  GENERATOR_VERSION,
  allOccupations,
  apportion,
  checkCity,
  conditionsOf,
  generateCity,
  parsePack,
  resolveCount,
} from '../src/index.ts';
import { lomiaWorld, medievalPack, rawMedievalPack, settlement } from './pack.ts';

const pack = medievalPack();
const occupation = (id: string) => allOccupations(pack).find((entry) => entry.id === id)!;
const landmarksFor = (...conditions: string[]) =>
  pack.landmarks.filter((landmark) => landmark.when !== undefined && conditions.includes(landmark.when)).map((landmark) => landmark.id);
const buildingsOfType = (city: City, types: string[]) => city.buildings.filter((building) => types.includes(building.type));
const largestCategory = (city: City) =>
  CATEGORY_IDS.reduce((best, category) => (city.summary.categories[category] > city.summary.categories[best] ? category : best));

let badanosBrief: SettlementBrief;
let badanos: City;
beforeAll(() => {
  badanosBrief = settlement('settlement-641');
  badanos = generateCity(badanosBrief, pack);
});

describe('steps 1 to 3: households, people, names and workforce', () => {
  const human = pack.species.human!;

  it('creates exactly as many people as the brief has townspeople', () => {
    expect(badanos.people).toHaveLength(9607);
    expect(badanos.households.reduce((sum, household) => sum + household.memberIds.length, 0)).toBe(9607);
  });

  it('gives records IDs that carry the settlement number, in order', () => {
    expect(badanos.people[0]!.id).toBe('person-641-000001');
    expect(badanos.people.at(-1)!.id).toBe('person-641-009607');
    expect(badanos.households[0]!.id).toBe('household-641-000001');
    expect(badanos.buildings[0]!.id).toBe('building-641-000001');
    expect(badanos.districts[0]!.id).toBe('district-641-001');
  });

  it('gives every household one head, listed first, and sizes the pack allows', () => {
    const sizes = Object.keys(human.household.sizes).map(Number);
    const people = new Map(badanos.people.map((person) => [person.id, person]));
    for (const household of badanos.households) {
      const roles = household.memberIds.map((id) => people.get(id)!.role);
      expect(roles[0]).toBe('head');
      expect(roles.filter((role) => role === 'head')).toHaveLength(1);
      expect(roles.filter((role) => role === 'partner').length).toBeLessThanOrEqual(1);
      expect(roles.filter((role) => role === 'elder').length).toBeLessThanOrEqual(human.household.maxElders);
      expect(household.headId).toBe(household.memberIds[0]);
    }
    // Every household but the last, which is cut to fit, has a size from the distribution.
    for (const household of badanos.households.slice(0, -1)) expect(sizes).toContain(household.memberIds.length);
  });

  it('draws household sizes roughly as the pack weights them', () => {
    const weights = human.household.sizes;
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    const mean = Object.entries(weights).reduce((sum, [size, weight]) => sum + (Number(size) * weight) / total, 0);
    expect(badanos.people.length / badanos.households.length).toBeCloseTo(mean, 0);
  });

  it('keeps ages within what the species allows, with children younger than their parents', () => {
    const people = new Map(badanos.people.map((person) => [person.id, person]));
    const { ages } = human;
    for (const household of badanos.households) {
      const head = people.get(household.headId)!;
      expect(head.age).toBeGreaterThanOrEqual(Math.min(...ages.head.map((band) => band.min)));
      expect(head.age).toBeLessThanOrEqual(Math.max(...ages.head.map((band) => band.max)));
      for (const id of household.memberIds) {
        const member = people.get(id)!;
        expect(member.age).toBeGreaterThanOrEqual(0);
        expect(member.age).toBeLessThanOrEqual(ages.maxAge);
        if (member.role === 'child') {
          expect(head.age - member.age).toBeGreaterThanOrEqual(ages.parentMinAge);
          expect(member.age).toBeLessThanOrEqual(ages.childMaxAge);
        }
        if (member.role === 'elder') expect(member.age - head.age).toBeGreaterThanOrEqual(ages.elderGap.min);
        if (member.role === 'partner') {
          expect(member.age).toBeGreaterThanOrEqual(ages.minPartnerAge);
          expect(member.sex).not.toBe(head.sex);
        }
      }
    }
  });

  it('records the species and culture of every person', () => {
    expect(new Set(badanos.people.map((person) => person.species))).toEqual(new Set(['human']));
    expect(new Set(badanos.people.map((person) => person.cultureId))).toEqual(new Set(['culture-8']));
    const male = badanos.people.filter((person) => person.sex === 'male').length / badanos.people.length;
    expect(male).toBeGreaterThan(0.45);
    expect(male).toBeLessThan(0.55);
  });

  it('names everyone, with kin sharing the household name and lodgers keeping their own', () => {
    const households = new Map(badanos.households.map((household) => [household.id, household]));
    let lodgersWithOwnName = 0;
    const lodgers = badanos.people.filter((person) => person.role === 'lodger');
    for (const person of badanos.people) {
      expect(person.givenName).toMatch(/^\p{Lu}\p{Ll}+$/u);
      expect(person.familyName).toMatch(/^\p{Lu}\p{Ll}+$/u);
      const family = households.get(person.householdId)!.familyName;
      const partnersParent = person.role === 'elder' && person.childIds[0] !== households.get(person.householdId)!.headId;
      if (person.role !== 'lodger' && !partnersParent) expect(person.familyName).toBe(family);
      else if (person.role === 'lodger' && person.familyName !== family) lodgersWithOwnName++;
    }
    expect(lodgersWithOwnName / lodgers.length).toBeGreaterThan(0.95);
    expect(new Set(badanos.households.map((household) => household.familyName)).size).toBeGreaterThan(1000);
  });

  it('builds names from the culture name base, within its length limits', () => {
    const base = badanosBrief.culture.nameBase;
    for (const household of badanos.households) {
      expect(household.familyName.length).toBeLessThanOrEqual(base.maxLength);
    }
    const letters = new Set(base.sampleNames.join('').toLowerCase());
    for (const person of badanos.people.slice(0, 500)) {
      for (const letter of person.givenName.toLowerCase()) expect(letters.has(letter)).toBe(true);
    }
  });

  it('takes names from another generator when one is supplied', () => {
    const fixed: NameGeneratorFactory = () => ({
      givenName: (_rng, sex) => (sex === 'female' ? 'Ada' : 'Bo'),
      familyName: () => 'Smith',
    });
    const city = generateCity(settlement('settlement-455'), pack, { names: fixed });
    expect(new Set(city.people.map((person) => person.familyName))).toEqual(new Set(['Smith']));
    expect(new Set(city.people.map((person) => `${person.sex}:${person.givenName}`))).toEqual(new Set(['female:Ada', 'male:Bo']));
    // Names come from their own stream, so the people themselves are unchanged.
    const usual = generateCity(settlement('settlement-455'), pack);
    expect(city.people.map((person) => [person.age, person.role, person.occupationId])).toEqual(
      usual.people.map((person) => [person.age, person.role, person.occupationId]),
    );
  });

  it('puts in the workforce only people of working age', () => {
    const { workingAges } = human.workforce;
    for (const person of badanos.people) {
      if (person.workforceState === 'not-working') continue;
      expect(person.age).toBeGreaterThanOrEqual(workingAges.min);
      expect(person.age).toBeLessThanOrEqual(workingAges.max);
    }
    expect(badanos.people.some((person) => person.age < workingAges.min)).toBe(true);
  });

  it('makes the workforce exactly the share of residents the pack sets', () => {
    expect(badanos.summary.workforce.working).toBe(Math.round(9607 * human.workforce.share));
    expect(badanos.summary.workforce).toEqual({
      working: badanos.people.filter((person) => person.workforceState === 'working').length,
      keepingHouse: badanos.people.filter((person) => person.workforceState === 'keeping-house').length,
      notWorking: badanos.people.filter((person) => person.workforceState === 'not-working').length,
    });
  });

  it('has at most one member keeping house per household, never the head or someone living alone', () => {
    const keepers = new Map<string, number>();
    for (const person of badanos.people) {
      if (person.workforceState !== 'keeping-house') continue;
      expect(person.role).not.toBe('head');
      keepers.set(person.householdId, (keepers.get(person.householdId) ?? 0) + 1);
    }
    expect(Math.max(...keepers.values())).toBe(1);
    const share = keepers.size / badanos.households.filter((household) => household.memberIds.length > 1).length;
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(0.9);
  });
});

describe('steps 4 to 8: shares, posts, occupations, assignment and status', () => {
  it('applies every matching modifier and scales the shares to 100%', () => {
    // Badanos is a city with no flags that is a province seat: only services x1.2 applies.
    const total = 15 + 10 + 20 * 1.2 + 10 + 5 + 5 + 35;
    const { shares } = badanos.summary;
    expect(shares.services).toBeCloseTo(24 / total, 12);
    expect(shares.trade).toBeCloseTo(35 / total, 12);
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);

    // Vereceldo is a walled village.
    const village = generateCity(settlement('settlement-455'), pack).summary.shares;
    const villageTotal = 60 + 10 + 12 + 12 + 6.5 + 1 + 14;
    expect(village.food).toBeCloseTo(60 / villageTotal, 12);
    expect(village.military).toBeCloseTo(6.5 / villageTotal, 12);
    expect(village.construction).toBeCloseTo(12 / villageTotal, 12);
  });

  it('shares the workforce across categories by largest remainder, summing exactly', () => {
    const { shares, categories, workforce } = badanos.summary;
    const expected = apportion(
      workforce.working,
      CATEGORY_IDS.map((category) => shares[category]),
    );
    expect(CATEGORY_IDS.map((category) => categories[category])).toEqual(expected);
    expect(Object.values(categories).reduce((a, b) => a + b, 0)).toBe(workforce.working);
  });

  it('creates the fixed posts a landmark requires, taken from their own category', () => {
    const hall = pack.landmarks.find((landmark) => landmark.when === 'provinceSeat')!;
    for (const post of hall.posts) {
      const count = resolveCount(post.count, 9607);
      expect(badanos.summary.occupations[post.occupation], post.occupation).toBe(count);
    }
    // No other flag's landmark applies, so no other such post exists. (Civic buildings, which a settlement
    // has by its size since generator version 3, have posts of their own: see civic.test.ts.)
    const posts = new Set(pack.landmarks.filter((landmark) => landmark.when !== undefined).flatMap((landmark) => landmark.posts.map((post) => post.occupation)));
    const present = Object.keys(badanos.summary.occupations).filter((id) => posts.has(id));
    expect(present.sort()).toEqual(hall.posts.map((post) => post.occupation).sort());
  });

  it('leaves out occupations whose minimum population is not met', () => {
    const village = generateCity(settlement('settlement-455'), pack);
    for (const id of Object.keys(village.summary.occupations)) {
      expect(occupation(id).minPopulation ?? 0, id).toBeLessThanOrEqual(253);
    }
    expect(Object.keys(badanos.summary.occupations)).toContain('physician');
    expect(Object.keys(village.summary.occupations)).not.toContain('physician');
  });

  it('fills most of the trade category from the specialty tags, weighted toward the first', () => {
    const trade = Object.entries(badanos.summary.occupations).filter(([id]) => occupation(id).category === 'trade');
    const sum = (wanted: (id: string) => boolean) => trade.filter(([id]) => wanted(id)).reduce((total, [, count]) => total + count, 0);
    const leather = sum((id) => occupation(id).specialties?.includes('leather') ?? false);
    const arms = sum((id) => occupation(id).specialties?.includes('arms') ?? false);
    const general = sum((id) => occupation(id).specialties === undefined);
    const all = badanos.summary.categories.trade;
    expect(leather + arms + general).toBe(all);
    expect((leather + arms) / all).toBeCloseTo(pack.specialties.tradeShare, 2);
    expect(leather / arms).toBeCloseTo(3 / 2, 1);
    expect(general).toBeGreaterThan(0);
    // No occupation of a specialty the settlement does not have.
    for (const [id] of trade) {
      const tags = occupation(id).specialties;
      if (tags) expect(tags.some((tag) => ['leather', 'arms'].includes(tag)), id).toBe(true);
    }
  });

  it('uses at most the first three tags that are not ignored', () => {
    const many = lomiaWorld().settlements.find((brief) => brief.specialtyTags.length >= 6)!;
    const used = many.specialtyTags.filter((tag) => !pack.specialties.tags[tag]!.ignore).slice(0, 3);
    const city = generateCity(many, pack);
    for (const id of Object.keys(city.summary.occupations)) {
      const tags = occupation(id).specialties;
      if (tags) expect(tags.some((tag) => used.includes(tag)), `${id} in ${many.name}`).toBe(true);
    }
  });

  it('gives a settlement whose only tag is ignored a trade category of general occupations', () => {
    const brief = { ...badanosBrief, specialtyTags: ['slaves'] };
    const city = generateCity(brief, pack);
    const trade = Object.keys(city.summary.occupations).filter((id) => occupation(id).category === 'trade');
    expect(trade.length).toBeGreaterThan(3);
    expect(trade.every((id) => occupation(id).specialties === undefined)).toBe(true);
    expect(city.summary.categories.trade).toBe(badanos.summary.categories.trade);
  });

  it('refuses a brief with a tag the pack does not list', () => {
    const brief = { ...badanosBrief, specialtyTags: ['unobtainium'] };
    expect(() => generateCity(brief, pack)).toThrow(CityGenerationError);
    expect(() => generateCity(brief, pack)).toThrow(/settlement-641 \(Badanos\).*"unobtainium"/);
  });

  it('gives every worker a slot, heads included, and leaves no slot empty', () => {
    const workers = badanos.people.filter((person) => person.workforceState === 'working');
    expect(workers.every((person) => person.occupationId !== undefined)).toBe(true);
    const counted = new Map<string, number>();
    for (const person of workers) counted.set(person.occupationId!, (counted.get(person.occupationId!) ?? 0) + 1);
    expect(Object.fromEntries(counted)).toEqual(badanos.summary.occupations);
  });

  it('lets household members follow the head into the same occupation more often than chance', () => {
    const people = new Map(badanos.people.map((person) => [person.id, person]));
    let followers = 0;
    let others = 0;
    for (const household of badanos.households) {
      const head = people.get(household.headId)!;
      if (!head.occupationId) continue;
      for (const id of household.memberIds.slice(1)) {
        const member = people.get(id)!;
        if (!member.occupationId) continue;
        if (member.occupationId === head.occupationId) followers++;
        else others++;
      }
    }
    const share = followers / (followers + others);
    expect(share).toBeGreaterThan(pack.pack.households.followHeadOccupation * 0.6);
    expect(share).toBeLessThan(pack.pack.households.followHeadOccupation * 1.4);
  });

  it('gives each household a status tier within one step of its earner\'s occupation', () => {
    const tiers = pack.pack.statusTiers.map((tier) => tier.id);
    const people = new Map(badanos.people.map((person) => [person.id, person]));
    let shifted = 0;
    for (const household of badanos.households) {
      const earner = household.memberIds.map((id) => people.get(id)!).find((person) => person.occupationId);
      if (!earner) {
        expect(household.statusTier).toBe(pack.pack.households.statusWithoutWorker);
        continue;
      }
      const distance = tiers.indexOf(household.statusTier) - tiers.indexOf(occupation(earner.occupationId!).status);
      expect(Math.abs(distance)).toBeLessThanOrEqual(1);
      if (distance !== 0) shifted++;
    }
    const share = shifted / badanos.households.length;
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.3);
  });
});

describe('steps 9 to 12: workplaces, dwellings, districts and summary', () => {
  it('creates just enough buildings of each workplace type for its workers', () => {
    // Servants also work in some of these buildings, in the homes of proprietors; they do not count against capacity.
    const staff = new Map<string, number>();
    for (const person of badanos.people) {
      if (person.workplaceId && !person.employerHouseholdId) staff.set(person.workplaceId, (staff.get(person.workplaceId) ?? 0) + 1);
    }
    for (const type of pack.workplaces) {
      const buildings = buildingsOfType(badanos, [type.id]);
      const workers = buildings.reduce((sum, building) => sum + (staff.get(building.id) ?? 0), 0);
      expect(buildings.length, type.id).toBe(Math.ceil(workers / type.capacity));
      for (const building of buildings) {
        expect(staff.get(building.id), building.id).toBeGreaterThan(0);
        expect(staff.get(building.id), building.id).toBeLessThanOrEqual(type.capacity);
      }
    }
  });

  it('houses a proprietor\'s household in the workplace when the type says so', () => {
    const people = new Map(badanos.people.map((person) => [person.id, person]));
    const households = new Map(badanos.households.map((household) => [household.id, household]));
    const workplaceTypes = new Map(pack.workplaces.map((type) => [type.id, type]));
    const both = badanos.buildings.filter((building) => building.kind === 'both' && workplaceTypes.has(building.type));
    expect(both.length).toBeGreaterThan(100);
    for (const building of both) {
      expect(workplaceTypes.get(building.type)!.proprietorLivesIn).toBe(true);
      expect(building.householdIds).toHaveLength(1);
      const head = people.get(households.get(building.householdIds[0]!)!.headId)!;
      expect(head.workplaceId).toBe(building.id);
      expect(head.apprentice).toBeUndefined();
    }
    for (const building of badanos.buildings.filter((entry) => entry.kind === 'workplace')) {
      expect(building.householdIds).toEqual([]);
    }
  });

  it('places every other household in a dwelling of its status tier, filled to capacity', () => {
    const households = new Map(badanos.households.map((household) => [household.id, household]));
    // A dwelling in which servants work has the kind "both"; it is still a dwelling type.
    const dwellings = badanos.buildings.filter((building) => pack.dwellings.some((type) => type.id === building.type));
    for (const building of dwellings) {
      const type = pack.dwellings.find((entry) => entry.id === building.type)!;
      expect(building.householdIds.length).toBeGreaterThan(0);
      expect(building.householdIds.length).toBeLessThanOrEqual(type.households);
      for (const id of building.householdIds) expect(households.get(id)!.statusTier).toBe(type.status);
    }
    // Shared buildings are filled before another is started: at most one part-empty building per tier.
    for (const tier of pack.pack.statusTiers) {
      const partEmpty = dwellings.filter((building) => {
        const type = pack.dwellings.find((entry) => entry.id === building.type)!;
        return type.status === tier.id && building.householdIds.length < type.households;
      });
      expect(partEmpty.length, tier.id).toBeLessThanOrEqual(1);
    }
  });

  it('creates districts by population and puts every building in one', () => {
    expect(badanos.districts).toHaveLength(Math.round(9607 / pack.districts.residentsPerDistrict));
    expect(new Set(badanos.districts.map((district) => district.name)).size).toBe(badanos.districts.length);
    expect(badanos.districts[0]!.kind).toBe(pack.districts.kinds[0]!.id);
    expect(badanos.districts.reduce((sum, district) => sum + district.buildingIds.length, 0)).toBe(badanos.buildings.length);
    // Without a port or a shanty town, no conditional district exists.
    const conditional = pack.districts.kinds.filter((kind) => kind.when).map((kind) => kind.id);
    expect(badanos.districts.filter((district) => conditional.includes(district.kind))).toEqual([]);
  });

  it('follows workplace preferences and household status when placing buildings', () => {
    const kindOf = new Map(badanos.districts.map((district) => [district.id, district.kind]));
    const present = new Set(kindOf.values());
    for (const building of badanos.buildings) {
      const kind = kindOf.get(building.districtId)!;
      const workplace = pack.workplaces.find((type) => type.id === building.type);
      const dwelling = pack.dwellings.find((type) => type.id === building.type);
      // A type the pack spreads is in every district; any other keeps to the kind it prefers.
      if (workplace && !workplace.spread && present.has(workplace.district)) expect(kind, building.id).toBe(workplace.district);
      if (dwelling) {
        // A dwelling stands in a kind of district its tier lives in: see districts.test.ts for the order of preference.
        const accepting = pack.districts.tierDistricts![dwelling.status]!.flat();
        if (accepting.some((entry) => present.has(entry))) expect(accepting, building.id).toContain(kind);
      }
    }
  });

  it('summarises the city, and records what produced it', () => {
    const { summary } = badanos;
    expect(summary).toMatchObject({
      settlementId: 'settlement-641',
      settlementName: 'Badanos',
      population: 9607,
      households: badanos.households.length,
      buildings: badanos.buildings.length,
      districts: badanos.districts.length,
      generatorVersion: GENERATOR_VERSION,
      pack: { name: 'medieval', version: '0.17.0' },
      seed: badanosBrief.seed,
    });
    const tiers = Object.values(summary.statusTiers);
    expect(tiers.reduce((sum, tier) => sum + tier.residents, 0)).toBe(9607);
    expect(tiers.reduce((sum, tier) => sum + tier.households, 0)).toBe(badanos.households.length);
    const totals = Object.values(summary.districtTotals);
    expect(Object.keys(summary.districtTotals)).toEqual(badanos.districts.map((district) => district.id));
    expect(totals.reduce((sum, district) => sum + district.residents, 0)).toBe(9607);
    expect(totals.reduce((sum, district) => sum + district.workers, 0)).toBe(summary.workforce.working);
    expect(totals.reduce((sum, district) => sum + district.buildings, 0)).toBe(badanos.buildings.length);
  });

  it('produces records that fit their schemas', () => {
    const small = generateCity(settlement('settlement-455'), pack);
    expect(CitySchema.safeParse(small).success).toBe(true);
    expect(CitySchema.safeParse(badanos).success).toBe(true);
    for (const person of badanos.people) {
      expect('occupationId' in person).toBe(person.workforceState === 'working');
      expect('workplaceId' in person).toBe(person.workforceState === 'working');
    }
  });
});

describe('the internal invariant check', () => {
  it('finds nothing wrong with a generated city', () => {
    expect(checkCity(badanos, badanosBrief, pack)).toEqual([]);
  });

  const copy = (): City => structuredClone(generateCity(settlement('settlement-455'), pack));
  const breaks: Array<[string, (city: City) => void, RegExp]> = [
    ['a missing person', (city) => city.people.pop(), /people but the brief's population is 253/],
    ['a person in the wrong household', (city) => (city.people[0]!.householdId = city.households[5]!.id), /lists person-455-000001, who names household-455-000006/],
    ['a household in a building that does not list it', (city) => (city.households[0]!.dwellingId = city.households.at(-1)!.dwellingId), /which does not list it/],
    ['a worker without a workplace', (city) => delete city.people.find((person) => person.occupationId)!.workplaceId, /works at undefined/],
    ['a non-worker with an occupation', (city) => (city.people.find((person) => person.workforceState === 'not-working')!.occupationId = 'baker'), /not in the workforce but has an occupation/],
    ['an occupation the pack does not have', (city) => (city.people.find((person) => person.occupationId)!.occupationId = 'astronaut'), /"astronaut", which is not an occupation in the pack/],
    ['a building type the pack does not have', (city) => (city.buildings[0]!.type = 'skyscraper'), /"skyscraper", which is not in the pack/],
    ['a district kind the pack does not have', (city) => (city.districts[0]!.kind = 'suburb'), /"suburb", which is not in the pack/],
    ['a wrong category count', (city) => city.summary.categories.food++, /the summary counts \d+ in food/],
    ['a building in a district that does not exist', (city) => (city.buildings[0]!.districtId = 'district-455-099'), /district-455-099, which does not exist/],
    ['records out of ID order', (city) => city.households.reverse(), /out of ID order/],
    ['a tag the pack does not handle', () => undefined, /"unobtainium" is neither used/],
  ];
  it.each(breaks)('reports %s', (name, damage, expected) => {
    const city = copy();
    damage(city);
    const brief = settlement('settlement-455');
    const problems = checkCity(city, name.startsWith('a tag') ? { ...brief, specialtyTags: ['unobtainium'] } : brief, pack);
    expect(problems.join('\n')).toMatch(expected);
  });

  it('reports an overfull workplace and an overfull dwelling', () => {
    const tight = structuredClone(pack);
    for (const type of tight.workplaces) type.capacity = 1;
    expect(checkCity(badanos, badanosBrief, tight).join('\n')).toMatch(/workers, over its capacity of 1/);
    const cramped = structuredClone(pack);
    for (const type of cramped.dwellings) type.households = 1;
    expect(checkCity(badanos, badanosBrief, cramped).join('\n')).toMatch(/households, over its capacity of 1/);
  });

  it('makes generation fail loudly when the pack asks for a workforce outside the limits', () => {
    const idle = structuredClone(pack);
    idle.species.human!.workforce.share = 0.2;
    expect(() => generateCity(badanosBrief, idle)).toThrow(/the workforce is 20\.0% of the population/);
  });

  it('makes generation fail when the pack asks for more workers than there are people of working age', () => {
    const busy = structuredClone(pack);
    busy.species.human!.workforce.share = 0.95;
    expect(() => generateCity(badanosBrief, busy)).toThrow(/asks for a workforce of 9127, but only \d+ residents are of working age/);
  });
});

describe('determinism', () => {
  it('gives byte-identical output for the same brief, pack and seed', () => {
    expect(JSON.stringify(generateCity(badanosBrief, pack))).toBe(JSON.stringify(badanos));
    const reloaded = parsePack(rawMedievalPack());
    expect(JSON.stringify(generateCity(structuredClone(badanosBrief), reloaded))).toBe(JSON.stringify(badanos));
    expect(JSON.stringify(generateCity(badanosBrief, pack, { seed: badanosBrief.seed }))).toBe(JSON.stringify(badanos));
  });

  it('gives different people but the same population and category counts for a different seed', () => {
    const other = generateCity(badanosBrief, pack, { seed: 12345 });
    expect(other.summary.seed).toBe(12345);
    expect(other.people).toHaveLength(9607);
    expect(other.summary.categories).toEqual(badanos.summary.categories);
    expect(other.summary.shares).toEqual(badanos.summary.shares);
    const describe = (city: City) => city.people.slice(0, 200).map((person) => `${person.givenName} ${person.familyName} ${person.age}`);
    expect(describe(other)).not.toEqual(describe(badanos));
    expect(other.households.length).not.toBe(badanos.households.length);
  });

  it('does not change the brief or the pack it is given', () => {
    const brief = JSON.stringify(badanosBrief);
    const before = JSON.stringify(pack);
    generateCity(badanosBrief, pack);
    expect(JSON.stringify(badanosBrief)).toBe(brief);
    expect(JSON.stringify(pack)).toBe(before);
  });
});

describe('named settlements', () => {
  it('Badanos: leather and arms lead its trade, with a county administration and no other landmarks', () => {
    expect(badanos.people).toHaveLength(9607);
    expect(conditionsOf(badanosBrief)).toMatchObject({ provinceSeat: true, citadel: false, temple: false, walls: false, port: false });

    // Group trade workers by specialty tag; general occupations stand as one group.
    const groups = new Map<string, number>();
    for (const [id, count] of Object.entries(badanos.summary.occupations)) {
      const entry = occupation(id);
      if (entry.category !== 'trade') continue;
      for (const group of entry.specialties ?? ['(general)']) groups.set(group, (groups.get(group) ?? 0) + count);
    }
    const ranked = [...groups].sort((a, b) => b[1] - a[1]).map(([group]) => group);
    expect(ranked.slice(0, 2)).toEqual(['leather', 'arms']);
    // And the largest single trade occupations are leather and arms ones.
    const top = Object.entries(badanos.summary.occupations)
      .filter(([id]) => occupation(id).category === 'trade')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([id]) => occupation(id).specialties?.[0]);
    expect(new Set(top)).toEqual(new Set(['leather', 'arms']));

    expect(buildingsOfType(badanos, landmarksFor('citadel', 'temple', 'walls', 'port'))).toEqual([]);
    const halls = buildingsOfType(badanos, landmarksFor('provinceSeat'));
    expect(halls).toHaveLength(1);
    expect(halls[0]!.kind).toBe('landmark');
    const staff = badanos.people.filter((person) => person.workplaceId === halls[0]!.id);
    expect(staff.length).toBeGreaterThanOrEqual(4);
    expect(staff.some((person) => person.occupationId === 'provincial-official')).toBe(true);
    // The only landmark a flag gives it; the rest are the civic buildings of a town its size.
    const civic = new Set(pack.landmarks.filter((landmark) => landmark.when === undefined).map((landmark) => landmark.id));
    expect(badanos.buildings.filter((building) => building.kind === 'landmark' && !civic.has(building.type))).toEqual(halls);
  });

  it('Pombal: citadel with garrison, temple with clergy, docks with dock workers, gatehouses and a market square', () => {
    const brief = settlement('settlement-5');
    const city = generateCity(brief, pack);
    expect(city.people).toHaveLength(47603);
    const staffed = (condition: string) => {
      const buildings = buildingsOfType(city, landmarksFor(condition));
      const ids = new Set(buildings.map((building) => building.id));
      return { buildings, staff: city.people.filter((person) => person.workplaceId && ids.has(person.workplaceId)) };
    };
    const citadel = staffed('citadel');
    expect(citadel.buildings).toHaveLength(1);
    expect(citadel.staff.filter((person) => person.occupationId === 'garrison-soldier').length).toBeGreaterThan(100);
    expect(citadel.staff.every((person) => occupation(person.occupationId!).category === 'military')).toBe(true);
    const temple = staffed('temple');
    expect(temple.buildings).toHaveLength(1);
    expect(temple.staff.filter((person) => person.occupationId === 'high-priest')).toHaveLength(1);
    expect(temple.staff.length).toBeGreaterThan(20);
    const docks = staffed('port');
    expect(docks.buildings.length).toBeGreaterThanOrEqual(1);
    expect(docks.staff.filter((person) => person.occupationId === 'dock-worker').length).toBeGreaterThan(100);
    const gates = staffed('walls');
    expect(gates.buildings.length).toBeGreaterThanOrEqual(2);
    expect(gates.buildings.every((building) => building.workerIds.length > 0)).toBe(true);
    expect(staffed('plaza').buildings).toHaveLength(1);
    expect(staffed('capital').buildings).toHaveLength(1);
    expect(city.districts.some((district) => district.kind === 'harbour')).toBe(true);

    expect(city.summary.shares.military).toBeGreaterThan(badanos.summary.shares.military);
    expect(city.summary.categories.military / city.summary.workforce.working).toBeGreaterThan(
      badanos.summary.categories.military / badanos.summary.workforce.working,
    );
  });

  it('Sunde: a shanty district whose households are all in the lowest status tier', () => {
    const city = generateCity(settlement('settlement-2'), pack);
    const shanty = city.districts.filter((district) => district.kind === 'shanty');
    expect(shanty).toHaveLength(1);
    const buildingIds = new Set(shanty[0]!.buildingIds);
    const households = city.households.filter((household) => buildingIds.has(household.dwellingId));
    expect(households.length).toBeGreaterThan(50);
    // Every household in a plain dwelling there is of the lowest tier. The shanty town has its own taverns and
    // shops too, since generator version 4 spreads those, and the households that keep them live in them: of the
    // lower tiers, and none wealthy or noble.
    const kindOf = new Map(city.buildings.map((building) => [building.id, building.kind]));
    const lowest = pack.pack.statusTiers[0]!.id;
    expect(new Set(households.filter((household) => kindOf.get(household.dwellingId) === 'dwelling').map((household) => household.statusTier))).toEqual(new Set([lowest]));
    const tiers = pack.pack.statusTiers.map((tier) => tier.id);
    for (const household of households) expect(tiers.indexOf(household.statusTier), household.id).toBeLessThanOrEqual(2);
    expect(households.filter((household) => household.statusTier === lowest).length / households.length).toBeGreaterThan(0.8);
    expect(badanos.districts.some((district) => district.kind === 'shanty')).toBe(false);
  });

  it('Flupines: a fort whose largest category is military', () => {
    const city = generateCity(settlement('settlement-143'), pack);
    expect(city.people).toHaveLength(497);
    expect(largestCategory(city)).toBe<CategoryId>('military');
  });

  it('Vereceldo: the smallest settlement, exactly 253 people, mostly food, in a single district', () => {
    const brief = settlement('settlement-455');
    expect(Math.min(...lomiaWorld().settlements.map((entry) => entry.population))).toBe(brief.population);
    const city = generateCity(brief, pack);
    expect(city.people).toHaveLength(253);
    expect(largestCategory(city)).toBe<CategoryId>('food');
    expect(city.districts).toHaveLength(1);
    expect(city.districts[0]!.buildingIds).toHaveLength(city.buildings.length);
  });

  it('Jungsund: a port town with a higher trade share than towns without a port', () => {
    const brief = settlement('settlement-33');
    expect(brief).toMatchObject({ sizeGroup: 'town', population: 7979, flags: { port: true } });
    const trade = generateCity(brief, pack).summary.shares.trade;
    const inland = lomiaWorld().settlements.filter((entry) => entry.sizeGroup === 'town' && !entry.flags.port);
    expect(inland.length).toBeGreaterThan(100);
    // The same town without its port, and every real inland town.
    const landlocked = generateCity({ ...brief, flags: { ...brief.flags, port: false } }, pack);
    expect(trade).toBeGreaterThan(landlocked.summary.shares.trade);
    for (const other of inland.slice(0, 40)) {
      expect(trade, other.name).toBeGreaterThan(generateCity(other, pack).summary.shares.trade);
    }
  });
});

describe('species', () => {
  const withDwarves = (): SettingPack => ({
    ...pack,
    cultures: { ...pack.cultures, cultures: { ...pack.cultures.cultures, Vengrian: 'dwarf' } },
  });

  it('gives dwarven Badanos a higher share of masons, and at least one runesmith', () => {
    const dwarven = generateCity(badanosBrief, withDwarves());
    expect(dwarven.people).toHaveLength(9607);
    expect(new Set(dwarven.people.map((person) => person.species))).toEqual(new Set(['dwarf']));
    const masons = (city: City) => (city.summary.occupations.mason ?? 0) / city.people.length;
    expect(masons(dwarven)).toBeGreaterThan(masons(badanos));
    expect((dwarven.summary.occupations.mason ?? 0) / dwarven.summary.workforce.working).toBeGreaterThan(
      (badanos.summary.occupations.mason ?? 0) / badanos.summary.workforce.working,
    );
    expect(dwarven.summary.occupations.runesmith).toBeGreaterThanOrEqual(1);
    expect(dwarven.summary.shares.construction).toBeGreaterThan(badanos.summary.shares.construction);
  });

  it('uses the species\' own ages and household sizes', () => {
    const dwarven = generateCity(badanosBrief, withDwarves());
    const oldest = (city: City) => Math.max(...city.people.map((person) => person.age));
    expect(oldest(badanos)).toBeLessThanOrEqual(pack.species.human!.ages.maxAge);
    expect(oldest(dwarven)).toBeGreaterThan(pack.species.human!.ages.maxAge);
    expect(dwarven.summary.workforce.working).toBe(Math.round(9607 * pack.species.dwarf!.workforce.share));
  });

  it('has no runesmith in Badanos under the default mapping', () => {
    expect(badanos.summary.occupations.runesmith).toBeUndefined();
  });
});

describe('pack edits take effect', () => {
  it('raises a category\'s count in Badanos when its base share is raised', () => {
    const raw = rawMedievalPack();
    raw.categories.find((category: any) => category.id === 'luxury').share = 15;
    const edited = generateCity(badanosBrief, parsePack(raw));
    expect(edited.summary.categories.luxury).toBeGreaterThan(badanos.summary.categories.luxury * 2);
    expect(edited.summary.categories.trade).toBeLessThan(badanos.summary.categories.trade);
    expect(edited.people).toHaveLength(9607);
  });

  it('follows edits to capacities, modifiers and district size', () => {
    const raw = rawMedievalPack();
    raw.workplaces.find((type: any) => type.id === 'tannery').capacity = 2;
    raw.modifiers.conditions.provinceSeat = { military: 4 };
    raw.districts.residentsPerDistrict = 500;
    const edited = generateCity(badanosBrief, parsePack(raw));
    expect(buildingsOfType(edited, ['tannery']).length).toBeGreaterThan(buildingsOfType(badanos, ['tannery']).length * 3);
    expect(edited.summary.shares.military).toBeGreaterThan(badanos.summary.shares.military * 3);
    expect(edited.districts).toHaveLength(Math.round(9607 / 500));
  });
});
