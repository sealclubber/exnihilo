/**
 * Phase 2.5: a generated city hangs together. Parents are old enough, kinship
 * is explicit, the pack decides who may hold which job, families share a
 * workplace, and servants work in the homes of the households that employ them.
 *
 * These tests hold exact figures for Badanos as it was generated before phase 6C gave settlements inns, a gaming
 * house and a visitors' quarter, so they run on the pack with those taken out (`medievalPackBefore6C`), which
 * `baselines/city-v4.json` proves gives the same cities. What phase 6C moved is in `visitors.test.ts`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type City,
  type Person,
  type SettingPack,
  CityGenerationError,
  GENERATOR_VERSION,
  allOccupations,
  apprenticeUntil,
  checkCity,
  generateCity,
  parsePack,
} from '../src/index.ts';
import { medievalPackBefore6C as medievalPack, rawMedievalPackBefore6C as rawMedievalPack, settlement } from './pack.ts';

const pack = medievalPack();
const occupationOf = (id: string, from: SettingPack = pack) => allOccupations(from).find((entry) => entry.id === id)!;
const brief = settlement('settlement-641');
let badanos: City;
let people: Map<string, Person>;
beforeAll(() => {
  badanos = generateCity(brief, pack);
  people = new Map(badanos.people.map((person) => [person.id, person]));
});

/** A copy of the medieval pack with some edits, checked like any pack. */
const edited = (edit: (raw: any) => void): SettingPack => {
  const raw = rawMedievalPack();
  edit(raw);
  return parsePack(raw);
};
const occupationIn = (raw: any, id: string) => raw.occupations.find((entry: any) => entry.id === id);

describe('versions', () => {
  it('is generator version 6 with pack 0.15.0', () => {
    expect(GENERATOR_VERSION).toBe(6);
    expect(badanos.summary.generatorVersion).toBe(6);
    expect(badanos.summary.pack).toEqual({ name: 'medieval', version: '0.15.0' });
  });
});

describe('parent ages', () => {
  it('makes every child at least parentMinAge younger than each parent in the household', () => {
    const { parentMinAge } = pack.species.human!.ages;
    let children = 0;
    let tooClose = 0;
    for (const person of badanos.people) {
      if (person.role !== 'child') continue;
      children++;
      for (const id of person.parentIds) if (people.get(id)!.age - person.age < parentMinAge) tooClose++;
    }
    expect(children).toBeGreaterThan(3000);
    expect(tooClose).toBe(0);
  });

  it('leaves no mother under 15 at a birth, where version 1 had 160', () => {
    const youngest = Math.min(
      ...badanos.people
        .filter((person) => person.role === 'child')
        .flatMap((child) => child.parentIds.map((id) => people.get(id)!.age - child.age)),
    );
    expect(youngest).toBeGreaterThanOrEqual(pack.species.human!.ages.parentMinAge);
  });

  it('follows the pack\'s parentMinAge, whatever it is', () => {
    const strict = generateCity(brief, edited((raw) => (raw.species.human.ages.parentMinAge = 20)));
    const byId = new Map(strict.people.map((person) => [person.id, person]));
    const gaps = strict.people.filter((person) => person.role === 'child').flatMap((child) => child.parentIds.map((id) => byId.get(id)!.age - child.age));
    expect(Math.min(...gaps)).toBe(20);
    expect(Math.min(...badanos.people.filter((person) => person.role === 'child').flatMap((child) => child.parentIds.map((id) => people.get(id)!.age - child.age)))).toBe(18);
  });

  it('gives a couple too young to be parents no children', () => {
    for (const household of badanos.households) {
      const members = household.memberIds.map((id) => people.get(id)!);
      const adults = members.filter((person) => person.role === 'head' || person.role === 'partner');
      if (Math.min(...adults.map((person) => person.age)) < pack.species.human!.ages.parentMinAge) {
        expect(members.filter((person) => person.role === 'child')).toEqual([]);
      }
    }
  });
});

