/**
 * Phase 4.5: opening hours, occupations split across shifts, stays out of
 * doors, home as a destination, and the pack fields that switch them on.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Activity,
  type City,
  type DayPlan,
  type Layout,
  type SettingPack,
  type SettlementLife,
  type Stay,
  GENERATOR_VERSION,
  LAYOUT_VERSION,
  LIFE_VERSION,
  OutsideStaySchema,
  WhereaboutsSchema,
  apportion,
  createLife,
  createPlanChecker,
  dutyCount,
  generateCity,
  generateLayout,
  geometry,
  isRestDay,
  parsePack,
  placeFlagsOf,
  positionOnWander,
  shiftLength,
  startOfDay,
} from '../src/index.ts';
import { BEFORE_6B5, lomiaWorld, medievalPack, rawMedievalPack, settlement, stripPhase6B } from './pack.ts';

/** A limit for the tests that plan whole towns, with headroom for a slower machine. */
const SLOW = 60_000;

const pack = medievalPack();
const at = (day: number, hours: number, minutes = 0) => startOfDay(day) + hours * 3600 + minutes * 60;
const edited = (edit: (raw: any) => void): SettingPack => {
  const raw = rawMedievalPack();
  edit(raw);
  return parsePack(raw);
};

interface Town {
  city: City;
  layout: Layout;
  life: SettlementLife;
}
const town = (id: string, packUsed: SettingPack = pack, seed?: number, layoutOptions: { arrange?: boolean } = {}): Town => {
  const brief = settlement(id);
  const city = generateCity(brief, packUsed);
  const layout = generateLayout(city, brief, packUsed, layoutOptions);
  return { city, layout, life: createLife({ city, layout, pack: packUsed, ...(seed !== undefined && { seed }) }) };
};

let badanos: Town;
const WORK_DAY = 1;
const MARKET_DAY = 6;
const REST_DAY = 7;
const WEEK = [1, 2, 3, 4, 5, 6, 7];
beforeAll(() => {
  badanos = town('settlement-641');
}, SLOW);

/** A plan's stays at buildings. Stops on a street, which have no building, are covered in rounds.test.ts. */
const staysOf = (plan: DayPlan) => plan.activities.filter((activity): activity is Stay => activity.kind !== 'travel' && activity.kind !== 'street');
const visitsOn = (life: SettlementLife, day: number) =>
  life.plansForDay(day).flatMap((plan) => staysOf(plan).filter((stay) => stay.kind === 'visit').map((stay) => ({ ...stay, personId: plan.personId })));
const typeOf = (city: City) => {
  const types = new Map(city.buildings.map((building) => [building.id, building.type]));
  return (buildingId: string) => types.get(buildingId) as string;
};
const homeOf = (city: City) => {
  const dwellings = new Map(city.households.map((household) => [household.id, household.dwellingId]));
  const people = new Map(city.people.map((person) => [person.id, person]));
  return (personId: string) => dwellings.get(people.get(personId)!.householdId) as string;
};
const watchmen = (city: City) => city.people.filter((person) => person.occupationId === 'watchman');
/** At work: at the workplace, or out on a round from it. */
const working = (life: SettlementLife, personId: string, time: number) => {
  const where = life.whereabouts(personId, time);
  return where.kind === 'work' || ((where.kind === 'travel' || where.kind === 'street') && where.round === true);
};
const atWork = (life: SettlementLife, people: City['people'], time: number) => people.filter((person) => working(life, person.id, time));

describe('versions', () => {
  it('raises the life version and leaves the other two alone', () => {
    expect(LIFE_VERSION).toBe(5);
    expect(GENERATOR_VERSION).toBe(6);
    expect(LAYOUT_VERSION).toBe(5);
  });
});

