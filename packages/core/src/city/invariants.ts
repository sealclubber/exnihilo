/**
 * The rules every generated city must satisfy. The generator runs these on
 * its own output and fails loudly if any is broken; the tests run them too.
 */
import { type SettingPack, CATEGORY_IDS, allOccupations, apprenticeUntil } from '../pack/schema.ts';
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
  const landmarkTypes = new Map(pack.landmarks.map((type) => [type.id, type]));
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
  /** Workers per building who count against a workplace's capacity: all but those employed by a household. */
  const staffed = new Map<string, number>();
  for (const person of people) {
    if (memberships.get(person.id) !== 1) {
      problem(`${person.id} is a member of ${memberships.get(person.id) ?? 0} households`);
    }
    if (!householdById.has(person.householdId)) problem(`${person.id} names ${person.householdId}, which does not exist`);
    checkKinship(person, personById, pack, problem);
    if (person.workforceState !== 'working') {
      if (
        person.occupationId !== undefined ||
        person.workplaceId !== undefined ||
        person.apprentice !== undefined ||
        person.employerHouseholdId !== undefined
      ) {
        problem(`${person.id} is not in the workforce but has an occupation, workplace, apprenticeship or employer`);
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
    if (occupation.employer) {
      // Work done in the home of a household that employs the person.
      const employer = person.employerHouseholdId === undefined ? undefined : householdById.get(person.employerHouseholdId);
      if (!employer) {
        problem(`${person.id} is a ${occupation.id} but has no employing household`);
      } else {
        if (employer.id === person.householdId) problem(`${person.id} is employed by their own household`);
        if (employer.dwellingId !== workplace.id) {
          problem(`${person.id} is employed by ${employer.id} but works in ${workplace.id}, not its home ${employer.dwellingId}`);
        }
      }
    } else {
      if (person.employerHouseholdId !== undefined) {
        problem(`${person.id} is a ${occupation.id}, which has a workplace of its own, but names an employing household`);
      }
      if (workplace.type !== occupation.workplace) {
        problem(`${person.id} is a ${occupation.id} but works in a ${workplace.type}`);
      }
      staffed.set(workplace.id, (staffed.get(workplace.id) ?? 0) + 1);
    }
    // Nobody holds an occupation the pack's limits exclude them from.
    if (occupation.minAge !== undefined && person.age < occupation.minAge) {
      problem(`${person.id} is a ${occupation.id} at ${person.age}, below its minAge of ${occupation.minAge}`);
    }
    if (occupation.maxAge !== undefined && person.age > occupation.maxAge) {
      problem(`${person.id} is a ${occupation.id} at ${person.age}, above its maxAge of ${occupation.maxAge}`);
    }
    if (occupation.sexes && !occupation.sexes.includes(person.sex)) {
      problem(`${person.id} is a ${occupation.id}, which is limited to ${occupation.sexes.join(' and ')}, but is ${person.sex}`);
    }
    // A worker is an apprentice exactly when younger than the job's apprenticeUntil.
    if ((person.apprentice === true) !== person.age < apprenticeUntil(occupation, pack)) {
      problem(
        `${person.id}, a ${occupation.id} aged ${person.age}, is ${person.apprentice ? '' : 'not '}marked an apprentice, against the job's apprenticeUntil of ${apprenticeUntil(occupation, pack)}`,
      );
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
    if (workplace && (staffed.get(building.id) ?? 0) > workplace.capacity) {
      problem(`${building.id} (${building.type}) holds ${staffed.get(building.id)} workers, over its capacity of ${workplace.capacity}`);
    }
    // The household living in a workplace is its proprietor's, and an apprentice is never the proprietor.
    if (workplace) {
      for (const id of building.householdIds) {
        const household = householdById.get(id);
        const head = household === undefined ? undefined : personById.get(household.headId);
        const ownTrade = head?.occupationId !== undefined && occupations.get(head.occupationId)?.workplace === building.type;
        if (!head || head.workplaceId !== building.id || !ownTrade) {
          problem(`${building.id} (${building.type}) houses ${id}, whose head does not work there as its proprietor`);
        } else if (head.apprentice) {
          problem(`${building.id} (${building.type}) has the apprentice ${head.id} as its proprietor`);
        }
      }
    }
    // A landmark whose keeper lives in houses the household of someone who holds its first post there.
    const keptBy = landmarkTypes.get(building.type);
    if (keptBy?.proprietorLivesIn) {
      for (const id of building.householdIds) {
        const keeper = householdById.get(id)?.memberIds.map((member) => personById.get(member)).find((member) => member?.workplaceId === building.id && member.occupationId === keptBy.posts[0]?.occupation);
        if (!keeper) problem(`${building.id} (${building.type}) houses ${id}, none of whom keeps it`);
        else if (keeper.apprentice) problem(`${building.id} (${building.type}) has the apprentice ${keeper.id} as its keeper`);
      }
    }
    const room = dwelling ? dwelling.households : workplace?.proprietorLivesIn || keptBy?.proprietorLivesIn ? 1 : 0;
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

/** Kinship: every tie recorded on both people, inside one household, with parents old enough. */
function checkKinship(
  person: Person,
  personById: Map<string, Person>,
  pack: SettingPack,
  problem: (text: string) => void,
): void {
  const { partnerId, parentIds, childIds } = person;
  if (partnerId === undefined && parentIds.length === 0 && childIds.length === 0) return;
  if (person.role === 'lodger') problem(`${person.id} is a lodger but has kin`);
  const kin = (id: string, tie: string): Person | undefined => {
    const other = personById.get(id);
    if (id === person.id) problem(`${person.id} is their own ${tie}`);
    else if (!other) problem(`${person.id} names ${id} as ${tie}, who does not exist`);
    else if (other.householdId !== person.householdId) problem(`${person.id} names ${id} as ${tie}, who lives in another household`);
    else return other;
    return undefined;
  };
  if (partnerId !== undefined) {
    const partner = kin(partnerId, 'partner');
    if (partner && partner.partnerId !== person.id) problem(`${person.id} names ${partnerId} as partner, who does not name them back`);
  }
  const parentMinAge = pack.species[person.species]?.ages.parentMinAge;
  if (parentMinAge === undefined) problem(`${person.id} is of the species "${person.species}", which is not in the pack`);
  for (const id of parentIds) {
    const parent = kin(id, 'parent');
    if (!parent) continue;
    if (!parent.childIds.includes(person.id)) problem(`${person.id} names ${id} as parent, who does not list them as a child`);
    if (parentMinAge !== undefined && parent.age - person.age < parentMinAge) {
      problem(`${person.id}, aged ${person.age}, has the parent ${id}, aged ${parent.age}: less than the parentMinAge of ${parentMinAge} apart`);
    }
  }
  if (new Set(parentIds).size !== parentIds.length || new Set(childIds).size !== childIds.length) {
    problem(`${person.id} lists the same parent or child twice`);
  }
  for (const id of childIds) {
    const child = kin(id, 'child');
    if (child && !child.parentIds.includes(person.id)) problem(`${person.id} lists ${id} as a child, who does not name them as a parent`);
  }
}

function expectedKind(building: Building, landmarks: Set<string>): Building['kind'] {
  if (landmarks.has(building.type)) return 'landmark';
  if (building.workerIds.length > 0) return building.householdIds.length > 0 ? 'both' : 'workplace';
  return 'dwelling';
}