describe('explicit kinship', () => {
  it('records every tie on both people', () => {
    for (const person of badanos.people) {
      if (person.partnerId) expect(people.get(person.partnerId)!.partnerId).toBe(person.id);
      for (const id of person.parentIds) expect(people.get(id)!.childIds).toContain(person.id);
      for (const id of person.childIds) expect(people.get(id)!.parentIds).toContain(person.id);
      expect([person.partnerId, ...person.parentIds, ...person.childIds]).not.toContain(person.id);
      expect(person.parentIds.length).toBeLessThanOrEqual(2);
    }
  });

  it('makes head and partner each other\'s partner, and children the children of both', () => {
    for (const household of badanos.households) {
      const members = household.memberIds.map((id) => people.get(id)!);
      const head = members[0]!;
      const partner = members.find((person) => person.role === 'partner');
      expect(head.partnerId).toBe(partner?.id);
      const children = members.filter((person) => person.role === 'child');
      for (const child of children) expect(child.parentIds).toEqual(partner ? [head.id, partner.id] : [head.id]);
      expect(head.childIds).toEqual(children.map((child) => child.id));
      if (partner) expect(partner.childIds).toEqual(head.childIds);
    }
  });

  it('makes every elder the parent of the head or of the partner, old enough for either', () => {
    const { elderGap } = pack.species.human!.ages;
    const elders = badanos.people.filter((person) => person.role === 'elder');
    expect(elders.length).toBeGreaterThan(300);
    let ofPartner = 0;
    for (const elder of elders) {
      expect(elder.childIds).toHaveLength(1);
      expect(elder.parentIds).toEqual([]);
      const child = people.get(elder.childIds[0]!)!;
      expect(['head', 'partner']).toContain(child.role);
      expect(child.householdId).toBe(elder.householdId);
      expect(elder.age - child.age).toBeGreaterThanOrEqual(elderGap.min);
      if (child.role === 'partner') ofPartner++;
    }
    // Some are the partner's parent, by a seeded choice, but fewer than the pack's share: many households have no partner.
    expect(ofPartner).toBeGreaterThan(50);
    expect(ofPartner / elders.length).toBeLessThan(pack.species.human!.household.elderOfPartnerShare!);
  });

  it('pairs two elders who are parents of the same person and of opposite sex, and no others', () => {
    let couples = 0;
    for (const person of badanos.people) {
      if (person.role === 'child' || person.parentIds.length !== 2) continue;
      const [first, second] = person.parentIds.map((id) => people.get(id)!) as [Person, Person];
      if (first.sex !== second.sex) {
        couples++;
        expect(first.partnerId).toBe(second.id);
      } else {
        expect(first.partnerId).toBeUndefined();
        expect(second.partnerId).toBeUndefined();
      }
    }
    expect(couples).toBeGreaterThan(10);
    for (const elder of badanos.people.filter((person) => person.role === 'elder' && person.partnerId)) {
      expect(people.get(elder.partnerId!)!.childIds).toEqual(elder.childIds);
    }
  });

  it('gives the partner\'s parents a family name of their own, shared between them', () => {
    const households = new Map(badanos.households.map((household) => [household.id, household]));
    let own = 0;
    for (const elder of badanos.people.filter((person) => person.role === 'elder')) {
      const family = households.get(elder.householdId)!.familyName;
      if (people.get(elder.childIds[0]!)!.role === 'head') {
        expect(elder.familyName).toBe(family);
      } else {
        own++;
        expect(elder.familyName).not.toBe(family);
        if (elder.partnerId) expect(people.get(elder.partnerId)!.familyName).toBe(elder.familyName);
      }
    }
    expect(own).toBeGreaterThan(50);
  });

  it('gives lodgers no kin', () => {
    const lodgers = badanos.people.filter((person) => person.role === 'lodger');
    expect(lodgers.length).toBeGreaterThan(500);
    for (const lodger of lodgers) {
      expect(lodger.partnerId).toBeUndefined();
      expect(lodger.parentIds).toEqual([]);
      expect(lodger.childIds).toEqual([]);
    }
  });

  it('never makes an elder the partner\'s parent when the pack leaves the share out', () => {
    const city = generateCity(brief, edited((raw) => delete raw.species.human.household.elderOfPartnerShare));
    const byId = new Map(city.people.map((person) => [person.id, person]));
    const elders = city.people.filter((person) => person.role === 'elder');
    // Only a third elder, which the human species does not allow, could be the partner's.
    expect(elders.every((elder) => byId.get(elder.childIds[0]!)!.role === 'head')).toBe(true);
  });

  it('finds every elder a child to be the parent of, even where a species allows more than two', () => {
    const dwarven = { ...pack, cultures: { ...pack.cultures, cultures: { ...pack.cultures.cultures, Vengrian: 'dwarf' } } };
    const city = generateCity(brief, dwarven);
    const byId = new Map(city.people.map((person) => [person.id, person]));
    const counts = new Map<string, number>();
    for (const elder of city.people.filter((person) => person.role === 'elder')) {
      expect(elder.childIds).toHaveLength(1);
      counts.set(elder.householdId, (counts.get(elder.householdId) ?? 0) + 1);
      expect(byId.get(elder.childIds[0]!)!.parentIds.length).toBeLessThanOrEqual(2);
    }
    expect(Math.max(...counts.values())).toBe(3);
  });
});

