import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Building,
  type BuildingDetail,
  type BuildingTypes,
  type CitySummary,
  type District,
  type HouseholdDetail,
  type HouseholdListItem,
  type PackLabels,
  type Page,
  type Person,
  BuildingSchema,
  CitySummarySchema,
  DistrictSchema,
  PersonSchema,
  generateCity,
  importAfmg,
} from '@worldsim/core';
import { loadLomia } from '../../core/test/fixture.ts';
import { medievalPack } from '../../core/test/pack.ts';
import { buildApp } from '../src/app.ts';
import { CityCache } from '../src/cities.ts';

let app: FastifyInstance;
const CITY = '/api/settlements/settlement-641/city';
const world = importAfmg(loadLomia());
const badanos = generateCity(world.world.settlements.find((brief) => brief.id === 'settlement-641')!, medievalPack());

beforeAll(async () => {
  app = buildApp(world.world, world.report, medievalPack());
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
  it('serves display names for the pack\'s IDs', async () => {
    const { status, body } = await get<PackLabels>('/api/pack');
    expect(status).toBe(200);
    expect(body.name).toBe('medieval');
    expect(body.categories.map((category) => category.id)).toHaveLength(7);
    expect(body.occupations.tanner).toEqual({ name: 'Tanner', category: 'trade' });
    expect(body.occupations.runesmith).toEqual({ name: 'Runesmith', category: 'luxury' });
    expect(body.buildingTypes).toMatchObject({ tannery: 'Tannery', tenement: 'Tenement', citadel: 'Citadel' });
    expect(body.buildingTypes['great-house']).toBeUndefined();
    expect(body.apprenticeLabel).toBe('Apprentice {occupation}');
    expect(body.districtKinds.centre).toBe('Centre');
    expect(body.statusTiers[0]).toEqual({ id: 'poor', name: 'Poor' });
  });
});

describe('GET /api/settlements/:id/city', () => {
  it('serves the summary of the generated city', async () => {
    const { status, body } = await get<CitySummary>(CITY);
    expect(status).toBe(200);
    expect(CitySummarySchema.parse(body)).toEqual(badanos.summary);
    expect(body.population).toBe(9607);
  });

  it('answers 404 for a settlement that does not exist', async () => {
    for (const path of ['', '/people', '/households/household-641-000001']) {
      const { status, body } = await get<{ error: string }>(`/api/settlements/settlement-9999/city${path}`);
      expect(status).toBe(404);
      expect(body.error).toContain('settlement-9999');
    }
  });
});

describe('GET /api/settlements/:id/city/building-types', () => {
  it('serves the type of every building by ID, for naming lots on the map', async () => {
    const { status, body } = await get<BuildingTypes>(`${CITY}/building-types`);
    expect(status).toBe(200);
    expect(Object.keys(body)).toHaveLength(1825);
    expect(body['building-641-000001']!.type).toMatch(/^[a-z-]+$/);
    expect(new Set(Object.values(body).map((building) => building.type)).has('tannery')).toBe(true);
    // And what kind of building each is, so that a home that is also a workplace can be named and marked as both.
    expect(new Set(Object.values(body).map((building) => building.kind))).toEqual(new Set(['dwelling', 'workplace', 'both', 'landmark']));
    expect(Object.values(body).filter((building) => building.kind === 'both').length).toBeGreaterThan(500);
  });
});

