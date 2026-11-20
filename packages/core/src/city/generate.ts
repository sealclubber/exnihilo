/**
 * The city generator: a settlement brief, a setting pack and a seed in; every
 * resident, household, building and district out, as linked records.
 *
 * Generation runs inside-out. People come first, buildings are derived from
 * what people need, and districts group the buildings. Each step draws
 * randomness only from its own stream.
 *
 * The steps, in order: households and people, kinship, names, workforce,
 * category shares, fixed posts, occupation slots, assigning slots, status,
 * workplaces, dwellings, work in an employer's home, districts, summary.
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
  apprenticeUntil,
} from '../pack/schema.ts';
import type { SettlementBrief } from '../schema.ts';
import { checkCity } from './invariants.ts';
import { type NameGeneratorFactory, nameBaseNames } from './names.ts';
import { type Rng, apportion, shuffle, stepRng, weightedPicker } from './random.ts';
import type { Building, City, CitySummary, District, Household, HouseholdRole, Person } from './records.ts';

/** Raised whenever the generator's output for the same inputs would change. */
export const GENERATOR_VERSION = 2;

/** A person has at most this many parents; it bounds how many elders one adult can be the child of. */
const PARENTS_PER_PERSON = 2;

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

  // ---- Households and people --------------------------------------
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
          parentIds: [],
          childIds: [],
          workforceState: 'not-working',
        });
      };

      const headIsMale = rng.chance(species.sexes.headMaleShare);
      const age = headAge();
      add('head', age, headIsMale);
      let partnerAge: number | undefined;
      if (size >= 2 && rng.chance(species.household.partnerProbability)) {
        const gap = rng.int(ages.partnerGap.min, ages.partnerGap.max);
        partnerAge = Math.min(Math.max(age + gap, ages.minPartnerAge), ages.maxAge);
        add('partner', partnerAge, !headIsMale);
      }
      // A child is the child of both adults, so the younger of them limits its age.
      const youngerParent = Math.min(age, partnerAge ?? age);
      const olderAdult = Math.max(age, partnerAge ?? age);
      let elders = 0;
      while (list.length < size) {
        const possible: HouseholdRole[] = ['lodger'];
        if (youngerParent >= ages.parentMinAge) possible.push('child');
        // An elder is a parent of the head or the partner. The head can have two; any more need a
        // partner to be the parents of, and are made old enough to be the parent of either adult.
        const elderBase = elders < PARENTS_PER_PERSON ? age : olderAdult;
        if (
          elders < species.household.maxElders &&
          elders < PARENTS_PER_PERSON * (partnerAge === undefined ? 1 : 2) &&
          elderBase + ages.elderGap.min <= ages.maxAge
        ) {
          possible.push('elder');
        }
        const role = pickRole(possible);
        const male = rng.chance(species.sexes.maleShare);
        if (role === 'child') {
          add('child', rng.int(0, Math.min(youngerParent - ages.parentMinAge, ages.childMaxAge)), male);
        } else if (role === 'elder') {
          elders++;
          add('elder', rng.int(elderBase + ages.elderGap.min, Math.min(elderBase + ages.elderGap.max, ages.maxAge)), male);
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

  // ---- Kinship ---------------------------------------------------------------
  /** Elders who are the partner's parent rather than the head's, by person index. */
  const partnersParent = new Set<number>();
  {
    const rng = stepRng(seed, 'kinship');
    const share = species.household.elderOfPartnerShare ?? 0;
    const gapMin = species.ages.elderGap.min;
    const person = (index: number) => people[index] as Person;
    const tie = (parent: number, child: number) => {
      person(parent).childIds.push(person(child).id);
      person(child).parentIds.push(person(parent).id);
    };
    const pair = (a: number, b: number) => {
      person(a).partnerId = person(b).id;
      person(b).partnerId = person(a).id;
    };
    for (const list of members) {
      const head = list[0] as number;
      const partner = list.find((index) => person(index).role === 'partner');
      if (partner !== undefined) pair(head, partner);
      const parentsOf = new Map<number, number[]>([[head, []]]);
      if (partner !== undefined) parentsOf.set(partner, []);
      for (const index of list) {
        const { role } = person(index);
        if (role === 'child') {
          tie(head, index);
          if (partner !== undefined) tie(partner, index);
        } else if (role === 'elder') {
          const hasRoom = (adult: number) => (parentsOf.get(adult) as number[]).length < PARENTS_PER_PERSON;
          const canBePartners =
            partner !== undefined && hasRoom(partner) && person(index).age - person(partner).age >= gapMin;
          // The head's parent unless a seeded choice says the partner's, or the head already has two.
          const child = canBePartners && (rng.chance(share) || !hasRoom(head)) ? (partner as number) : head;
          if (!hasRoom(child)) fail(`${person(index).id} is an elder with nobody left to be the parent of`);
          (parentsOf.get(child) as number[]).push(index);
          if (child !== head) partnersParent.add(index);
          tie(index, child);
        }
      }
      // Two elders who are the parents of the same person, and of opposite sex, are a couple.
      for (const parents of parentsOf.values()) {
        const [first, second] = parents;
        if (first !== undefined && second !== undefined && person(first).sex !== person(second).sex) pair(first, second);
      }
    }
  }

  // ---- Names -------------------------------------------------------------------
  {
    const rng = stepRng(seed, 'names');
    const names = (options.names ?? nameBaseNames)(brief);
    households.forEach((household, index) => {
      household.familyName = names.familyName(rng);
      // The partner's parents keep the name the partner was born with.
      let partnersFamily: string | undefined;
      for (const member of members[index] as number[]) {
        const person = people[member] as Person;
        person.givenName = names.givenName(rng, person.sex);
        if (person.role === 'lodger') {
          // A lodger is not kin, so does not share the household's name.
          person.familyName = names.familyName(rng);
        } else if (partnersParent.has(member)) {
          person.familyName = partnersFamily ??= names.familyName(rng);
        } else {
          person.familyName = household.familyName;
        }
      }
    });
  }

  // ---- workforce -----------------------------------------------------
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

  // ---- category shares ------------------------------------------------
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

  // ---- fixed posts -----------------------------------------------------
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

  // ---- occupation slots ---------------------------------------------------
  {
    const multipliers = species.multipliers.occupations ?? {};
    const weightOf = (occupation: Occupation) =>
      (occupation.workplace !== undefined && landmarkById.has(occupation.workplace)) ||
      (occupation.minPopulation ?? 0) > population
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

  // ---- assigning slots ---------------------------------------------------------
  /** Occupation index of each person, or -1. */
  const occupationOf = new Int32Array(people.length).fill(-1);
  const isApprentice = new Uint8Array(people.length);
  const headOf = (index: number) => (members[householdOf[index] as number] as number[])[0] as number;
  {
    const rng = stepRng(seed, 'assignment');
    const count = occupations.length;
    const free = [...slots];
    const offered = occupations.map((_, index) => index).filter((index) => (slots[index] as number) > 0);

    // Workers fall into classes by which occupations the pack lets them hold. The class depends
    // only on sex and on which of the pack's age limits the worker's age lies between.
    const limits = [
      ...new Set(
        offered.flatMap((index) => {
          const { minAge, maxAge } = occupations[index] as Occupation;
          return [...(minAge === undefined ? [] : [minAge]), ...(maxAge === undefined ? [] : [maxAge + 1])];
        }),
      ),
    ].sort((a, b) => a - b);
    interface EligibilityClass {
      id: number;
      /** Occupation indexes this class may hold, and the same as a lookup. */
      eligible: number[];
      can: Uint8Array;
    }
    const classes: EligibilityClass[] = [];
    const classByKey = new Map<string, EligibilityClass>();
    const classOf = (index: number): EligibilityClass => {
      const { age, sex } = people[index] as Person;
      let band = 0;
      while (band < limits.length && age >= (limits[band] as number)) band++;
      const key = `${sex}:${band}`;
      let found = classByKey.get(key);
      if (!found) {
        const eligible = offered.filter((occupationIndex) => {
          const { minAge, maxAge, sexes } = occupations[occupationIndex] as Occupation;
          return (minAge === undefined || age >= minAge) && (maxAge === undefined || age <= maxAge) && (!sexes || sexes.includes(sex));
        });
        const can = new Uint8Array(count);
        for (const occupationIndex of eligible) can[occupationIndex] = 1;
        found = { id: classes.length, eligible, can };
        classes.push(found);
        classByKey.set(key, found);
      }
      return found;
    };

    /** Who holds each occupation, by class, so that a holder can be moved when someone else has no other choice. */
    const holders = new Map<number, number[]>();
    const hold = (worker: number, group: EligibilityClass, occupation: number) => {
      occupationOf[worker] = occupation;
      const key = group.id * count + occupation;
      const list = holders.get(key);
      if (list) list.push(worker);
      else holders.set(key, [worker]);
    };
    const take = (worker: number, group: EligibilityClass, occupation: number) => {
      free[occupation]!--;
      hold(worker, group, occupation);
    };

    /**
     * Finds a place for a worker whose eligible occupations are all full, by moving earlier
     * workers along a chain into occupations they may also hold. Fails only when no assignment
     * of everyone could give this worker a place.
     */
    const makeRoom = (worker: number, group: EligibilityClass): boolean => {
      const cameFrom = new Int32Array(count).fill(-2);
      const movedClass = new Int32Array(count);
      const queue = [...group.eligible];
      for (const occupation of queue) cameFrom[occupation] = -1;
      let end = -1;
      search: for (let at = 0; at < queue.length; at++) {
        const occupation = queue[at] as number;
        for (const other of classes) {
          if (!holders.get(other.id * count + occupation)?.length) continue;
          for (const next of other.eligible) {
            if (cameFrom[next] !== -2) continue;
            cameFrom[next] = occupation;
            movedClass[next] = other.id;
            if ((free[next] as number) > 0) {
              end = next;
              break search;
            }
            queue.push(next);
          }
        }
      }
      if (end === -1) return false;
      free[end]!--;
      let occupation = end;
      while (cameFrom[occupation] !== -1) {
        const previous = cameFrom[occupation] as number;
        const mover = classes[movedClass[occupation] as number] as EligibilityClass;
        const moved = (holders.get(mover.id * count + previous) as number[]).pop() as number;
        hold(moved, mover, occupation);
        occupation = previous;
      }
      hold(worker, group, occupation);
      return true;
    };

    const unplaced: number[] = [];
    /** Gives the worker a free slot chosen evenly from those they are eligible for. */
    const drawAny = (worker: number, group: EligibilityClass) => {
      let open = 0;
      for (const occupation of group.eligible) open += free[occupation] as number;
      if (open === 0) {
        if (!makeRoom(worker, group)) unplaced.push(worker);
        return;
      }
      let target = rng.int(0, open - 1);
      for (const occupation of group.eligible) {
        target -= free[occupation] as number;
        if (target < 0) return take(worker, group, occupation);
      }
    };

    for (const index of workers) {
      if ((people[index] as Person).role === 'head') drawAny(index, classOf(index));
    }
    const follow = pack.pack.households.followHeadOccupation;
    for (const index of workers) {
      if ((people[index] as Person).role === 'head') continue;
      const group = classOf(index);
      const headOccupation = occupationOf[headOf(index)] as number;
      if (headOccupation >= 0 && free[headOccupation]! > 0 && group.can[headOccupation] === 1 && rng.chance(follow)) {
        take(index, group, headOccupation);
      } else {
        drawAny(index, group);
      }
    }

    if (unplaced.length > 0) {
      const short = offered
        .filter((index) => (free[index] as number) > 0)
        .map((index) => `${free[index]} of the ${slots[index]} slots for "${(occupations[index] as Occupation).id}"`);
      fail(
        `cannot fill ${short.join(', ')}: ${unplaced.length} ${unplaced.length === 1 ? 'worker is' : 'workers are'} left ` +
          'whom the pack\'s minAge, maxAge and sexes limits exclude from every remaining slot. Loosen a limit on one of these occupations.',
      );
    }
    for (const index of workers) {
      const person = people[index] as Person;
      const occupation = occupations[occupationOf[index] as number] as Occupation;
      person.occupationId = occupation.id;
      if (person.age < apprenticeUntil(occupation, pack)) {
        person.apprentice = true;
        isApprentice[index] = 1;
      }
    }
  }

  // ---- status ----------------------------------------------------------------------
  {
    const rng = stepRng(seed, 'status');
    const { statusShiftUp, statusShiftDown, statusWithoutWorker } = pack.pack.households;
    households.forEach((household, index) => {
      const list = members[index] as number[];
      const working = list.filter((member) => (occupationOf[member] as number) >= 0);
      // The head's occupation sets the tier, or failing that the first worker's. An apprentice's
      // job counts only when nobody else in the household works.
      const earner = working.find((member) => isApprentice[member] === 0) ?? working[0];
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

  // ---- workplaces ---------------------------------------------------------------------
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
  /**
   * Splits the holders of one kind of work into heads, each with the co-residents who share
   * the head's occupation, and everyone else. Groups are ordered largest first.
   */
  const groupByHead = (staffList: number[]): { groups: number[][]; others: number[] } => {
    const byHead = new Map<number, number[]>();
    const others: number[] = [];
    for (const index of staffList) {
      if ((people[index] as Person).role === 'head') byHead.set(index, [index]);
    }
    for (const index of staffList) {
      if ((people[index] as Person).role === 'head') continue;
      const group = occupationOf[headOf(index)] === occupationOf[index] ? byHead.get(headOf(index)) : undefined;
      if (group) group.push(index);
      else others.push(index);
    }
    const groups = [...byHead.values()].sort((a, b) => b.length - a.length || (a[0] as number) - (b[0] as number));
    return { groups, others };
  };
  /** The household that lives in a workplace, by household index. */
  const livesAtWork = new Map<number, BuildingDraft>();
  {
    const workersByType = new Map<string, number[]>();
    for (const index of workers) {
      const type = (occupations[occupationOf[index] as number] as Occupation).workplace;
      if (type === undefined) continue; // works in an employer's home, which is settled once homes exist
      let list = workersByType.get(type);
      if (!list) workersByType.set(type, (list = []));
      list.push(index);
    }

    for (const { landmark, buildings } of landmarkPlan) {
      const staffList = workersByType.get(landmark.id) ?? [];
      const made: BuildingDraft[] = [];
      // A landmark that has staff exists even if its count came to zero.
      for (let n = 0; n < Math.max(buildings, staffList.length > 0 ? 1 : 0); n++) {
        made.push(newBuilding(landmark.id, 'landmark', { kind: landmark.district }));
      }
      staffList.forEach((index, turn) => (made[turn % made.length] as BuildingDraft).workers.push(index));
    }

    for (const type of pack.workplaces as WorkplaceType[]) {
      const staffList = workersByType.get(type.id);
      if (!staffList) continue;
      const made: BuildingDraft[] = [];
      for (let n = 0; n < Math.ceil(staffList.length / type.capacity); n++) {
        made.push(newBuilding(type.id, 'workplace', { kind: type.district }));
      }
      const emptiest = (): BuildingDraft => {
        let best = made[0] as BuildingDraft;
        for (const draft of made) if (draft.workers.length < best.workers.length) best = draft;
        return best;
      };
      // Each head goes in together with the co-residents who share the head's occupation, largest
      // group first and always into the emptiest building, so that heads are spread across the
      // buildings and groups stay whole where capacity allows. Whoever does not fit, and everyone
      // who follows no head, then fills the places that remain.
      const { groups, others } = groupByHead(staffList);
      const proprietors = new Map<BuildingDraft, number>();
      for (const group of groups) {
        const draft = emptiest();
        const head = group[0] as number;
        const fits = group.splice(0, type.capacity - draft.workers.length);
        draft.workers.push(...fits);
        others.push(...group);
        // The proprietor is the first head placed in a building. An apprentice is never one.
        if (!proprietors.has(draft) && isApprentice[head] === 0) proprietors.set(draft, head);
      }
      for (const index of others.sort((a, b) => a - b)) emptiest().workers.push(index);
      if (type.proprietorLivesIn) {
        for (const [draft, proprietor] of proprietors) livesAtWork.set(householdOf[proprietor] as number, draft);
      }
    }
  }

  // ---- dwellings --------------------------------------------------------------------------
  /** Each household's home, by household index. */
  const homeOf: BuildingDraft[] = [];
  {
    const rng = stepRng(seed, 'dwellings');
    const house = (draft: BuildingDraft, index: number) => {
      const household = households[index] as Household;
      household.dwellingId = draft.building.id;
      draft.building.householdIds.push(household.id);
      draft.residents += (members[index] as number[]).length;
      homeOf[index] = draft;
    };
    for (const [index, draft] of livesAtWork) house(draft, index);
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

  // ---- Work in an employer's home ---------------------------------------------------------------
  {
    const rng = stepRng(seed, 'employers');
    const byOccupation = new Map<number, number[]>();
    for (const index of workers) {
      const occupation = occupationOf[index] as number;
      if (!(occupations[occupation] as Occupation).employer) continue;
      const list = byOccupation.get(occupation);
      if (list) list.push(index);
      else byOccupation.set(occupation, [index]);
    }
    const householdsOfTier = (tier: string) =>
      households.flatMap((household, index) => (household.statusTier === tier ? [index] : []));
    const tiersFromTop = [...tierIds].reverse();

    for (const [occupation, staffList] of byOccupation) {
      const { id, employer } = occupations[occupation] as Occupation;
      // Households of the listed tiers employ, by the tier's weight. Where there are none, the highest tier present does.
      let candidates: number[] = [];
      let weights: number[] = [];
      for (const [tier, weight] of Object.entries((employer as NonNullable<Occupation['employer']>).tiers)) {
        const found = householdsOfTier(tier);
        candidates.push(...found);
        weights.push(...found.map(() => weight));
      }
      if (candidates.length === 0) {
        candidates = householdsOfTier(tiersFromTop.find((tier) => householdsOfTier(tier).length > 0) as string);
        weights = candidates.map(() => 1);
      }
      const pick = weightedPicker(weights);

      // A head and the co-residents who share the occupation are taken on together.
      const { groups, others } = groupByHead(staffList);
      const units = [...groups, ...others.map((index) => [index])].sort((a, b) => (a[0] as number) - (b[0] as number));
      for (const unit of units) {
        const own = householdOf[unit[0] as number] as number;
        const drawn = pick(rng);
        // Nobody is employed by their own household: the next candidate takes them instead, or
        // failing that the first household of the highest tier that has another.
        let employing: number | undefined = candidates[drawn] as number;
        if (employing === own) employing = candidates.length > 1 ? candidates[(drawn + 1) % candidates.length] : undefined;
        if (employing === undefined) {
          employing = tiersFromTop.flatMap(householdsOfTier).find((index) => index !== own);
        }
        if (employing === undefined) {
          return fail(`nobody can employ the ${unit.length} "${id}" of ${(households[own] as Household).id}: it is the only household`);
        }
        for (const index of unit) {
          (people[index] as Person).employerHouseholdId = (households[employing] as Household).id;
          (homeOf[employing] as BuildingDraft).workers.push(index);
        }
      }
    }
  }

  // Buildings now have everyone who works in them.
  for (const draft of drafts) {
    const { building } = draft;
    if (building.kind !== 'landmark') {
      building.kind = draft.workers.length === 0 ? 'dwelling' : building.householdIds.length > 0 ? 'both' : 'workplace';
    }
    draft.workers.sort((a, b) => a - b);
    for (const index of draft.workers) {
      const person = people[index] as Person;
      person.workplaceId = building.id;
      building.workerIds.push(person.id);
    }
  }

  // ---- districts ----------------------------------------------------------------------------
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

  // ---- summary ---------------------------------------------------------------------------------
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