describe('who may hold which job', () => {
  it('gives nobody a job outside its age limits', () => {
    const limited = badanos.people.filter((person) => person.occupationId && occupationOf(person.occupationId).minAge !== undefined);
    expect(limited.length).toBeGreaterThan(300);
    expect(limited.filter((person) => person.age < occupationOf(person.occupationId!).minAge!)).toEqual([]);
    // The military had 21 workers under 16 in version 1.
    const military = badanos.people.filter((person) => person.occupationId && occupationOf(person.occupationId).category === 'military');
    expect(Math.min(...military.map((person) => person.age))).toBeGreaterThanOrEqual(16);
  });

  it('still lets children of working age work, in the jobs the pack leaves open', () => {
    const young = badanos.people.filter((person) => person.occupationId && person.age < 16);
    expect(young.length).toBeGreaterThan(200);
    expect(young.every((person) => occupationOf(person.occupationId!).minAge === undefined)).toBe(true);
  });

  it('flags a worker as an apprentice exactly when younger than the job\'s apprenticeUntil', () => {
    let apprentices = 0;
    for (const person of badanos.people) {
      if (!person.occupationId) {
        expect('apprentice' in person).toBe(false);
        continue;
      }
      const until = apprenticeUntil(occupationOf(person.occupationId), pack);
      expect(person.apprentice === true, person.id).toBe(person.age < until);
      if (person.apprentice) apprentices++;
      else expect('apprentice' in person).toBe(false);
    }
    expect(apprentices).toBeGreaterThan(100);
    // Unskilled jobs have no apprenticeship, however young the worker.
    expect(badanos.people.filter((person) => person.occupationId === 'servant' && person.apprentice)).toEqual([]);
    expect(badanos.people.some((person) => person.occupationId === 'servant' && person.age < 16)).toBe(true);
  });

  it('never makes an apprentice the proprietor of a workplace', () => {
    const households = new Map(badanos.households.map((household) => [household.id, household]));
    const live = new Set(pack.workplaces.filter((type) => type.proprietorLivesIn).map((type) => type.id));
    for (const building of badanos.buildings) {
      if (!live.has(building.type)) continue;
      for (const id of building.householdIds) expect(people.get(households.get(id)!.headId)!.apprentice).toBeUndefined();
    }
    // Even when the pack makes most workers apprentices.
    const late = generateCity(brief, edited((raw) => (raw.pack.apprenticeUntil = 45)));
    expect(late.people.filter((person) => person.apprentice).length).toBeGreaterThan(1500);
    const lateHouseholds = new Map(late.households.map((household) => [household.id, household]));
    const lateHeads = new Map(late.people.map((person) => [person.id, person]));
    let proprietors = 0;
    for (const building of late.buildings) {
      if (!live.has(building.type)) continue;
      for (const id of building.householdIds) {
        proprietors++;
        expect(lateHeads.get(lateHouseholds.get(id)!.headId)!.apprentice).toBeUndefined();
      }
    }
    expect(proprietors).toBeGreaterThan(100);
  });

  it('lets an apprentice\'s job set the household\'s status only when nobody else works', () => {
    const tiers = pack.pack.statusTiers.map((tier) => tier.id);
    let apprenticeLed = 0;
    for (const household of badanos.households) {
      const working = household.memberIds.map((id) => people.get(id)!).filter((person) => person.occupationId);
      if (working.length === 0) continue;
      const earner = working.find((person) => !person.apprentice) ?? working[0]!;
      if (working[0]!.apprentice && earner !== working[0]) apprenticeLed++;
      const distance = tiers.indexOf(household.statusTier) - tiers.indexOf(occupationOf(earner.occupationId!).status);
      expect(Math.abs(distance), household.id).toBeLessThanOrEqual(1);
    }
    expect(apprenticeLed).toBeGreaterThan(0);
  });

  it('removes every younger holder of an occupation given a minAge, without changing its count', () => {
    expect(badanos.people.some((person) => person.occupationId === 'tanner' && person.age < 30)).toBe(true);
    const city = generateCity(brief, edited((raw) => (occupationIn(raw, 'tanner').minAge = 30)));
    const tanners = city.people.filter((person) => person.occupationId === 'tanner');
    expect(tanners).toHaveLength(417);
    expect(Math.min(...tanners.map((person) => person.age))).toBeGreaterThanOrEqual(30);
    expect(city.summary.occupations).toEqual(badanos.summary.occupations);
  });

  it('respects a maxAge and a sexes limit', () => {
    const city = generateCity(
      brief,
      edited((raw) => {
        occupationIn(raw, 'tanner').sexes = ['female'];
        occupationIn(raw, 'weaponsmith').sexes = ['male'];
        occupationIn(raw, 'leatherworker').maxAge = 40;
      }),
    );
    const holding = (id: string) => city.people.filter((person) => person.occupationId === id);
    expect(new Set(holding('tanner').map((person) => person.sex))).toEqual(new Set(['female']));
    expect(new Set(holding('weaponsmith').map((person) => person.sex))).toEqual(new Set(['male']));
    expect(Math.max(...holding('leatherworker').map((person) => person.age))).toBeLessThanOrEqual(40);
    expect(city.summary.occupations).toEqual(badanos.summary.occupations);
  });

  it('fills every slot under tight limits by moving earlier workers to make room', () => {
    // Only two jobs are open to the under-16s, with barely more slots than there are of them.
    const tight = edited((raw) => {
      for (const entry of raw.occupations) if (!['servant', 'farmhand'].includes(entry.id)) entry.minAge = Math.max(entry.minAge ?? 0, 16);
    });
    const city = generateCity(brief, tight);
    const young = city.people.filter((person) => person.occupationId && person.age < 16);
    expect(young.length).toBeGreaterThan(300);
    expect(new Set(young.map((person) => person.occupationId))).toEqual(new Set(['servant', 'farmhand']));
    expect(city.summary.occupations).toEqual(badanos.summary.occupations);
    expect(checkCity(city, brief, tight)).toEqual([]);
  });

  it('fails, naming the settlement, the occupation and the shortfall, when the limits cannot be met', () => {
    // No dwarf, let alone a human, works at 200.
    const impossible = edited((raw) => (occupationIn(raw, 'servant').minAge = 200));
    expect(() => generateCity(brief, impossible)).toThrow(CityGenerationError);
    expect(() => generateCity(brief, impossible)).toThrow(
      /settlement-641 \(Badanos\): cannot fill 305 of the 305 slots for "servant": 305 workers are left/,
    );
    // Too few slots open to the young: the message names the jobs that could not be filled.
    const closed = edited((raw) => {
      for (const entry of raw.occupations) if (entry.id !== 'farmhand') entry.minAge = Math.max(entry.minAge ?? 0, 16);
    });
    expect(() => generateCity(brief, closed)).toThrow(/cannot fill \d+ of the \d+ slots for "[a-z-]+".*\d+ workers are left/);
  });
});

