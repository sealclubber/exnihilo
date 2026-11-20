/**
 * The city generator: a settlement brief, a setting pack and a seed in; every
 * resident, household, building and district out, as linked records.
 *
 * Generation runs inside-out. People come first, buildings are derived from
 * what people need, and districts group the buildings. Each step draws
 * randomness only from its own stream.
 *
 * This file knows the seven categories, the brief's flags and the shape of
 * the records. Everything else, every occupation, building and number, comes
 * from the pack.
 */
import { idNumber } from '../ids.ts';
import {
  type CategoryId,
  type Condition,
  type CountSpec,
  type DwellingType,
  type Landmark,
  type Occupation,
  type SettingPack,
  type Species,
  type WorkplaceType,
  CATEGORY_IDS,
} from '../pack/schema.ts';
import type { SettlementBrief } from '../schema.ts';
import { checkCity } from './invariants.ts';
import { type NameGeneratorFactory, nameBaseNames } from './names.ts';
import { type Rng, apportion, shuffle, stepRng, weightedPicker } from './random.ts';
import type { Building, City, CitySummary, District, Household, HouseholdRole, Person } from './records.ts';

/** Raised whenever the generator's output for the same inputs would change. */
export const GENERATOR_VERSION = 1;

export class CityGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CityGenerationError';
  }
}

export interface GenerateOptions {
  /** Replaces the brief's own seed. */
  seed?: number;
  /** Replaces the default name generator. */
  names?: NameGeneratorFactory;
}

/** Which of the pack's conditions a settlement meets. */
export function conditionsOf(brief: SettlementBrief): Record<Condition, boolean> {
  return { ...brief.flags, provinceSeat: brief.isProvinceSeat };
}

/** The species a settlement's culture belongs to under a pack. */
export function speciesOf(brief: SettlementBrief, pack: SettingPack): string {
  return pack.cultures.cultures[brief.culture.name] ?? pack.cultures.default;
}

/** Resolves a count that is either fixed or grows with the population. */
export function resolveCount(spec: CountSpec, population: number): number {
  if ('fixed' in spec) return spec.fixed;
  const scaled = Math.round((population / 1000) * spec.perThousand);
  return Math.min(Math.max(scaled, spec.min ?? 0), spec.max ?? Infinity);
}

const pad = (value: number, digits: number) => String(value).padStart(digits, '0');