describe('paged records', () => {
  it('serves people fifty at a time by default, in ID order', async () => {
    const { status, body } = await get<Page<Person>>(`${CITY}/people`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 9607, offset: 0, limit: 50 });
    expect(body.items).toEqual(badanos.people.slice(0, 50));
    for (const person of body.items) expect(PersonSchema.safeParse(person).success).toBe(true);
  });

  it('serves the page asked for', async () => {
    const { body } = await get<Page<Person>>(`${CITY}/people?offset=9600&limit=20`);
    expect(body).toMatchObject({ total: 9607, offset: 9600, limit: 20 });
    expect(body.items.map((person) => person.id)).toEqual(badanos.people.slice(9600).map((person) => person.id));
    expect((await get<Page<Person>>(`${CITY}/people?offset=20000`)).body.items).toEqual([]);
  });

  it('pages every person exactly once', async () => {
    const seen = new Set<string>();
    for (let offset = 0; offset < 9607; offset += 500) {
      const { body } = await get<Page<Person>>(`${CITY}/people?offset=${offset}&limit=500`);
      for (const person of body.items) seen.add(person.id);
    }
    expect(seen.size).toBe(9607);
  });

  it('rejects a page request that makes no sense', async () => {
    for (const query of ['limit=0', 'limit=501', 'limit=ten', 'offset=-1', 'offset=1.5']) {
      const { status, body } = await get<{ error: string }>(`${CITY}/people?${query}`);
      expect(status, query).toBe(400);
      expect(body.error).toMatch(/must be a whole number/);
    }
  });

  it('serves households, buildings and districts', async () => {
    const households = (await get<Page<HouseholdListItem>>(`${CITY}/households?limit=5`)).body;
    expect(households.total).toBe(badanos.households.length);
    expect(households.items[0]).toMatchObject({ ...badanos.households[0], size: badanos.households[0]!.memberIds.length });
    expect(households.items[0]!.member).toEqual({
      id: badanos.people[0]!.id,
      name: `${badanos.people[0]!.givenName} ${badanos.people[0]!.familyName}`,
      role: 'head',
      occupationId: badanos.people[0]!.occupationId,
    });
    expect(households.items[0]!.districtId).toMatch(/^district-641-/);

    const buildings = (await get<Page<Building>>(`${CITY}/buildings?limit=3`)).body;
    expect(buildings.total).toBe(badanos.buildings.length);
    expect(buildings.items).toEqual(badanos.buildings.slice(0, 3));
    expect(BuildingSchema.safeParse(buildings.items[0]).success).toBe(true);

    const districts = (await get<Page<District>>(`${CITY}/districts`)).body;
    expect(districts.total).toBe(badanos.districts.length);
    expect(districts.items).toEqual(badanos.districts);
    expect(DistrictSchema.safeParse(districts.items[0]).success).toBe(true);
  });
});