describe('shared workplaces', () => {
  it('puts at least 70% of members who share the head\'s occupation in the head\'s workplace', () => {
    let sharing = 0;
    let together = 0;
    for (const household of badanos.households) {
      const [head, ...others] = household.memberIds.map((id) => people.get(id)!) as [Person, ...Person[]];
      if (!head.occupationId) continue;
      for (const member of others) {
        if (member.occupationId !== head.occupationId) continue;
        sharing++;
        if (member.workplaceId === head.workplaceId) together++;
      }
    }
    expect(sharing).toBeGreaterThan(500);
    expect(together / sharing).toBeGreaterThanOrEqual(0.7);
    // Version 1 managed 36 of 769.
    expect(together / sharing).toBeGreaterThan(0.9);
  });

  it('includes lodgers who share the head\'s occupation', () => {
    const lodgers = badanos.people.filter((person) => person.role === 'lodger' && person.occupationId);
    const households = new Map(badanos.households.map((household) => [household.id, household]));
    const sharing = lodgers.filter((lodger) => people.get(households.get(lodger.householdId)!.headId)!.occupationId === lodger.occupationId);
    const together = sharing.filter((lodger) => people.get(households.get(lodger.householdId)!.headId)!.workplaceId === lodger.workplaceId);
    expect(sharing.length).toBeGreaterThan(50);
    expect(together.length / sharing.length).toBeGreaterThan(0.9);
  });

  it('keeps the number of buildings per type and their capacity as they were', () => {
    for (const type of pack.workplaces) {
      const holders = badanos.people.filter((person) => person.occupationId && occupationOf(person.occupationId).workplace === type.id);
      const buildings = badanos.buildings.filter((building) => building.type === type.id);
      expect(buildings.length, type.id).toBe(Math.ceil(holders.length / type.capacity));
      const perBuilding = new Map<string, number>();
      for (const person of holders) perBuilding.set(person.workplaceId!, (perBuilding.get(person.workplaceId!) ?? 0) + 1);
      expect(Math.max(0, ...perBuilding.values()), type.id).toBeLessThanOrEqual(type.capacity);
    }
  });
});

