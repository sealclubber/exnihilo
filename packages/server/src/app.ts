/**
 * The HTTP API. Read-only: the server owns the world and the browser views it.
 */
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  type ApiError,
  type HouseholdNow,
  LayoutPathError,
  LifeError,
  type ImportReport,
  type OccupantsNow,
  type PersonNow,
  type PersonPlan,
  type Region,
  type TripsWindow,
  dayOf,
  type SettingPack,
  type SettlementBrief,
  type World,
  packLabels,
} from '@worldsim/core';
import { type CityFilters, type CityView, type PageRequest, CityCache, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './cities.ts';
import { ClockError, WorldClock } from './clock.ts';
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

export interface AppOptions {
  /** The world clock. Left out, a clock of its own is made that starts paused at day 1 and is not stored. */
  clock?: WorldClock;
}

/** The longest window of game time one request for trips may cover. */
export const MAX_TRIP_WINDOW = 2 * 86_400;

/** Reads a number from a query, or gives the fallback when it is absent. Returns a message when it is not a number. */
function numberOf(query: Query, name: string, fallback: number): number | string {
  const text = query[name];
  if (text === undefined || text === '') return fallback;
  const value = Number(text);
  return typeof text === 'string' && Number.isFinite(value) ? value : `${name} must be a number`;
}

export function buildApp(world: World, report: ImportReport, pack: SettingPack, options: AppOptions = {}): FastifyInstance {
  const app = Fastify();
  const clock = options.clock ?? new WorldClock({ now: () => Date.now(), rates: pack.time.rates, defaultRate: pack.time.defaultRate });

  // The world does not change while the server runs, so each body is built once.
  const summary = JSON.stringify(worldSummary(world, report));
  const geometry = JSON.stringify(mapGeometry(world));
  const settlements = JSON.stringify(settlementList(world));
  const labels = JSON.stringify(packLabels(pack));
  const briefs = new Map<string, SettlementBrief>(world.settlements.map((brief) => [brief.id, brief]));
  const cities = new CityCache(pack);

  // The viewer is served from another origin, often another machine. A browser asks leave
  // before it posts from one; the clock's controls are the only things that can be posted to.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    if (request.method === 'OPTIONS') {
      return reply.header('Access-Control-Allow-Methods', 'GET, POST').header('Access-Control-Allow-Headers', 'Content-Type').code(204).send();
    }
  });

  // ---- The clock ----------------------------------------------------------------------
  app.get('/api/clock', (_request, reply) => reply.send(clock.read()));
  const control = (path: string, change: (body: Record<string, unknown>) => unknown) => {
    app.post<{ Body: unknown }>(`/api/clock/${path}`, (request, reply) => {
      try {
        const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
        return reply.send(change(body));
      } catch (error) {
        if (error instanceof ClockError) return send(reply, 400, error.message);
        throw error;
      }
    });
  };
  control('run', () => clock.run());
  control('pause', () => clock.pause());
  control('rate', (body) => clock.setRate(typeof body.rate === 'number' ? body.rate : NaN));
  control('time', (body) => clock.setTime(typeof body.gameTime === 'number' ? body.gameTime : NaN));
  // Viewers hear of every change at once over a socket: the state on connecting, then each new state.
  void app.register(websocket);
  void app.register(async (scope) => {
    scope.get('/api/clock/stream', { websocket: true }, (socket) => {
      socket.send(JSON.stringify(clock.read()));
      const stop = clock.subscribe((state) => socket.send(JSON.stringify(state)));
      socket.on('close', stop);
    });
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

  // The town's layout, generated with the city and kept in memory beside it.
  app.get<{ Params: { id: string } }>('/api/settlements/:id/layout', (request, reply) => {
    const brief = briefs.get(request.params.id);
    if (!brief) return send(reply, 404, `no settlement has the ID "${request.params.id}"`);
    return reply.send(cities.get(brief).layout);
  });
  app.get<{ Params: { id: string }; Querystring: Query }>('/api/settlements/:id/layout/path', (request, reply) => {
    const brief = briefs.get(request.params.id);
    if (!brief) return send(reply, 404, `no settlement has the ID "${request.params.id}"`);
    const { from, to } = request.query;
    if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') {
      return send(reply, 400, 'a path needs two lots: from and to');
    }
    try {
      return reply.send(cities.get(brief).path(from, to));
    } catch (error) {
      if (error instanceof LayoutPathError) return send(reply, 404, `${brief.id}: ${error.message}`);
      throw error;
    }
  });

  // ---- Daily life ---------------------------------------------------------------------------
  // Plans and whereabouts are derived when asked for. A request may name a game time; left out, it is the clock's.
  type LifeRoute = { Params: { id: string; record?: string }; Querystring: Query };
  const life = (path: string, handle: (view: CityView, query: Query, record: string) => unknown) => {
    app.get<LifeRoute>(`/api/settlements/:id/life${path}`, (request, reply) => {
      const brief = briefs.get(request.params.id);
      if (!brief) return send(reply, 404, `no settlement has the ID "${request.params.id}"`);
      try {
        const result = handle(cities.get(brief), request.query, request.params.record ?? '');
        return typeof result === 'string' ? send(reply, 400, result) : reply.send(result);
      } catch (error) {
        if (error instanceof LifeError) return send(reply, 404, `${brief.id}: ${error.message}`);
        throw error;
      }
    });
  };
  const timeOf = (query: Query) => numberOf(query, 'time', clock.read().gameTime);
  const round = (value: number) => Math.round(value * 10) / 10;

  life('/trips', (view, query): TripsWindow | string => {
    const from = numberOf(query, 'from', NaN);
    const to = numberOf(query, 'to', NaN);
    if (typeof from === 'string' || typeof to === 'string') return typeof from === 'string' ? from : (to as string);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return 'a window of trips needs from and to, with to after from';
    if (to - from > MAX_TRIP_WINDOW) return `a window of trips may cover at most ${MAX_TRIP_WINDOW} game seconds`;
    const edges = ['minX', 'minY', 'maxX', 'maxY'].map((name) => numberOf(query, name, NaN));
    const bad = edges.find((edge) => typeof edge === 'string');
    if (bad !== undefined) return bad as string;
    const given = edges.filter((edge) => !Number.isNaN(edge)).length;
    if (given !== 0 && given !== 4) return 'a region needs all of minX, minY, maxX and maxY';
    const [minX, minY, maxX, maxY] = edges as number[];
    const region: Region | undefined = given === 4 ? { minX: minX as number, minY: minY as number, maxX: maxX as number, maxY: maxY as number } : undefined;
    // Coordinates are sent to the nearest tenth of a metre, which is plenty for a dot on a map.
    const trips = view.life.trips(from, to, region).map((trip) => ({ ...trip, length: round(trip.length), points: trip.points.map(([x, y]): [number, number] => [round(x), round(y)]) }));
    return { from, to, trips };
  });
  life('/summary', (view, query) => {
    const day = numberOf(query, 'day', dayOf(clock.read().gameTime));
    return typeof day === 'string' ? day : Number.isInteger(day) ? view.life.daySummary(day) : 'day must be a whole number';
  });
  life('/people/:record/plan', (view, query, record): PersonPlan | string => {
    const day = numberOf(query, 'day', dayOf(clock.read().gameTime));
    if (typeof day === 'string' || !Number.isInteger(day)) return 'day must be a whole number';
    const plan = view.life.plan(record, day);
    const named = plan.activities.flatMap((activity) => (activity.kind === 'travel' ? [activity.fromBuildingId, activity.toBuildingId] : [activity.buildingId]));
    return { person: view.person(record)!, plan, buildings: view.buildingTypes(named) };
  });
  life('/people/:record/now', (view, query, record): PersonNow | string => {
    const time = timeOf(query);
    if (typeof time === 'string') return time;
    const whereabouts = view.life.whereabouts(record, time);
    const named = whereabouts.kind === 'travel' ? [whereabouts.fromBuildingId, whereabouts.toBuildingId] : [whereabouts.buildingId];
    return { time, person: view.person(record)!, whereabouts, buildings: view.buildingTypes(named) };
  });
  life('/buildings/:record/occupants', (view, query, record): OccupantsNow | string => {
    const time = timeOf(query);
    if (typeof time === 'string') return time;
    const occupants = view.life.occupants(record, time).map((occupant) => ({ ...occupant, person: view.person(occupant.personId)! }));
    return { time, buildingId: record, occupants };
  });
  life('/households/:record/now', (view, query, record): HouseholdNow | string => {
    const time = timeOf(query);
    if (typeof time === 'string') return time;
    const household = view.householdRecord(record);
    if (!household) throw new LifeError(`there is no household with the ID "${record}"`);
    return { time, householdId: record, members: household.memberIds.map((id) => view.life.whereabouts(id, time)) };
  });

  app.setNotFoundHandler((request, reply) => send(reply, 404, `nothing is served at ${request.method} ${request.url}`));

  return app;
}