describe('filters', () => {
  const district = badanos.districts[2]!;
  const inDistrict = new Set(district.buildingIds);

  it('filters people by occupation and by category', async () => {
    const tanners = (await get<Page<Person>>(`${CITY}/people?occupation=tanner&limit=500`)).body;
    expect(tanners.total).toBe(badanos.summary.occupations.tanner);
    expect(tanners.items.every((person) => person.occupationId === 'tanner')).toBe(true);
    const military = (await get<Page<Person>>(`${CITY}/people?category=military&limit=1`)).body;
    expect(military.total).toBe(badanos.summary.categories.military);
    expect((await get<Page<Person>>(`${CITY}/people?occupation=tanner&category=food`)).body.total).toBe(0);
  });

  it('filters people by district, household, workplace and name', async () => {
    const residents = (await get<Page<Person>>(`${CITY}/people?district=${district.id}&limit=1`)).body;
    expect(residents.total).toBe(badanos.summary.districtTotals[district.id]!.residents);

    const household = badanos.households[10]!;
    const members = (await get<Page<Person>>(`${CITY}/people?household=${household.id}`)).body;
    expect(members.items.map((person) => person.id)).toEqual(household.memberIds);

    const workplace = badanos.buildings.find((building) => building.workerIds.length > 2)!;
    const staff = (await get<Page<Person>>(`${CITY}/people?workplace=${workplace.id}`)).body;
    expect(staff.items.map((person) => person.id)).toEqual(workplace.workerIds);

    const someone = badanos.people[1234]!;
    const found = (await get<Page<Person>>(`${CITY}/people?q=${encodeURIComponent(`${someone.givenName} ${someone.familyName}`.toUpperCase())}`)).body;
    expect(found.items.map((person) => person.id)).toContain(someone.id);
  });

  it('filters households by district, status, occupation and name', async () => {
    const local = (await get<Page<HouseholdListItem>>(`${CITY}/households?district=${district.id}&limit=500`)).body;
    expect(local.total).toBe(badanos.summary.districtTotals[district.id]!.households);
    expect(local.items.every((household) => inDistrict.has(household.dwellingId) && household.districtId === district.id)).toBe(true);

    const wealthy = (await get<Page<HouseholdListItem>>(`${CITY}/households?status=wealthy`)).body;
    expect(wealthy.total).toBe(badanos.summary.statusTiers.wealthy!.households);

    const armourers = (await get<Page<HouseholdListItem>>(`${CITY}/households?occupation=armourer&limit=500`)).body;
    const expected = new Set(badanos.people.filter((person) => person.occupationId === 'armourer').map((person) => person.householdId));
    expect(new Set(armourers.items.map((household) => household.id))).toEqual(expected);

    // Under an occupation or category filter, each row shows the member who matched, not the head.
    const people = new Map(badanos.people.map((person) => [person.id, person]));
    expect(armourers.items.every((household) => household.member.occupationId === 'armourer')).toBe(true);
    expect(armourers.items.some((household) => household.member.role !== 'head')).toBe(true);
    const military = (await get<Page<HouseholdListItem>>(`${CITY}/households?category=military&limit=500`)).body;
    expect(military.total).toBeGreaterThan(100);
    for (const household of military.items) {
      expect(household.memberIds).toContain(household.member.id);
      expect(['watchman', 'watch-sergeant', 'gaoler', 'soldier', 'officer']).toContain(household.member.occupationId);
      expect(household.member.name).toBe(`${people.get(household.member.id)!.givenName} ${people.get(household.member.id)!.familyName}`);
    }
    // Without such a filter the row shows the head.
    expect(wealthy.items.every((household) => household.member.id === household.headId)).toBe(true);
    const apprentice = (await get<Page<HouseholdListItem>>(`${CITY}/households?occupation=tanner&limit=500`)).body.items.find((household) => household.member.apprentice);
    expect(people.get(apprentice!.member.id)!.apprentice).toBe(true);

    const family = badanos.households[77]!.familyName;
    const named = (await get<Page<HouseholdListItem>>(`${CITY}/households?q=${encodeURIComponent(family.toLowerCase())}&limit=500`)).body;
    expect(named.items.map((household) => household.id)).toContain(badanos.households[77]!.id);
    expect(named.total).toBeLessThan(badanos.households.length / 10);
  });

  it('filters buildings by district, kind, type, occupation and category', async () => {
    const local = (await get<Page<Building>>(`${CITY}/buildings?district=${district.id}&limit=1`)).body;
    expect(local.total).toBe(district.buildingIds.length);
    const landmarks = (await get<Page<Building>>(`${CITY}/buildings?kind=landmark&limit=100`)).body;
    // The one landmark a flag gives Badanos, the civic buildings of a town its size, and since phase 6C two inns and a gaming house.
    expect(new Set(landmarks.items.map((building) => building.type))).toEqual(new Set(['province-hall', 'well', 'public-oven', 'bathhouse', 'granary', 'infirmary', 'town-hall', 'guild-hall', 'adventurers-guild', 'inn', 'gaming-house']));
    expect(landmarks.total).toBe(55);
    const tanneries = (await get<Page<Building>>(`${CITY}/buildings?type=tannery&limit=500`)).body;
    expect(tanneries.total).toBe(badanos.buildings.filter((building) => building.type === 'tannery').length);
    const withTanners = (await get<Page<Building>>(`${CITY}/buildings?occupation=tanner&limit=500`)).body;
    expect(withTanners.items.every((building) => building.type === 'tannery')).toBe(true);
    const military = (await get<Page<Building>>(`${CITY}/buildings?category=military&limit=500`)).body;
    expect(new Set(military.items.map((building) => building.type))).toEqual(new Set(['watch-house', 'barracks']));
  });
});