describe('work in an employer\'s home', () => {
  const servantsOf = (city: City) => city.people.filter((person) => person.occupationId === 'servant');

  it('has every servant work in the dwelling of a household that employs them, not their own', () => {
    const households = new Map(badanos.households.map((household) => [household.id, household]));
    const buildings = new Map(badanos.buildings.map((building) => [building.id, building]));
    const servants = servantsOf(badanos);
    expect(servants).toHaveLength(305);
    for (const servant of servants) {
      const employer = households.get(servant.employerHouseholdId!)!;
      expect(employer.id).not.toBe(servant.householdId);
      expect(servant.workplaceId).toBe(employer.dwellingId);
      const home = buildings.get(employer.dwellingId)!;
      expect(home.workerIds).toContain(servant.id);
      expect(home.kind).toBe('both');
      expect(Object.keys(occupationOf('servant').employer!.tiers)).toContain(employer.statusTier);
    }
    expect(badanos.people.filter((person) => person.employerHouseholdId && person.occupationId !== 'servant')).toEqual([]);
  });

  it('has no great house', () => {
    expect(badanos.buildings.filter((building) => building.type === 'great-house')).toEqual([]);
    expect(badanos.buildings.every((building) => building.kind === 'landmark' || building.workerIds.length + building.householdIds.length > 0)).toBe(true);
  });

  it('shares servants out by the tiers\' weights', () => {
    const households = new Map(badanos.households.map((household) => [household.id, household]));
    const perHousehold = (tier: string) => {
      const count = servantsOf(badanos).filter((servant) => households.get(servant.employerHouseholdId!)!.statusTier === tier).length;
      return count / badanos.summary.statusTiers[tier]!.households;
    };
    // A wealthy household has four times a comfortable one's weight.
    expect(perHousehold('wealthy')).toBeGreaterThan(perHousehold('comfortable') * 2);
    expect(perHousehold('noble')).toBeGreaterThan(perHousehold('wealthy'));
  });

  it('takes on a head and the co-residents who share the occupation together', () => {
    const households = new Map(badanos.households.map((household) => [household.id, household]));
    let sharing = 0;
    for (const servant of servantsOf(badanos)) {
      const head = people.get(households.get(servant.householdId)!.headId)!;
      if (servant.id === head.id || head.occupationId !== 'servant') continue;
      sharing++;
      expect(servant.employerHouseholdId).toBe(head.employerHouseholdId);
    }
    expect(sharing).toBeGreaterThan(5);
  });

  it('uses the highest tier present when no household of a listed tier exists', () => {
    const village = settlement('settlement-455');
    const nobleOnly = edited((raw) => (occupationIn(raw, 'servant').employer = { tiers: { noble: 1 } }));
    const city = generateCity(village, nobleOnly);
    expect(city.summary.statusTiers.noble!.households).toBe(0);
    const tiers = pack.pack.statusTiers.map((tier) => tier.id);
    const highest = [...tiers].reverse().find((tier) => city.summary.statusTiers[tier]!.households > 0)!;
    const households = new Map(city.households.map((household) => [household.id, household]));
    const servants = servantsOf(city);
    expect(servants.length).toBeGreaterThan(0);
    for (const servant of servants) expect(households.get(servant.employerHouseholdId!)!.statusTier).toBe(highest);
  });

  it('never has a household employ its own members, even when servants\' own tier employs', () => {
    const poorEmploy = edited((raw) => (occupationIn(raw, 'servant').employer = { tiers: { poor: 1 } }));
    const city = generateCity(brief, poorEmploy);
    const servants = servantsOf(city);
    expect(servants).toHaveLength(305);
    expect(servants.filter((servant) => servant.employerHouseholdId === servant.householdId)).toEqual([]);
    expect(checkCity(city, brief, poorEmploy)).toEqual([]);
  });

  it('does not count servants against a workplace\'s capacity', () => {
    const types = new Map(pack.workplaces.map((type) => [type.id, type]));
    const crowded = badanos.buildings.filter((building) => types.has(building.type) && building.workerIds.length > types.get(building.type)!.capacity);
    for (const building of crowded) {
      const own = building.workerIds.filter((id) => !people.get(id)!.employerHouseholdId);
      expect(own.length).toBeLessThanOrEqual(types.get(building.type)!.capacity);
    }
    expect(checkCity(badanos, brief, pack)).toEqual([]);
  });
});

