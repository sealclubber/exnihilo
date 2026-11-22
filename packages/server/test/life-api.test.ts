import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DaySummary,
  type HouseholdNow,
  type OccupantsNow,
  type PackLabels,
  type PersonNow,
  type PersonPlan,
  type TripsWindow,
  DayPlanSchema,
  DaySummarySchema,
  OutsideStaySchema,
  TripSchema,
  WhereaboutsSchema,
  createLife,
  generateCity,
  generateLayout,
  importAfmg,
  parsePack,
  startOfDay,
} from '@worldsim/core';
import { LOMIA_PATH, loadLomia } from '../../core/test/fixture.ts';
import { MEDIEVAL_PATH, medievalPack, rawMedievalPack } from '../../core/test/pack.ts';
import { MAX_TRIP_WINDOW, buildApp } from '../src/app.ts';
import { WorldClock } from '../src/clock.ts';
import { describeSettlementDay } from '../src/day-command.ts';
import { importFile } from '../src/import-command.ts';
import { WorldStore } from '../src/storage.ts';

/** A limit for the tests that plan whole towns, with headroom for a slower machine. */
const SLOW = 60_000;

const pack = medievalPack();
const world = importAfmg(loadLomia());
const brief = world.world.settlements.find((entry) => entry.id === 'settlement-641')!;
const city = generateCity(brief, pack);
const layout = generateLayout(city, brief, pack);
const expected = createLife({ city, layout, pack, brief });
const LIFE = '/api/settlements/settlement-641/life';
const at = (day: number, hours: number, minutes = 0) => startOfDay(day) + hours * 3600 + minutes * 60;

