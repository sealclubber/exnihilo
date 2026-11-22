/**
 * Daily life: plans, whereabouts and the queries built on them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Activity,
  type City,
  type DayPlan,
  type Layout,
  type Person,
  type SettingPack,
  type SettlementLife,
  type Stay,
  type Travel,
  DayPlanSchema,
  DaySummarySchema,
  LifeError,
  TripSchema,
  WhereaboutsSchema,
  allOccupations,
  createLife,
  createPlanChecker,
  describeDay,
  dutyCount,
  formatTimeOfDay,
  generateCity,
  generateLayout,
  geometry,
  isRestDay,
  parsePack,
  shiftsOf,
  stopsOf,
  startOfDay,
  tripDuration,
  walkingSpeed,
} from '../src/index.ts';
import { inYardsticks } from './cost.ts';
import { medievalPack, rawMedievalPack, settlement } from './pack.ts';

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
const town = (id: string, packUsed: SettingPack = pack): Town => {
  const brief = settlement(id);
  const city = generateCity(brief, packUsed);
  const layout = generateLayout(city, brief, packUsed);
  return { city, layout, life: createLife({ city, layout, pack: packUsed }) };
};

let badanos: Town;
let vereceldo: Town;
const WORK_DAY = 2;
const REST_DAY = 7;
/** The two towns' lives by settlement number, for asking a person's shift. */
const lives = new Map<string, SettlementLife>();
beforeAll(() => {
  badanos = town('settlement-641');
  vereceldo = town('settlement-455');
  lives.set('641', badanos.life).set('455', vereceldo.life);
}, SLOW);

/** The shift a person of Badanos or Vereceldo works, under the medieval pack. */
const shiftId = (person: Person) => lives.get(person.id.split('-')[1]!)!.shiftOf(person.id)?.id;
const onShift = (city: City, id: string) => city.people.filter((person) => shiftId(person) === id);
const workOf = (plan: DayPlan) => plan.activities.filter((activity): activity is Stay => activity.kind === 'work');
/** At work: at the workplace, or out on a round from it. */
const working = (life: SettlementLife, person: Person, time: number) => {
  const where = life.whereabouts(person.id, time);
  return (where.kind === 'work' && (where.buildingId === person.workplaceId || where.round === true)) || ((where.kind === 'travel' || where.kind === 'street') && where.round === true);
};
const travelOf = (plan: DayPlan) => plan.activities.filter((activity): activity is Travel => activity.kind === 'travel');