describe('a pack with none of the new fields', () => {
  const legacy = (): SettingPack =>
    edited((raw) => {
      delete raw.pack.apprenticeUntil;
      delete raw.pack.apprenticeLabel;
      for (const entry of raw.occupations) {
        delete entry.minAge;
        delete entry.maxAge;
        delete entry.sexes;
        delete entry.apprenticeUntil;
        if (entry.employer) {
          delete entry.employer;
          entry.workplace = 'great-house';
        }
      }
      raw.workplaces.push({ id: 'great-house', name: 'Great house', capacity: 8, proprietorLivesIn: false, district: 'upper' });
      for (const species of Object.values<any>(raw.species)) delete species.household.elderOfPartnerShare;
    });

  it('generates a city with no apprentices, no limits and no employers, passing every invariant', () => {
    const old = legacy();
    const city = generateCity(brief, old);
    expect(checkCity(city, brief, old)).toEqual([]);
    expect(city.people.filter((person) => person.apprentice)).toEqual([]);
    expect(city.people.filter((person) => person.employerHouseholdId)).toEqual([]);
    expect(city.people.some((person) => person.occupationId === 'watchman' && person.age < 16)).toBe(true);
    expect(city.buildings.filter((building) => building.type === 'great-house').length).toBe(Math.ceil(311 / 8));
    expect(city.summary.occupations).toEqual(badanos.summary.occupations);
  });
});

describe('determinism', () => {
  it('gives byte-identical output on repeated runs', () => {
    expect(JSON.stringify(generateCity(brief, pack))).toBe(JSON.stringify(badanos));
    expect(JSON.stringify(generateCity(structuredClone(brief), parsePack(rawMedievalPack())))).toBe(JSON.stringify(badanos));
  });

  it('draws kinship and employers from their own streams, leaving the people as they were', () => {
    // Changing only the elder share touches kinship and names, not who exists or what they do.
    const other = generateCity(brief, edited((raw) => (raw.species.human.household.elderOfPartnerShare = 1)));
    const core = (city: City) => city.people.map((person) => [person.age, person.sex, person.role, person.occupationId, person.workplaceId]);
    expect(core(other)).toEqual(core(badanos));
    expect(other.people.map((person) => person.parentIds)).not.toEqual(badanos.people.map((person) => person.parentIds));
    // Changing only who employs touches servants' workplaces and nothing else.
    const employers = generateCity(brief, edited((raw) => (occupationIn(raw, 'servant').employer = { tiers: { wealthy: 1 } })));
    const withoutServants = (city: City) =>
      city.people.map((person) => (person.occupationId === 'servant' ? person.id : [person.age, person.occupationId, person.workplaceId, person.parentIds]));
    expect(withoutServants(employers)).toEqual(withoutServants(badanos));
  });
});

