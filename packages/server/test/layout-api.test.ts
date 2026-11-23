import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Layout, type LayoutPath, LayoutPathSchema, LayoutSchema, generateCity, generateLayout, importAfmg, shortestPath } from '@worldsim/core';
import { loadLomia } from '../../core/test/fixture.ts';
import { medievalPack } from '../../core/test/pack.ts';
import { buildApp } from '../src/app.ts';
import { CityCache } from '../src/cities.ts';

let app: FastifyInstance;
const world = importAfmg(loadLomia());
const brief = world.world.settlements.find((entry) => entry.id === 'settlement-641')!;
const expected = generateLayout(generateCity(brief, medievalPack()), brief, medievalPack());
const LAYOUT = '/api/settlements/settlement-641/layout';

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

describe('GET /api/settlements/:id/layout', () => {
  it('serves the settlement\'s layout', async () => {
    const { status, body } = await get<Layout>(LAYOUT);
    expect(status).toBe(200);
    expect(LayoutSchema.parse(body)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(body.lots).toHaveLength(1825);
    expect(body.summary.generator).toBe('grid');
  });

  it('serves the layout a named generator makes of the same town', async () => {
    const city = generateCity(brief, medievalPack());
    for (const generator of ['grid'] as const) {
      const { status, body } = await get<Layout>(`${LAYOUT}?generator=${generator}`);
      expect(status, generator).toBe(200);
      expect(body.summary.generator).toBe(generator);
      expect(LayoutSchema.parse(body)).toEqual(JSON.parse(JSON.stringify(generateLayout(city, brief, medievalPack(), { generator }))));
    }
    // The grid has no walls or open places, and asking for it changes nothing about the layout served without the query.
    const grid = (await get<Layout>(`${LAYOUT}?generator=grid`)).body;
    expect(grid.summary.counts).toMatchObject({ walls: 0, gates: 0, places: 0 });
    expect((await get<Layout>(LAYOUT)).body).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it('answers 400 for a generator it does not have, naming the parameter and the ones it has', async () => {
    for (const query of ['?generator=rings', '?generator=', '?generator=grid&generator=rings', '?generator=grown']) {
      const { status, body } = await get<{ error: string }>(`${LAYOUT}${query}`);
      expect(status, query).toBe(400);
      expect(body.error).toMatch(/^generator must be one of grid;/);
    }
    expect((await get<{ error: string }>('/api/settlements/settlement-9999/layout?generator=grid')).status).toBe(404);
  });

  it('answers 404 for a settlement that does not exist', async () => {
    const { status, body } = await get<{ error: string }>('/api/settlements/settlement-9999/layout');
    expect(status).toBe(404);
    expect(body.error).toContain('settlement-9999');
  });

  it('makes the layout once and keeps it with the city', () => {
    const cache = new CityCache(medievalPack());
    const view = cache.get(brief);
    expect(view.layout).toBe(view.layout);
    expect(cache.get(brief).layout).toBe(view.layout);
    // The city is as it was before the layout was made.
    expect(JSON.stringify(view.city)).toBe(JSON.stringify(generateCity(brief, medievalPack())));
  });
});

describe('GET /api/settlements/:id/layout/path', () => {
  const [from, to] = [expected.lots[3]!.id, expected.lots[1500]!.id];

  it('serves the shortest walking path between two lots', async () => {
    const { status, body } = await get<LayoutPath>(`${LAYOUT}/path?from=${from}&to=${to}`);
    expect(status).toBe(200);
    expect(LayoutPathSchema.parse(body)).toEqual(JSON.parse(JSON.stringify(shortestPath(expected, from, to))));
    expect(body.length).toBeGreaterThan(100);
    expect(body.segmentIds.length).toBeGreaterThan(2);
    expect(body.points[0]![0]).toBeCloseTo(expected.lots[3]!.entrance.point[0], 9);
    expect(body.points[0]![1]).toBeCloseTo(expected.lots[3]!.entrance.point[1], 9);
  });

  it('serves a path of zero length from a lot to itself', async () => {
    const { body } = await get<LayoutPath>(`${LAYOUT}/path?from=${from}&to=${from}`);
    expect(body.length).toBe(0);
  });

  it('asks for both lots', async () => {
    for (const query of ['', `?from=${from}`, `?to=${to}`, `?from=&to=${to}`]) {
      const { status, body } = await get<{ error: string }>(`${LAYOUT}/path${query}`);
      expect(status, query).toBe(400);
      expect(body.error).toMatch(/needs two lots/);
    }
  });

  it('answers 404 for a lot or a settlement that does not exist', async () => {
    const missing = await get<{ error: string }>(`${LAYOUT}/path?from=${from}&to=lot-641-999999`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/settlement-641: there is no lot with the ID "lot-641-999999"/);
    expect((await get(`/api/settlements/settlement-9999/layout/path?from=${from}&to=${to}`)).status).toBe(404);
  });
});
