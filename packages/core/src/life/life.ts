/**
 * A settlement's daily life: every resident's plan for every day, and where
 * everyone is at any moment.
 *
 * Nothing is stepped. A plan is a pure function of the person, the day, the
 * city, the layout, the pack and a seed; a position is a plan plus a game
 * time. So any moment can be asked about in any order, at any clock rate.
 *
 * How a plan is made. Each person has a personal day that runs from the
 * middle of one sleep to the middle of the next, placed so that it holds
 * their whole shift even when the shift crosses midnight. Within it they
 * sleep, wake, perhaps go to work, perhaps make a visit or two, come home
 * and sleep. A personal day depends only on the person and its day number,
 * and always begins and ends asleep at home, so days join without a seam. A
 * calendar day's plan is the midnight-to-midnight slice across the personal
 * days that overlap it.
 *
 * This module reads the layout format and uses the path function. It knows
 * nothing of how a layout was generated.
 */
import type { City, Person } from '../city/records.ts';
import { createRng } from '../city/random.ts';
import { boxOf, distance, pointAlongPolyline } from '../layout/geometry.ts';
import { createPathFinder } from '../layout/path.ts';
import type { Layout } from '../layout/records.ts';
import { type NamedShift, type SettingPack, type Species, type Visit, HOME, placeFlagsOf, shiftLength, sleepLength } from '../pack/schema.ts';
import type { Point } from '../schema.ts';
import { deriveSeed } from '../seed.ts';
import { SECONDS_PER_DAY, dayOf, isRestDay, startOfDay, weekdayOf } from './calendar.ts';
import { createWorkingHours } from './hours.ts';
import { type Ground, type WanderHabit, clipWander, groundOf, makeWander, positionOnWander } from './wander.ts';
import type { Activity, DayPlan, DaySummary, Nearby, Occupant, OpenSpan, OutsideStay, Region, Stay, Travel, Trip, TripPath, Wander, Whereabouts } from './records.ts';

export { dutyCount, restDaysUpTo } from './hours.ts';

export class LifeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifeError';
  }
}

export interface LifeInputs {
  city: City;
  layout: Layout;
  pack: SettingPack;
  /** Left out, the city's own seed is used. */
  seed?: number;
}

export interface SettlementLife {
  /** One person's plan for one day. */
  plan(personId: string, day: number): DayPlan;
  /** Everyone's plan for one day, in person order. */
  plansForDay(day: number): DayPlan[];
  /** Where a person is at a game time. */
  whereabouts(personId: string, time: number): Whereabouts;
  /** Who is at a building at a game time, inside it or outside on its lot. */
  occupants(buildingId: string, time: number): Occupant[];
  /** Whether a building is open at a game time: whether someone who works there is on shift, or it never closes. */
  isOpen(buildingId: string, time: number): boolean;
  /** The stretches of a day during which a building is open. */
  openingHours(buildingId: string, day: number): OpenSpan[];
  /** The shift a person works, the same every day; nothing for someone with no job. */
  shiftOf(personId: string): NamedShift | undefined;
  /** The stays out of doors that overlap a window of game time, optionally only those in a region. */
  outsideStays(from: number, to: number, region?: Region): OutsideStay[];
  /** The trips under way at any point in a window of game time, optionally only those that pass through a region. */
  trips(from: number, to: number, region?: Region): Trip[];
  /**
   * Every resident who can be seen within a distance of a point at a game time, nearest first: those walking
   * between two buildings and those outside at one. People inside buildings are not among them.
   */
  nearby(point: Point, radius: number, time: number): Nearby[];
  /** A day, hour by hour. */
  daySummary(day: number): DaySummary;
  /** How many of a day's trips use each segment, busiest first. */
  segmentLoads(day: number): Array<{ segmentId: string; trips: number }>;
}

/** The walking speed of a person, in metres per second. */
export function walkingSpeed(person: Pick<Person, 'age' | 'species'>, pack: SettingPack): number {
  const bands = (pack.species[person.species] as Species).life.walkingSpeed;
  const band = bands.find((entry) => entry.upToAge === undefined || person.age <= entry.upToAge);
  return (band as (typeof bands)[number]).metresPerSecond;
}

/** How long a walk of a given length takes a person, in whole game seconds. */
export function tripDuration(length: number, speed: number): number {
  return Math.ceil(length / speed);
}