describe('the new invariants', () => {
  const village = settlement('settlement-455');
  const copy = (): City => structuredClone(generateCity(village, pack));
  const first = (city: City, wanted: (person: Person) => boolean) => city.people.find(wanted)!;
  const breaks: Array<[string, (city: City) => void, RegExp]> = [
    ['a child too close in age to a parent', (city) => (first(city, (p) => p.role === 'child').age = 80), /less than the parentMinAge of 18 apart/],
    ['a parent who does not list the child', (city) => first(city, (p) => p.role === 'child').parentIds.pop() && undefined, /as a child, who does not name them as a parent/],
    ['a child who does not name the parent', (city) => (first(city, (p) => p.role === 'head' && p.childIds.length > 0).childIds = []), /as parent, who does not list them as a child/],
    ['a partner who is not named back', (city) => delete first(city, (p) => p.role === 'partner').partnerId, /as partner, who does not name them back/],
    ['someone who is their own kin', (city) => { const p = first(city, (x) => x.role === 'head'); p.partnerId = p.id; }, /is their own partner/],
    ['a lodger with kin', (city) => { const l = first(city, (p) => p.role === 'lodger'); const h = first(city, (p) => p.householdId === l.householdId && p.role === 'head'); l.parentIds = [h.id]; h.childIds.push(l.id); }, /is a lodger but has kin/],
    ['kin in another household', (city) => (first(city, (p) => p.role === 'head' && !p.partnerId).partnerId = city.people.at(-1)!.id), /who lives in another household/],
    ['a worker below the job\'s minAge', (city) => (first(city, (p) => p.occupationId === 'gate-guard').age = 12), /is a gate-guard at 12, below its minAge of 16/],
    ['an apprentice who is not flagged', (city) => (first(city, (p) => p.occupationId === 'baker').age = 13), /a baker aged 13, is not marked an apprentice/],
    ['a flagged apprentice who is too old', (city) => (first(city, (p) => p.occupationId === 'baker' && p.age > 20).apprentice = true), /is marked an apprentice/],
    ['a non-worker flagged as an apprentice', (city) => (first(city, (p) => p.workforceState === 'not-working').apprentice = true), /not in the workforce but has an occupation, workplace, apprenticeship or employer/],
    ['a servant with no employer', (city) => delete first(city, (p) => p.occupationId === 'servant').employerHouseholdId, /is a servant but has no employing household/],
    ['a servant employed by their own household', (city) => { const s = first(city, (p) => p.occupationId === 'servant'); s.employerHouseholdId = s.householdId; }, /is employed by their own household/],
    ['a servant working somewhere other than the employer\'s home', (city) => { const s = first(city, (p) => p.occupationId === 'servant'); s.employerHouseholdId = city.households.find((h) => h.dwellingId !== s.workplaceId && h.id !== s.householdId)!.id; }, /but works in building-455-\d+, not its home/],
    ['an employer named by someone with a workplace of their own', (city) => (first(city, (p) => p.occupationId === 'baker').employerHouseholdId = city.households[0]!.id), /which has a workplace of its own, but names an employing household/],
  ];
  it.each(breaks)('reports %s', (_, damage, expected) => {
    const city = copy();
    damage(city);
    expect(checkCity(city, village, pack).join('\n')).toMatch(expected);
  });

  it('reports an apprentice as proprietor', () => {
    const city = structuredClone(badanos);
    const households = new Map(city.households.map((household) => [household.id, household]));
    const shop = city.buildings.find((building) => building.type === 'bakery' && building.householdIds.length === 1)!;
    const head = city.people.find((person) => person.id === households.get(shop.householdIds[0]!)!.headId)!;
    head.apprentice = true;
    expect(checkCity(city, brief, pack).join('\n')).toMatch(/has the apprentice person-641-\d+ as its proprietor/);
  });
});