describe('an occupation split across shifts', () => {
  it('meets the shares exactly in every settlement tried, by the largest-remainder method', { timeout: SLOW }, () => {
    const three = edited((raw) => {
      raw.occupations.find((entry: any) => entry.id === 'tanner').shift = [
        { shift: 'day', share: 0.5 },
        { shift: 'early', share: 0.3 },
        { shift: 'evening', share: 0.2 },
      ];
    });
    const towns: Array<[Town, SettingPack, string, string[]]> = [
      [badanos, pack, 'watchman', ['watch-day', 'watch-evening', 'night']],
      [town('settlement-455'), pack, 'watchman', ['watch-day', 'watch-evening', 'night']],
      [town('settlement-641', three), three, 'tanner', ['day', 'early', 'evening']],
    ];
    for (const [{ city, life }, packUsed, occupationId, shifts] of towns) {
      const holders = city.people.filter((person) => person.occupationId === occupationId);
      const shares = (packUsed.occupations.find((entry) => entry.id === occupationId)!.shift as Array<{ shift: string; share: number }>).map((entry) => entry.share);
      const counts = shifts.map((id) => holders.filter((person) => life.shiftOf(person.id)?.id === id).length);
      expect(counts, `${city.summary.settlementName}, ${occupationId}`).toEqual(apportion(holders.length, shares));
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(holders.length);
    }
    expect(watchmen(badanos.city)).toHaveLength(97);
  });

  it('keeps each worker on the same shift every day', () => {
    const { city, life } = badanos;
    for (const person of watchmen(city)) {
      const shift = life.shiftOf(person.id)!;
      for (const day of WEEK) {
        // A shift that begins on a day begins at the person's own shift, give or take their habit: the first
        // work after time at home. (Later spells of work follow circuits of the patrol.)
        const { activities } = life.plan(person.id, day);
        activities.forEach((activity, index) => {
          if (activity.kind !== 'work' || activities[index - 1]?.kind !== 'travel' || (activities[index - 1] as { round?: true }).round) return;
          expect(Math.abs(activity.start - (startOfDay(day) + shift.start)), `${person.id}, day ${day}`).toBeLessThanOrEqual(30 * 60);
        });
      }
    }
  });

  it('draws who gets which shift from the seed, and nothing else', () => {
    const { city, layout } = badanos;
    const assignment = (seed?: number) => {
      const life = createLife({ city, layout, pack, ...(seed !== undefined && { seed }) });
      return watchmen(city).map((person) => life.shiftOf(person.id)!.id);
    };
    expect(assignment()).toEqual(assignment());
    const other = assignment(12345);
    expect(other).not.toEqual(assignment());
    expect(other.filter((id) => id === 'night')).toHaveLength(assignment().filter((id) => id === 'night').length);
    // Not simply one watch after another down the list.
    expect(new Set(assignment().slice(0, 20)).size).toBe(3);
  });

  it('puts the day share of the watch at work at 12:30, the evening share at 18:00 and the night share at 03:00', () => {
    const { city, life } = badanos;
    const watch = watchmen(city);
    const [day, evening, night] = apportion(watch.length, [0.4, 0.3, 0.3]) as [number, number, number];
    // At work means at the watch house or out on patrol from it.
    expect(atWork(life, watch, at(WORK_DAY, 12, 30))).toHaveLength(day);
    expect(atWork(life, watch, at(WORK_DAY, 18))).toHaveLength(evening);
    expect(atWork(life, watch, at(WORK_DAY + 1, 3))).toHaveLength(night);
    expect(day).toBeGreaterThan(30);
    expect(evening).toBeGreaterThan(25);
    expect(night).toBeGreaterThan(25);
    // The two never overlap: nobody on the day watch is there at 03:00.
    const there = new Set(atWork(life, watch, at(WORK_DAY + 1, 3)).map((person) => life.shiftOf(person.id)!.id));
    expect(there).toEqual(new Set(['night']));
  });

  it('takes rest-day turns within each shift', () => {
    const { city, life } = badanos;
    for (const id of ['watch-day', 'watch-evening', 'night']) {
      const group = watchmen(city).filter((person) => life.shiftOf(person.id)!.id === id);
      const share = pack.shifts.shifts[id]!.dutyShare!;
      const time = id === 'night' ? at(REST_DAY + 1, 3) : id === 'watch-evening' ? at(REST_DAY, 18) : at(REST_DAY, 12, 30);
      expect(atWork(life, group, time), id).toHaveLength(dutyCount(group.length, share));
    }
  });
});