const DAYS_KEPT = 4;
/** The nearby query's index sorts a day's walks and outside stays into stretches of this many game seconds. */
const WALK_SLOT = 300;
const STAY_SLOT = 3600;

export function createLife(inputs: LifeInputs): SettlementLife {
  const { city, layout, pack } = inputs;
  const seed = inputs.seed ?? city.summary.seed;
  const { calendar } = pack;
  const finder = createPathFinder(layout);

  // ---- Lookups, made once -------------------------------------------------------
  const personIndex = new Map(city.people.map((person, index) => [person.id, index]));
  const homeOf = new Map(city.households.map((household) => [household.id, household.dwellingId]));
  const lotOf = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
  const hours = createWorkingHours({ city, pack, seed });
  const checksHours = pack.visits.openingHours === true;
  const buildingType = new Map(city.buildings.map((building) => [building.id, building.type]));
  const buildingsOfType = new Map<string, string[]>();
  for (const building of city.buildings) {
    const list = buildingsOfType.get(building.type);
    if (list) list.push(building.id);
    else buildingsOfType.set(building.type, [building.id]);
  }
  const openAir = new Set(city.buildings.filter((building) => placeFlagsOf(building.type, pack).openAir).map((building) => building.id));
  const lotBoxes = new Map<string, Region>();
  const lotBox = (buildingId: string): Region => {
    let box = lotBoxes.get(buildingId);
    if (!box) {
      const lot = lotOf.get(buildingId);
      if (!lot) throw new LifeError(`${buildingId} has no lot in the layout`);
      lotBoxes.set(buildingId, (box = boxOf(lot.polygon)));
    }
    return box;
  };
  const entranceOf = (buildingId: string): Point => {
    const lot = lotOf.get(buildingId);
    if (!lot) throw new LifeError(`${buildingId} has no lot in the layout`);
    return lot.entrance.point;
  };

  // ---- What is fixed about a person ---------------------------------------------------
  interface Profile {
    person: Person;
    home: string;
    speed: number;
    species: Species;
    /** The person's habit: earlier or later, the same every day, in seconds. */
    habit: number;
    /** Usual waking time, in seconds from the start of the day, before the habit and the day's variation. */
    wake: number;
    sleepLength: number;
    /** Where the personal day starts, in seconds from the start of the calendar day of the same number. */
    anchor: number;
    work?: { building: string; start: number; end: number };
  }
  const profiles = new Array<Profile | undefined>(city.people.length);
  const profileOf = (index: number): Profile => {
    const known = profiles[index];
    if (known) return known;
    const person = city.people[index] as Person;
    const species = pack.species[person.species] as Species;
    const home = homeOf.get(person.householdId) as string;
    const asleep = sleepLength(species);
    const { personalMinutes } = species.life.variation;
    const habit = Math.round((createRng(deriveSeed(String(seed), 'life-habit', person.id)).next() * 2 - 1) * personalMinutes * 60);
    let wake = species.life.sleep.to;
    let work: Profile['work'];
    const shift = hours.shiftOf(index);
    if (shift && person.workplaceId !== undefined) {
      const start = shift.start;
      const end = shift.start + shiftLength(shift);
      work = { building: person.workplaceId, start, end };
      // Sleep is moved, not shortened, as far as the shift requires: up in time to get ready, and not to bed before winding down.
      const earliest = end + species.life.minutesBeforeBed * 60 - (SECONDS_PER_DAY - asleep);
      const latest = start - species.life.minutesBeforeLeaving * 60;
      wake = Math.min(Math.max(wake, earliest), latest);
    }
    const profile: Profile = {
      person,
      home,
      speed: walkingSpeed(person, pack),
      species,
      habit,
      wake,
      sleepLength: asleep,
      anchor: wake + habit - Math.round(asleep / 2),
      ...(work && { work }),
    };
    profiles[index] = profile;
    return profile;
  };

  // ---- Trips and destinations ---------------------------------------------------------
  const paths = new Map<string, TripPath>();
  const pathBetween = (from: string, to: string): TripPath => {
    const key = `${from}>${to}`;
    let path = paths.get(key);
    if (!path) {
      const a = lotOf.get(from);
      const b = lotOf.get(to);
      if (!a || !b) throw new LifeError(`${a ? to : from} has no lot in the layout`);
      const { segmentIds, walked, length, points } = finder.path(a.id, b.id);
      path = { segmentIds, walked, length, points };
      paths.set(key, path);
    }
    return path;
  };
  const travel = (from: string, to: string, departAt: number, speed: number): Travel => {
    const path = pathBetween(from, to);
    const arriveAt = departAt + tripDuration(path.length, speed);
    return { kind: 'travel', start: departAt, end: arriveAt, fromBuildingId: from, toBuildingId: to, departAt, arriveAt, path };
  };
  /** The buildings a visit can go to from a starting point, nearest first. Kept, since homes are asked about daily. */
  interface Reachable {
    id: string;
    /** Straight-line distance, which no walk can beat. */
    away: number;
  }
  const reachable = new Map<string, Reachable[]>();
  const destinations = (visit: Visit, from: string): Reachable[] => {
    const key = `${visit.id}|${from}`;
    let list = reachable.get(key);
    if (!list) {
      const origin = entranceOf(from);
      list = visit.destinations
        .flatMap((type) => buildingsOfType.get(type) ?? [])
        .filter((id) => id !== from && lotOf.has(id))
        .map((id) => ({ id, away: distance(origin, entranceOf(id)) }))
        .sort((a, b) => a.away - b.away || (a.id < b.id ? -1 : 1));
      reachable.set(key, list);
    }
    return list;
  };

  // ---- A personal day ---------------------------------------------------------------------
  const visits = pack.visits.visits;
  const applies = (visit: Visit, person: Person, workedToday: boolean, restDay: boolean, day: number): boolean => {
    if (visit.weekdays && !visit.weekdays.includes(calendar.week[weekdayOf(day, calendar)]!.name)) return false;
    if (!visit.who.states.includes(person.workforceState)) return false;
    if (visit.who.minAge !== undefined && person.age < visit.who.minAge) return false;
    if (visit.who.maxAge !== undefined && person.age > visit.who.maxAge) return false;
    if (visit.days === 'any') return true;
    // For someone in the workforce a work day is one they work; for anyone else it is one that is not a rest day.
    const workDay = person.workforceState === 'working' ? workedToday : !restDay;
    return visit.days === 'work' ? workDay : !workDay;
  };

  /** Something that takes the person out of their home routine: a stretch of activities between two moments at home. */
  interface Block {
    start: number;
    end: number;
    activities: Activity[];
  }

  /** Each lot's open ground, worked out the first time someone is outside on it. */
  const grounds = new Map<string, Ground>();
  const habits = new Map<string, WanderHabit | undefined>(
    Object.entries(pack.species).map(([speciesId, species]) => {
      const outside = species.life.outside;
      return [speciesId, outside && { pace: outside.pace, pause: { min: outside.pauseMinutes.min * 60, max: outside.pauseMinutes.max * 60 } }];
    }),
  );
  /**
   * How a person moves about a building's lot during one stay outside: drawn from the person, the building and
   * when the stay begins, by a stream of its own.
   */
  const wanderFor = (person: Person, buildingId: string, start: number, end: number): Wander => {
    let ground = grounds.get(buildingId);
    if (!ground) {
      const lot = lotOf.get(buildingId);
      if (!lot) throw new LifeError(`${buildingId} has no lot in the layout`);
      grounds.set(buildingId, (ground = groundOf(lot)));
    }
    const rng = createRng(deriveSeed(String(seed), 'life-outside', `${person.id}:${buildingId}:${start}`));
    return makeWander(ground, rng, start, end, habits.get(person.species));
  };

  const personalDay = (index: number, day: number): Activity[] => {
    const profile = profileOf(index);
    const { person, home, speed, species, work } = profile;
    const rng = createRng(deriveSeed(String(seed), 'life-day', `${person.id}:${day}`));
    const base = startOfDay(day);
    const dayStart = base + profile.anchor;
    const dayEnd = dayStart + SECONDS_PER_DAY;
    const daily = species.life.variation.dailyMinutes * 60;
    const vary = () => Math.round((rng.next() * 2 - 1) * daily);
    const leadTime = species.life.minutesBeforeLeaving * 60;
    let wake = base + profile.wake + profile.habit + vary();
    let bed = base + profile.wake + profile.habit + (SECONDS_PER_DAY - profile.sleepLength) + vary();

    const restDay = isRestDay(day, calendar);
    const onDuty = work !== undefined && hours.onDuty(index, day);

    /** Time spent at a building, at work or on a visit: outside if the building is open-air or the visit says so. */
    const spend = (kind: 'work' | 'visit', start: number, end: number, buildingId: string, visit?: Visit): Stay => ({
      kind,
      start,
      end,
      buildingId,
      ...(visit && { visitId: visit.id }),
      ...((openAir.has(buildingId) || visit?.outside === true) && end > start && { outside: true as const, wander: wanderFor(person, buildingId, start, end) }),
    });

    const blocks: Block[] = [];
    /**
     * Chooses where a visit goes from a starting point, or nothing if there is nowhere. `arrival` says when the
     * visitor would get to a place, given the length of the walk. Where the pack keeps opening hours, the place
     * must be open then, and stay open for at least the visit's shortest duration.
     */
    const choose = (visit: Visit, from: string, arrival: (to: string, exact: boolean, away: number) => number): { to: string; arriveAt: number; closes: number } | undefined => {
      let list = destinations(visit, from).filter((entry) => entry.id !== home);
      // The person's own dwelling, where the visit allows it, is reached without a walk.
      if (from === home && visit.destinations.includes(HOME)) list = [{ id: home, away: 0 }, ...list];
      const shortest = visit.durationMinutes.min * 60;
      const closing = (to: string, at: number) => (to === home || !checksHours ? Infinity : hours.openUntil(to, at));
      // A first sieve by the time a straight walk would take, so that paths are found only for places worth trying.
      if (checksHours) list = list.filter((entry) => closing(entry.id, arrival(entry.id, false, entry.away)) !== undefined);
      while (list.length > 0) {
        // Raising an even draw to the pack's power leans the choice toward the near end of the list.
        const picked = Math.min(list.length - 1, Math.floor(list.length * rng.next() ** pack.visits.nearness));
        const { id: to, away } = list[picked] as Reachable;
        const arriveAt = arrival(to, true, away);
        const closes = closing(to, arriveAt);
        if (closes !== undefined && closes - arriveAt >= shortest) return { to, arriveAt, closes };
        list = list.filter((_, at) => at !== picked);
      }
      return undefined;
    };
    const stayLength = (visit: Visit) => {
      const { min, max } = visit.durationMinutes;
      return Math.round((min + rng.next() * (max - min)) * 60);
    };
    /** The stops after work, each walked to from the last, starting where and when work ends. */
    const afterWork = (from: string, at: number): { activities: Activity[]; at: number; where: string } => {
      const activities: Activity[] = [];
      let where = from;
      let now = at;
      for (const visit of visits) {
        if (visit.when !== 'after-work' || !applies(visit, person, true, restDay, day) || !rng.chance(visit.probability)) continue;
        const origin = where;
        const leaving = now;
        const chosen = choose(visit, origin, (to, exact, away) =>
          to === origin ? leaving : leaving + tripDuration(exact ? pathBetween(origin, to).length : away, speed),
        );
        if (!chosen) continue;
        const { to, arriveAt, closes } = chosen;
        if (to !== where) activities.push(travel(where, to, now, speed));
        const until = Math.min(arriveAt + stayLength(visit), closes);
        activities.push(spend('visit', arriveAt, until, to, visit));
        where = to;
        now = until;
      }
      return { activities, at: now, where };
    };

    if (work && onDuty) {
      let arrive = base + work.start + profile.habit + vary();
      let leave = Math.max(base + work.end + profile.habit + vary(), arrive);
      if (work.building === home) {
        // Working at home: no commute. Any stop after work is an outing of its own.
        const stops = afterWork(home, leave);
        blocks.push({ start: arrive, end: leave, activities: [spend('work', arrive, leave, home)] });
        if (stops.activities.length > 0) {
          if (stops.where === home) {
            // Every stop was at home itself, so there is no walk back.
            if (stops.at <= dayEnd) blocks.push({ start: leave, end: stops.at, activities: stops.activities });
          } else {
            const back = travel(stops.where, home, stops.at, speed);
            if (back.arriveAt <= dayEnd) blocks.push({ start: leave, end: back.arriveAt, activities: [...stops.activities, back] });
          }
        }
      } else {
        const out = pathBetween(home, work.building);
        const walkOut = tripDuration(out.length, speed);
        // Someone whose walk is too long to make after waking arrives late rather than leaving in their sleep.
        arrive = Math.max(arrive, dayStart + leadTime + walkOut);
        leave = Math.max(leave, arrive);
        let stops = afterWork(work.building, leave);
        let back = travel(stops.where, home, stops.at, speed);
        if (back.arriveAt > dayEnd && stops.activities.length > 0) {
          // No time for stops today.
          stops = { activities: [], at: leave, where: work.building };
          back = travel(work.building, home, leave, speed);
        }
        if (back.arriveAt > dayEnd) {
          // Nor for the whole shift: leave in time to be home.
          leave = Math.max(arrive, leave - (back.arriveAt - dayEnd));
          back = travel(work.building, home, leave, speed);
        }
        const there = travel(home, work.building, arrive - walkOut, speed);
        blocks.push({
          start: there.departAt,
          end: back.arriveAt,
          activities: [there, spend('work', arrive, leave, work.building), ...stops.activities, back],
        });
        wake = Math.min(wake, there.departAt - leadTime);
      }
    }
    const first = blocks[0];
    if (first) wake = Math.min(wake, first.start);
    wake = Math.max(wake, dayStart);
    const last = blocks[blocks.length - 1];
    if (last) bed = Math.max(bed, last.end);
    bed = Math.min(Math.max(bed, wake), dayEnd);

    // Visits at a time of day: from home and back, if they fit around everything else.
    for (const visit of visits) {
      if (visit.when === 'after-work' || !applies(visit, person, onDuty, restDay, day) || !rng.chance(visit.probability)) continue;
      const begin = base + visit.when.from + Math.floor(rng.next() * (visit.when.to - visit.when.from));
      const wanted = stayLength(visit);
      const chosen = choose(visit, home, () => begin);
      if (chosen === undefined) continue;
      const { to } = chosen;
      const until = Math.min(begin + wanted, chosen.closes);
      const block: Block =
        to === home
          ? { start: begin, end: until, activities: [spend('visit', begin, until, home, visit)] }
          : (() => {
              const out = travel(home, to, begin - tripDuration(pathBetween(home, to).length, speed), speed);
              const back = travel(to, home, until, speed);
              return { start: out.departAt, end: back.arriveAt, activities: [out, spend('visit', begin, until, to, visit), back] };
            })();
      if (block.start < wake || block.end > bed) continue;
      // Outings may not touch, either: someone home from one walk does not set out on the next in the same second.
      if (blocks.some((other) => block.start <= other.end && block.end >= other.start)) continue;
      blocks.push(block);
    }
    blocks.sort((a, b) => a.start - b.start);

    // Lay the day out: asleep, up, each block with time at home between, then to bed.
    const activities: Activity[] = [];
    const stay = (kind: Stay['kind'], start: number, end: number) => {
      if (end > start) activities.push({ kind, start, end, buildingId: home });
    };
    stay('sleep', dayStart, wake);
    let now = wake;
    for (const block of blocks) {
      stay('home', now, block.start);
      for (const activity of block.activities) {
        // A stay of no length is left out; a walk of no length is kept, as it still joins two buildings.
        if (activity.kind === 'travel' || activity.end > activity.start) activities.push(activity);
      }
      now = block.end;
    }
    stay('home', now, bed);
    stay('sleep', bed, dayEnd);
    return activities;
  };

  // ---- Days, kept for a while ---------------------------------------------------------------
  const personalDays = new Map<number, Array<Activity[] | undefined>>();
  const keep = <T>(map: Map<number, T>, day: number, value: T): T => {
    map.delete(day);
    map.set(day, value);
    while (map.size > DAYS_KEPT) map.delete(map.keys().next().value as number);
    return value;
  };
  const personalDayOf = (index: number, day: number): Activity[] => {
    const days = personalDays.get(day) ?? keep(personalDays, day, new Array<Activity[] | undefined>(city.people.length));
    return (days[index] ??= personalDay(index, day));
  };

  const planOf = (index: number, day: number): DayPlan => {
    const { anchor, person } = profileOf(index);
    const from = startOfDay(day);
    const to = from + SECONDS_PER_DAY;
    // The calendar day lies across the personal day of the same number and, unless they coincide, one neighbour.
    const sources = anchor > 0 ? [day - 1, day] : anchor < 0 ? [day, day + 1] : [day];
    const activities: Activity[] = [];
    for (const source of sources) {
      for (const activity of personalDayOf(index, source)) {
        if (activity.end < from || activity.start > to) continue;
        const start = Math.max(activity.start, from);
        const end = Math.min(activity.end, to);
        // Only what lies within the day is kept; a walk of no length at the very boundary belongs to the day it starts.
        if (end <= start && !(activity.kind === 'travel' && activity.start === activity.end && activity.start >= from && activity.start < to)) continue;
        const previous = activities[activities.length - 1];
        if (previous && previous.kind !== 'travel' && activity.kind === previous.kind && activity.buildingId === previous.buildingId && previous.visitId === activity.visitId) {
          // The same thing either side of a seam is one activity.
          previous.end = end;
        } else {
          // A stay outside that is cut at midnight keeps the part of its wander that falls in the day.
          const wander = activity.kind !== 'travel' && activity.wander && (start !== activity.start || end !== activity.end) ? { wander: clipWander(activity.wander, start, end) } : undefined;
          activities.push({ ...activity, start, end, ...wander });
        }
      }
    }
    return { personId: person.id, day, activities };
  };

  const dayPlans = new Map<number, DayPlan[]>();
  const plansForDay = (day: number): DayPlan[] => dayPlans.get(day) ?? keep(dayPlans, day, city.people.map((_, index) => planOf(index, day)));
  const indexOfPerson = (personId: string): number => {
    const index = personIndex.get(personId);
    if (index === undefined) throw new LifeError(`there is no person with the ID "${personId}"`);
    return index;
  };
  const plan = (personId: string, day: number): DayPlan => {
    const index = indexOfPerson(personId);
    return dayPlans.get(day)?.[index] ?? planOf(index, day);
  };
  const activityAt = (activities: Activity[], time: number): Activity => {
    // The activity under way: the last one that has started. A walk of no length gives way to what follows it.
    let low = 0;
    let high = activities.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((activities[middle] as Activity).start <= time) low = middle;
      else high = middle - 1;
    }
    return activities[low] as Activity;
  };

  /** Where along its path a trip has reached at a moment: the point, and the segment it is on. */
  const positionOn = (trip: Travel, time: number): { point: Point; segmentId: string } => {
    const { path, departAt, arriveAt } = trip;
    const share = arriveAt === departAt ? 1 : Math.min(1, Math.max(0, (time - departAt) / (arriveAt - departAt)));
    const along = path.length * share;
    let covered = 0;
    let segment = path.segmentIds.length - 1;
    for (let at = 0; at < path.walked.length; at++) {
      covered += path.walked[at] as number;
      if (along <= covered) {
        segment = at;
        break;
      }
    }
    return { point: pointAlongPolyline(path.points, along), segmentId: path.segmentIds[segment] as string };
  };

  // ---- Who can be seen, by time of day ------------------------------------------------------
  // For the nearby query: each day's walks and outside stays, sorted into stretches of the day,
  // so that a question about one moment looks only at the people who are out around then.
  interface Seen {
    walks: Array<Array<{ personId: string; travel: Travel; box: Region }>>;
    stays: Array<Array<{ personId: string; stay: Stay }>>;
  }
  const boxes = new WeakMap<TripPath, Region>();
  const boxOfPath = (path: TripPath): Region => {
    let box = boxes.get(path);
    if (!box) {
      box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const [x, y] of path.points) {
        if (x < box.minX) box.minX = x;
        if (x > box.maxX) box.maxX = x;
        if (y < box.minY) box.minY = y;
        if (y > box.maxY) box.maxY = y;
      }
      boxes.set(path, box);
    }
    return box;
  };
  const seenByDay = new Map<number, Seen>();
  const seenOn = (day: number): Seen => {
    const known = seenByDay.get(day);
    if (known) return known;
    const start = startOfDay(day);
    const seen: Seen = {
      walks: Array.from({ length: Math.ceil(SECONDS_PER_DAY / WALK_SLOT) }, () => []),
      stays: Array.from({ length: Math.ceil(SECONDS_PER_DAY / STAY_SLOT) }, () => []),
    };
    const file = <T>(slots: T[][], size: number, from: number, to: number, entry: T) => {
      // The stretches that a span of time, open at its end, touches.
      const last = Math.min(slots.length - 1, Math.floor((to - 1 - start) / size));
      for (let slot = Math.max(0, Math.floor((from - start) / size)); slot <= last; slot++) (slots[slot] as T[]).push(entry);
    };
    for (const { personId, activities } of plansForDay(day)) {
      for (const activity of activities) {
        if (activity.end <= activity.start) continue;
        if (activity.kind === 'travel') file(seen.walks, WALK_SLOT, activity.start, activity.end, { personId, travel: activity, box: boxOfPath(activity.path) });
        else if (activity.outside) file(seen.stays, STAY_SLOT, activity.start, activity.end, { personId, stay: activity });
      }
    }
    return keep(seenByDay, day, seen);
  };

  const daysIn = (from: number, to: number): number[] => {
    const days: number[] = [];
    for (let day = dayOf(from); startOfDay(day) < to || day === dayOf(from); day++) days.push(day);
    return days;
  };

  return {
    plan,
    plansForDay,

    whereabouts(personId, time) {
      const activity = activityAt(plan(personId, dayOf(time)).activities, time);
      if (activity.kind === 'travel') {
        return {
          personId,
          time,
          kind: 'travel',
          ...positionOn(activity, time),
          fromBuildingId: activity.fromBuildingId,
          toBuildingId: activity.toBuildingId,
          since: activity.departAt,
          until: activity.arriveAt,
        };
      }
      return {
        personId,
        time,
        kind: activity.kind,
        buildingId: activity.buildingId,
        ...(activity.visitId !== undefined && { visitId: activity.visitId }),
        ...(activity.outside && { outside: true as const, point: positionOnWander(activity.wander as Wander, time) }),
        since: activity.start,
        until: activity.end,
      };
    },

    occupants(buildingId, time) {
      if (!buildingType.has(buildingId)) throw new LifeError(`there is no building with the ID "${buildingId}"`);
      const inside: Occupant[] = [];
      for (const { personId, activities } of plansForDay(dayOf(time))) {
        const activity = activityAt(activities, time);
        if (activity.kind !== 'travel' && activity.buildingId === buildingId) {
          inside.push({
            personId,
            kind: activity.kind,
            ...(activity.visitId !== undefined && { visitId: activity.visitId }),
            ...(activity.outside && { outside: true as const }),
          });
        }
      }
      return inside;
    },

    isOpen(buildingId, time) {
      if (!buildingType.has(buildingId)) throw new LifeError(`there is no building with the ID "${buildingId}"`);
      return hours.openUntil(buildingId, time) !== undefined;
    },

    openingHours(buildingId, day) {
      if (!buildingType.has(buildingId)) throw new LifeError(`there is no building with the ID "${buildingId}"`);
      return hours.hoursOn(buildingId, day);
    },

    shiftOf: (personId) => hours.shiftOf(indexOfPerson(personId)),

    outsideStays(from, to, region) {
      const found: OutsideStay[] = [];
      /** The last stay found for each person, for joining one that crosses midnight to its other half. */
      const latest = new Map<string, OutsideStay>();
      for (const day of daysIn(from, to)) {
        for (const { personId, activities } of plansForDay(day)) {
          for (const activity of activities) {
            if (activity.kind === 'travel' || !activity.outside || activity.end <= from || activity.start >= to) continue;
            // A stay is on its building's lot, so it is in a region when the lot is.
            if (region) {
              const box = lotBox(activity.buildingId);
              if (box.maxX < region.minX || box.minX > region.maxX || box.maxY < region.minY || box.minY > region.maxY) continue;
            }
            const wander = activity.wander as Wander;
            const before = latest.get(personId);
            if (before && before.to === activity.start && before.buildingId === activity.buildingId) {
              // The other half of a stay already found: the wander goes on from where it stopped.
              before.to = activity.end;
              before.wander = { times: [...before.wander.times, ...wander.times.slice(1)], points: [...before.wander.points, ...wander.points.slice(1)] };
              continue;
            }
            const stay: OutsideStay = {
              personId,
              buildingId: activity.buildingId,
              kind: activity.kind as 'work' | 'visit',
              ...(activity.visitId !== undefined && { visitId: activity.visitId }),
              wander,
              from: activity.start,
              to: activity.end,
            };
            latest.set(personId, stay);
            found.push(stay);
          }
        }
      }
      // Only the part of each wander that falls in the window is given.
      for (const stay of found) stay.wander = clipWander(stay.wander, from, to);
      return found;
    },

    trips(from, to, region) {
      const found: Trip[] = [];
      const seen = new Set<string>();
      for (const day of daysIn(from, to)) {
        for (const { personId, activities } of plansForDay(day)) {
          for (const activity of activities) {
            if (activity.kind !== 'travel' || activity.arriveAt < from || activity.departAt >= to) continue;
            // A trip that crosses midnight appears in both days' plans, and is one trip.
            const key = `${personId}:${activity.departAt}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const { points } = activity.path;
            if (region && !points.some(([x, y]) => x >= region.minX && x <= region.maxX && y >= region.minY && y <= region.maxY)) {
              // No corner in view; the line may still cross it, so compare the boxes.
              let minX = Infinity;
              let minY = Infinity;
              let maxX = -Infinity;
              let maxY = -Infinity;
              for (const [x, y] of points) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
              if (maxX < region.minX || minX > region.maxX || maxY < region.minY || minY > region.maxY) continue;
            }
            found.push({
              personId,
              fromBuildingId: activity.fromBuildingId,
              toBuildingId: activity.toBuildingId,
              departAt: activity.departAt,
              arriveAt: activity.arriveAt,
              length: activity.path.length,
              points,
            });
          }
        }
      }
      return found;
    },

    nearby(point, radius, time) {
      const day = dayOf(time);
      const seen = seenOn(day);
      const sinceMidnight = time - startOfDay(day);
      const [x, y] = point;
      const found: Nearby[] = [];
      for (const { personId, travel: walk, box } of seen.walks[Math.floor(sinceMidnight / WALK_SLOT)] ?? []) {
        if (time < walk.start || time >= walk.end) continue;
        // A walk whose whole line is out of reach is not worth placing.
        if (x < box.minX - radius || x > box.maxX + radius || y < box.minY - radius || y > box.maxY + radius) continue;
        const at = positionOn(walk, time).point;
        const away = distance(point, at);
        if (away <= radius) found.push({ personId, distance: away, point: at, kind: 'walking', fromBuildingId: walk.fromBuildingId, toBuildingId: walk.toBuildingId });
      }
      for (const { personId, stay } of seen.stays[Math.floor(sinceMidnight / STAY_SLOT)] ?? []) {
        if (time < stay.start || time >= stay.end) continue;
        const at = positionOnWander(stay.wander as Wander, time);
        const away = distance(point, at);
        if (away > radius) continue;
        found.push({
          personId,
          distance: away,
          point: at,
          kind: 'outside',
          buildingId: stay.buildingId,
          activity: stay.kind as 'work' | 'visit',
          ...(stay.visitId !== undefined && { visitId: stay.visitId }),
        });
      }
      return found.sort((a, b) => a.distance - b.distance || (a.personId < b.personId ? -1 : 1));
    },

    daySummary(day) {
      const start = startOfDay(day);
      const seconds = { sleep: new Float64Array(24), home: new Float64Array(24), work: new Float64Array(24), visit: new Float64Array(24), travel: new Float64Array(24) };
      const outside = new Float64Array(24);
      const started = new Int32Array(24);
      let trips = 0;
      for (const { activities } of plansForDay(day)) {
        for (const activity of activities) {
          if (activity.kind === 'travel' && activity.departAt >= start && activity.departAt < start + SECONDS_PER_DAY) {
            started[Math.floor((activity.departAt - start) / 3600)]!++;
            trips++;
          }
          for (let hour = Math.floor((activity.start - start) / 3600); hour < 24 && start + hour * 3600 < activity.end; hour++) {
            const from = Math.max(activity.start, start + hour * 3600);
            const to = Math.min(activity.end, start + (hour + 1) * 3600);
            if (to <= from) continue;
            seconds[activity.kind][hour]! += to - from;
            if (activity.kind !== 'travel' && activity.outside) outside[hour]! += to - from;
          }
        }
      }
      return {
        day,
        hours: Array.from({ length: 24 }, (_, hour) => ({
          hour,
          asleep: (seconds.sleep[hour] as number) / 3600,
          atHome: (seconds.home[hour] as number) / 3600,
          atWork: (seconds.work[hour] as number) / 3600,
          visiting: (seconds.visit[hour] as number) / 3600,
          travelling: (seconds.travel[hour] as number) / 3600,
          outside: (outside[hour] as number) / 3600,
          tripsStarted: started[hour] as number,
        })),
        trips,
      };
    },

    segmentLoads(day) {
      const start = startOfDay(day);
      const loads = new Map<string, number>(layout.segments.map((segment) => [segment.id, 0]));
      for (const { activities } of plansForDay(day)) {
        for (const activity of activities) {
          if (activity.kind !== 'travel' || activity.departAt < start || activity.departAt >= start + SECONDS_PER_DAY) continue;
          for (const segmentId of activity.path.segmentIds) loads.set(segmentId, (loads.get(segmentId) ?? 0) + 1);
        }
      }
      return [...loads].map(([segmentId, trips]) => ({ segmentId, trips })).sort((a, b) => b.trips - a.trips || (a.segmentId < b.segmentId ? -1 : 1));
    },
  };
}
