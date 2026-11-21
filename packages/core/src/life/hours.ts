/**
 * Who works when, and so when each building is open.
 *
 * Everything here comes from shifts and rest-day duty, never from anyone's
 * day plan. A building is open at a moment when at least one of the people
 * who work there is on shift then, by the shift's own hours. That keeps
 * openness a pure function of game time, and keeps one person's plan from
 * depending on another's.
 */
import type { City } from '../city/records.ts';
import { apportion, createRng, shuffle } from '../city/random.ts';
import { type NamedShift, type Occupation, type SettingPack, allOccupations, placeFlagsOf, shiftLength, shiftsOf } from '../pack/schema.ts';
import { deriveSeed } from '../seed.ts';
import { SECONDS_PER_DAY, dayOf, isRestDay, startOfDay } from './calendar.ts';
import type { OpenSpan } from './records.ts';

const DAYS_KEPT = 6;

/** How many of an occupation's workers on a shift are on duty on a rest day, given the shift's share. */
export function dutyCount(workers: number, share: number): number {
  return Math.round(workers * share);
}

/** How many rest days there have been from day 1 up to and including a day. */
export function restDaysUpTo(day: number, calendar: SettingPack['calendar']): number {
  const perWeek = calendar.week.filter((entry) => entry.rest).length;
  const weeks = Math.floor(day / calendar.week.length);
  let count = weeks * perWeek;
  for (let extra = weeks * calendar.week.length + 1; extra <= day; extra++) if (isRestDay(extra, calendar)) count++;
  return count;
}

export interface WorkingHours {
  /** The shift a person works, the same every day; nothing for someone with no job. Indexed as `city.people`. */
  shiftOf(personIndex: number): NamedShift | undefined;
  /** Whether a person works the shift that starts on a day. */
  onDuty(personIndex: number, day: number): boolean;
  /** If a building is open at a time, when it next closes; `Infinity` for one that never does. Nothing if it is closed. */
  openUntil(buildingId: string, time: number): number | undefined;
  /** The stretches of a day during which a building is open. */
  hoursOn(buildingId: string, day: number): OpenSpan[];
}

