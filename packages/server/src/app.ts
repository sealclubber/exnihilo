/**
 * The HTTP API. Read-only: the server owns the world and the browser views it.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  type ApiError,
  type ImportReport,
  type SettingPack,
  type SettlementBrief,
  type World,
  packLabels,
} from '@worldsim/core';
import { type CityFilters, type CityView, type PageRequest, CityCache, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './cities.ts';
import { mapGeometry, settlementList, worldSummary } from './views.ts';

type Query = Record<string, string | string[] | undefined>;

const FILTERS = ['district', 'occupation', 'category', 'household', 'workplace', 'status', 'kind', 'type', 'q'] as const;

function send(reply: FastifyReply, status: number, error: string) {
  const body: ApiError = { error };
  return reply.code(status).send(body);
}

/** Reads offset and limit from a query, or says what is wrong with them. */
function pageOf(query: Query): PageRequest | string {
  const read = (name: string, fallback: number, min: number, max: number): number | string => {
    const text = query[name];
    if (text === undefined) return fallback;
    const value = Number(text);
    if (typeof text !== 'string' || !/^\d+$/.test(text) || value < min || value > max) {
      return `${name} must be a whole number from ${min} to ${max}`;
    }
    return value;
  };
  const offset = read('offset', 0, 0, Number.MAX_SAFE_INTEGER);
  if (typeof offset === 'string') return offset;
  const limit = read('limit', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  if (typeof limit === 'string') return limit;
  return { offset, limit };
}

function filtersOf(query: Query): CityFilters {
  const filters: CityFilters = {};
  for (const name of FILTERS) {
    const value = query[name];
    if (typeof value === 'string' && value !== '') filters[name] = value;
  }
  return filters;
}

export function buildApp(world: World, report: ImportReport, pack: SettingPack): FastifyInstance {
  const app = Fastify();

  // The world does not change while the server runs, so each body is built once.
  const summary = JSON.stringify(worldSummary(world, report));
  const geometry = JSON.stringify(mapGeometry(world));
  const settlements = JSON.stringify(settlementList(world));
  const labels = JSON.stringify(packLabels(pack));
  const briefs = new Map<string, SettlementBrief>(world.settlements.map((brief) => [brief.id, brief]));
  const cities = new CityCache(pack);

  // The viewer is served from another origin, often another machine.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
  });

  const json = 'application/json; charset=utf-8';
  app.get('/api/world', (_request, reply) => reply.type(json).send(summary));
  app.get('/api/map', (_request, reply) => reply.type(json).send(geometry));
  app.get('/api/pack', (_request, reply) => reply.type(json).send(labels));
  app.get('/api/settlements', (_request, reply) => reply.type(json).send(settlements));
  app.get<{ Params: { id: string } }>('/api/settlements/:id', (request, reply) => {
    const brief = briefs.get(request.params.id);
    if (!brief) return send(reply, 404, `no settlement has the ID "${request.params.id}"`);
    return reply.send(brief);
  });

  // Cities are generated when first asked for. Each handler below receives the city already made.
  type CityRoute = { Params: { id: string; record?: string }; Querystring: Query };
  const city = (path: string, handle: (view: CityView, query: Query, record: string) => unknown | string) => {
    app.get<CityRoute>(`/api/settlements/:id/city${path}`, (request, reply) => {
      const brief = briefs.get(request.params.id);
      if (!brief) return send(reply, 404, `no settlement has the ID "${request.params.id}"`);
      const page = pageOf(request.query);
      if (typeof page === 'string') return send(reply, 400, page);
      const result = handle(cities.get(brief), request.query, request.params.record ?? '');
      if (result === undefined) return send(reply, 404, `${brief.id} has no record with the ID "${request.params.record}"`);
      return reply.send(result);
    });
  };
  city('', (view) => view.city.summary);
  city('/people', (view, query) => view.listPeople(filtersOf(query), pageOf(query) as PageRequest));
  city('/households', (view, query) => view.listHouseholds(filtersOf(query), pageOf(query) as PageRequest));
  city('/buildings', (view, query) => view.listBuildings(filtersOf(query), pageOf(query) as PageRequest));
  city('/districts', (view, query) => view.listDistricts(pageOf(query) as PageRequest));
  city('/households/:record', (view, _query, record) => view.household(record));
  city('/buildings/:record', (view, _query, record) => view.building(record));

  app.setNotFoundHandler((request, reply) => send(reply, 404, `nothing is served at ${request.method} ${request.url}`));

  return app;
}
