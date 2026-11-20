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
import { distance, pointAlongPolyline } from '../layout/geometry.ts';
import { createPathFinder } from '../layout/path.ts';
import type { Layout } from '../layout/records.ts';
import { type Calendar, type Occupation, type SettingPack, type Shift, type Species, type Visit, allOccupations, shiftLength, shiftOf, sleepLength } from '../pack/schema.ts';
import type { Point } from '../schema.ts';
import { deriveSeed } from '../seed.ts';
import { SECONDS_PER_DAY, dayOf, isRestDay, startOfDay } from './calendar.ts';
import type { Activity, DayPlan, DaySummary, Occupant, Region, Stay, Travel, Trip, TripPath, Whereabouts } from './records.ts';

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
  /** Who is in a building at a game time. */
  occupants(buildingId: string, time: number): Occupant[];
  /** The trips under way at any point in a window of game time, optionally only those that pass through a region. */
  trips(from: number, to: number, region?: Region): Trip[];
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

/** How many of an occupation's workers are on duty on a rest day, given the shift's share. */
export function dutyCount(workers: number, share: number): number {
  return Math.round(workers * share);
}

const DAYS_KEPT = 4;

/** How many rest days there have been from day 1 up to and including a day. */
export function restDaysUpTo(day: number, calendar: Calendar): number {
  const perWeek = calendar.week.filter((entry) => entry.rest).length;
  const weeks = Math.floor(day / calendar.week.length);
  let count = weeks * perWeek;
  for (let extra = weeks * calendar.week.length + 1; extra <= day; extra++) if (isRestDay(extra, calendar)) count++;
  return count;
}

export function createLife(inputs: LifeInputs): SettlementLife {
  const { city, layout, pack } = inputs;
  const seed = inputs.seed ?? city.summary.seed;
  const { calendar } = pack;
  const finder = createPathFinder(layout);

  // ---- Lookups, made once -------------------------------------------------------
  const personIndex = new Map(city.people.map((person, index) => [person.id, index]));
  const homeOf = new Map(city.households.map((household) => [household.id, household.dwellingId]));
  const lotOf = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
  const occupations = new Map(allOccupations(pack).map((occupation) => [occupation.id, occupation]));
  const buildingType = new Map(city.buildings.map((building) => [building.id, building.type]));
  const buildingsOfType = new Map<string, string[]>();
  for (const building of city.buildings) {
    const list = buildingsOfType.get(building.type);
    if (list) list.push(building.id);
    else buildingsOfType.set(building.type, [building.id]);
  }
  /** Each worker's place among the holders of their occupation, for taking turns at rest-day duty. */
  const rank = new Int32Array(city.people.length);
  const holders = new Map<string, number>();
  city.people.forEach((person, index) => {
    if (person.occupationId === undefined) return;
    const count = holders.get(person.occupationId) ?? 0;
    rank[index] = count;
    holders.set(person.occupationId, count + 1);
  });
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
    work?: { building: string; occupation: Occupation; shift: Shift; start: number; end: number };
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
    const occupation = person.occupationId === undefined ? undefined : occupations.get(person.occupationId);
    if (occupation && person.workplaceId !== undefined) {
      const shift = shiftOf(occupation, pack);
      const start = shift.start;
      const end = shift.start + shiftLength(shift);
      work = { building: person.workplaceId, occupation, shift, start, end };
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
  const reachable = new Map<string, string[]>();
  const destinations = (visit: Visit, from: string): string[] => {
    const key = `${visit.id}|${from}`;
    let list = reachable.get(key);
    if (!list) {
      const origin = entranceOf(from);
      list = visit.destinations
        .flatMap((type) => buildingsOfType.get(type) ?? [])
        .filter((id) => id !== from && lotOf.has(id))
        .map((id) => ({ id, away: distance(origin, entranceOf(id)) }))
        .sort((a, b) => a.away - b.away || (a.id < b.id ? -1 : 1))
        .map((entry) => entry.id);
      reachable.set(key, list);
    }
    return list;
  };

  // ---- A personal day ---------------------------------------------------------------------
  const visits = pack.visits.visits;
  const applies = (visit: Visit, person: Person, workedToday: boolean, restDay: boolean): boolean => {
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
    let onDuty = false;
    if (work) {
      if (!restDay) onDuty = true;
      else if (work.shift.restDays) {
        // Workers take turns: each rest day the duty moves on to the next stretch of the occupation's holders.
        const workers = holders.get(work.occupation.id) as number;
        const count = dutyCount(workers, work.shift.dutyShare ?? 0);
        const turn = ((((rank[index] as number) - restDaysUpTo(day, calendar) * count) % workers) + workers) % workers;
        onDuty = turn < count;
      }
    }

    const blocks: Block[] = [];
    /** Chooses where a visit goes from a starting point, or nothing if there is nowhere. */
    const choose = (visit: Visit, from: string): string | undefined => {
      const list = destinations(visit, from).filter((id) => id !== home);
      if (list.length === 0) return undefined;
      // Raising an even draw to the pack's power leans the choice toward the near end of the list.
      return list[Math.min(list.length - 1, Math.floor(list.length * rng.next() ** pack.visits.nearness))];
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
        if (visit.when !== 'after-work' || !applies(visit, person, true, restDay) || !rng.chance(visit.probability)) continue;
        const to = choose(visit, where);
        if (to === undefined) continue;
        const walk = travel(where, to, now, speed);
        const until = walk.arriveAt + stayLength(visit);
        activities.push(walk, { kind: 'visit', start: walk.arriveAt, end: until, buildingId: to, visitId: visit.id });
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
        blocks.push({ start: arrive, end: leave, activities: [{ kind: 'work', start: arrive, end: leave, buildingId: home }] });
        if (stops.activities.length > 0) {
          const back = travel(stops.where, home, stops.at, speed);
          if (back.arriveAt <= dayEnd) blocks.push({ start: leave, end: back.arriveAt, activities: [...stops.activities, back] });
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
          activities: [there, { kind: 'work', start: arrive, end: leave, buildingId: work.building }, ...stops.activities, back],
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
      if (visit.when === 'after-work' || !applies(visit, person, onDuty, restDay) || !rng.chance(visit.probability)) continue;
      const begin = base + visit.when.from + Math.floor(rng.next() * (visit.when.to - visit.when.from));
      const length = stayLength(visit);
      const to = choose(visit, home);
      if (to === undefined) continue;
      const out = travel(home, to, begin - tripDuration(pathBetween(home, to).length, speed), speed);
      const back = travel(to, home, begin + length, speed);
      if (out.departAt < wake || back.arriveAt > bed) continue;
      if (blocks.some((block) => out.departAt < block.end && back.arriveAt > block.start)) continue;
      blocks.push({
        start: out.departAt,
        end: back.arriveAt,
        activities: [out, { kind: 'visit', start: begin, end: begin + length, buildingId: to, visitId: visit.id }, back],
      });
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
          activities.push({ ...activity, start, end });
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
          inside.push({ personId, kind: activity.kind, ...(activity.visitId !== undefined && { visitId: activity.visitId }) });
        }
      }
      return inside;
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

    daySummary(day) {
      const start = startOfDay(day);
      const seconds = { sleep: new Float64Array(24), home: new Float64Array(24), work: new Float64Array(24), visit: new Float64Array(24), travel: new Float64Array(24) };
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
            if (to > from) seconds[activity.kind][hour]! += to - from;
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
