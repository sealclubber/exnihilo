/**
 * The HTTP API. The server owns the world and the browser views it; the only
 * things a browser can change are the clock and the avatar.
 */
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  type ApiError,
  type AvatarPerception,
  type AvatarReport,
  type AvatarState,
  AvatarError,
  GRID_GENERATOR,
  STAGED_GENERATOR,
  generateLayout,
  leaveBuilding,
  perceive,
  spawnAvatar,
  stopAvatar,
  walkToBuilding,
  walkToPoint,
  type HouseholdNow,
  LayoutPathError,
  LifeError,
  type ImportReport,
  type OccupantsNow,
  type OutsiderDetail,
  type OutsidersToday,
  type PersonNow,
  type PersonPlan,
  type Region,
  type TripsWindow,
  dayOf,
  type SettingPack,
  type SettlementBrief,
  type SettlementDraw,
  type World,
  drawOf,
  expectedTravellers,
  packLabels,
} from '@worldsim/core';
import { type CityFilters, type CityView, type PageRequest, CityCache, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './cities.ts';
import { AvatarKeeper } from './avatar.ts';
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
  /** The avatar. Left out, there is none until one is spawned, and it is not stored. */
  avatar?: AvatarKeeper;
}

/** The layout generators a request may name. */
const LAYOUT_GENERATORS = [GRID_GENERATOR, STAGED_GENERATOR] as const;

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

  // ---- The avatar ---------------------------------------------------------------------
  // The avatar is never stepped: the server keeps its state and the viewer is sent that state,
  // a resting place or a trip, and works out the position itself as it does for residents.
  const avatar = options.avatar ?? new AvatarKeeper();
  const reportAvatar = (): AvatarReport => ({ avatar: avatar.read() ?? null });
  const NO_AVATAR = 'there is no avatar yet: spawn one first, with POST /api/avatar/spawn';
  app.get('/api/avatar', (_request, reply) => reply.send(reportAvatar()));
  const pointOf = (value: unknown): [number, number] | undefined =>
    Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'number' && Number.isFinite(part)) ? [value[0] as number, value[1] as number] : undefined;
  /** An action on the avatar: given what was posted and the game time, the new state, or a message saying what was wrong with the request. */
  const act = (path: string, change: (body: Record<string, unknown>, time: number) => AvatarState | string) => {
    app.post<{ Body: unknown }>(`/api/avatar/${path}`, (request, reply) => {
      try {
        const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
        const result = change(body, clock.read().gameTime);
        if (typeof result === 'string') return send(reply, 400, result);
        avatar.set(result);
        return reply.send(reportAvatar());
      } catch (error) {
        // An action that makes no sense as things stand is refused, with the reason.
        if (error instanceof AvatarError) return send(reply, 409, error.message);
        throw error;
      }
    });
  };
  /** An action that needs an avatar to act on, and the town it is in. */
  const actOn = (path: string, change: (state: AvatarState, view: CityView, body: Record<string, unknown>, time: number) => AvatarState | string) => {
    act(path, (body, time) => {
      const state = avatar.read();
      if (!state) throw new AvatarError(NO_AVATAR);
      return change(state, cities.get(briefs.get(state.settlementId) as SettlementBrief), body, time);
    });
  };
  act('spawn', (body) => {
    const brief = typeof body.settlementId === 'string' ? briefs.get(body.settlementId) : undefined;
    if (!brief) return `spawning needs a settlementId that exists; "${String(body.settlementId)}" does not`;
    const point = pointOf(body.point);
    if (!point) return 'spawning needs a point: [x, y] in metres on the town map';
    return spawnAvatar(cities.get(brief).avatarTown, point);
  });
  actOn('walk-to-point', (state, view, body, time) => {
    const point = pointOf(body.point);
    if (!point) return 'walking to a street point needs a point: [x, y] in metres on the town map';
    return walkToPoint(state, view.avatarTown, point, time, pack.avatar.walkingSpeed);
  });
  actOn('walk-to-building', (state, view, body, time) => {
    if (typeof body.buildingId !== 'string') return 'walking to a building needs a buildingId';
    return walkToBuilding(state, view.avatarTown, body.buildingId, time, pack.avatar.walkingSpeed);
  });
  actOn('stop', (state, _view, _body, time) => stopAvatar(state, time));
  actOn('leave', (state, view, _body, time) => leaveBuilding(state, view.avatarTown, time));
  app.get<{ Querystring: Query }>('/api/avatar/perception', (request, reply) => {
    const state = avatar.read();
    if (!state) return send(reply, 409, NO_AVATAR);
    const time = numberOf(request.query, 'time', clock.read().gameTime);
    if (typeof time === 'string') return send(reply, 400, time);
    const view = cities.get(briefs.get(state.settlementId) as SettlementBrief);
    const seen = perceive(state, view.life, pack.avatar.perceptionRadius, time);
    const { settlementId } = state;
    const body: AvatarPerception =
      seen.where === 'building'
        ? {
            where: 'building',
            time,
            settlementId,
            buildingId: seen.buildingId,
            buildingType: view.buildingTypes([seen.buildingId])[seen.buildingId] as string,
            occupants: seen.occupants.map((occupant) => ({ ...occupant, person: view.anyone(occupant.personId)! })),
          }
        : {
            where: 'street',
            time,
            settlementId,
            point: seen.point,
            radius: seen.radius,
            nearby: seen.nearby.map((entry) => ({ ...entry, person: view.anyone(entry.personId)! })),
            buildings: view.buildingTypes(seen.nearby.flatMap((entry) => (entry.kind === 'walking' ? [entry.fromBuildingId, entry.toBuildingId] : [entry.buildingId]))),
          };
    return reply.send(body);
  });
  // Viewers hear of avatar changes the way they hear of clock changes.
  void app.register(async (scope) => {
    scope.get('/api/avatar/stream', { websocket: true }, (socket) => {
      socket.send(JSON.stringify(reportAvatar()));
      const stop = avatar.subscribe(() => socket.send(JSON.stringify(reportAvatar())));
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

  // Why visitors come here: the draw with its terms, worked out from the brief and the pack.
  app.get<{ Params: { id: string } }>('/api/settlements/:id/draw', (request, reply) => {
    const brief = briefs.get(request.params.id);
    if (!brief) return send(reply, 404, `no settlement has the ID "${request.params.id}"`);
    const quarter = pack.districts.kinds.find((kind) => kind.whenDraw !== undefined);
    const draw = drawOf(brief, pack);
    const body: SettlementDraw = {
      draw,
      expectedTravellers: expectedTravellers(brief, pack),
      ...(quarter?.whenDraw !== undefined && { quarterAt: quarter.whenDraw }),
      hasQuarter: quarter?.whenDraw !== undefined && draw.total >= quarter.whenDraw,
    };
    return reply.send(body);
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
  city('/building-types', (view) => view.allBuildingTypes);
  city('/households/:record', (view, _query, record) => view.household(record));
  city('/buildings/:record', (view, _query, record) => view.building(record));

  // The town's layout, generated with the city and kept in memory beside it.
  // Asked for by generator, it is that generator's layout of the same town, made for the asking and not kept:
  // a way to compare the two. Residents walk the pack's layout whatever is asked for here.
  app.get<{ Params: { id: string }; Querystring: Query }>('/api/settlements/:id/layout', (request, reply) => {
    const brief = briefs.get(request.params.id);
    if (!brief) return send(reply, 404, `no settlement has the ID "${request.params.id}"`);
    const { generator } = request.query;
    if (generator === undefined) return reply.send(cities.get(brief).layout);
    const wanted = LAYOUT_GENERATORS.find((name) => name === generator);
    if (wanted === undefined) return send(reply, 400, `generator must be one of ${LAYOUT_GENERATORS.join(', ')}; "${String(generator)}" is not`);
    const view = cities.get(brief);
    // A layout made for comparing is sent unchecked: the staged generator does not yet keep every rule about
    // district ground in every town, and the town is worth seeing all the same. Nobody walks it.
    return reply.send(view.layout.summary.generator === wanted ? view.layout : generateLayout(view.city, brief, pack, { generator: wanted, check: false }));
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
    // Each comes with the person's name and the role that colours them, so the viewer need not ask who anyone is.
    const trips = view.life.trips(from, to, region).map((trip) => ({ ...trip, ...view.seen(trip.personId), length: round(trip.length), points: trip.points.map(([x, y]): [number, number] => [round(x), round(y)]) }));
    // The wander, not positions: whoever is out of doors in the window, and the points and times of their moving about
    // in it. Points are sent to the nearest centimetre, so that someone beside a wall is not shown inside it.
    const exact = (value: number) => Math.round(value * 100) / 100;
    const outside = view.life.outsideStays(from, to, region).map((stay) => ({
      ...stay,
      ...view.seen(stay.personId),
      wander: { times: stay.wander.times, points: stay.wander.points.map(([x, y]): [number, number] => [exact(x), exact(y)]) },
    }));
    return { from, to, trips, outside };
  });
  life('/summary', (view, query) => {
    const day = numberOf(query, 'day', dayOf(clock.read().gameTime));
    return typeof day === 'string' ? day : Number.isInteger(day) ? view.life.daySummary(day) : 'day must be a whole number';
  });
  life('/people/:record/plan', (view, query, record): PersonPlan | string => {
    const day = numberOf(query, 'day', dayOf(clock.read().gameTime));
    if (typeof day === 'string' || !Number.isInteger(day)) return 'day must be a whole number';
    const plan = view.life.plan(record, day);
    const named = plan.activities.flatMap((activity) => (activity.kind === 'travel' ? [activity.fromBuildingId, activity.toBuildingId] : activity.kind === 'street' ? [] : [activity.buildingId]));
    return { person: view.anyone(record)!, plan, buildings: view.buildingTypes(named) };
  });
  life('/people/:record/now', (view, query, record): PersonNow | string => {
    const time = timeOf(query);
    if (typeof time === 'string') return time;
    const whereabouts = view.life.whereabouts(record, time);
    const named = whereabouts.kind === 'travel' ? [whereabouts.fromBuildingId, whereabouts.toBuildingId] : whereabouts.kind === 'street' || whereabouts.kind === 'away' ? [] : [whereabouts.buildingId];
    return { time, person: view.anyone(record)!, whereabouts, buildings: view.buildingTypes(named) };
  });
  life('/buildings/:record/occupants', (view, query, record): OccupantsNow | string => {
    const time = timeOf(query);
    if (typeof time === 'string') return time;
    const occupants = view.life.occupants(record, time).map((occupant) => ({ ...occupant, person: view.anyone(occupant.personId)! }));
    return { time, buildingId: record, open: view.life.isOpen(record, time), hours: view.life.openingHours(record, dayOf(time)), occupants, guests: view.guestsOf(record, dayOf(time)) };
  });
  // Outsiders: who is in town on a day, and one of them at a moment.
  life('/outsiders', (view, query): OutsidersToday | string => {
    const day = numberOf(query, 'day', dayOf(clock.read().gameTime));
    return typeof day === 'string' || !Number.isInteger(day) ? 'day must be a whole number' : view.outsidersOn(day);
  });
  life('/outsiders/:record', (view, query, record): OutsiderDetail | string => {
    const time = timeOf(query);
    if (typeof time === 'string') return time;
    const detail = view.outsiderDetail(record, time);
    if (!detail) throw new LifeError(`there is no outsider with the ID "${record}"`);
    return detail;
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