describe('single records', () => {
  it('serves a household with its members and its home', async () => {
    const household = badanos.households[10]!;
    const { status, body } = await get<HouseholdDetail>(`${CITY}/households/${household.id}`);
    expect(status).toBe(200);
    expect(body.household).toEqual(household);
    expect(body.members.map((person) => person.id)).toEqual(household.memberIds);
    expect(body.dwelling.id).toBe(household.dwellingId);
    expect(body.dwelling.householdIds).toContain(household.id);
    expect(body.district).toEqual({
      id: body.dwelling.districtId,
      name: expect.any(String),
      kind: expect.any(String),
    });
  });

  it('says where each member works, and which household employs a servant', async () => {
    const servant = badanos.people.find((person) => person.occupationId === 'servant')!;
    const employer = badanos.households.find((household) => household.id === servant.employerHouseholdId)!;
    const { body } = await get<HouseholdDetail>(`${CITY}/households/${servant.householdId}`);
    expect(body.workplaces[servant.workplaceId!]).toEqual({
      type: badanos.buildings.find((building) => building.id === employer.dwellingId)!.type,
      employer: { householdId: employer.id, familyName: employer.familyName },
    });
    const working = body.members.filter((person) => person.workplaceId);
    expect(Object.keys(body.workplaces).sort()).toEqual([...new Set(working.map((person) => person.workplaceId!))].sort());
    const tanner = badanos.people.find((person) => person.occupationId === 'tanner')!;
    const other = (await get<HouseholdDetail>(`${CITY}/households/${tanner.householdId}`)).body;
    expect(other.workplaces[tanner.workplaceId!]).toEqual({ type: 'tannery' });
  });

  it('lists the people who work in an employer household\'s home', async () => {
    const servants = badanos.people.filter((person) => person.occupationId === 'servant');
    const employerId = servants[0]!.employerHouseholdId!;
    const { body } = await get<HouseholdDetail>(`${CITY}/households/${employerId}`);
    expect(body.staff.map((person) => person.id)).toEqual(servants.filter((person) => person.employerHouseholdId === employerId).map((person) => person.id));
    expect(body.staff.every((person) => person.workplaceId === body.dwelling.id)).toBe(true);
    expect(body.dwelling.kind).toBe('both');
    const nobody = badanos.households.find((household) => !servants.some((person) => person.employerHouseholdId === household.id))!;
    expect((await get<HouseholdDetail>(`${CITY}/households/${nobody.id}`)).body.staff).toEqual([]);
  });

  it('serves a workplace with the people who work there', async () => {
    const workplace = badanos.buildings.find((building) => building.kind === 'both' && building.type === 'bakery')!;
    const { status, body } = await get<BuildingDetail>(`${CITY}/buildings/${workplace.id}`);
    expect(status).toBe(200);
    expect(body.building).toEqual(workplace);
    expect(body.workers.map((person) => person.id)).toEqual(workplace.workerIds);
    expect(body.workers.every((person) => person.workplaceId === workplace.id)).toBe(true);
    expect(body.households.map((household) => household.id)).toEqual(workplace.householdIds);
  });

  it('answers 404 for a record that does not exist', async () => {
    for (const path of ['/households/household-641-999999', '/buildings/nonsense']) {
      const { status, body } = await get<{ error: string }>(`${CITY}${path}`);
      expect(status).toBe(404);
      expect(body.error).toMatch(/settlement-641 has no record/);
    }
  });
});

describe('the city cache', () => {
  it('generates a city once and keeps only the most recently used few', () => {
    const cache = new CityCache(medievalPack());
    const villages = world.world.settlements.filter((brief) => brief.sizeGroup === 'village').slice(0, 9);
    const first = cache.get(villages[0]!);
    expect(cache.get(villages[0]!)).toBe(first);
    for (const brief of villages.slice(1, 6)) cache.get(brief);
    cache.get(villages[0]!); // used again, so the next additions push out others first
    for (const brief of villages.slice(6)) cache.get(brief);
    expect(cache.size).toBe(6);
    expect(cache.get(villages[0]!)).toBe(first);
    expect(cache.get(villages[1]!).city).toEqual(generateCity(villages[1]!, medievalPack()));
  });

  it('writes nothing generated into the world', () => {
    expect(Object.keys(world.world)).toEqual(['info', 'cells', 'states', 'provinces', 'cultures', 'religions', 'rivers', 'routes', 'settlements']);
  });
});
