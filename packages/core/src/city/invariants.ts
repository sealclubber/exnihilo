/**
 * The rules every generated city must satisfy. The generator runs these on
 * its own output and fails loudly if any is broken; the tests run them too.
 */
import { type SettingPack, CATEGORY_IDS, allOccupations } from '../pack/schema.ts';
import type { SettlementBrief } from '../schema.ts';
import type { Building, City, Household, Person } from './records.ts';

/** The share of residents in the workforce must stay within these bounds. */
export const WORKFORCE_SHARE_LIMITS = { min: 0.35, max: 0.6 };

const MOST_PROBLEMS_LISTED = 20;

/** Returns one line per broken rule; an empty list means the city is sound. */
export function checkCity(city: City, brief: SettlementBrief, pack: SettingPack): string[] {
  const problems: string[] = [];
  const problem = (text: string) => {
    if (problems.length < MOST_PROBLEMS_LISTED) problems.push(text);
  };
  const { people, households, buildings, districts, summary } = city;

  const occupations = new Map(allOccupations(pack).map((occupation) => [occupation.id, occupation]));
  const workplaces = new Map(pack.workplaces.map((type) => [type.id, type]));
  const dwellings = new Map(pack.dwellings.map((type) => [type.id, type]));
  const landmarks = new Set(pack.landmarks.map((type) => type.id));
  const kinds = new Set(pack.districts.kinds.map((kind) => kind.id));
  const tiers = new Set(pack.pack.statusTiers.map((tier) => tier.id));

  // IDs are unique and every list is in ID order.
  const index = <T extends { id: string }>(what: string, list: T[]): Map<string, T> => {
    const map = new Map<string, T>();
    let previous = '';
    for (const record of list) {
      if (record.id <= previous) problem(`${what} ${record.id} is out of ID order or repeated`);
      previous = record.id;
      map.set(record.id, record);
    }
    return map;
  };
  const personById = index('person', people);
  const householdById = index('household', households);
  const buildingById = index('building', buildings);
  const districtById = index('district', districts);

  // The number of people equals the brief's population exactly.
  if (people.length !== brief.population) {
    problem(`there are ${people.length} people but the brief's population is ${brief.population}`);
  }

  // Every person belongs to exactly one household, and the links agree both ways.
  const memberships = new Map<string, number>();
  for (const household of households) {
    if (!tiers.has(household.statusTier)) problem(`${household.id} has the unknown status tier "${household.statusTier}"`);
    let heads = 0;
    for (const memberId of household.memberIds) {
      memberships.set(memberId, (memberships.get(memberId) ?? 0) + 1);
      const member = personById.get(memberId);
      if (!member) problem(`${household.id} lists ${memberId}, who does not exist`);
      else {
        if (member.householdId !== household.id) problem(`${household.id} lists ${memberId}, who names ${member.householdId}`);
        if (member.role === 'head') heads++;
      }
    }
    if (heads !== 1) problem(`${household.id} has ${heads} heads`);
    if (personById.get(household.headId)?.role !== 'head' || !household.memberIds.includes(household.headId)) {
      problem(`${household.id} names ${household.headId} as head, who is not a head among its members`);
    }
    // Every household lives in exactly one building, which lists it.
    const home = buildingById.get(household.dwellingId);
    if (!home) problem(`${household.id} lives in ${household.dwellingId}, which does not exist`);
    else if (!home.householdIds.includes(household.id)) problem(`${household.id} lives in ${home.id}, which does not list it`);
  }

  // Workers have exactly one occupation and one workplace; nobody else has either.
  const categoryCounts = new Map<string, number>(CATEGORY_IDS.map((category) => [category, 0]));
  const occupationCounts = new Map<string, number>();
  let working = 0;
  for (const person of people) {
    if (memberships.get(person.id) !== 1) {
      problem(`${person.id} is a member of ${memberships.get(person.id) ?? 0} households`);
    }
    if (!householdById.has(person.householdId)) problem(`${person.id} names ${person.householdId}, which does not exist`);
    if (person.workforceState !== 'working') {
      if (person.occupationId !== undefined || person.workplaceId !== undefined) {
        problem(`${person.id} is not in the workforce but has an occupation or workplace`);
      }
      continue;
    }
    working++;
    const occupation = person.occupationId === undefined ? undefined : occupations.get(person.occupationId);
    const workplace = person.workplaceId === undefined ? undefined : buildingById.get(person.workplaceId);
    if (!occupation) {
      problem(`${person.id} works as "${person.occupationId}", which is not an occupation in the pack`);
      continue;
    }
    if (!workplace) {
      problem(`${person.id} works at ${person.workplaceId}, which does not exist`);
      continue;
    }
    if (workplace.type !== occupation.workplace) {
      problem(`${person.id} is a ${occupation.id} but works in a ${workplace.type}`);
    }
    categoryCounts.set(occupation.category, (categoryCounts.get(occupation.category) as number) + 1);
    occupationCounts.set(occupation.id, (occupationCounts.get(occupation.id) ?? 0) + 1);
  }

  // Category counts sum to the workforce, and occupation counts to their category.
  let categoryTotal = 0;
  for (const category of CATEGORY_IDS) {
    categoryTotal += summary.categories[category];
    if (summary.categories[category] !== categoryCounts.get(category)) {
      problem(`the summary counts ${summary.categories[category]} in ${category}, the people ${categoryCounts.get(category)}`);
    }
    let inCategory = 0;
    for (const [id, count] of Object.entries(summary.occupations)) {
      if (occupations.get(id)?.category === category) inCategory += count;
    }
    if (inCategory !== summary.categories[category]) {
      problem(`occupations in ${category} sum to ${inCategory}, not the category's ${summary.categories[category]}`);
    }
  }
  if (categoryTotal !== working || summary.workforce.working !== working) {
    problem(`category counts sum to ${categoryTotal} and the summary says ${summary.workforce.working}, but ${working} people work`);
  }
  for (const [id, count] of Object.entries(summary.occupations)) {
    if (occupationCounts.get(id) !== count) problem(`the summary counts ${count} ${id}, the people ${occupationCounts.get(id) ?? 0}`);
  }
  if (summary.workforce.working + summary.workforce.keepingHouse + summary.workforce.notWorking !== people.length) {
    problem('the summary\'s workforce states do not sum to the population');
  }

  // The workforce is a plausible share of the population.
  const share = people.length === 0 ? 0 : working / people.length;
  if (share < WORKFORCE_SHARE_LIMITS.min || share > WORKFORCE_SHARE_LIMITS.max) {
    problem(
      `the workforce is ${(share * 100).toFixed(1)}% of the population, outside ${WORKFORCE_SHARE_LIMITS.min * 100}% to ${WORKFORCE_SHARE_LIMITS.max * 100}%`,
    );
  }

  // Buildings: known types, capacities respected, links agreeing both ways.
  for (const building of buildings) {
    const workplace = workplaces.get(building.type);
    const dwelling = dwellings.get(building.type);
    if (!workplace && !dwelling && !landmarks.has(building.type)) {
      problem(`${building.id} has the type "${building.type}", which is not in the pack`);
    }
    if (workplace && building.workerIds.length > workplace.capacity) {
      problem(`${building.id} (${building.type}) holds ${building.workerIds.length} workers, over its capacity of ${workplace.capacity}`);
    }
    const room = dwelling ? dwelling.households : workplace?.proprietorLivesIn ? 1 : 0;
    if (building.householdIds.length > room) {
      problem(`${building.id} (${building.type}) holds ${building.householdIds.length} households, over its capacity of ${room}`);
    }
    if (building.kind !== expectedKind(building, landmarks)) {
      problem(`${building.id} is marked ${building.kind} but should be ${expectedKind(building, landmarks)}`);
    }
    for (const id of building.householdIds) {
      if ((householdById.get(id) as Household | undefined)?.dwellingId !== building.id) {
        problem(`${building.id} lists ${id}, which does not live there`);
      }
    }
    for (const id of building.workerIds) {
      if ((personById.get(id) as Person | undefined)?.workplaceId !== building.id) {
        problem(`${building.id} lists ${id}, who does not work there`);
      }
    }
    const district = districtById.get(building.districtId);
    if (!district) problem(`${building.id} is in ${building.districtId}, which does not exist`);
  }
  // A worker's building must list them; counting is enough, given the check above.
  const listedWorkers = buildings.reduce((sum, building) => sum + building.workerIds.length, 0);
  if (listedWorkers !== working) problem(`buildings list ${listedWorkers} workers but ${working} people work`);
  const listedHouseholds = buildings.reduce((sum, building) => sum + building.householdIds.length, 0);
  if (listedHouseholds !== households.length) {
    problem(`buildings list ${listedHouseholds} households but there are ${households.length}`);
  }

  // Districts: known kinds, and every building in exactly the district it names.
  let listedBuildings = 0;
  for (const district of districts) {
    if (!kinds.has(district.kind)) problem(`${district.id} has the kind "${district.kind}", which is not in the pack`);
    for (const id of district.buildingIds) {
      listedBuildings++;
      if (buildingById.get(id)?.districtId !== district.id) problem(`${district.id} lists ${id}, which is not in it`);
    }
  }
  if (listedBuildings !== buildings.length) {
    problem(`districts list ${listedBuildings} buildings but there are ${buildings.length}`);
  }
  if (districts.length === 0) problem('there are no districts');

  // Every specialty tag in the brief is either used or marked ignored in the pack.
  for (const tag of brief.specialtyTags) {
    const treatment = pack.specialties.tags[tag];
    const carried = pack.occupations.some((occupation) => occupation.specialties?.includes(tag));
    if (!treatment || (!treatment.ignore && !carried)) {
      problem(`the specialty tag "${tag}" is neither used by an occupation nor marked ignored in the pack`);
    }
  }

  return problems;
}

function expectedKind(building: Building, landmarks: Set<string>): Building['kind'] {
  if (landmarks.has(building.type)) return 'landmark';
  if (building.workerIds.length > 0) return building.householdIds.length > 0 ? 'both' : 'workplace';
  return 'dwelling';
}