let app: FastifyInstance;
let clock: WorldClock;
beforeAll(async () => {
  clock = new WorldClock({ now: () => 0, rates: pack.time.rates, defaultRate: pack.time.defaultRate });
  app = buildApp(world.world, world.report, pack, { clock });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
const get = async <T>(url: string): Promise<{ status: number; body: T }> => {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() as T };
};

describe('GET /api/pack', () => {
  it('serves the calendar and the names of visits, for showing game time and plans', async () => {
    const { body } = await get<PackLabels>('/api/pack');
    expect(body.calendar.week.map((day) => day.name)[6]).toBe('Restday');
    expect(body.calendar).toMatchObject({ sunrise: 6 * 3600, sunset: 19 * 3600 });
    expect(body.visits).toMatchObject({ market: 'Going to market', tavern: 'A drink after work', worship: 'Worship' });
  });

  it('serves the colour of each role, from the pack', async () => {
    const { body } = await get<PackLabels>('/api/pack');
    const residents = { ...pack.display.categories, 'keeping-house': pack.display.keepingHouse, 'not-working': pack.display.notWorking };
    // Since phase 6C: a colour for each kind of traveller, and one for vagrants, under keys no occupation can have.
    const outsiders = { ...Object.fromEntries(Object.entries(pack.display.travellers!).map(([kind, colour]) => [`traveller:${kind}`, colour])), vagrant: pack.display.vagrants };
    expect(body.roleColours).toEqual({ ...residents, ...outsiders });
    expect(body.roleColours.military).toBe('#c62828');
    expect(new Set(Object.values(residents)).size).toBe(9);
    expect(new Set(Object.values(body.roleColours)).size).toBe(9 + pack.travellers!.kinds.length + 1);
  });

  it('gives an occupation with a colour of its own a role of its own', async () => {
    const raw = rawMedievalPack();
    raw.display.occupations = { watchman: '#101010' };
    const own = parsePack(raw);
    const other = buildApp(world.world, world.report, own, { clock: new WorldClock({ now: () => 0, rates: own.time.rates, defaultRate: 1 }) });
    await other.ready();
    const labels = (await other.inject({ method: 'GET', url: '/api/pack' })).json() as PackLabels;
    expect(labels.roleColours.watchman).toBe('#101010');
    const window = (await other.inject({ method: 'GET', url: `${LIFE}/trips?from=${at(2, 5, 30)}&to=${at(2, 6, 30)}` })).json() as TripsWindow;
    const watch = window.trips.filter((trip) => trip.occupationId === 'watchman');
    expect(watch.length).toBeGreaterThan(10);
    expect(new Set(watch.map((trip) => trip.role))).toEqual(new Set(['watchman']));
    // A sergeant keeps the category's colour.
    expect(window.trips.find((trip) => trip.occupationId === 'watch-sergeant')?.role ?? 'military').toBe('military');
    await other.close();
  });
});

describe('trips in a window', () => {
  it('serves the trips that overlap a window of game time, to a tenth of a metre', { timeout: SLOW }, async () => {
    const from = at(2, 7, 30);
    const to = at(2, 7, 45);
    const { status, body } = await get<TripsWindow>(`${LIFE}/trips?from=${from}&to=${to}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ from, to });
    const trips = expected.trips(from, to);
    expect(body.trips).toHaveLength(trips.length);
    expect(body.trips.length).toBeGreaterThan(500);
    // Each trip is a trip, with who is making it: their name and the role that colours them.
    const people = new Map(city.people.map((person) => [person.id, person]));
    for (const { name, role, occupationId, apprentice, ...trip } of body.trips.slice(0, 200)) {
      expect(TripSchema.safeParse(trip).success).toBe(true);
      const person = people.get(trip.personId)!;
      expect(name).toBe(`${person.givenName} ${person.familyName}`);
      expect(occupationId).toBe(person.occupationId);
      expect(apprentice ?? false).toBe(person.apprentice ?? false);
      expect(role).toBe(person.occupationId ? pack.occupations.find((entry) => entry.id === person.occupationId)!.category : person.workforceState);
    }
    const soldiers = body.trips.filter((trip) => trip.occupationId !== undefined && pack.occupations.find((entry) => entry.id === trip.occupationId)?.category === 'military');
    expect(soldiers.length).toBeGreaterThan(0);
    expect(new Set(soldiers.map((trip) => trip.role))).toEqual(new Set(['military']));
    expect(body.trips.map((trip) => [trip.personId, trip.departAt, trip.arriveAt])).toEqual(trips.map((trip) => [trip.personId, trip.departAt, trip.arriveAt]));
    const sent = body.trips[0]!;
    const full = trips[0]!;
    sent.points.forEach(([x, y], index) => {
      expect(Math.abs(x - full.points[index]![0])).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(y - full.points[index]![1])).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Number.isInteger(Math.round(x * 10))).toBe(true);
    });
  });

  it('sends, alongside the trips, the stays out of doors that overlap the window', { timeout: SLOW }, async () => {
    const from = at(2, 12);
    const to = at(2, 12, 20);
    const { body } = await get<TripsWindow>(`${LIFE}/trips?from=${from}&to=${to}`);
    const stays = expected.outsideStays(from, to);
    expect(body.outside.length).toBeGreaterThan(900);
    expect(body.outside.map((stay) => [stay.personId, stay.buildingId, stay.from, stay.to])).toEqual(stays.map((stay) => [stay.personId, stay.buildingId, stay.from, stay.to]));
    for (const { name, role, occupationId: _occupation, apprentice: _apprentice, kindId: _kind, origin: _origin, ...stay } of body.outside.slice(0, 100)) {
      expect(OutsideStaySchema.safeParse(stay).success).toBe(true);
      expect(name.length).toBeGreaterThan(2);
      // A resident's role is a category or a workforce state; an outsider's is their kind (outsiders-api.test.ts).
      if (stay.outsider) expect(role).toMatch(/^traveller:|^vagrant$/);
      else expect(role in pack.display.categories || role === 'keeping-house' || role === 'not-working').toBe(true);
    }
    // The wander, not positions: the points and times of the window, to the nearest centimetre.
    const sent = body.outside[0]!;
    expect(sent.wander.times).toEqual(stays[0]!.wander.times);
    expect(sent.wander.times[0]).toBe(Math.max(from, sent.from));
    expect(sent.wander.times.at(-1)).toBe(Math.min(to, sent.to));
    expect(sent.wander.points).toEqual(stays[0]!.wander.points.map((point) => point.map((value) => Math.round(value * 100) / 100)));
    const atBuilding = body.outside.find((stay) => stay.buildingId !== undefined && stay.occupationId !== undefined && !stay.round && !stay.onStreet)!;
    expect(Object.keys(atBuilding).sort()).toEqual(['buildingId', 'from', 'kind', 'name', 'occupationId', 'personId', 'role', 'to', 'wander']);
    // Twenty minutes of someone's day is a handful of points, not their whole day.
    expect(Math.max(...body.outside.map((stay) => stay.wander.times.length))).toBeLessThan(40);
    // At night no resident is out but the watch, stopped at points on its beat: on a segment, at no building.
    // (Since phase 6C the vagrants are out too, asleep on the street.)
    const night = (await get<TripsWindow>(`${LIFE}/trips?from=${at(2, 2)}&to=${at(2, 2, 20)}`)).body.outside.filter((stay) => !stay.outsider);
    expect(night.length).toBeGreaterThan(0);
    expect(night.every((stay) => stay.occupationId === 'watchman' && stay.round === true && stay.buildingId === undefined && stay.segmentId !== undefined)).toBe(true);
    // A region limits the stays as it does the trips.
    const local = (await get<TripsWindow>(`${LIFE}/trips?from=${from}&to=${to}&minX=0&minY=0&maxX=120&maxY=120`)).body.outside;
    expect(local.length).toBe(expected.outsideStays(from, to, { minX: 0, minY: 0, maxX: 120, maxY: 120 }).length);
    expect(local.length).toBeGreaterThan(0);
    expect(local.length).toBeLessThan(body.outside.length);
  });

  it('can be limited to a region of the map', async () => {
    const from = at(2, 7, 30);
    const to = at(2, 7, 45);
    const all = (await get<TripsWindow>(`${LIFE}/trips?from=${from}&to=${to}`)).body.trips.length;
    const { body } = await get<TripsWindow>(`${LIFE}/trips?from=${from}&to=${to}&minX=0&minY=0&maxX=120&maxY=120`);
    expect(body.trips.length).toBe(expected.trips(from, to, { minX: 0, minY: 0, maxX: 120, maxY: 120 }).length);
    expect(body.trips.length).toBeGreaterThan(0);
    expect(body.trips.length).toBeLessThan(all);
  });

  it('refuses a window or a region that makes no sense', async () => {
    const cases: Array<[string, RegExp]> = [
      ['', /needs from and to/],
      ['?from=100', /needs from and to/],
      ['?from=200&to=100', /with to after from/],
      ['?from=soon&to=100', /from must be a number/],
      [`?from=0&to=${MAX_TRIP_WINDOW + 1}`, /at most 172800 game seconds/],
      ['?from=0&to=600&minX=0', /a region needs all of minX, minY, maxX and maxY/],
      ['?from=0&to=600&minX=a&minY=0&maxX=1&maxY=1', /minX must be a number/],
    ];
    for (const [query, message] of cases) {
      const { status, body } = await get<{ error: string }>(`${LIFE}/trips${query}`);
      expect(status, query).toBe(400);
      expect(body.error).toMatch(message);
    }
    expect((await get('/api/settlements/settlement-9999/life/trips?from=0&to=10')).status).toBe(404);
  });
});

describe('a person', () => {
  const worker = city.people.find((person) => person.occupationId === 'tanner')!;

  it('has a plan for a day, by default the clock\'s day', async () => {
    const { status, body } = await get<PersonPlan>(`${LIFE}/people/${worker.id}/plan?day=3`);
    expect(status).toBe(200);
    expect(body.person).toEqual(worker);
    expect(DayPlanSchema.parse(body.plan)).toEqual(JSON.parse(JSON.stringify(expected.plan(worker.id, 3))));
    expect(body.buildings[worker.workplaceId!]).toBe('tannery');
    expect(Object.keys(body.buildings).length).toBeGreaterThanOrEqual(2);
    clock.setTime(at(9, 14));
    expect((await get<PersonPlan>(`${LIFE}/people/${worker.id}/plan`)).body.plan.day).toBe(9);
    clock.setTime(0);
    expect((await get<{ error: string }>(`${LIFE}/people/${worker.id}/plan?day=2.5`)).body.error).toMatch(/day must be a whole number/);
  });

  it('is somewhere now, by the clock or at a time asked for', async () => {
    const noon = (await get<PersonNow>(`${LIFE}/people/${worker.id}/now?time=${at(2, 12)}`)).body;
    expect(noon.time).toBe(at(2, 12));
    expect(noon.person).toEqual(worker);
    expect(WhereaboutsSchema.parse(noon.whereabouts)).toEqual(JSON.parse(JSON.stringify(expected.whereabouts(worker.id, at(2, 12)))));
    expect(noon.whereabouts).toMatchObject({ kind: 'work', buildingId: worker.workplaceId });
    expect(noon.buildings).toEqual({ [worker.workplaceId!]: 'tannery' });
    clock.setTime(at(3, 3));
    const byClock = (await get<PersonNow>(`${LIFE}/people/${worker.id}/now`)).body;
    expect(byClock.time).toBe(at(3, 3));
    expect(byClock.whereabouts.kind).toBe('sleep');
    clock.setTime(0);
  });

  it('answers 404 for someone who does not exist', async () => {
    for (const path of ['now', 'plan']) {
      const { status, body } = await get<{ error: string }>(`${LIFE}/people/person-641-999999/${path}`);
      expect(status).toBe(404);
      expect(body.error).toMatch(/settlement-641: there is no person with the ID "person-641-999999"/);
    }
  });
});

describe('buildings and households', () => {
  it('says who is inside a building, with who they are', async () => {
    const tannery = city.buildings.find((building) => building.type === 'tannery')!;
    const { status, body } = await get<OccupantsNow>(`${LIFE}/buildings/${tannery.id}/occupants?time=${at(2, 12)}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ time: at(2, 12), buildingId: tannery.id });
    expect(body.occupants.map((occupant) => occupant.personId)).toEqual(expected.occupants(tannery.id, at(2, 12)).map((occupant) => occupant.personId));
    expect(body.occupants.length).toBeGreaterThan(0);
    for (const occupant of body.occupants) {
      expect(occupant.kind).toBe('work');
      expect(occupant.person.id).toBe(occupant.personId);
      // The tannery's own people, or someone stopped there on a round, such as a carter.
      if (occupant.person.workplaceId !== tannery.id) expect(expected.whereabouts(occupant.personId, at(2, 12))).toMatchObject({ round: true });
    }
    expect(body.occupants.some((occupant) => occupant.person.workplaceId === tannery.id)).toBe(true);
    expect((await get<OccupantsNow>(`${LIFE}/buildings/${tannery.id}/occupants?time=${at(2, 3)}`)).body.occupants).toEqual([]);
    expect((await get(`${LIFE}/buildings/building-641-999999/occupants`)).status).toBe(404);
  });

  it('says whether a building is open and its hours that day, and who is outside at it', async () => {
    const tavern = city.buildings.find((building) => building.type === 'tavern' && building.workerIds.every((id) => expected.shiftOf(id)!.id === 'evening'))!;
    const evening = (await get<OccupantsNow>(`${LIFE}/buildings/${tavern.id}/occupants?time=${at(2, 20)}`)).body;
    expect(evening.open).toBe(true);
    expect(evening.hours).toEqual([{ from: at(2, 15), to: at(2, 23) }]);
    const morning = (await get<OccupantsNow>(`${LIFE}/buildings/${tavern.id}/occupants?time=${at(2, 9)}`)).body;
    expect(morning.open).toBe(false);
    expect(morning.hours).toEqual(evening.hours);
    const stall = city.buildings.find((building) => building.type === 'market-stall')!;
    const noon = (await get<OccupantsNow>(`${LIFE}/buildings/${stall.id}/occupants?time=${at(2, 11)}`)).body;
    expect(noon.open).toBe(true);
    expect(noon.occupants.length).toBeGreaterThan(0);
    expect(noon.occupants.every((occupant) => occupant.outside === true)).toBe(true);
    const rest = (await get<OccupantsNow>(`${LIFE}/buildings/${stall.id}/occupants?time=${at(7, 11)}`)).body;
    expect(rest).toMatchObject({ open: false, hours: [] });
  });

  it('says what each member of a household is doing', async () => {
    const household = city.households.find((entry) => entry.memberIds.length >= 4)!;
    const { status, body } = await get<HouseholdNow>(`${LIFE}/households/${household.id}/now?time=${at(2, 12)}`);
    expect(status).toBe(200);
    expect(body.members.map((member) => member.personId)).toEqual(household.memberIds);
    for (const member of body.members) expect(member).toEqual(JSON.parse(JSON.stringify(expected.whereabouts(member.personId, at(2, 12)))));
    const asleep = (await get<HouseholdNow>(`${LIFE}/households/${household.id}/now?time=${at(2, 2)}`)).body;
    expect(new Set(asleep.members.map((member) => member.kind)).size).toBeLessThanOrEqual(2);
    expect((await get(`${LIFE}/households/household-641-999999/now`)).status).toBe(404);
  });
});