export function generateCity(brief: SettlementBrief, pack: SettingPack, options: GenerateOptions = {}): City {
  const seed = options.seed ?? brief.seed;
  const number = idNumber(brief.id);
  const population = brief.population;
  const conditions = conditionsOf(brief);
  const speciesId = speciesOf(brief, pack);
  const species = pack.species[speciesId] as Species;
  const tierIds = pack.pack.statusTiers.map((tier) => tier.id);
  const tierIndex = new Map(tierIds.map((tier, index) => [tier, index]));
  const landmarkById = new Map(pack.landmarks.map((landmark) => [landmark.id, landmark]));
  const fail = (message: string): never => {
    throw new CityGenerationError(`${brief.id} (${brief.name}): ${message}`);
  };

  for (const tag of brief.specialtyTags) {
    if (!(tag in pack.specialties.tags)) {
      fail(`the specialty tag "${tag}" is not listed in the pack; give it occupations or mark it ignored`);
    }
  }

  // ---- Step 1: households and people --------------------------------------
  const people: Person[] = [];
  const households: Household[] = [];
  /** Person indexes of each household's members, head first. */
  const members: number[][] = [];
  {
    const rng = stepRng(seed, 'households');
    const sizes = Object.keys(species.household.sizes).map(Number);
    const pickSize = weightedPicker(Object.values(species.household.sizes));
    const ageFrom = (bands: Species['ages']['head']) => {
      const pickBand = weightedPicker(bands.map((band) => band.weight));
      return () => {
        const band = bands[pickBand(rng)] as (typeof bands)[number];
        return rng.int(band.min, band.max);
      };
    };
    const headAge = ageFrom(species.ages.head);
    const lodgerAge = ageFrom(species.ages.lodger);
    const { ages } = species;
    const roleWeights = species.household.otherRoles;
    const pickers = new Map<string, (rng: Rng) => number>();
    const pickRole = (roles: HouseholdRole[]): HouseholdRole => {
      const key = roles.join();
      let picker = pickers.get(key);
      if (!picker) {
        const weights = roles.map((role) => roleWeights[role as 'child' | 'elder' | 'lodger']);
        // If the pack gives the possible roles no weight at all, they are equally likely.
        picker = weightedPicker(weights.some((weight) => weight > 0) ? weights : weights.map(() => 1));
        pickers.set(key, picker);
      }
      return roles[picker(rng)] as HouseholdRole;
    };

    while (people.length < population) {
      // The last household is cut to whatever is left, so the total is exact.
      const size = Math.min(sizes[pickSize(rng)] as number, population - people.length);
      const householdId = `household-${number}-${pad(households.length + 1, 6)}`;
      const list: number[] = [];
      const add = (role: HouseholdRole, age: number, male: boolean) => {
        list.push(people.length);
        people.push({
          id: `person-${number}-${pad(people.length + 1, 6)}`,
          givenName: '',
          familyName: '',
          age,
          sex: male ? 'male' : 'female',
          species: speciesId,
          cultureId: brief.culture.id,
          householdId,
          role,
          workforceState: 'not-working',
        });
      };

      const headIsMale = rng.chance(species.sexes.headMaleShare);
      const age = headAge();
      add('head', age, headIsMale);
      if (size >= 2 && rng.chance(species.household.partnerProbability)) {
        const gap = rng.int(ages.partnerGap.min, ages.partnerGap.max);
        add('partner', Math.min(Math.max(age + gap, ages.minPartnerAge), ages.maxAge), !headIsMale);
      }
      let elders = 0;
      while (list.length < size) {
        const possible: HouseholdRole[] = ['lodger'];
        if (age >= ages.parentMinAge) possible.push('child');
        if (elders < species.household.maxElders && age + ages.elderGap.min <= ages.maxAge) possible.push('elder');
        const role = pickRole(possible);
        const male = rng.chance(species.sexes.maleShare);
        if (role === 'child') {
          add('child', rng.int(0, Math.min(age - ages.parentMinAge, ages.childMaxAge)), male);
        } else if (role === 'elder') {
          elders++;
          add('elder', rng.int(age + ages.elderGap.min, Math.min(age + ages.elderGap.max, ages.maxAge)), male);
        } else {
          add('lodger', lodgerAge(), male);
        }
      }

      members.push(list);
      households.push({
        id: householdId,
        familyName: '',
        memberIds: list.map((index) => (people[index] as Person).id),
        headId: (people[list[0] as number] as Person).id,
        statusTier: '',
        dwellingId: '',
      });
    }
  }
  const householdOf = new Int32Array(people.length);
  members.forEach((list, household) => list.forEach((index) => (householdOf[index] = household)));

  // ---- Step 2: names ---------------------------------------------------------
  {
    const rng = stepRng(seed, 'names');
    const names = (options.names ?? nameBaseNames)(brief);
    households.forEach((household, index) => {
      household.familyName = names.familyName(rng);
      for (const member of members[index] as number[]) {
        const person = people[member] as Person;
        person.givenName = names.givenName(rng, person.sex);
        // A lodger is not kin, so does not share the household's name.
        person.familyName = person.role === 'lodger' ? names.familyName(rng) : household.familyName;
      }
    });
  }

  // ---- Step 3: workforce -----------------------------------------------------
  /** Person indexes of everyone in the workforce, in ID order. */
  const workers: number[] = [];
  {
    const rng = stepRng(seed, 'workforce');
    const { workingAges, share, unableShare, keepingHouseShare } = species.workforce;
    const person = (index: number) => people[index] as Person;
    const ofAge = (index: number) => person(index).age >= workingAges.min && person(index).age <= workingAges.max;
    const hasKeeper = new Uint8Array(households.length);

    // First pass: everyone of working age works unless unable or keeping house.
    people.forEach((entry, index) => {
      if (ofAge(index) && !rng.chance(unableShare)) entry.workforceState = 'working';
    });
    members.forEach((list, household) => {
      if (list.length < 2 || !rng.chance(keepingHouseShare)) return;
      // The partner keeps house if able, otherwise an elder, otherwise the eldest child.
      const candidates = list.filter((index) => person(index).workforceState === 'working' && person(index).role !== 'head');
      const keeper =
        candidates.find((index) => person(index).role === 'partner') ??
        candidates.find((index) => person(index).role === 'elder') ??
        candidates
          .filter((index) => person(index).role === 'child')
          .sort((a, b) => person(b).age - person(a).age || a - b)[0];
      if (keeper !== undefined) {
        person(keeper).workforceState = 'keeping-house';
        hasKeeper[household] = 1;
      }
    });

    // Second pass: the size of the workforce is an exact share of the population, so that it
    // does not depend on the seed. People are moved in or out of work until the count is met.
    const target = Math.round(population * share);
    const working: number[] = [];
    const idle: number[] = [];
    people.forEach((entry, index) => {
      if (entry.workforceState === 'working') working.push(index);
      else if (ofAge(index)) idle.push(index);
    });
    if (working.length > target) {
      // Heads keep their work for as long as anyone else can give theirs up.
      const order = [
        ...shuffle(rng, working.filter((index) => person(index).role !== 'head')),
        ...shuffle(rng, working.filter((index) => person(index).role === 'head')),
      ];
      for (const index of order.slice(0, working.length - target)) {
        const household = householdOf[index] as number;
        const canKeepHouse = hasKeeper[household] === 0 && person(index).role !== 'head';
        person(index).workforceState = canKeepHouse ? 'keeping-house' : 'not-working';
        if (canKeepHouse) hasKeeper[household] = 1;
      }
    } else if (working.length < target) {
      const needed = target - working.length;
      if (idle.length < needed) {
        fail(
          `the pack asks for a workforce of ${target}, but only ${working.length + idle.length} residents are of working age`,
        );
      }
      for (const index of shuffle(rng, idle).slice(0, needed)) person(index).workforceState = 'working';
    }
    people.forEach((entry, index) => {
      if (entry.workforceState === 'working') workers.push(index);
    });
  }

  // ---- Step 4: category shares ------------------------------------------------
  const shares = {} as Record<CategoryId, number>;
  const categoryCounts = {} as Record<CategoryId, number>;
  {
    const sizeModifiers = pack.modifiers.sizeGroups[brief.sizeGroup] ?? {};
    let total = 0;
    for (const category of pack.categories) {
      let share = category.share * (sizeModifiers[category.id] ?? 1);
      for (const [condition, multipliers] of Object.entries(pack.modifiers.conditions)) {
        if (conditions[condition as Condition]) share *= multipliers?.[category.id] ?? 1;
      }
      // A settlement has one culture and so one species; its multipliers apply in full.
      share *= species.multipliers.categories?.[category.id] ?? 1;
      shares[category.id] = share;
      total += share;
    }
    if (!(total > 0)) fail('every category share is zero after modifiers, so the workforce cannot be shared out');
    for (const category of CATEGORY_IDS) shares[category] = shares[category] / total;
    const counts = apportion(
      workers.length,
      CATEGORY_IDS.map((category) => shares[category]),
    );
    CATEGORY_IDS.forEach((category, index) => (categoryCounts[category] = counts[index] as number));
  }

  // The occupations this settlement can have: the pack's own plus its species' extras.
  const occupations: Occupation[] = [...pack.occupations, ...(species.occupations ?? [])];
  const occupationIndex = new Map(occupations.map((occupation, index) => [occupation.id, index]));
  /** Slots per occupation, by index into `occupations`. */
  const slots = new Array<number>(occupations.length).fill(0);

  // ---- Step 5: fixed posts -----------------------------------------------------
  const ordinary = { ...categoryCounts };
  const landmarkPlan: Array<{ landmark: Landmark; buildings: number }> = [];
  for (const landmark of pack.landmarks) {
    if (!conditions[landmark.when]) continue;
    landmarkPlan.push({ landmark, buildings: resolveCount(landmark.count, population) });
    for (const post of landmark.posts) {
      const index = occupationIndex.get(post.occupation) as number;
      const category = (occupations[index] as Occupation).category;
      // A post takes a slot from its own category. A category that has run out grants fewer posts.
      const granted = Math.min(resolveCount(post.count, population), ordinary[category]);
      ordinary[category] -= granted;
      slots[index]! += granted;
    }
  }

  // ---- Step 6: occupation slots ---------------------------------------------------
  {
    const multipliers = species.multipliers.occupations ?? {};
    const weightOf = (occupation: Occupation) =>
      landmarkById.has(occupation.workplace) || (occupation.minPopulation ?? 0) > population
        ? 0
        : occupation.weight * (multipliers[occupation.id] ?? 1);
    const usedTags = brief.specialtyTags
      .filter((tag) => !pack.specialties.tags[tag]?.ignore)
      .slice(0, pack.specialties.maxTags);

    for (const category of CATEGORY_IDS) {
      const count = ordinary[category];
      if (count === 0) continue;
      const weights = occupations.map((occupation) => (occupation.category === category ? weightOf(occupation) : 0));

      if (category === 'trade') {
        const general = weights.map((weight, index) => ((occupations[index] as Occupation).specialties ? 0 : weight));
        const generalTotal = general.reduce((a, b) => a + b, 0);
        // Each used tag that has occupations here, with its rank weight.
        const tags = usedTags
          .map((tag, rank) => {
            const own = weights.map((weight, index) =>
              (occupations[index] as Occupation).specialties?.includes(tag) ? weight : 0,
            );
            return { own, total: own.reduce((a, b) => a + b, 0), rank: pack.specialties.rankWeights[rank] as number };
          })
          .filter((tag) => tag.total > 0);
        const rankTotal = tags.reduce((sum, tag) => sum + tag.rank, 0);
        const specialtyShare = tags.length === 0 ? 0 : generalTotal > 0 ? pack.specialties.tradeShare : 1;
        weights.fill(0);
        general.forEach((weight, index) => {
          if (generalTotal > 0) weights[index]! += ((1 - specialtyShare) * weight) / generalTotal;
        });
        for (const tag of tags) {
          tag.own.forEach((weight, index) => {
            weights[index]! += (specialtyShare * (tag.rank / rankTotal) * weight) / tag.total;
          });
        }
      }

      if (!weights.some((weight) => weight > 0)) {
        fail(`the ${category} category has ${count} workers but the pack offers it no occupation here`);
      }
      apportion(count, weights).forEach((granted, index) => (slots[index]! += granted));
    }
  }

  // ---- Step 7: assigning slots ---------------------------------------------------------
  /** Occupation index of each person, or -1. */
  const occupationOf = new Int32Array(people.length).fill(-1);
  {
    const rng = stepRng(seed, 'assignment');
    const deck: number[] = [];
    slots.forEach((count, index) => {
      for (let n = 0; n < count; n++) deck.push(index);
    });
    shuffle(rng, deck);
    const free = [...slots];
    // Slots taken by name are still somewhere in the deck; this counts them so they are skipped when reached.
    const taken = new Array<number>(occupations.length).fill(0);
    let top = 0;
    const drawAny = (): number => {
      for (;;) {
        const index = deck[top++] as number;
        if (taken[index]! > 0) {
          taken[index]!--;
          continue;
        }
        free[index]!--;
        return index;
      }
    };
    for (const index of workers) {
      if ((people[index] as Person).role === 'head') occupationOf[index] = drawAny();
    }
    const follow = pack.pack.households.followHeadOccupation;
    for (const index of workers) {
      if ((people[index] as Person).role === 'head') continue;
      const head = (members[householdOf[index] as number] as number[])[0] as number;
      const headOccupation = occupationOf[head] as number;
      if (headOccupation >= 0 && free[headOccupation]! > 0 && rng.chance(follow)) {
        free[headOccupation]!--;
        taken[headOccupation]!++;
        occupationOf[index] = headOccupation;
      } else {
        occupationOf[index] = drawAny();
      }
    }
    for (const index of workers) {
      (people[index] as Person).occupationId = (occupations[occupationOf[index] as number] as Occupation).id;
    }
  }

  // ---- Step 8: status ----------------------------------------------------------------------
  {
    const rng = stepRng(seed, 'status');
    const { statusShiftUp, statusShiftDown, statusWithoutWorker } = pack.pack.households;
    households.forEach((household, index) => {
      const list = members[index] as number[];
      // The head's occupation sets the tier; a household whose head does not work takes its first worker's.
      const earner = list.find((member) => (occupationOf[member] as number) >= 0);
      if (earner === undefined) {
        household.statusTier = statusWithoutWorker;
        return;
      }
      let tier = tierIndex.get((occupations[occupationOf[earner] as number] as Occupation).status) as number;
      const roll = rng.next();
      if (roll < statusShiftUp) tier++;
      else if (roll < statusShiftUp + statusShiftDown) tier--;
      household.statusTier = tierIds[Math.min(Math.max(tier, 0), tierIds.length - 1)] as string;
    });
  }

  // ---- Step 9: workplaces ---------------------------------------------------------------------
  interface BuildingDraft {
    building: Building;
    workers: number[];
    /** The kind of district the building asks for, or the status tier whose districts it belongs in. */
    wants: { kind: string } | { tier: string };
    residents: number;
  }
  const drafts: BuildingDraft[] = [];
  const newBuilding = (type: string, kind: Building['kind'], wants: BuildingDraft['wants']): BuildingDraft => {
    const draft: BuildingDraft = {
      building: {
        id: `building-${number}-${pad(drafts.length + 1, 6)}`,
        type,
        kind,
        districtId: '',
        householdIds: [],
        workerIds: [],
      },
      workers: [],
      wants,
      residents: 0,
    };
    drafts.push(draft);
    return draft;
  };
  /** The household that lives in a workplace, by household index. */
  const livesAtWork = new Map<number, BuildingDraft>();
  {
    const workersByType = new Map<string, number[]>();
    for (const index of workers) {
      const type = (occupations[occupationOf[index] as number] as Occupation).workplace;
      let list = workersByType.get(type);
      if (!list) workersByType.set(type, (list = []));
      list.push(index);
    }
    const staff = (buildings: BuildingDraft[], staffList: number[]) => {
      staffList.forEach((index, turn) => (buildings[turn % buildings.length] as BuildingDraft).workers.push(index));
    };

    for (const { landmark, buildings } of landmarkPlan) {
      const staffList = workersByType.get(landmark.id) ?? [];
      const made: BuildingDraft[] = [];
      // A landmark that has staff exists even if its count came to zero.
      for (let n = 0; n < Math.max(buildings, staffList.length > 0 ? 1 : 0); n++) {
        made.push(newBuilding(landmark.id, 'landmark', { kind: landmark.district }));
      }
      staff(made, staffList);
    }

    for (const type of pack.workplaces as WorkplaceType[]) {
      const staffList = workersByType.get(type.id);
      if (!staffList) continue;
      // Heads are dealt out first, so that each building gets a proprietor where there are enough.
      const isHead = (index: number) => (people[index] as Person).role === 'head';
      const ordered = [...staffList.filter(isHead), ...staffList.filter((index) => !isHead(index))];
      const made: BuildingDraft[] = [];
      for (let n = 0; n < Math.ceil(ordered.length / type.capacity); n++) {
        made.push(newBuilding(type.id, 'workplace', { kind: type.district }));
      }
      staff(made, ordered);
      if (type.proprietorLivesIn) {
        for (const draft of made) {
          const proprietor = draft.workers[0] as number;
          if (isHead(proprietor)) livesAtWork.set(householdOf[proprietor] as number, draft);
        }
      }
    }

    for (const draft of drafts) {
      draft.workers.sort((a, b) => a - b);
      for (const index of draft.workers) {
        const person = people[index] as Person;
        person.workplaceId = draft.building.id;
        draft.building.workerIds.push(person.id);
      }
    }
  }

  // ---- Step 10: dwellings --------------------------------------------------------------------------
  {
    const rng = stepRng(seed, 'dwellings');
    const house = (draft: BuildingDraft, index: number) => {
      const household = households[index] as Household;
      household.dwellingId = draft.building.id;
      draft.building.householdIds.push(household.id);
      draft.residents += (members[index] as number[]).length;
    };
    for (const [index, draft] of livesAtWork) {
      draft.building.kind = 'both';
      house(draft, index);
    }
    for (const tier of tierIds) {
      const types = pack.dwellings.filter((type) => type.status === tier);
      const pickType = weightedPicker(types.map((type) => type.weight));
      let current: BuildingDraft | undefined;
      let room = 0;
      households.forEach((household, index) => {
        if (household.statusTier !== tier || livesAtWork.has(index)) return;
        if (!current || room === 0) {
          const type = types[pickType(rng)] as DwellingType;
          current = newBuilding(type.id, 'dwelling', { tier });
          room = type.households;
        }
        house(current, index);
        room--;
      });
    }
  }

  // ---- Step 11: districts ----------------------------------------------------------------------------
  const districts: District[] = [];
  {
    const rng = stepRng(seed, 'districts');
    const kinds = pack.districts.kinds;
    const byWeight = kinds.filter((kind) => kind.when === undefined);
    const first = byWeight[0] as (typeof kinds)[number];
    const wanted = Math.max(1, Math.round(population / pack.districts.residentsPerDistrict));
    // The first kind always gets one district; the rest are shared out by weight.
    const extra = apportion(
      wanted - 1,
      byWeight.map((kind) => kind.weight ?? 0),
    );
    const usedNames = new Set<string>();
    const expand = (pattern: string): string[] => {
      const match = /\{([^}]*)\}/.exec(pattern);
      if (!match) return [pattern];
      const key = match[1] as string;
      const values = key === 'settlement' ? [brief.name] : (pack.districts.words[key] as string[]);
      return values.flatMap((value) => expand(pattern.replace(match[0], value)));
    };
    /** Districts by kind, and whether the kind takes buildings that did not ask for it. */
    const load: number[] = [];
    const ofKind = new Map<string, number[]>();
    const open: number[] = [];

    for (const kind of kinds) {
      const count = kind.when === undefined ? (extra[byWeight.indexOf(kind)] as number) + (kind === first ? 1 : 0) : conditions[kind.when] ? 1 : 0;
      if (count === 0) continue;
      const candidates = shuffle(rng, [...new Set(kind.names.flatMap(expand))]);
      for (let n = 0, next = 0, round = 1; n < count; n++) {
        let name: string;
        do {
          // When the patterns run out, the names are reused with a number.
          if (next === candidates.length) {
            next = 0;
            round++;
          }
          name = round === 1 ? (candidates[next++] as string) : `${candidates[next++] as string} ${round}`;
        } while (usedNames.has(name));
        usedNames.add(name);
        const index = districts.length;
        districts.push({ id: `district-${number}-${pad(index + 1, 3)}`, name, kind: kind.id, buildingIds: [] });
        load.push(0);
        ofKind.set(kind.id, [...(ofKind.get(kind.id) ?? []), index]);
        if (kind.when === undefined) open.push(index);
      }
    }

    const ofTier = new Map<string, number[]>();
    for (const tier of tierIds) {
      ofTier.set(
        tier,
        kinds.filter((kind) => kind.statuses.includes(tier)).flatMap((kind) => ofKind.get(kind.id) ?? []),
      );
    }
    for (const draft of drafts) {
      const asked = 'kind' in draft.wants ? ofKind.get(draft.wants.kind) : ofTier.get(draft.wants.tier);
      // A building whose preferred kind is absent goes to any district that every settlement can have.
      const candidates = asked && asked.length > 0 ? asked : open;
      let best = candidates[0] as number;
      for (const index of candidates) {
        if ((load[index] as number) < (load[best] as number)) best = index;
      }
      load[best]! += draft.residents + draft.workers.length;
      const district = districts[best] as District;
      draft.building.districtId = district.id;
      district.buildingIds.push(draft.building.id);
    }
  }
  const buildings = drafts.map((draft) => draft.building);

  // ---- Step 12: summary ---------------------------------------------------------------------------------
  const summary: CitySummary = {
    settlementId: brief.id,
    settlementName: brief.name,
    population,
    households: households.length,
    buildings: buildings.length,
    districts: districts.length,
    workforce: { working: 0, keepingHouse: 0, notWorking: 0 },
    categories: Object.fromEntries(CATEGORY_IDS.map((category) => [category, 0])) as Record<CategoryId, number>,
    shares,
    occupations: {},
    statusTiers: Object.fromEntries(tierIds.map((tier) => [tier, { households: 0, residents: 0 }])),
    districtTotals: Object.fromEntries(
      districts.map((district) => [district.id, { residents: 0, households: 0, buildings: 0, workers: 0 }]),
    ),
    generatorVersion: GENERATOR_VERSION,
    pack: { name: pack.pack.name, version: pack.pack.version },
    seed,
  };
  {
    const occupationTotals = new Array<number>(occupations.length).fill(0);
    people.forEach((person, index) => {
      if (person.workforceState === 'working') summary.workforce.working++;
      else if (person.workforceState === 'keeping-house') summary.workforce.keepingHouse++;
      else summary.workforce.notWorking++;
      const occupation = occupationOf[index] as number;
      if (occupation >= 0) {
        occupationTotals[occupation]!++;
        summary.categories[(occupations[occupation] as Occupation).category]++;
      }
    });
    occupations.forEach((occupation, index) => {
      if ((occupationTotals[index] as number) > 0) summary.occupations[occupation.id] = occupationTotals[index] as number;
    });
    households.forEach((household, index) => {
      const tier = summary.statusTiers[household.statusTier] as { households: number; residents: number };
      tier.households++;
      tier.residents += (members[index] as number[]).length;
    });
    for (const draft of drafts) {
      const totals = summary.districtTotals[draft.building.districtId] as CitySummary['districtTotals'][string];
      totals.buildings++;
      totals.residents += draft.residents;
      totals.households += draft.building.householdIds.length;
      totals.workers += draft.workers.length;
    }
  }

  const city: City = { people, households, buildings, districts, summary };
  const broken = checkCity(city, brief, pack);
  if (broken.length > 0) {
    fail(`the generated city breaks ${broken.length === 1 ? 'an invariant' : 'invariants'}:\n  ${broken.join('\n  ')}`);
  }
  return city;
}