describe('opening hours', () => {
  it('open a building while someone who works there is on shift, by the shift\'s own hours', () => {
    const { city, life } = badanos;
    const one = (type: string) => city.buildings.find((building) => building.type === type)!;
    const tavern = one('tavern');
    expect(life.openingHours(tavern.id, WORK_DAY)).toEqual([{ from: at(WORK_DAY, 15), to: at(WORK_DAY, 23) }]);
    expect(life.isOpen(tavern.id, at(WORK_DAY, 6, 16))).toBe(false);
    expect(life.isOpen(tavern.id, at(WORK_DAY, 15))).toBe(true);
    expect(life.isOpen(tavern.id, at(WORK_DAY, 22, 59))).toBe(true);
    expect(life.isOpen(tavern.id, at(WORK_DAY, 23))).toBe(false);
    // A stall keeps the day shift, and no hours on the rest day.
    const stall = one('market-stall');
    expect(life.openingHours(stall.id, WORK_DAY)).toEqual([{ from: at(WORK_DAY, 8), to: at(WORK_DAY, 17) }]);
    expect(life.openingHours(stall.id, REST_DAY)).toEqual([]);
    expect(life.isOpen(stall.id, at(REST_DAY, 10))).toBe(false);
    // A dwelling nobody works in is never open.
    const empty = city.buildings.find((building) => building.workerIds.length === 0 && building.householdIds.length > 0)!;
    expect(life.openingHours(empty.id, WORK_DAY)).toEqual([]);
    expect(() => life.isOpen('building-641-999999', 0)).toThrow(/there is no building/);
    expect(() => life.openingHours('building-641-999999', 1)).toThrow(/there is no building/);
  });

  it('join shifts that meet, and carry a night shift across midnight', () => {
    const { city, life } = badanos;
    // A watch house with all three watches: day, evening and night meet end to end, so it never shuts.
    const house = city.buildings.find((building) => {
      const shifts = new Set(building.workerIds.map((id) => life.shiftOf(id)?.id));
      return building.type === 'watch-house' && shifts.has('watch-day') && shifts.has('watch-evening') && shifts.has('night');
    })!;
    expect(life.openingHours(house.id, 3)).toEqual([{ from: at(3, 0), to: at(4, 0) }]);
    for (const hour of [3, 13, 14, 20, 22, 23]) expect(life.isOpen(house.id, at(3, hour)), `${hour}:00`).toBe(true);
    // One with no evening watch is shut from 17:00, when its day-shift sergeant goes, or 14:00 without one, until 22:00.
    const gap = city.buildings.find((building) => {
      const shifts = new Set(building.workerIds.map((id) => life.shiftOf(id)?.id));
      return building.type === 'watch-house' && shifts.has('night') && !shifts.has('watch-evening');
    });
    if (gap) {
      expect(life.isOpen(gap.id, at(3, 20))).toBe(false);
      expect(life.openingHours(gap.id, 3).at(-1)).toEqual({ from: at(3, 22), to: at(4, 0) });
      expect(life.isOpen(gap.id, at(3, 3))).toBe(true);
    }
  });

  it('agree with the shifts and rest-day duty of the people who work there, on every day of a week', { timeout: SLOW }, () => {
    const { city, life } = badanos;
    const people = new Map(city.people.map((person) => [person.id, person]));
    for (const day of [WORK_DAY, REST_DAY]) {
      for (const building of city.buildings.filter((_, index) => index % 7 === 0)) {
        if (placeFlagsOf(building.type, pack).alwaysOpen) continue;
        for (const hour of [3, 7, 12, 16, 20, 22.5]) {
          const time = startOfDay(day) + hour * 3600;
          // Someone is on shift if their shift, begun today or yesterday, covers the moment and they were on duty for it.
          const expected = building.workerIds.some((id) => {
            const shift = life.shiftOf(id)!;
            return [day - 1, day].some((began) => {
              const from = startOfDay(began) + shift.start;
              if (time < from || time >= from + shiftLength(shift)) return false;
              if (!isRestDay(began, pack.calendar)) return true;
              if (!shift.restDays) return false;
              // On duty that rest day: at work, there or out on a round, at the middle of the shift.
              return working(life, id, from + shiftLength(shift) / 2) && people.get(id)!.workplaceId === building.id;
            });
          });
          expect(life.isOpen(building.id, time), `${building.id} (${building.type}) on day ${day} at ${hour}`).toBe(expected);
        }
      }
    }
  });

  it('send no visit, in a week, to a place that is closed when the visitor arrives or past its closing', { timeout: SLOW }, () => {
    const { city, life } = badanos;
    const home = homeOf(city);
    let checked = 0;
    for (const day of WEEK) {
      for (const visit of visitsOn(life, day)) {
        if (visit.buildingId === home(visit.personId)) continue;
        checked++;
        expect(life.isOpen(visit.buildingId, visit.start), `${visit.personId} at ${visit.buildingId}, day ${day}, ${visit.visitId}`).toBe(true);
        expect(life.isOpen(visit.buildingId, visit.end - 1), `${visit.personId} leaving ${visit.buildingId}, day ${day}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(10_000);
    // The watchman who used to drink at 06:16: the night watch comes off duty when the taverns are shut, and goes home.
    const night = new Set(watchmen(city).filter((person) => life.shiftOf(person.id)!.id === 'night').map((person) => person.id));
    expect(night.size).toBeGreaterThan(25);
    for (const day of WEEK) expect(visitsOn(life, day).filter((visit) => visit.visitId === 'tavern' && night.has(visit.personId))).toEqual([]);
    // The evening watch, off at 22:00 with the taverns open until 23:00, still can.
    const evening = new Set(watchmen(city).filter((person) => life.shiftOf(person.id)!.id === 'watch-evening').map((person) => person.id));
    expect(WEEK.flatMap((day) => visitsOn(life, day)).filter((visit) => visit.visitId === 'tavern' && evening.has(visit.personId)).length).toBeGreaterThan(5);
  });

  it('send rest-day market visits only to places that are open or always open', { timeout: SLOW }, () => {
    // Badanos has no market square, and its stalls and shops rest: nobody goes to market.
    const market = (town: Town) => visitsOn(town.life, REST_DAY).filter((visit) => visit.visitId === 'market');
    expect(badanos.city.buildings.some((building) => building.type === 'market-square')).toBe(false);
    expect(market(badanos)).toEqual([]);
    expect(visitsOn(badanos.life, WORK_DAY).filter((visit) => visit.visitId === 'market').length).toBeGreaterThan(500);
    // A town with a square: the square is the market on a rest day.
    const withSquare = lomiaWorld()
      .settlements.filter((entry) => entry.flags.plaza && entry.population > 1500)
      .sort((a, b) => a.population - b.population)[0]!;
    const other = town(withSquare.id);
    const type = typeOf(other.city);
    const went = market(other);
    expect(went.length).toBeGreaterThan(20);
    expect(new Set(went.map((visit) => type(visit.buildingId)))).toEqual(new Set(['market-square']));
    // And people spend the rest-day afternoon there, out of doors.
    const afternoon = visitsOn(other.life, REST_DAY).filter((visit) => visit.visitId === 'square');
    expect(afternoon.length).toBeGreaterThan(20);
    expect(afternoon.every((visit) => visit.outside === true && type(visit.buildingId) === 'market-square')).toBe(true);
    const checker = createPlanChecker({ ...other, pack });
    expect(other.life.plansForDay(REST_DAY).flatMap((plan) => checker.check(plan)).slice(0, 5)).toEqual([]);
  });

  it('cut a visit short at closing, and drop one that closing would cut below its shortest', { timeout: SLOW }, () => {
    // Taverns that shut at 20:00, and an evening visit that begins between 19:00 and 21:00.
    const early = (min: number) =>
      edited((raw) => {
        raw.shifts.shifts.evening.end = '20:00';
        Object.assign(raw.visits.visits.find((entry: any) => entry.id === 'tavern-evening'), { durationMinutes: { min, max: 120 }, probability: 0.5 });
      });
    const evening = (packUsed: SettingPack) => visitsOn(town('settlement-641', packUsed).life, WORK_DAY).filter((visit) => visit.visitId === 'tavern-evening');
    const short = evening(early(20));
    expect(short.length).toBeGreaterThan(50);
    for (const visit of short) {
      expect(visit.start).toBeLessThanOrEqual(at(WORK_DAY, 19, 40));
      expect(visit.end).toBeLessThanOrEqual(at(WORK_DAY, 20));
      expect(visit.end - visit.start).toBeGreaterThanOrEqual(20 * 60);
    }
    expect(short.filter((visit) => visit.end === at(WORK_DAY, 20)).length).toBeGreaterThan(20);
    // Nobody can fit an hour and a half in before 20:00.
    expect(evening(early(90))).toEqual([]);
  });

  it('give the evening somewhere to go: people are in taverns at 20:30, and every one of the taverns is open', () => {
    const { city, life } = badanos;
    const time = at(WORK_DAY, 20, 30);
    const visiting = city.people.map((person) => life.whereabouts(person.id, time)).filter((where) => where.kind === 'visit');
    console.log(`Badanos at 20:30 on a work day: ${visiting.length} people on a visit`);
    expect(visiting.length).toBeGreaterThan(100);
    for (const where of visiting) expect(life.isOpen((where as { buildingId: string }).buildingId, time)).toBe(true);
  });
});

describe('being outside', () => {
  it('puts everyone at an open-air building outside, on its lot', () => {
    const { city, layout, life } = badanos;
    const lots = new Map(layout.lots.map((lot) => [lot.buildingId, lot.polygon]));
    const stall = city.buildings.find((building) => building.type === 'market-stall')!;
    const time = at(WORK_DAY, 11);
    const there = life.occupants(stall.id, time);
    expect(there.filter((occupant) => occupant.kind === 'work').length).toBeGreaterThan(0);
    expect(there.every((occupant) => occupant.outside === true)).toBe(true);
    for (const occupant of there) {
      const where = life.whereabouts(occupant.personId, time);
      expect(WhereaboutsSchema.safeParse(where).success).toBe(true);
      if (where.kind === 'travel' || where.kind === 'street' || where.kind === 'away') throw new Error('an occupant is walking');
      expect(where.outside).toBe(true);
      expect(geometry.strictlyInside(where.point!, lots.get(stall.id)!)).toBe(true);
      // On the lot for the whole stay, and asked again, in the same place at the same moment.
      for (const moment of [where.since, (where.since + where.until) / 2, where.until - 1]) {
        const then = life.whereabouts(occupant.personId, moment);
        expect(then).toMatchObject({ outside: true, buildingId: stall.id });
        expect(geometry.pointInPolygon((then as { point: [number, number] }).point, lots.get(stall.id)!)).toBe(true);
        expect(life.whereabouts(occupant.personId, moment)).toEqual(then);
      }
    }
    // People at the same stall stand in different places, and the same person stands elsewhere another day.
    const workers = there.filter((occupant) => occupant.kind === 'work');
    const points = workers.map((occupant) => (life.whereabouts(occupant.personId, time) as { point: [number, number] }).point.join());
    expect(new Set(points).size).toBe(points.length);
    const again = life.whereabouts(workers[0]!.personId, time + 86_400) as { point: [number, number] };
    expect(again.point.join()).not.toBe(points[0]);
    // Someone in an ordinary workplace is inside, with no point.
    const tannery = city.buildings.find((building) => building.type === 'tannery')!;
    const inside = life.whereabouts(tannery.workerIds[0]!, at(WORK_DAY, 11));
    expect(inside).not.toHaveProperty('outside');
    expect(inside).not.toHaveProperty('point');
  });

  it('marks a stay outside exactly when its building type is open-air or its visit says so', () => {
    const { city, life } = badanos;
    const type = typeOf(city);
    const visits = new Map(pack.visits.visits.map((visit) => [visit.id, visit]));
    const seen = { outside: 0, inside: 0, openAir: 0, byVisit: 0 };
    for (const day of [WORK_DAY, MARKET_DAY, REST_DAY]) {
      for (const plan of life.plansForDay(day)) {
        for (const stay of staysOf(plan)) {
          const openAir = placeFlagsOf(type(stay.buildingId), pack).openAir;
          const byVisit = stay.visitId !== undefined && visits.get(stay.visitId)!.outside === true;
          const expected = (stay.kind === 'work' || stay.kind === 'visit') && (openAir || byVisit);
          if ((stay.outside === true) !== expected || (stay.wander !== undefined) !== expected) throw new Error(`${plan.personId}, day ${day}: ${JSON.stringify(stay)}`);
          if (expected) seen.outside++;
          else seen.inside++;
          if (expected && openAir) seen.openAir++;
          if (expected && byVisit) seen.byVisit++;
        }
      }
    }
    expect(seen.openAir).toBeGreaterThan(1000);
    expect(seen.byVisit).toBeGreaterThan(1000);
    expect(seen.inside).toBeGreaterThan(seen.outside);
  });

  it('has children outside their own homes at 15:00, without a walk, and nobody younger', () => {
    const { city, life } = badanos;
    const home = homeOf(city);
    const people = new Map(city.people.map((person) => [person.id, person]));
    const play = pack.visits.visits.find((visit) => visit.id === 'play-afternoon')!;
    const time = at(WORK_DAY, 15);
    const out = city.people.map((person) => life.whereabouts(person.id, time)).filter((where) => where.kind === 'visit' && where.visitId === 'play-afternoon');
    console.log(`Badanos at 15:00 on a work day: ${out.length} children outside`);
    expect(out.length).toBeGreaterThan(100);
    for (const where of out) {
      const person = people.get(where.personId)!;
      expect(person.age).toBeGreaterThanOrEqual(play.who.minAge!);
      expect(person.age).toBeLessThanOrEqual(play.who.maxAge!);
      // Out on the street in front of their own home.
      expect(where).toMatchObject({ outside: true, onStreet: true, buildingId: home(person.id) });
      // A visit to home involves no travel: they are at home before it and after it, with no walk either side.
      const { activities } = life.plan(person.id, WORK_DAY);
      const playing = activities.findIndex((activity) => activity.kind === 'visit' && activity.start <= time && time < activity.end);
      expect(activities[playing - 1]?.kind).toBe('home');
      expect(activities[playing + 1]?.kind).toBe('home');
    }
    const small = city.people.filter((person) => person.age < play.who.minAge!);
    expect(small.length).toBeGreaterThan(300);
    for (const child of small) {
      for (const day of [WORK_DAY, REST_DAY]) expect(new Set(life.plan(child.id, day).activities.map((activity) => activity.kind))).toEqual(new Set(['sleep', 'home']));
    }
  });

  it('has nobody outside in their own sleeping hours', () => {
    const { city, life } = badanos;
    const species = pack.species.human!;
    for (const day of [WORK_DAY, REST_DAY]) {
      // Nobody is outside in the dead of night.
      for (const hour of [0, 1, 2, 3, 4]) {
        const out = city.people.filter((person) => (life.whereabouts(person.id, at(day, hour)) as { outside?: true }).outside);
        expect(out, `day ${day}, ${hour}:00`).toEqual([]);
      }
      for (const plan of life.plansForDay(day)) {
        const stays = staysOf(plan);
        // Sleep is indoors, and nothing out of doors falls between going to bed and getting up.
        expect(stays.some((stay) => (stay.kind === 'sleep' || stay.kind === 'home') && stay.outside)).toBe(false);
        const wakes = stays.find((stay) => stay.kind === 'sleep' && stay.start === startOfDay(day))?.end ?? startOfDay(day);
        for (const stay of stays.filter((entry) => entry.outside)) expect(stay.start).toBeGreaterThanOrEqual(wakes);
      }
    }
    // Those who are out by their own choice, not for work, are out in the species' waking hours.
    const chosen = visitsOn(life, WORK_DAY).filter((visit) => visit.outside);
    expect(chosen.length).toBeGreaterThan(1500);
    for (const visit of chosen) {
      expect(visit.start).toBeGreaterThan(startOfDay(WORK_DAY) + species.life.sleep.to - 3600);
      expect(visit.end).toBeLessThan(startOfDay(WORK_DAY) + species.life.sleep.from + 3600);
    }
  });

  it('shows at least 300 people on the map at 12:30 on a work day, walking or outside', () => {
    const { city, life } = badanos;
    const time = at(WORK_DAY, 12, 30);
    const where = city.people.map((person) => life.whereabouts(person.id, time));
    const walking = where.filter((entry) => entry.kind === 'travel').length;
    const outside = where.filter((entry) => entry.kind === 'street' || (entry.kind !== 'travel' && entry.kind !== 'away' && entry.outside)).length;
    console.log(`Badanos at 12:30 on a work day: ${walking} walking and ${outside} outside, ${walking + outside} to be seen`);
    expect(walking + outside).toBeGreaterThanOrEqual(300);
  });

  it('lists the outside stays that overlap a window, agreeing with whereabouts, and only those in a region when asked', () => {
    const { city, life } = badanos;
    const from = at(WORK_DAY, 12);
    const to = at(WORK_DAY, 13);
    const stays = life.outsideStays(from, to);
    for (const stay of stays.slice(0, 300)) expect(OutsideStaySchema.safeParse(stay).success).toBe(true);
    for (const time of [from, at(WORK_DAY, 12, 30), to - 1]) {
      const expected = city.people
        .map((person) => life.whereabouts(person.id, time))
        .filter((where) => where.kind === 'street' || (where.kind !== 'travel' && where.kind !== 'away' && where.outside))
        .map((where) => ({ personId: where.personId, point: (where as { point: [number, number] }).point }))
        .sort((a, b) => (a.personId < b.personId ? -1 : 1));
      // Each stay's wander, followed to the moment, puts the person where their whereabouts say.
      const listed = stays
        .filter((stay) => stay.from <= time && time < stay.to)
        .map((stay) => ({ personId: stay.personId, point: positionOnWander(stay.wander, time) }))
        .sort((a, b) => (a.personId < b.personId ? -1 : 1));
      expect(listed.map((entry) => entry.personId)).toEqual(expected.map((entry) => entry.personId));
      listed.forEach((entry, index) => expect(geometry.distance(entry.point, expected[index]!.point)).toBeLessThan(1e-9));
      expect(expected.length).toBeGreaterThan(300);
    }
    expect(stays.every((stay) => stay.to > from && stay.from < to)).toBe(true);
    // Only the part of each wander that falls in the window is given.
    for (const stay of stays) {
      expect(stay.wander.times[0]).toBe(Math.max(from, stay.from));
      expect(stay.wander.times.at(-1)).toBe(Math.min(to, stay.to));
    }
    const region = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    const local = life.outsideStays(from, to, region);
    expect(local.length).toBeGreaterThan(0);
    expect(local.length).toBeLessThan(stays.length);
    // A stay is in a region when its building's lot is.
    const boxes = new Map(badanos.layout.lots.map((lot) => [lot.buildingId, geometry.boxOf(lot.polygon)]));
    // A stay is in a region when its building's lot is; one out on a street, when the person is.
    const within = (stay: (typeof stays)[number]) => {
      const [x, y] = stay.wander.points[0]!;
      const box = stay.buildingId === undefined || stay.onStreet ? { minX: x, maxX: x, minY: y, maxY: y } : boxes.get(stay.buildingId)!;
      return box.maxX >= region.minX && box.minX <= region.maxX && box.maxY >= region.minY && box.minY <= region.maxY;
    };
    expect(local.every(within)).toBe(true);
    expect(stays.filter(within)).toHaveLength(local.length);
    // In the small hours nobody is out but the night watch, at stops on its beat.
    const small = life.outsideStays(at(WORK_DAY, 2), at(WORK_DAY, 3));
    expect(small.every((stay) => stay.round === true && stay.buildingId === undefined && stay.segmentId !== undefined)).toBe(true);
    const watch = new Set(watchmen(city).map((person) => person.id));
    expect(small.every((stay) => watch.has(stay.personId))).toBe(true);
  });

  it('lists a stay that crosses midnight once, whole', { timeout: SLOW }, () => {
    // With the watch house out of doors and no patrol to walk, the night watch stands outside from 22:00 to 06:00.
    const outdoors = (raw: any) => {
      raw.workplaces.find((entry: any) => entry.id === 'watch-house').openAir = true;
      delete raw.occupations.find((entry: any) => entry.id === 'watchman').round;
    };
    const { city, layout, life } = town('settlement-641', edited(outdoors));
    const night = watchmen(city).filter((person) => life.shiftOf(person.id)!.id === 'night');
    const stays = life.outsideStays(at(2, 23), at(3, 1)).filter((stay) => night.some((person) => person.id === stay.personId));
    expect(stays).toHaveLength(night.length);
    for (const stay of stays) {
      expect(stay.from).toBeLessThan(at(3, 0));
      expect(stay.to).toBeGreaterThan(at(3, 5));
      // One wander for the two hours asked about, joined at midnight without a jump.
      expect(stay.wander.times[0]).toBe(at(2, 23));
      expect(stay.wander.times.at(-1)).toBe(at(3, 1));
      for (const moment of [at(3, 0) - 1, at(3, 0), at(3, 0) + 1]) {
        expect(geometry.distance(positionOnWander(stay.wander, moment), (life.whereabouts(stay.personId, moment) as { point: [number, number] }).point)).toBeLessThan(1e-9);
      }
      expect(geometry.distance(positionOnWander(stay.wander, at(3, 0) - 1), positionOnWander(stay.wander, at(3, 0) + 1))).toBeLessThanOrEqual(2 * 0.5 + 1e-9);
    }
    const checker = createPlanChecker({ city, layout, pack: edited(outdoors) });
    const problems = night.flatMap((person) => [...checker.check(life.plan(person.id, 2)), ...checker.checkContinuity(life.plan(person.id, 2), life.plan(person.id, 3))]);
    expect(problems).toEqual([]);
  });

  it('counts the people outside in each hour of the day summary', () => {
    const { city, life } = badanos;
    const { hours } = life.daySummary(WORK_DAY);
    for (const hour of hours) expect(hour.outside).toBeLessThanOrEqual(hour.atWork + hour.visiting + 1e-6);
    // In the small hours only the watch is out, at stops on its beat; by mid-morning the yards and the market are busy.
    expect(hours[3]!.outside).toBeLessThan(15);
    expect(hours[10]!.outside).toBeGreaterThan(900);
    // An hour's figure is the average over the hour: check one against whereabouts sampled through it.
    const samples = Array.from({ length: 60 }, (_, minute) => at(WORK_DAY, 15, minute) + 30);
    const out = (personId: string, time: number) => {
      const where = life.whereabouts(personId, time);
      return where.kind === 'street' || (where.kind !== 'travel' && where.kind !== 'away' && where.outside === true);
    };
    const sampled = samples.reduce((sum, time) => sum + city.people.filter((person) => out(person.id, time)).length, 0) / samples.length;
    expect(Math.abs(hours[15]!.outside - sampled)).toBeLessThan(5);
  });
});

describe('the plan checker', () => {
  it('reports each new rule when it is broken', { timeout: SLOW }, () => {
    const { city, layout, life } = badanos;
    const checker = createPlanChecker({ city, layout, pack });
    const type = typeOf(city);
    const plans = life.plansForDay(WORK_DAY);
    const withStay = (wanted: (stay: Stay) => boolean) => {
      const plan = structuredClone(plans.find((entry) => staysOf(entry).some(wanted))!);
      return { plan, stay: staysOf(plan).find(wanted)! };
    };
    // A stallholder's own day at the stall, not a carter's brief stop there on a round.
    const atStall = (stay: Stay) => stay.kind === 'work' && !stay.round && type(stay.buildingId) === 'market-stall' && (stay.wander?.times.length ?? 0) > 6;

    const indoors = withStay(atStall);
    delete indoors.stay.outside;
    delete indoors.stay.wander;
    expect(checker.check(indoors.plan).join('\n')).toMatch(/is inside at building-641-\d+, but should be outside/);

    const astray = withStay(atStall);
    astray.stay.wander!.points[2] = [1e6, 1e6];
    expect(checker.check(astray.plan).join('\n')).toMatch(/wanders to a point that is not on the open ground of building-641-\d+'s lot/);

    const short = withStay(atStall);
    short.stay.wander!.times[short.stay.wander!.times.length - 1]! -= 60;
    expect(checker.check(short.plan).join('\n')).toMatch(/has a wander from \d+ to \d+, not covering the stay from \d+ to \d+/);

    // Hurried: a move that took its time is made in a second.
    const hurried = withStay((stay) => atStall(stay) && stay.wander!.points.length > 6);
    const { times, points } = hurried.stay.wander!;
    const leg = points.findIndex((point, index) => index > 0 && geometry.distance(point, points[index - 1]!) > 1.5);
    times[leg] = times[leg - 1]! + 1;
    expect(checker.check(hurried.plan).join('\n')).toMatch(/wanders [\d.]+ m in 1 s, faster than the pace of 0\.5 m\/s/);

    // In a yard with a building on it, a point inside the building is not open ground.
    const inYard = (stay: Stay) => stay.kind === 'work' && type(stay.buildingId) === 'stockyard';
    const walled = withStay(inYard);
    const footprint = layout.lots.find((lot) => lot.buildingId === walled.stay.buildingId)!.footprints[0]!;
    walled.stay.wander!.points[1] = geometry.polygonCentroid(footprint);
    expect(checker.check(walled.plan).join('\n')).toMatch(/wanders to a point that is not on the open ground|wanders through a footprint/);

    const out = withStay((stay) => stay.kind === 'work' && type(stay.buildingId) === 'tannery');
    Object.assign(out.stay, { outside: true, wander: { times: [out.stay.start, out.stay.end], points: [[0, 0], [0, 0]] } });
    expect(checker.check(out.plan).join('\n')).toMatch(/is outside at building-641-\d+, but should be inside/);

    // A drink after work, checked against taverns that do not open until 21:00.
    const drink = withStay((stay) => stay.visitId === 'tavern');
    const lateTaverns = edited((raw) => Object.assign(raw.shifts.shifts.evening, { start: '21:00', end: '23:30' }));
    expect(createPlanChecker({ city, layout, pack: lateTaverns }).check(drink.plan).join('\n')).toMatch(/is a "tavern" visit to building-641-\d+, which is closed at \d+/);
    // And against taverns that shut at 17:15.
    const earlyTaverns = edited((raw) => (raw.shifts.shifts.evening.end = '17:15'));
    const problems = plans.filter((plan) => staysOf(plan).some((stay) => stay.visitId === 'tavern')).flatMap((plan) => createPlanChecker({ city, layout, pack: earlyTaverns }).check(plan));
    expect(problems.join('\n')).toMatch(/is a "tavern" visit to building-641-\d+ that runs past its closing at \d+/);

    // A watchman's work, checked against a different draw of who keeps which watch.
    const other = createPlanChecker({ city, layout, pack, seed: 12345 });
    const watch = watchmen(city).flatMap((person) => other.check(life.plan(person.id, WORK_DAY)));
    expect(watch.join('\n')).toMatch(/is work outside the hours of the person's shift, "(night|watch-day)"/);
    expect(watchmen(city).flatMap((person) => checker.check(life.plan(person.id, WORK_DAY)))).toEqual([]);

    // A child playing somewhere that is not home.
    const play = withStay((stay) => stay.visitId === 'play-morning');
    const elsewhere = city.buildings.find((building) => building.type === 'tannery')!.id;
    play.stay.buildingId = elsewhere;
    expect(checker.check(play.plan).join('\n')).toMatch(/is a "play-morning" visit to a tannery, which that visit does not allow/);
  });
});

describe('home as a destination, and weekdays', () => {
  it('puts elders on the doorstep in the early evening', () => {
    const { city, life } = badanos;
    const home = homeOf(city);
    const sitting = visitsOn(life, WORK_DAY).filter((visit) => visit.visitId === 'doorstep');
    expect(sitting.length).toBeGreaterThan(50);
    const ages = new Map(city.people.map((person) => [person.id, person.age]));
    for (const visit of sitting) {
      expect(visit.buildingId).toBe(home(visit.personId));
      expect(visit.outside).toBe(true);
      expect(ages.get(visit.personId)).toBeGreaterThanOrEqual(60);
    }
  });

  it('has a visit to home sit between time at home, with no walk either side', () => {
    const { life } = badanos;
    let found = 0;
    for (const plan of life.plansForDay(WORK_DAY)) {
      plan.activities.forEach((activity: Activity, index) => {
        if (activity.kind !== 'visit' || !['play-morning', 'play-afternoon', 'doorstep'].includes(activity.visitId!)) return;
        found++;
        expect(plan.activities[index - 1]?.kind).toBe('home');
        expect(plan.activities[index + 1]?.kind).toBe('home');
      });
    }
    expect(found).toBeGreaterThan(1500);
  });

  it('lets home stand beside building types, as the nearest of them', () => {
    const packUsed = edited((raw) => raw.visits.visits.find((entry: any) => entry.id === 'errand').destinations.push('home'));
    const { city, layout, life } = town('settlement-455', packUsed);
    const home = homeOf(city);
    const errands = [WORK_DAY, 2, 3].flatMap((day) => visitsOn(life, day).filter((visit) => visit.visitId === 'errand'));
    expect(errands.some((visit) => visit.buildingId === home(visit.personId))).toBe(true);
    const checker = createPlanChecker({ city, layout, pack: packUsed });
    expect([WORK_DAY, 2, 3].flatMap((day) => life.plansForDay(day).flatMap((plan) => checker.check(plan)))).toEqual([]);
  });

  it('limits a visit to the weekdays it names', () => {
    const { life } = badanos;
    const count = (day: number) => visitsOn(life, day).filter((visit) => visit.visitId === 'marketday').length;
    expect(pack.calendar.week[MARKET_DAY - 1]!.name).toBe('Marketday');
    expect(count(MARKET_DAY)).toBeGreaterThan(300);
    expect(count(MARKET_DAY + 7)).toBeGreaterThan(300);
    for (const day of [1, 2, 3, 4, 5, 7, 8]) expect(count(day), `day ${day}`).toBe(0);
    // So the market is busier on Marketday.
    const type = typeOf(badanos.city);
    const atMarket = (day: number) => visitsOn(life, day).filter((visit) => type(visit.buildingId) === 'market-stall').length;
    expect(atMarket(MARKET_DAY)).toBeGreaterThan(atMarket(MARKET_DAY - 1) * 1.3);
  });
});

describe('pack behaviour', () => {
  /** The medieval pack with every phase 4.5 field taken out again: the pack as it was in phase 4. */
  const phase4 = () =>
    edited((raw) => {
      // Phase 6B's civic buildings, rounds and errands go first: the fingerprint is of the town before them.
      stripPhase6B(raw);
      for (const entry of [...raw.workplaces, ...raw.landmarks]) {
        delete entry.openAir;
        delete entry.alwaysOpen;
      }
      raw.occupations.find((entry: any) => entry.id === 'watchman').shift = 'night';
      delete raw.visits.openingHours;
      raw.visits.visits = raw.visits.visits.filter((visit: any) => ['market', 'tavern', 'worship', 'errand'].includes(visit.id));
      const left = JSON.stringify([raw.visits, raw.workplaces, raw.landmarks, raw.occupations]);
      for (const field of ['openAir', 'alwaysOpen', 'openingHours', 'weekdays', 'outside', '"home"', 'share']) expect(left).not.toContain(field);
    });

  it('gives the same plans as phase 4 from a pack with none of the new fields', { timeout: SLOW }, () => {
    const baseline = JSON.parse(readFileSync(new URL('./baselines/badanos-phase4-plans.json', import.meta.url), 'utf8')) as { planHash: Record<string, string> };
    // Laid out as it was then too: each building on the lot it was first given.
    const { life } = town('settlement-641', phase4(), undefined, BEFORE_6B5);
    for (const [day, hash] of Object.entries(baseline.planHash)) {
      const plans = life.plansForDay(Number(day));
      expect(createHash('sha256').update(JSON.stringify(plans)).digest('hex'), `day ${day}`).toBe(hash);
    }
    expect(Object.keys(baseline.planHash)).toEqual(['1', '7']);
    expect(life.outsideStays(at(1, 0), at(2, 0))).toEqual([]);
    expect(life.daySummary(1).hours.every((hour) => hour.outside === 0)).toBe(true);
  });

  it('lets a building type marked alwaysOpen be visited at night', { timeout: SLOW }, () => {
    const night = edited((raw) => Object.assign(raw.visits.visits.find((entry: any) => entry.id === 'tavern-evening'), { when: { from: '23:10', to: '23:40' }, durationMinutes: { min: 10, max: 15 }, probability: 0.5 }));
    const open = edited((raw) => {
      Object.assign(raw.visits.visits.find((entry: any) => entry.id === 'tavern-evening'), { when: { from: '23:10', to: '23:40' }, durationMinutes: { min: 10, max: 15 }, probability: 0.5 });
      raw.workplaces.find((entry: any) => entry.id === 'tavern').alwaysOpen = true;
    });
    const lateVisits = (packUsed: SettingPack) => {
      const { city, life } = town('settlement-641', packUsed);
      // A tavern whose only workers keep the evening shift.
      const tavern = city.buildings.find((building) => building.type === 'tavern' && building.workerIds.every((id) => life.shiftOf(id)!.id === 'evening'))!;
      return { visits: visitsOn(life, WORK_DAY).filter((visit) => visit.visitId === 'tavern-evening'), open: life.isOpen(tavern.id, at(WORK_DAY, 3)), hours: life.openingHours(tavern.id, WORK_DAY) };
    };
    const closed = lateVisits(night);
    expect(closed.visits).toEqual([]);
    expect(closed.open).toBe(false);
    const always = lateVisits(open);
    expect(always.visits.length).toBeGreaterThan(0);
    expect(always.open).toBe(true);
    expect(always.hours).toEqual([{ from: at(WORK_DAY, 0), to: at(WORK_DAY + 1, 0) }]);
  });

  it('removes a type\'s outside stays when openAir is taken off it', { timeout: SLOW }, () => {
    const indoors = edited((raw) => delete raw.workplaces.find((entry: any) => entry.id === 'market-stall').openAir);
    const outsideAtStalls = ({ city, life }: Town) => {
      const type = typeOf(city);
      return life.outsideStays(at(WORK_DAY, 0), at(WORK_DAY + 1, 0)).filter((stay) => stay.buildingId !== undefined && type(stay.buildingId) === 'market-stall').length;
    };
    expect(outsideAtStalls(badanos)).toBeGreaterThan(100);
    const changed = town('settlement-641', indoors);
    expect(outsideAtStalls(changed)).toBe(0);
    // Nothing else moves: the same people make the same visits at the same times.
    const strip = (plans: DayPlan[]) => JSON.stringify(plans.map((plan) => plan.activities.map(({ outside: _outside, wander: _wander, ...rest }: any) => rest)));
    expect(strip(changed.life.plansForDay(WORK_DAY))).toBe(strip(badanos.life.plansForDay(WORK_DAY)));
  });

  it('accepts home as a destination in any visit', () => {
    // In a visit of one stop, and in every stop of an errand that chains.
    expect(() => edited((raw) => raw.visits.visits.forEach((visit: any) => [visit, ...(visit.stops ?? [])].forEach((stop: any) => stop.destinations?.push('home'))))).not.toThrow();
  });
});

describe('determinism', () => {
  it('derives an outside point from the person, the building and the stay, whatever was asked first', () => {
    const { city, layout } = badanos;
    const a = createLife({ city, layout, pack });
    const b = createLife({ city, layout, pack });
    const time = at(3, 10, 30);
    b.plansForDay(5);
    b.plansForDay(2);
    const people = city.people.filter((_, index) => index % 9 === 0);
    for (const person of [...people].reverse()) b.whereabouts(person.id, time);
    for (const person of people) expect(a.whereabouts(person.id, time)).toEqual(b.whereabouts(person.id, time));
    expect(JSON.stringify(a.outsideStays(at(3, 10), at(3, 11)))).toBe(JSON.stringify(b.outsideStays(at(3, 10), at(3, 11))));
    // A different seed puts people elsewhere.
    const other = createLife({ city, layout, pack, seed: 99 });
    expect(JSON.stringify(other.outsideStays(at(3, 10), at(3, 11)))).not.toBe(JSON.stringify(a.outsideStays(at(3, 10), at(3, 11))));
  });
});
