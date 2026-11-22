/**
 * Phase 6C in the API: outsiders in every answer, who is in town on a day, one outsider at a moment, an inn's
 * guests, and a settlement's draw.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AvatarPerception,
  type DaySummary,
  type OccupantsNow,
  type OutsiderDetail,
  type OutsidersToday,
  type PackLabels,
  type PersonNow,
  type PersonPlan,
  type SettlementBrief,
  type SettlementDraw,
  type TripsWindow,
  DayPlanSchema,
  OutsiderSchema,
  PartySchema,
  WhereaboutsSchema,
  createLife,
  drawOf,
  generateCity,
  generateLayout,
  importAfmg,
  isOutsiderId,
  startOfDay,
} from '@worldsim/core';
import { loadLomia } from '../../core/test/fixture.ts';
import { medievalPack } from '../../core/test/pack.ts';
import { buildApp } from '../src/app.ts';
import { WorldClock } from '../src/clock.ts';

const SLOW = 120_000;
const pack = medievalPack();
const world = importAfmg(loadLomia());
const brief = world.world.settlements.find((entry) => entry.id === 'settlement-641')!;
const city = generateCity(brief, pack);
const layout = generateLayout(city, brief, pack);
const expected = createLife({ city, layout, pack, brief });
const outsiders = expected.outsiders!;
const BADANOS = '/api/settlements/settlement-641';
const LIFE = `${BADANOS}/life`;
const DAY = 9;
const at = (hours: number, minutes = 0) => startOfDay(DAY) + hours * 3600 + minutes * 60;

let app: FastifyInstance;
beforeAll(async () => {
  const clock = new WorldClock({ now: () => 0, rates: pack.time.rates, defaultRate: pack.time.defaultRate });
  clock.setTime(at(14));
  app = buildApp(world.world, world.report, pack, { clock });
  await app.ready();
}, SLOW);
afterAll(async () => {
  await app.close();
});
const get = async <T>(url: string): Promise<{ status: number; body: T }> => {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() as T };
};
const post = async <T>(url: string, payload: unknown): Promise<{ status: number; body: T }> => {
  const response = await app.inject({ method: 'POST', url, payload: payload as object });
  return { status: response.statusCode, body: response.json() as T };
};

describe('the settlement', () => {
  it('says in its brief where each route leads', async () => {
    const { body } = await get<SettlementBrief>(BADANOS);
    expect(body.routes.map((exit) => [exit.bearing, exit.leadsTo?.name])).toEqual([[61, 'Veszfetaros'], [227, 'Pusztaszi']]);
  });

  it('serves its draw with the breakdown, the travellers expected, and whether it has a visitors\' quarter', async () => {
    const { status, body } = await get<SettlementDraw>(`${BADANOS}/draw`);
    expect(status).toBe(200);
    expect(body.draw).toEqual(drawOf(brief, pack));
    expect(body.draw.terms.map((term) => term.term)).toEqual(['provinceSeat', 'population', 'specialties']);
    expect(body).toMatchObject({ quarterAt: 22, hasQuarter: false });
    expect(body.expectedTravellers).toBeGreaterThan(10);
    const pombal = (await get<SettlementDraw>('/api/settlements/settlement-5/draw')).body;
    expect(pombal.hasQuarter).toBe(true);
    expect(pombal.draw.total).toBeGreaterThan(body.draw.total);
    expect((await get('/api/settlements/settlement-99999/draw')).status).toBe(404);
  });

  it('names the kinds of traveller and their visits in the pack\'s labels', async () => {
    const { body } = await get<PackLabels>('/api/pack');
    expect(body.travellerKinds).toEqual({ merchant: 'Merchant', tourist: 'Tourist', adventurer: 'Adventurer', mercenary: 'Mercenary', 'passing-through': 'Passing through' });
    expect(body.vagrantName).toBe('Vagrant');
    expect(body.visits).toMatchObject({ trading: 'Doing business', wandering: 'Wandering the streets', tavern: 'A drink after work' });
    expect(body.roleColours['traveller:merchant']).toBe(pack.display.travellers!.merchant);
    expect(body.roleColours.vagrant).toBe(pack.display.vagrants);
    expect(body.buildingTypes.inn).toBe('Inn');
    expect(body.districtKinds.visitors).toBe('Visitors\' quarter');
  });
});

describe('who is in town', () => {
  it('lists the day\'s travellers and vagrants, with counts by kind', { timeout: SLOW }, async () => {
    const { status, body } = await get<OutsidersToday>(`${LIFE}/outsiders?day=${DAY}`);
    expect(status).toBe(200);
    const inTown = outsiders.inTown(DAY);
    expect([...body.travellers, ...body.vagrants]).toEqual(inTown);
    expect(body.vagrants).toHaveLength(29);
    expect(Object.values(body.byKind).reduce((sum, count) => sum + count, 0)).toBe(body.travellers.length);
    for (const outsider of inTown) expect(OutsiderSchema.safeParse(outsider).success).toBe(true);
    // Where they lodge is named.
    for (const traveller of body.travellers) if (traveller.lodgingId) expect(['inn', 'adventurers-guild']).toContain(body.buildings[traveller.lodgingId]);
    // By default, the clock's day.
    expect((await get<OutsidersToday>(`${LIFE}/outsiders`)).body.day).toBe(DAY);
    expect((await get(`${LIFE}/outsiders?day=soon`)).status).toBe(400);
  });

  it('reports them in the day\'s summary, apart from the residents', async () => {
    const { body } = await get<DaySummary>(`${LIFE}/summary?day=${DAY}`);
    expect(body.outsiders).toMatchObject({ vagrants: 29, travellers: outsiders.inTown(DAY).length - 29 });
    expect(body).toEqual(expected.daySummary(DAY));
  });
});

describe('an outsider', () => {
  const traveller = () => outsiders.inTown(DAY).find((outsider) => outsider.group === 'traveller' && outsider.lodgingId !== undefined && outsider.arrival.time < at(12) && outsider.departure.time > at(16))!;

  it('has a detail: who they are, their party, where they are and today\'s plan', async () => {
    const who = traveller();
    if (who.group !== 'traveller') throw new Error('expected a traveller');
    const { status, body } = await get<OutsiderDetail>(`${LIFE}/outsiders/${who.id}`);
    expect(status).toBe(200);
    expect(body.outsider).toEqual(who);
    expect(PartySchema.safeParse(body.party).success).toBe(true);
    expect(body.companions!.map((companion) => companion.id)).toEqual(body.party!.memberIds);
    expect(body.companions).toContainEqual(who);
    expect(body.time).toBe(at(14));
    expect(body.whereabouts).toEqual(expected.whereabouts(who.id, at(14)));
    expect(body.plan).toEqual(expected.plan(who.id, DAY));
    expect(DayPlanSchema.safeParse(body.plan).success).toBe(true);
    expect(body.buildings[who.lodgingId!]).toMatch(/inn|adventurers-guild/);
    // At a time when they are not in town, they are away, with no plan.
    const before = (await get<OutsiderDetail>(`${LIFE}/outsiders/${who.id}?time=${who.arrival.time - 3 * 86_400}`)).body;
    expect(before.whereabouts).toMatchObject({ kind: 'away', outsider: true });
    expect(before.plan.activities).toEqual([]);
    expect(before.outsider).toEqual(who);
  });

  it('is a vagrant with no party, on the street at night', async () => {
    const vagrant = outsiders.vagrants()[3]!;
    const { body } = await get<OutsiderDetail>(`${LIFE}/outsiders/${vagrant.id}?time=${at(3)}`);
    expect(body.outsider).toEqual(vagrant);
    expect(body.party).toBeUndefined();
    expect(body.whereabouts).toMatchObject({ kind: 'street', purpose: 'sleep', outsider: true });
    expect(WhereaboutsSchema.safeParse(body.whereabouts).success).toBe(true);
  });

  it('answers the questions asked of a person, by ID', async () => {
    const who = traveller();
    const now = (await get<PersonNow>(`${LIFE}/people/${who.id}/now`)).body;
    expect(now.person).toEqual(who);
    expect(now.whereabouts).toEqual(expected.whereabouts(who.id, at(14)));
    const plan = (await get<PersonPlan>(`${LIFE}/people/${who.id}/plan?day=${DAY}`)).body;
    expect(plan.person).toEqual(who);
    expect(plan.plan).toMatchObject({ outsider: true, personId: who.id });
  });

  it('answers 404 for an ID nobody has', async () => {
    expect((await get(`${LIFE}/outsiders/traveller-641-000009-merchant-999-01`)).status).toBe(404);
    expect((await get(`${LIFE}/outsiders/vagrant-641-009999`)).status).toBe(404);
    expect((await get(`${LIFE}/outsiders/person-641-000001`)).status).toBe(404);
    expect((await get(`${LIFE}/people/traveller-641-000009-merchant-999-01/now`)).status).toBe(404);
  });
});

describe('outsiders in what the viewer is sent', () => {
  it('are among the trips and the stays out of doors, each with a name, a colour of their kind and where they came from', async () => {
    const { body } = await get<TripsWindow>(`${LIFE}/trips?from=${at(14)}&to=${at(15)}`);
    const walking = body.trips.filter((trip) => trip.outsider);
    expect(walking.length).toBeGreaterThan(5);
    for (const trip of walking) {
      expect(isOutsiderId(trip.personId)).toBe(true);
      expect(trip.role).toMatch(/^traveller:|^vagrant$/);
      expect(trip.name).toMatch(/\S \S/);
      if (trip.role !== 'vagrant') {
        expect(Object.keys(pack.display.travellers!)).toContain(trip.kindId);
        expect(['Pusztaszi', 'Veszfetaros']).toContain(trip.origin);
      }
    }
    // Residents are as they were: a role of their own, and no kind or origin.
    const residents = body.trips.filter((trip) => !trip.outsider);
    expect(residents.length).toBeGreaterThan(100);
    for (const trip of residents.slice(0, 50)) {
      expect(trip.role).not.toMatch(/traveller|vagrant/);
      expect(trip.kindId).toBeUndefined();
    }
    const night = (await get<TripsWindow>(`${LIFE}/trips?from=${at(3)}&to=${at(3) + 60}`)).body;
    expect(night.outside.filter((stay) => stay.outsider && stay.role === 'vagrant' && stay.kind === 'sleep')).toHaveLength(29);
  });

  it('are an inn\'s guests, and among its occupants when they are in', async () => {
    const inn = city.buildings.find((building) => building.type === 'inn')!;
    const { body } = await get<OccupantsNow>(`${LIFE}/buildings/${inn.id}/occupants?time=${at(3)}`);
    const guests = outsiders.inTown(DAY).filter((outsider) => outsider.group === 'traveller' && outsider.lodgingId === inn.id);
    expect(body.guests).toEqual(guests);
    expect(body.guests.length).toBeGreaterThan(5);
    expect(body.open).toBe(true);
    const asleep = body.occupants.filter((occupant) => occupant.outsider);
    expect(asleep.length).toBeGreaterThan(3);
    for (const occupant of asleep) {
      expect(occupant.kind).toBe('sleep');
      expect(occupant.person).toMatchObject({ group: 'traveller' });
      expect(body.guests.map((guest) => guest.id)).toContain(occupant.personId);
    }
    // A building nobody lodges at has no guests.
    const tannery = city.buildings.find((building) => building.type === 'tannery')!;
    expect((await get<OccupantsNow>(`${LIFE}/buildings/${tannery.id}/occupants`)).body.guests).toEqual([]);
  });

  it('are perceived by the avatar as residents are, with who they are', async () => {
    const vagrant = outsiders.vagrants()[0]!;
    const asleep = expected.whereabouts(vagrant.id, at(3));
    if (asleep.kind !== 'street') throw new Error('expected the vagrant on a street');
    expect((await post('/api/avatar/spawn', { settlementId: 'settlement-641', point: asleep.point })).status).toBe(200);
    const { body } = await get<AvatarPerception>(`/api/avatar/perception?time=${at(3)}`);
    expect(body.where).toBe('street');
    if (body.where !== 'street') return;
    const seen = body.nearby.find((entry) => entry.personId === vagrant.id)!;
    expect(seen).toMatchObject({ outsider: true, kind: 'outside', activity: 'sleep' });
    expect(seen.person).toEqual(vagrant);
  });
});