export function createWorkingHours(inputs: { city: City; pack: SettingPack; seed?: number }): WorkingHours {
  const { city, pack } = inputs;
  const seed = inputs.seed ?? city.summary.seed;
  const { calendar } = pack;
  const occupations = new Map(allOccupations(pack).map((occupation) => [occupation.id, occupation]));

  // ---- Each worker's shift ---------------------------------------------------------------
  const shifts = new Array<NamedShift | undefined>(city.people.length);
  const holdersOf = new Map<string, number[]>();
  city.people.forEach((person, index) => {
    if (person.occupationId === undefined || person.workplaceId === undefined) return;
    const list = holdersOf.get(person.occupationId);
    if (list) list.push(index);
    else holdersOf.set(person.occupationId, [index]);
  });
  for (const [occupationId, holders] of holdersOf) {
    const offered = shiftsOf(occupations.get(occupationId) as Occupation, pack);
    if (offered.length === 1) {
      for (const index of holders) shifts[index] = offered[0];
      continue;
    }
    // The shares are met exactly; who gets which shift is drawn, and then never changes.
    const counts = apportion(holders.length, offered.map((entry) => entry.share));
    const order = shuffle(createRng(deriveSeed(String(seed), 'life-shift', occupationId)), [...holders]);
    let next = 0;
    offered.forEach((shift, at) => {
      for (let taken = 0; taken < (counts[at] as number); taken++) shifts[order[next++] as number] = shift;
    });
  }

  // ---- Rest-day duty ---------------------------------------------------------------------
  // Each worker's place among those who share their occupation and shift, for taking turns.
  const rank = new Int32Array(city.people.length);
  const groupSize = new Map<string, number>();
  const groupOf = (index: number) => `${city.people[index]!.occupationId}|${shifts[index]!.id}`;
  city.people.forEach((_, index) => {
    if (!shifts[index]) return;
    const count = groupSize.get(groupOf(index)) ?? 0;
    rank[index] = count;
    groupSize.set(groupOf(index), count + 1);
  });
  const onDuty = (index: number, day: number): boolean => {
    const shift = shifts[index];
    if (!shift) return false;
    if (!isRestDay(day, calendar)) return true;
    if (!shift.restDays) return false;
    // Workers take turns: each rest day the duty moves on to the next stretch of the group.
    const workers = groupSize.get(groupOf(index)) as number;
    const count = dutyCount(workers, shift.dutyShare ?? 0);
    const turn = ((((rank[index] as number) - restDaysUpTo(day, calendar) * count) % workers) + workers) % workers;
    return turn < count;
  };

  // ---- Opening hours ---------------------------------------------------------------------
  const staff = new Map<string, number[]>();
  shifts.forEach((shift, index) => {
    if (!shift) return;
    const building = city.people[index]!.workplaceId as string;
    const list = staff.get(building);
    if (list) list.push(index);
    else staff.set(building, [index]);
  });
  const alwaysOpen = new Set(city.buildings.filter((building) => placeFlagsOf(building.type, pack).alwaysOpen).map((building) => building.id));

  /** The shifts that start in a building on a day, as stretches of game time. */
  const started = new Map<number, Map<string, OpenSpan[]>>();
  const startedOn = (buildingId: string, day: number): OpenSpan[] => {
    let ofDay = started.get(day);
    if (!ofDay) {
      ofDay = new Map();
      started.set(day, ofDay);
      while (started.size > DAYS_KEPT) started.delete(started.keys().next().value as number);
    }
    let spans = ofDay.get(buildingId);
    if (!spans) {
      spans = [];
      const seen = new Set<string>();
      for (const index of staff.get(buildingId) ?? []) {
        const shift = shifts[index] as NamedShift;
        if (seen.has(shift.id) || !onDuty(index, day)) continue;
        seen.add(shift.id);
        const from = startOfDay(day) + shift.start;
        spans.push({ from, to: from + shiftLength(shift) });
      }
      ofDay.set(buildingId, spans);
    }
    return spans;
  };
  /** The stretches a building is open that touch a day, joined where they meet. */
  const around = new Map<number, Map<string, OpenSpan[]>>();
  const openAround = (buildingId: string, day: number): OpenSpan[] => {
    let ofDay = around.get(day);
    if (!ofDay) {
      ofDay = new Map();
      around.set(day, ofDay);
      while (around.size > DAYS_KEPT) around.delete(around.keys().next().value as number);
    }
    let spans = ofDay.get(buildingId);
    if (!spans) {
      spans = [];
      const all = [...startedOn(buildingId, day - 1), ...startedOn(buildingId, day), ...startedOn(buildingId, day + 1)].sort((a, b) => a.from - b.from);
      for (const span of all) {
        const last = spans[spans.length - 1];
        if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
        else spans.push({ ...span });
      }
      ofDay.set(buildingId, spans);
    }
    return spans;
  };

  return {
    shiftOf: (index) => shifts[index],
    onDuty,
    openUntil(buildingId, time) {
      if (alwaysOpen.has(buildingId)) return Infinity;
      if (!staff.has(buildingId)) return undefined;
      for (const span of openAround(buildingId, dayOf(time))) if (span.from <= time && time < span.to) return span.to;
      return undefined;
    },
    hoursOn(buildingId, day) {
      const from = startOfDay(day);
      const to = from + SECONDS_PER_DAY;
      if (alwaysOpen.has(buildingId)) return [{ from, to }];
      return openAround(buildingId, day)
        .filter((span) => span.to > from && span.from < to)
        .map((span) => ({ from: Math.max(span.from, from), to: Math.min(span.to, to) }));
    },
  };
}
