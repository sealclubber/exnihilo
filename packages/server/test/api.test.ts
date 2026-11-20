import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type MapGeometry,
  type SettlementListItem,
  type WorldSummary,
  SettlementBriefSchema,
  importAfmg,
} from '@worldsim/core';
import { loadLomia } from '../../core/test/fixture.ts';
import { medievalPack } from '../../core/test/pack.ts';
import { buildApp } from '../src/app.ts';
import { WorldStore } from '../src/storage.ts';

let app: FastifyInstance;

beforeAll(async () => {
  // Serve what comes back out of storage, as the real server does.
  const imported = importAfmg(loadLomia());
  const store = new WorldStore(':memory:');
  store.save(imported.world, imported.report);
  app = buildApp(store.loadWorld(), store.loadReport(), medievalPack());
  store.close();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const get = async <T>(url: string): Promise<{ status: number; body: T; headers: Record<string, unknown> }> => {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() as T, headers: response.headers };
};

describe('GET /api/world', () => {
  it('serves the world summary', async () => {
    const { status, body } = await get<WorldSummary>('/api/world');
    expect(status).toBe(200);
    expect(body.info.name).toBe('Lomia');
    expect(body.info.currentYear).toBe(848);
    expect(body.info.eraName).toBe('Thatcking Era');
    expect(body.counts).toMatchObject({ settlements: 682, cells: 4605, states: 24, provinces: 168 });
  });

  it('can be read from a page served by another machine', async () => {
    const { headers } = await get('/api/world');
    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers['content-type']).toContain('application/json');
  });
});

describe('GET /api/map', () => {
  let map: MapGeometry;
  beforeAll(async () => {
    map = (await get<MapGeometry>('/api/map')).body;
  });

  it('serves the map size and every drawable thing', () => {
    expect([map.width, map.height]).toEqual([1920, 1002]);
    expect(map.cells).toHaveLength(4605);
    expect(map.states).toHaveLength(24);
    expect(map.rivers).toHaveLength(156);
    expect(map.routes).toHaveLength(606);
    expect(map.settlements).toHaveLength(682);
  });

  it('gives each cell a polygon, land or water, and a state that is listed', () => {
    const states = new Set(map.states.map((state) => state.id));
    for (const cell of map.cells) {
      expect(cell.polygon.length).toBeGreaterThanOrEqual(3);
      expect(states.has(cell.stateId)).toBe(true);
    }
    expect(map.cells.filter((cell) => cell.isLand)).toHaveLength(3276);
    expect(map.states.find((state) => state.id === 'state-4')).toEqual({
      id: 'state-4',
      name: 'Monzia',
      colour: '#e78ac3',
      isPlaceholder: false,
    });
  });

  it('draws a river through the centres of its cells', () => {
    const hegyes = map.rivers.find((river) => river.id === 'river-85')!;
    expect(hegyes.name).toBe('Hegyes');
    expect(hegyes.points).toHaveLength(7);
    expect(hegyes.points[2]).toEqual([931.71, 423.13]);
  });

  it('gives each route its kind and points', () => {
    const trail = map.routes.find((route) => route.id === 'route-34')!;
    expect(trail.kind).toBe('trail');
    expect(trail.points[0]).toEqual([921.02, 433.03]);
  });
});

describe('GET /api/settlements', () => {
  it('lists every settlement in ID order', async () => {
    const { status, body } = await get<SettlementListItem[]>('/api/settlements');
    expect(status).toBe(200);
    expect(body).toHaveLength(682);
    expect(body[0]!.id).toBe('settlement-1');
    expect(body.at(-1)!.id).toBe('settlement-682');
    expect(body.find((item) => item.id === 'settlement-641')).toEqual({
      id: 'settlement-641',
      name: 'Badanos',
      position: [931.35, 422.9],
      sizeGroup: 'city',
      isCapital: false,
      population: 9607,
      stateId: 'state-4',
    });
  });
});

describe('GET /api/settlements/:id', () => {
  it('serves the Badanos brief', async () => {
    const { status, body } = await get<unknown>('/api/settlements/settlement-641');
    expect(status).toBe(200);
    const brief = SettlementBriefSchema.parse(body);
    expect(brief.name).toBe('Badanos');
    expect(brief.population).toBe(9607);
    expect(brief.river?.name).toBe('Hegyes');
    expect(brief.routes).toHaveLength(2);
  });

  it('serves a valid brief for every listed settlement', async () => {
    const { body: list } = await get<SettlementListItem[]>('/api/settlements');
    for (const item of list) {
      const { status, body } = await get<unknown>(`/api/settlements/${item.id}`);
      expect(status).toBe(200);
      expect(SettlementBriefSchema.safeParse(body).success, item.id).toBe(true);
    }
  });

  it('answers 404 with a message for an ID that does not exist', async () => {
    for (const id of ['settlement-0', 'settlement-99999', 'badanos', 'state-4']) {
      const { status, body } = await get<{ error: string }>(`/api/settlements/${id}`);
      expect(status).toBe(404);
      expect(body.error).toContain(id);
    }
  });
});

describe('anything else', () => {
  it('answers 404 as JSON', async () => {
    const { status, body } = await get<{ error: string }>('/api/economy');
    expect(status).toBe(404);
    expect(body.error).toContain('/api/economy');
  });

  it('offers no way to change the world', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/api/settlements/settlement-641', payload: {} });
      expect(response.statusCode).toBe(404);
    }
  });
});