describe('plan invariants', () => {
  it('hold for every resident of Badanos and Vereceldo on each of eight consecutive days', { timeout: SLOW }, () => {
    expect(isRestDay(REST_DAY, pack.calendar)).toBe(true);
    for (const { city, layout, life } of [badanos, vereceldo]) {
      const checker = createPlanChecker({ city, layout, pack });
      const problems: string[] = [];
      let previous: DayPlan[] | undefined;
      for (let day = 1; day <= 9; day++) {
        const plans = life.plansForDay(day);
        expect(plans).toHaveLength(city.people.length);
        if (day <= 8) for (const plan of plans) problems.push(...checker.check(plan));
        // A person's whereabouts at the end of one day equal their whereabouts at the start of the next.
        if (previous) previous.forEach((plan, index) => problems.push(...checker.checkContinuity(plan, plans[index]!)));
        previous = plans;
      }
      expect(problems.slice(0, 5)).toEqual([]);
    }
  });

  it('describe plans that fit their schema', () => {
    for (const plan of vereceldo.life.plansForDay(WORK_DAY)) expect(DayPlanSchema.safeParse(plan).success).toBe(true);
    for (const plan of badanos.life.plansForDay(REST_DAY).slice(0, 300)) expect(DayPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('are reported, one line per broken rule', () => {
    const { city, layout, life } = vereceldo;
    const checker = createPlanChecker({ city, layout, pack });
    const worker = city.people.find((person) => person.workplaceId && shiftId(person) === 'day' && travelOf(life.plan(person.id, WORK_DAY)).length >= 2)!;
    const child = city.people.find((person) => person.workforceState === 'not-working' && person.age < 10)!;
    const fresh = (person: Person = worker): DayPlan => structuredClone(life.plan(person.id, WORK_DAY));
    const first = <K extends Activity['kind']>(plan: DayPlan, kind: K) =>
      plan.activities.find((activity) => activity.kind === kind) as K extends 'travel' ? Travel : Stay;
    const cases: Array<[string, () => DayPlan, RegExp]> = [
      ['a gap', () => { const plan = fresh(); plan.activities[1]!.start += 60; return plan; }, /activity 2 starts at \d+ but the one before ends at \d+/],
      ['a plan that starts late', () => { const plan = fresh(); plan.activities[0]!.start += 5; return plan; }, /the plan starts at \d+, not at midnight/],
      ['a plan that stops early', () => { const plan = fresh(); plan.activities.pop(); return plan; }, /the plan does not run to midnight/],
      ['a jump between buildings', () => { const plan = fresh(); first(plan, 'work').buildingId = city.buildings[0]!.id; return plan; }, /begins in building-455-\d+ but the one before ended in/],
      ['work somewhere other than the workplace', () => { const plan = fresh(); const other = city.buildings.find((building) => building.id !== worker.workplaceId)!.id; first(plan, 'work').buildingId = other; return plan; }, /is work in building-455-\d+, not the person's workplace/],
      ['work by someone outside the workforce', () => { const plan = fresh(child); plan.activities[0]!.kind = 'work'; return plan; }, /is work, but the person is not in the workforce/],
      ['a walk at the wrong speed', () => { const plan = fresh(); first(plan, 'travel').arriveAt += 600; return plan; }, /is a walk of [\d.]+ m taking \d+ s, not the \d+ s that 1\.35 m\/s gives/],
      ['a walk from a building to itself', () => { const plan = fresh(); const walk = first(plan, 'travel'); walk.toBuildingId = walk.fromBuildingId; return plan; }, /is a walk from building-455-\d+ to itself/],
      ['a path that does not reach the door', () => { const plan = fresh(); const walk = first(plan, 'travel'); walk.path = { ...walk.path, points: walk.path.points.slice(0, -1) }; return plan; }, /has a path that does not run from the entrance/],
      ['a building that does not exist', () => { const plan = fresh(); first(plan, 'work').buildingId = 'building-455-999999'; return plan; }, /building-455-999999, which does not exist/],
      ['sleep away from home', () => { const plan = fresh(); plan.activities[0]!.kind = 'sleep'; (plan.activities[0] as { buildingId: string }).buildingId = worker.workplaceId!; return plan; }, /is sleep in building-455-\d+, which is not the person's home/],
      ['a visit of a kind the pack lacks', () => { const plan = fresh(); Object.assign(first(plan, 'work'), { kind: 'visit', visitId: 'joust' }); return plan; }, /a visit of the kind "joust", which the pack does not define/],
      ['a visit to a building type the visit does not allow', () => { const plan = fresh(); Object.assign(first(plan, 'work'), { kind: 'visit', visitId: 'worship', buildingId: worker.workplaceId }); return plan; }, /is a "worship" visit to a [a-z-]+, which that visit does not allow/],
    ];
    expect(checker.check(fresh())).toEqual([]);
    for (const [name, damage, expected] of cases) expect(checker.check(damage()).join('\n'), name).toMatch(expected);
    // And a break across midnight.
    const today = fresh();
    const tomorrow = structuredClone(life.plan(worker.id, WORK_DAY + 1));
    expect(checker.checkContinuity(today, tomorrow)).toEqual([]);
    (tomorrow.activities[0] as { buildingId: string }).buildingId = worker.workplaceId!;
    expect(checker.checkContinuity(today, tomorrow).join()).toMatch(/day 2 ends sleep in building-455-\d+ but day 3 starts sleep in building-455-\d+/);
  });
});

describe('the base routine', () => {
  it('takes a day-shift worker from sleep to work and home to sleep', () => {
    const { city, life } = badanos;
    const worker = city.people.find((person) => shiftId(person) === 'day' && person.workplaceId !== city.households.find((household) => household.id === person.householdId)!.dwellingId)!;
    const kinds = life.plan(worker.id, WORK_DAY).activities.map((activity) => activity.kind).filter((kind) => kind !== 'visit');
    expect(kinds.slice(0, 4)).toEqual(['sleep', 'home', 'travel', 'work']);
    expect(kinds.at(-1)).toBe('sleep');
    expect(kinds.filter((kind) => kind === 'work')).toHaveLength(1);
  });

  it('gets workers to work for the start of their shift, give or take their habit and the day', () => {
    const { city, life } = badanos;
    const { start, end } = pack.shifts.shifts.day!;
    const slack = (pack.species.human!.life.variation.personalMinutes + pack.species.human!.life.variation.dailyMinutes) * 60;
    const arrivals: number[] = [];
    for (const person of onShift(city, 'day')) {
      // The shift runs from the first work of the day to the last: someone on a round is away from the workplace between.
      const spells = workOf(life.plan(person.id, WORK_DAY));
      const work = spells[0];
      expect(work, person.id).toBeDefined();
      expect(Math.abs(work!.start - (startOfDay(WORK_DAY) + start))).toBeLessThanOrEqual(slack);
      expect(Math.abs(spells.at(-1)!.end - (startOfDay(WORK_DAY) + end))).toBeLessThanOrEqual(slack);
      arrivals.push(work!.start - startOfDay(WORK_DAY) - start);
    }
    // People differ, some early and some late.
    expect(Math.min(...arrivals)).toBeLessThan(-600);
    expect(Math.max(...arrivals)).toBeGreaterThan(600);
  });

  it('gives each person a habit that holds from day to day, with a smaller variation on top', () => {
    const { city, life } = badanos;
    const daily = pack.species.human!.life.variation.dailyMinutes * 60;
    const workers = onShift(city, 'day').slice(0, 300);
    let moved = 0;
    for (const person of workers) {
      const starts = [2, 3, 4, 5].map((day) => workOf(life.plan(person.id, day))[0]!.start - startOfDay(day));
      expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(2 * daily);
      if (new Set(starts).size > 1) moved++;
    }
    expect(moved).toBeGreaterThan(workers.length * 0.9);
  });

  it('gives someone who works where they live no commute', () => {
    const { city, life } = badanos;
    const homes = new Map(city.households.map((household) => [household.id, household.dwellingId]));
    const atHome = city.people.filter((person) => person.workplaceId !== undefined && person.workplaceId === homes.get(person.householdId));
    expect(atHome.length).toBeGreaterThan(100);
    for (const person of atHome.slice(0, 200)) {
      const plan = life.plan(person.id, WORK_DAY);
      const work = workOf(plan)[0]!;
      const before = plan.activities[plan.activities.indexOf(work) - 1]!;
      expect(before.kind).not.toBe('travel');
      expect((work as { buildingId: string }).buildingId).toBe(homes.get(person.householdId));
    }
  });

  it('sends a servant to work in the home of the household that employs them', () => {
    const { city, life } = badanos;
    const homes = new Map(city.households.map((household) => [household.id, household.dwellingId]));
    const servant = city.people.find((person) => person.employerHouseholdId !== undefined)!;
    expect(workOf(life.plan(servant.id, WORK_DAY))[0]).toMatchObject({ buildingId: homes.get(servant.employerHouseholdId!) });
  });

  it('keeps apprentices to their workplace\'s shift', () => {
    const { city, life } = badanos;
    const apprentice = city.people.find((person) => person.apprentice && shiftId(person) === 'day')!;
    const [work] = workOf(life.plan(apprentice.id, WORK_DAY));
    expect(formatTimeOfDay(work!.start)).toMatch(/^0[78]:/);
    expect(formatTimeOfDay(work!.end)).toMatch(/^1[67]:/);
  });

  it('puts at least 95% of the default shift\'s workers at work at its midpoint: in their workplace, or on a round from it', () => {
    for (const { city, life } of [badanos, vereceldo]) {
      const { start, end } = pack.shifts.shifts[pack.shifts.default]!;
      const workers = onShift(city, pack.shifts.default);
      const middle = startOfDay(WORK_DAY) + (start + end) / 2;
      const there = workers.filter((person) => working(life, person, middle));
      expect(workers.length).toBeGreaterThan(50);
      expect(there.length / workers.length).toBeGreaterThanOrEqual(0.95);
      // Those whose occupation has no round are in the workplace itself.
      const rounds = new Set(allOccupations(pack).filter((occupation) => occupation.round !== undefined).map((occupation) => occupation.id));
      const fixed = workers.filter((person) => !rounds.has(person.occupationId!));
      const inside = fixed.filter((person) => {
        const where = life.whereabouts(person.id, middle);
        return where.kind === 'work' && where.buildingId === person.workplaceId;
      });
      expect(inside.length / fixed.length).toBeGreaterThanOrEqual(0.95);
    }
  });
});

describe('people outside the workforce', () => {
  it('never gives work to a child below the working age, or to anyone outside the workforce', () => {
    for (const { city, life } of [badanos, vereceldo]) {
      const minimum = pack.species.human!.workforce.workingAges.min;
      const idle = city.people.filter((person) => person.workforceState !== 'working');
      expect(idle.some((person) => person.age < minimum)).toBe(true);
      for (const day of [WORK_DAY, REST_DAY]) {
        for (const person of idle) expect(workOf(life.plan(person.id, day)), person.id).toEqual([]);
      }
    }
  });

  it('keeps children too young for any visit at home all day', () => {
    const { city, life } = badanos;
    const youngest = Math.min(...pack.visits.visits.map((visit) => visit.who.minAge ?? 0));
    const small = city.people.filter((person) => person.age < youngest);
    expect(small.length).toBeGreaterThan(300);
    for (const child of small.slice(0, 400)) {
      for (const day of [WORK_DAY, REST_DAY]) {
        expect(new Set(life.plan(child.id, day).activities.map((activity) => activity.kind))).toEqual(new Set(['sleep', 'home']));
      }
    }
  });

  it('sends some of those keeping house to market, and some elders on errands', () => {
    const { city, life } = badanos;
    const visitsOf = (people: Person[]) => people.flatMap((person) => life.plan(person.id, WORK_DAY).activities.filter((activity) => activity.kind === 'visit').map((activity) => (activity as { visitId: string }).visitId));
    const keepers = city.people.filter((person) => person.workforceState === 'keeping-house');
    const market = visitsOf(keepers).filter((id) => id === 'market').length;
    expect(market / keepers.length).toBeGreaterThan(0.4);
    expect(market / keepers.length).toBeLessThan(0.7);
    const elders = city.people.filter((person) => person.role === 'elder' && person.workforceState === 'not-working');
    const errands = visitsOf(elders).filter((id) => id === 'errand').length;
    expect(errands).toBeGreaterThan(0);
    expect(errands / elders.length).toBeLessThan(0.35);
  });
});

describe('rest days and rotas', () => {
  it('keeps everyone on a shift that does not work rest days away from work', () => {
    const { city, life } = badanos;
    const resting = city.people.filter((person) => life.shiftOf(person.id)?.restDays === false);
    expect(resting.length).toBeGreaterThan(3000);
    for (const person of resting) expect(workOf(life.plan(person.id, REST_DAY)), person.id).toEqual([]);
  });

  it('puts the pack\'s share of each rota occupation on duty, taking turns', () => {
    const { city, life } = badanos;
    // Those who share an occupation and a shift take turns among themselves.
    const rota = allOccupations(pack).flatMap((occupation) => shiftsOf(occupation, pack).filter((shift) => shift.restDays).map((shift) => ({ occupation, shift })));
    expect(rota.map((entry) => entry.occupation.id)).toEqual(expect.arrayContaining(['watchman', 'tavern-keeper', 'priest']));
    let checked = 0;
    for (const { occupation, shift } of rota) {
      const holders = city.people.filter((person) => person.occupationId === occupation.id && life.shiftOf(person.id)?.id === shift.id);
      if (holders.length === 0) continue;
      checked++;
      // On duty: a work activity that starts with the rest day's own shift.
      const dutyOn = (day: number) => holders.filter((person) => workOf(life.plan(person.id, day)).some((work) => work.start >= startOfDay(day) + shift.start - 3600));
      expect(dutyOn(REST_DAY).length, `${occupation.id}, ${shift.id}`).toBe(dutyCount(holders.length, shift.dutyShare!));
      expect(dutyOn(WORK_DAY).length, occupation.id).toBe(holders.length);
      if (shift.dutyShare! < 1 && holders.length > 3) {
        expect(dutyOn(REST_DAY + 7).map((person) => person.id), occupation.id).not.toEqual(dutyOn(REST_DAY).map((person) => person.id));
      }
    }
    expect(checked).toBeGreaterThan(6);
  });

  it('fills a rest day with visits instead, worship among them', () => {
    const { life } = badanos;
    const count = (day: number) => life.plansForDay(day).flatMap((plan) => plan.activities).filter((activity) => activity.kind === 'visit' && activity.visitId === 'worship').length;
    expect(count(WORK_DAY)).toBe(0);
    expect(count(REST_DAY)).toBeGreaterThan(2000);
  });
});

describe('night work and sleep', () => {
  it('has at least 95% of residents asleep at home at 03:00 on any day', () => {
    for (const { city, life } of [badanos, vereceldo]) {
      const homes = new Map(city.households.map((household) => [household.id, household.dwellingId]));
      for (let day = 1; day <= 8; day++) {
        const asleep = city.people.filter((person) => {
          const where = life.whereabouts(person.id, at(day, 3));
          return where.kind === 'sleep' && where.buildingId === homes.get(person.householdId);
        });
        expect(asleep.length / city.people.length, `day ${day}`).toBeGreaterThanOrEqual(0.95);
      }
    }
  });

  it('has every night-shift worker who is on duty at work at 03:00', () => {
    const { city, life } = badanos;
    const night = onShift(city, 'night');
    expect(night.length).toBeGreaterThan(25);
    const { dutyShare } = pack.shifts.shifts.night!;
    for (let day = 2; day <= 9; day++) {
      // At the watch house, or out on patrol from it.
      const atWork = night.filter((person) => working(life, person, at(day, 3)));
      // The shift began the evening before: everyone after a work day, the rota's share after a rest day.
      const expected = isRestDay(day - 1, pack.calendar) ? dutyCount(night.length, dutyShare!) : night.length;
      expect(atWork.length, `day ${day}`).toBe(expected);
    }
  });

  it('carries a night shift across midnight without a break', () => {
    const { city, life } = badanos;
    const watch = onShift(city, 'night')[0]!;
    // At work either side of midnight, and all through the night: at the watch house or on patrol.
    for (const time of [at(3, 0) - 1, at(3, 0), at(2, 22, 30), at(2, 23, 30), at(3, 1), at(3, 3), at(3, 5, 30)]) expect(working(life, watch, time), formatTimeOfDay(time)).toBe(true);
    // One shift, seen from both days' plans: it begins late on one day and ends early on the next.
    const evening = workOf(life.plan(watch.id, 2)).filter((work) => !work.round && work.start > at(2, 12))[0]!;
    const morning = workOf(life.plan(watch.id, 3)).filter((work) => !work.round && work.end < at(3, 12)).at(-1)!;
    expect(formatTimeOfDay(evening.start)).toMatch(/^2[12]:/);
    expect(formatTimeOfDay(morning.end)).toMatch(/^0[56]:/);
    // No home and no sleep between the two.
    const between = [...life.plan(watch.id, 2).activities, ...life.plan(watch.id, 3).activities].filter((activity) => activity.start >= evening.start && activity.end <= morning.end);
    expect(between.every((activity) => activity.kind === 'work' || activity.kind === 'travel' || activity.kind === 'street')).toBe(true);
  });

  it('moves sleep to fit the shift without shortening it', () => {
    const { city, life } = badanos;
    const asleep = (person: Person, day: number) =>
      [day, day + 1].flatMap((entry) => life.plan(person.id, entry).activities).filter((activity) => activity.kind === 'sleep' && activity.start >= at(day, 6) && activity.start < at(day + 1, 6));
    // A night worker sleeps by day; an evening worker goes to bed after midnight.
    const watch = onShift(city, 'night')[0]!;
    const daySleep = asleep(watch, 3).find((sleep) => sleep.start >= at(3, 6) && sleep.end <= at(3, 18));
    expect(daySleep).toBeDefined();
    expect(daySleep!.end - daySleep!.start).toBeGreaterThan(7 * 3600);
    const taverner = onShift(city, 'evening')[0]!;
    expect(life.whereabouts(taverner.id, at(3, 22)).kind).toBe('work');
    expect(life.whereabouts(taverner.id, at(4, 3)).kind).toBe('sleep');
    expect(life.whereabouts(taverner.id, at(4, 7)).kind).toBe('sleep');
    // Everyone sleeps about the species' usual length each day.
    const usual = 8 * 3600;
    for (const person of [watch, taverner, ...city.people.slice(0, 200)]) {
      const total = life.plan(person.id, 3).activities.filter((activity) => activity.kind === 'sleep').reduce((sum, sleep) => sum + sleep.end - sleep.start, 0);
      expect(Math.abs(total - usual), person.id).toBeLessThan(45 * 60);
    }
  });
});

describe('visits', () => {
  it('go only to building types the visit allows, and never to the place the person is leaving', () => {
    const { city, life } = badanos;
    const types = new Map(city.buildings.map((building) => [building.id, building.type]));
    const homes = new Map(city.households.map((household) => [household.id, household.dwellingId]));
    const people = new Map(city.people.map((person) => [person.id, person]));
    const seen = new Set<string>();
    for (const day of [WORK_DAY, REST_DAY]) {
      for (const plan of life.plansForDay(day)) {
        plan.activities.forEach((activity, index) => {
          if (activity.kind !== 'visit') return;
          const visit = pack.visits.visits.find((entry) => entry.id === activity.visitId)!;
          seen.add(visit.id);
          // A visit to the person's own home is walked to from nowhere.
          // Any stop of the visit will do; a stroll goes by way of a place it favours.
          const allowed = visit.stroll ? (visit.stroll.favour ?? []) : stopsOf(visit).flatMap((stop) => stop.destinations);
          if (activity.buildingId === homes.get(people.get(plan.personId)!.householdId)) return expect(allowed).toContain('home');
          expect(allowed).toContain(types.get(activity.buildingId));
          // A visit under way at midnight is the rest of one begun the day before.
          if (index === 0 || index === plan.activities.length - 1) return;
          const walk = plan.activities[index - 1] as Travel;
          expect(walk.kind).toBe('travel');
          expect(walk.toBuildingId).toBe(activity.buildingId);
          expect(walk.fromBuildingId).not.toBe(activity.buildingId);
          const length = activity.end - activity.start;
          // Closing time may cut a visit short, but never below its shortest duration. (A stroll's pause has no such floor.)
          const lengths = visit.stroll ? [visit.stroll.pauseMinutes] : stopsOf(visit).filter((stop) => stop.destinations.includes(types.get(activity.buildingId)!)).map((stop) => stop.durationMinutes);
          expect(length).toBeGreaterThanOrEqual(visit.stroll ? 1 : Math.min(...lengths.map((range) => range.min)) * 60);
          expect(length).toBeLessThanOrEqual(Math.max(...lengths.map((range) => range.max)) * 60);
        });
      }
    }
    // Every visit of the pack that has a building to go to, bar the two that depend on the day or on chance too far.
    for (const id of ['market', 'tavern', 'worship', 'errand', 'tavern-evening', 'play-morning', 'play-afternoon', 'doorstep', 'water', 'water-children', 'marketing', 'bathhouse']) expect(seen, id).toContain(id);
  });

  it('put a stop after work between leaving work and arriving home', () => {
    const { city, life } = badanos;
    const homes = new Map(city.households.map((household) => [household.id, household.dwellingId]));
    let found = 0;
    for (const plan of life.plansForDay(WORK_DAY)) {
      const person = city.people.find((entry) => entry.id === plan.personId)!;
      const stop = plan.activities.findIndex((activity) => activity.kind === 'visit' && activity.visitId === 'tavern');
      if (stop === -1 || person.workplaceId === homes.get(person.householdId)) continue;
      found++;
      if (stop < 2 || stop > plan.activities.length - 3) continue;
      expect(plan.activities.slice(stop - 2, stop + 2).map((activity) => activity.kind)).toEqual(['work', 'travel', 'visit', 'travel']);
      // Then home, awake for a while or straight to bed.
      expect(['home', 'sleep']).toContain(plan.activities[stop + 2]!.kind);
      expect((plan.activities[stop - 1] as Travel).fromBuildingId).toBe(person.workplaceId);
      expect((plan.activities[stop + 1] as Travel).toBuildingId).toBe(homes.get(person.householdId));
      if (found > 200) break;
    }
    expect(found).toBeGreaterThan(100);
  });

  it('happen about as often as the pack says', () => {
    const { city, life } = badanos;
    const tavern = pack.visits.visits.find((visit) => visit.id === 'tavern')!;
    const eligible = city.people.filter((person) => person.workforceState === 'working' && person.age >= tavern.who.minAge!);
    const went = eligible.filter((person) => life.plan(person.id, WORK_DAY).activities.some((activity) => activity.kind === 'visit' && activity.visitId === 'tavern'));
    expect(went.length / eligible.length).toBeGreaterThan(tavern.probability - 0.05);
    expect(went.length / eligible.length).toBeLessThan(tavern.probability + 0.05);
  });

  it('favour nearer destinations', () => {
    const { city, layout, life } = badanos;
    const entrance = new Map(layout.lots.map((lot) => [lot.buildingId, lot.entrance.point]));
    const homes = new Map(city.households.map((household) => [household.id, household.dwellingId]));
    const chapels = city.buildings.filter((building) => building.type === 'chapel');
    let chosen = 0;
    let average = 0;
    let count = 0;
    for (const plan of life.plansForDay(REST_DAY)) {
      const visit = plan.activities.find((activity) => activity.kind === 'visit' && activity.visitId === 'worship');
      if (!visit || visit.kind === 'travel' || visit.kind === 'street') continue;
      const home = entrance.get(homes.get(city.people.find((person) => person.id === plan.personId)!.householdId)!)!;
      chosen += geometry.distance(home, entrance.get(visit.buildingId)!);
      average += chapels.reduce((sum, chapel) => sum + geometry.distance(home, entrance.get(chapel.id)!), 0) / chapels.length;
      if (++count >= 600) break;
    }
    // Each person's chosen chapel is, on average, nearer than their average chapel.
    expect(chosen / count).toBeLessThan((average / count) * 0.9);
  });

  it('do not happen when the settlement has no building of the type', () => {
    const { city, life } = town('settlement-641', edited((raw) => (raw.visits.visits.find((visit: any) => visit.id === 'worship').destinations = ['temple'])));
    expect(city.buildings.some((building) => building.type === 'temple')).toBe(false);
    const visits = life.plansForDay(REST_DAY).flatMap((plan) => plan.activities).filter((activity) => activity.kind === 'visit');
    expect(visits.filter((activity) => (activity as { visitId?: string }).visitId === 'worship')).toEqual([]);
    expect(visits.length).toBeGreaterThan(100);
  });
});

describe('trips and whereabouts', () => {
  it('take a path\'s length divided by the person\'s walking speed', () => {
    const { city, life } = badanos;
    const people = new Map(city.people.map((person) => [person.id, person]));
    let trips = 0;
    for (const plan of life.plansForDay(WORK_DAY)) {
      const speed = walkingSpeed(people.get(plan.personId)!, pack);
      for (const walk of travelOf(plan)) {
        trips++;
        expect(walk.arriveAt - walk.departAt).toBe(tripDuration(walk.path.length, speed));
        expect(Math.abs(walk.arriveAt - walk.departAt - walk.path.length / speed)).toBeLessThan(1);
      }
    }
    expect(trips).toBeGreaterThan(8000);
    expect(walkingSpeed({ age: 5, species: 'human' }, pack)).toBe(0.9);
    expect(walkingSpeed({ age: 30, species: 'human' }, pack)).toBe(1.35);
    expect(walkingSpeed({ age: 75, species: 'human' }, pack)).toBe(1.0);
  });

  it('place a walker at the point that far along the path, on the segment they are walking', () => {
    const { city, layout, life } = badanos;
    const segments = new Map(layout.segments.map((segment) => [segment.id, segment]));
    // A walk from one building to another, by several streets.
    const far = (walk: Travel) => walk.path.segmentIds.length > 4 && walk.toBuildingId !== undefined && walk.fromBuildingId !== undefined;
    const walker = city.people.find((person) => travelOf(life.plan(person.id, WORK_DAY)).some(far))!;
    const walk = travelOf(life.plan(walker.id, WORK_DAY)).find(far)!;
    const seen = new Set<string>();
    for (const share of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) {
      const time = walk.departAt + (walk.arriveAt - walk.departAt) * share;
      const where = life.whereabouts(walker.id, time);
      expect(WhereaboutsSchema.safeParse(where).success).toBe(true);
      if (where.kind !== 'travel') throw new Error('expected the person to be walking');
      expect(where).toMatchObject({ since: walk.departAt, until: walk.arriveAt });
      expect([where.fromBuildingId, where.toBuildingId, where.fromStreet, where.toStreet]).toEqual([walk.fromBuildingId, walk.toBuildingId, walk.fromStreet, walk.toStreet]);
      const along = geometry.projectOnPolyline(walk.path.points, where.point);
      expect(along.distance).toBeLessThan(1e-6);
      expect(along.along).toBeCloseTo(walk.path.length * share, 6);
      expect(walk.path.segmentIds).toContain(where.segmentId);
      expect(geometry.distanceToPolyline(where.point, segments.get(where.segmentId)!.points)).toBeLessThan(1e-6);
      seen.add(where.segmentId);
    }
    expect(seen.size).toBeGreaterThan(2);
    expect(life.whereabouts(walker.id, walk.departAt)).toMatchObject({ kind: 'travel', point: walk.path.points[0] });
    // On arrival the person is in the building.
    expect(life.whereabouts(walker.id, walk.arriveAt)).toMatchObject({ buildingId: walk.toBuildingId });
  });

  it('answer for someone in a building with the building and the activity', () => {
    const { city, life } = badanos;
    const worker = onShift(city, 'day')[0]!;
    const where = life.whereabouts(worker.id, at(WORK_DAY, 12));
    expect(where).toMatchObject({ personId: worker.id, time: at(WORK_DAY, 12), kind: 'work', buildingId: worker.workplaceId });
    if (where.kind === 'away') throw new Error('a resident is never away');
    expect(where.since).toBeLessThan(at(WORK_DAY, 9));
    expect(where.until).toBeGreaterThan(at(WORK_DAY, 16));
    expect(() => life.whereabouts('person-641-999999', 0)).toThrow(LifeError);
    expect(() => life.plan('nobody', 1)).toThrow(/there is no person with the ID "nobody"/);
  });

  it('say who is in a building, agreeing with each person\'s whereabouts', { timeout: SLOW }, () => {
    const { city, life } = badanos;
    for (const time of [at(WORK_DAY, 3), at(WORK_DAY, 12), at(WORK_DAY, 17, 40)]) {
      const inside = new Map<string, number>();
      let walking = 0;
      for (const person of city.people) {
        const where = life.whereabouts(person.id, time);
        if (where.kind === 'travel' || where.kind === 'street' || where.kind === 'away') walking++;
        else inside.set(where.buildingId, (inside.get(where.buildingId) ?? 0) + 1);
      }
      let counted = 0;
      for (const building of city.buildings) {
        const occupants = life.occupants(building.id, time);
        expect(occupants.length, building.id).toBe(inside.get(building.id) ?? 0);
        counted += occupants.length;
      }
      expect(counted + walking).toBe(city.people.length);
    }
    const tannery = city.buildings.find((building) => building.type === 'tannery')!;
    const staff = life.occupants(tannery.id, at(WORK_DAY, 12));
    expect(staff.length).toBeGreaterThan(0);
    // Everyone there at midday is at work: the tannery's own people, and perhaps a carter stopped there on a round.
    expect(staff.every((occupant) => occupant.kind === 'work')).toBe(true);
    expect(staff.filter((occupant) => tannery.workerIds.includes(occupant.personId)).length).toBeGreaterThan(0);
    for (const caller of staff.filter((occupant) => !tannery.workerIds.includes(occupant.personId))) expect(life.whereabouts(caller.personId, at(WORK_DAY, 12))).toMatchObject({ round: true });
    expect(life.occupants(tannery.id, at(WORK_DAY, 3))).toEqual([]);
    expect(() => life.occupants('building-641-999999', 0)).toThrow(/there is no building/);
  });

  it('list the trips that overlap a window, each once, and only those in a region when asked', () => {
    const { life } = badanos;
    const from = at(WORK_DAY, 7);
    const to = at(WORK_DAY, 8);
    const trips = life.trips(from, to);
    for (const trip of trips.slice(0, 200)) expect(TripSchema.safeParse(trip).success).toBe(true);
    const expected = life.plansForDay(WORK_DAY).flatMap((plan) => travelOf(plan).filter((walk) => walk.arriveAt >= from && walk.departAt < to).map((walk) => `${plan.personId}:${walk.departAt}`));
    expect(trips.map((trip) => `${trip.personId}:${trip.departAt}`).sort()).toEqual(expected.sort());
    expect(trips.length).toBeGreaterThan(2000);
    expect(new Set(trips.map((trip) => `${trip.personId}:${trip.departAt}`)).size).toBe(trips.length);
    // A window across midnight counts a trip that crosses it once.
    const night = life.trips(at(WORK_DAY, 23), at(WORK_DAY + 1, 1));
    expect(new Set(night.map((trip) => `${trip.personId}:${trip.departAt}`)).size).toBe(night.length);
    expect(night.length).toBeGreaterThan(0);

    const region = { minX: 0, minY: 0, maxX: 150, maxY: 150 };
    const local = life.trips(from, to, region);
    expect(local.length).toBeGreaterThan(0);
    expect(local.length).toBeLessThan(trips.length);
    const touches = (points: [number, number][]) => {
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      return Math.max(...xs) >= region.minX && Math.min(...xs) <= region.maxX && Math.max(...ys) >= region.minY && Math.min(...ys) <= region.maxY;
    };
    expect(local.every((trip) => touches(trip.points))).toBe(true);
    expect(trips.filter((trip) => touches(trip.points)).length).toBe(local.length);
    // In the small hours the only walks are the night watch's patrols.
    const small = life.trips(at(WORK_DAY, 2), at(WORK_DAY, 2, 10));
    expect(small.length).toBeGreaterThan(0);
    expect(small.every((trip) => trip.round === true)).toBe(true);
  });
});

describe('a settlement\'s day', () => {
  it('counts everyone in every hour', () => {
    const { city, life } = badanos;
    const summary = life.daySummary(WORK_DAY);
    expect(DaySummarySchema.safeParse(summary).success).toBe(true);
    for (const hour of summary.hours) {
      expect(hour.asleep + hour.atHome + hour.atWork + hour.visiting + hour.travelling).toBeCloseTo(city.people.length, 6);
    }
    expect(summary.hours.reduce((sum, hour) => sum + hour.tripsStarted, 0)).toBe(summary.trips);
    expect(summary.hours[3]!.asleep).toBeGreaterThan(city.people.length * 0.95);
    expect(summary.hours[12]!.atWork).toBeGreaterThan(3500);
  });

  it('is busiest for travel within an hour of the start or the end of the default shift', () => {
    const { life } = badanos;
    const { start, end } = pack.shifts.shifts[pack.shifts.default]!;
    const near = (hour: number) => [start, end].some((edge) => hour * 3600 >= edge - 3600 && hour * 3600 < edge + 3600);
    const summary = life.daySummary(WORK_DAY);
    const busiest = (pick: (hour: (typeof summary.hours)[number]) => number) => summary.hours.reduce((best, hour) => (pick(hour) > pick(best) ? hour : best)).hour;
    expect(near(busiest((hour) => hour.travelling))).toBe(true);
    expect(near(busiest((hour) => hour.tripsStarted))).toBe(true);
  });

  it('sends more trips over the bridge than over the median segment', () => {
    const { layout, life } = badanos;
    const loads = life.segmentLoads(WORK_DAY);
    expect(loads).toHaveLength(layout.segments.length);
    expect(loads.map((load) => load.trips)).toEqual([...loads.map((load) => load.trips)].sort((a, b) => b - a));
    const median = loads[Math.floor(loads.length / 2)]!.trips;
    const bridges = layout.segments.filter((segment) => segment.kind === 'bridge');
    expect(bridges.length).toBeGreaterThan(0);
    const busiestBridge = Math.max(...bridges.map((bridge) => loads.find((load) => load.segmentId === bridge.id)!.trips));
    expect(busiestBridge).toBeGreaterThan(median);
    expect(busiestBridge).toBeGreaterThan(500);
  });

  it('can be written out as text', () => {
    const { layout, life } = badanos;
    const text = describeDay(life, REST_DAY, { layout, pack, settlementName: 'Badanos' });
    expect(text).toContain('Badanos, day 7: Restday, a rest day');
    expect(text).toMatch(/Sunrise 06:00, sunset 19:00\. [\d,]+ trips begun\./);
    expect(text).toMatch(/03:00\s+9,5\d\d\s/);
    expect(text).toMatch(/Busiest segments[\s\S]*segment-641-\d{6}\s+[\d,]+\s+(bridge|street|lane|arterial)/);
    expect(text.split('\n').filter((line) => /^\s+\d\d:00/.test(line))).toHaveLength(24);
    expect(describeDay(life, WORK_DAY, { layout, pack, settlementName: 'Badanos' })).toContain('day 2: Tilsday\n');
  });
});

describe('determinism', () => {
  it('gives an identical plan for the same inputs', () => {
    const { city, layout, life } = vereceldo;
    const again = createLife({ city, layout, pack });
    for (const day of [1, 2, 7]) expect(JSON.stringify(again.plansForDay(day))).toBe(JSON.stringify(life.plansForDay(day)));
    const fresh = town('settlement-455', parsePack(rawMedievalPack()));
    expect(JSON.stringify(fresh.life.plansForDay(3))).toBe(JSON.stringify(life.plansForDay(3)));
  });

  it('gives a different day for a different seed, and a different day each day', () => {
    const { city, layout, life } = vereceldo;
    const other = createLife({ city, layout, pack, seed: 99 });
    expect(JSON.stringify(other.plansForDay(2))).not.toBe(JSON.stringify(life.plansForDay(2)));
    const shifted = (day: number) => life.plansForDay(day).map((plan) => plan.activities.map((activity) => [activity.kind, activity.start - startOfDay(day)]));
    expect(shifted(2)).not.toEqual(shifted(3));
  });

  it('gives the same plan whether or not other people\'s plans, or other days, were computed first', () => {
    const { city, layout } = badanos;
    const person = city.people[4321]!;
    const alone = createLife({ city, layout, pack }).plan(person.id, 5);
    const busy = createLife({ city, layout, pack });
    for (const day of [1, 2, 3, 4, 6, 9, 5]) busy.plansForDay(day);
    for (const other of city.people.slice(0, 50)) busy.plan(other.id, 12);
    expect(JSON.stringify(busy.plan(person.id, 5))).toBe(JSON.stringify(alone));
    const backwards = createLife({ city, layout, pack });
    for (const day of [9, 6, 5, 4]) backwards.plan(person.id, day);
    expect(JSON.stringify(backwards.plan(person.id, 5))).toBe(JSON.stringify(alone));
  });

  it('gives whereabouts that depend only on game time, in whatever order they are asked', () => {
    const { city, layout } = badanos;
    const people = city.people.filter((_, index) => index % 400 === 3);
    const times = [at(2, 7, 31), at(1, 3), at(8, 12), at(2, 7, 30), at(5, 17, 12), at(3, 0), at(2, 23, 59), at(7, 10, 15), at(30, 8, 5)];
    const ask = (order: number[]) => {
      const life = createLife({ city, layout, pack });
      const answers = new Map<number, string>();
      for (const index of order) answers.set(index, JSON.stringify(people.map((person) => life.whereabouts(person.id, times[index]!))));
      return times.map((_, index) => answers.get(index));
    };
    const forwards = ask(times.map((_, index) => index));
    // Jumping the clock back and forth, and asking twice, changes nothing.
    expect(ask([8, 0, 7, 1, 6, 2, 5, 3, 4])).toEqual(forwards);
    expect(ask([4, 4, 0, 8, 0, 3, 5, 1, 7, 2, 6, 8])).toEqual(forwards);
  });

  it('leaves the city and the layout as they were', () => {
    const brief = settlement('settlement-455');
    const city = generateCity(brief, pack);
    const layout = generateLayout(city, brief, pack);
    const before = JSON.stringify([city, layout]);
    const life = createLife({ city, layout, pack });
    life.plansForDay(1);
    life.daySummary(7);
    expect(JSON.stringify([city, layout])).toBe(before);
  });
});

describe('pack edits take effect', () => {
  it('moves workers\' arrivals an hour later when the shift starts an hour later', () => {
    const later = town('settlement-641', edited((raw) => (raw.shifts.shifts.day.start = '09:00')));
    const workers = onShift(badanos.city, 'day');
    let exact = 0;
    for (const person of workers) {
      const before = workOf(badanos.life.plan(person.id, WORK_DAY))[0]!.start;
      const after = workOf(later.life.plan(person.id, WORK_DAY))[0]!.start;
      if (after - before === 3600) exact++;
    }
    expect(exact).toBe(workers.length);
  });

  it('has workers work every day when the pack has no rest days', () => {
    const tireless = edited((raw) => raw.calendar.week.forEach((day: any) => (day.rest = false)));
    const { city, life } = town('settlement-641', tireless);
    const workers = city.people.filter((person) => person.workplaceId !== undefined);
    for (const day of [6, 7, 8]) {
      const working = workers.filter((person) => workOf(life.plan(person.id, day)).length > 0);
      expect(working.length, `day ${day}`).toBe(workers.length);
    }
    const resting = badanos.city.people.filter((person) => person.workplaceId !== undefined && workOf(badanos.life.plan(person.id, 7)).length > 0);
    expect(resting.length).toBeLessThan(workers.length / 5);
  });

  it('halves every trip\'s duration when walking speed doubles', () => {
    const fast = town('settlement-455', edited((raw) => raw.species.human.life.walkingSpeed.forEach((band: any) => (band.metresPerSecond *= 2))));
    let trips = 0;
    for (const person of vereceldo.city.people) {
      const speed = walkingSpeed(person, pack);
      for (const walk of travelOf(fast.life.plan(person.id, WORK_DAY))) {
        trips++;
        // Durations are whole seconds, so halving is exact to the second.
        expect(walk.arriveAt - walk.departAt).toBe(tripDuration(walk.path.length, speed * 2));
        expect(Math.abs((walk.arriveAt - walk.departAt) * 2 - tripDuration(walk.path.length, speed))).toBeLessThanOrEqual(1);
      }
    }
    expect(trips).toBeGreaterThan(100);
    // The commute itself is the same walk, done in half the time.
    const commuter = vereceldo.city.people.find((person) => travelOf(vereceldo.life.plan(person.id, WORK_DAY)).length > 0 && shiftId(person) === 'day')!;
    const slow = travelOf(vereceldo.life.plan(commuter.id, WORK_DAY))[0]!;
    const quick = travelOf(fast.life.plan(commuter.id, WORK_DAY))[0]!;
    expect(quick.path.length).toBe(slow.path.length);
    expect(quick.arriveAt).toBe(slow.arriveAt);
    expect(Math.abs((quick.arriveAt - quick.departAt) * 2 - (slow.arriveAt - slow.departAt))).toBeLessThanOrEqual(1);
  });

  it('follows the pack\'s sleep hours and variations', () => {
    const { city, life } = town('settlement-455', edited((raw) => {
      raw.species.human.life.sleep = { from: '21:00', to: '05:00' };
      raw.species.human.life.variation = { personalMinutes: 0, dailyMinutes: 0 };
    }));
    const child = city.people.find((person) => person.age < 10)!;
    expect(life.plan(child.id, 3).activities.map((activity) => [activity.kind, formatTimeOfDay(activity.start)])).toEqual([['sleep', '00:00'], ['home', '05:00'], ['sleep', '21:00']]);
    // With no variation, everyone on the day shift arrives on the dot.
    const starts = new Set(onShift(city, 'day').map((person) => formatTimeOfDay(workOf(life.plan(person.id, WORK_DAY))[0]!.start)));
    expect(starts).toEqual(new Set(['08:00']));
  });
});

describe('independence from the layout generator', () => {
  it('imports the layout format and the path function, and nothing from the grid generator', () => {
    const folder = new URL('../src/life/', import.meta.url);
    const files = readdirSync(folder).filter((name) => name.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['calendar.ts', 'invariants.ts', 'life.ts', 'records.ts', 'report.ts']));
    const imports = files.flatMap((name) => [...readFileSync(new URL(name, folder), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!));
    const fromLayout = [...new Set(imports.filter((path) => path.includes('/layout/')))].sort();
    expect(fromLayout).toEqual(['../layout/geometry.ts', '../layout/path.ts', '../layout/records.ts']);
    expect(imports.some((path) => /grid|generate/.test(path))).toBe(false);
  });

  it('plans a day on a layout it has never seen the making of', () => {
    // Bend every street: the plans still hold, and walks grow with the paths.
    const { city, layout } = vereceldo;
    const bent = structuredClone(layout);
    for (const segment of bent.segments) {
      const [start, end] = [segment.points[0]!, segment.points.at(-1)!];
      segment.points = [start, [(start[0] + end[0]) / 2 + 2, (start[1] + end[1]) / 2 + 2], end];
    }
    for (const lot of bent.lots) {
      const segment = bent.segments.find((candidate) => candidate.id === lot.entrance.segmentId)!;
      lot.entrance.point = geometry.projectOnPolyline(segment.points, lot.entrance.point).point;
    }
    const life = createLife({ city, layout: bent, pack });
    const checker = createPlanChecker({ city, layout: bent, pack });
    const plans = life.plansForDay(WORK_DAY);
    expect(plans.flatMap((plan) => checker.check(plan))).toEqual([]);
    const walked = (all: DayPlan[]) => all.flatMap(travelOf).reduce((sum, walk) => sum + walk.path.length, 0);
    expect(walked(plans)).toBeGreaterThan(walked(vereceldo.life.plansForDay(WORK_DAY)) * 0.98);
  });
});

describe('cost', () => {
  it('plans one day for all 9,607 residents of Badanos within a few times a fixed piece of work timed alongside it', { timeout: SLOW }, () => {
    const { city, layout } = badanos;
    let plans: DayPlan[] = [];
    // A limit in seconds fails on a slow or busy machine, so the work is measured in yardsticks: see cost.ts.
    const { seconds, yardsticks } = inYardsticks(() => (plans = createLife({ city, layout, pack }).plansForDay(WORK_DAY)));
    console.log(`Planned one day for Badanos's ${plans.length.toLocaleString('en-US')} residents in ${seconds.toFixed(2)} s, ${yardsticks.toFixed(1)} yardsticks`);
    expect(plans).toHaveLength(9607);
    expect(yardsticks).toBeLessThan(6);
  });

  it('plans one day for Pombal\'s 47,603 residents', { timeout: 60_000 }, () => {
    const { city, layout } = town('settlement-5');
    const started = performance.now();
    const life = createLife({ city, layout, pack });
    const plans = life.plansForDay(WORK_DAY);
    const first = (performance.now() - started) / 1000;
    const again = performance.now();
    life.plansForDay(WORK_DAY + 1);
    const next = (performance.now() - again) / 1000;
    console.log(`Planned one day for Pombal's ${plans.length.toLocaleString('en-US')} residents in ${first.toFixed(2)} s, and the next day in ${next.toFixed(2)} s`);
    expect(plans).toHaveLength(47603);
    const checker = createPlanChecker({ city, layout, pack });
    expect(plans.filter((_, index) => index % 50 === 0).flatMap((plan) => checker.check(plan))).toEqual([]);
  });
});