describe('a day\'s summary', () => {
  it('serves the hourly counts for a day', async () => {
    const { status, body } = await get<DaySummary>(`${LIFE}/summary?day=2`);
    expect(status).toBe(200);
    expect(DaySummarySchema.parse(body)).toEqual(expected.daySummary(2));
    expect(body.hours[12]!.atWork).toBeGreaterThan(3500);
    expect((await get<DaySummary>(`${LIFE}/summary`)).body.day).toBe(1);
  });
});

describe('the day command', () => {
  let folder: string;
  let storePath: string;
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'worldsim-day-'));
    storePath = join(folder, 'world.sqlite');
    importFile(LOMIA_PATH, storePath);
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it('prints a settlement\'s day: the hourly counts and the busiest segments', { timeout: SLOW }, () => {
    const text = describeSettlementDay({ settlementId: 'settlement-641', day: 2, storePath, packPath: MEDIEVAL_PATH });
    expect(text).toContain('Badanos, day 2: Tilsday');
    expect(text).toMatch(/Hour\s+Asleep\s+At home\s+At work\s+Visiting\s+Travelling\s+Outside\s+Trips begun/);
    // Twenty-four hours of the residents, and since phase 6C twenty-four of the outsiders, counted apart.
    expect(text.split('\n').filter((line) => /^\s+\d\d:00\s/.test(line))).toHaveLength(48);
    expect(text).toMatch(/Outsiders, who are not residents: \d+ travellers in town at some time of the day \([^)]*merchant[^)]*\), and 29 vagrants/);
    expect(text).toMatch(/Hour\s+In town\s+Asleep\s+At lodging\s+Visiting\s+Travelling\s+Outside/);
    expect(text).toMatch(/Busiest segments[^\n]*\n\s+segment-641-\d{6}\s+[\d,]+\s+bridge/);
    expect(text).toBe(describeSettlementDay({ settlementId: 'settlement-641', day: 2, storePath, packPath: MEDIEVAL_PATH }));
    expect(describeSettlementDay({ settlementId: 'settlement-641', day: 7, storePath, packPath: MEDIEVAL_PATH })).toContain('Restday, a rest day');
  });

  it('fails with a readable message for an unknown settlement', () => {
    expect(() => describeSettlementDay({ settlementId: 'badanos', day: 1, storePath, packPath: MEDIEVAL_PATH })).toThrow(/no settlement has the ID "badanos"/);
  });

  it('stores nothing: the world store is as it was', () => {
    const dump = () => {
      const store = new WorldStore(storePath);
      const text = store.dump();
      store.close();
      return text;
    };
    const before = dump();
    describeSettlementDay({ settlementId: 'settlement-455', day: 3, storePath, packPath: MEDIEVAL_PATH });
    expect(dump()).toBe(before);
  });
});
