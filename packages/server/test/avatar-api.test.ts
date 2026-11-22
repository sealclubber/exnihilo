/**
 * The avatar in the server: storage, the endpoints for each action, what it
 * perceives, and the notices sent to viewers.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AvatarPerception,
  type AvatarReport,
  type AvatarState,
  AvatarStateSchema,
  arrivalTime,
  avatarPosition,
  createLife,
  generateCity,
  generateLayout,
  geometry,
  importAfmg,
  startOfDay,
} from '@worldsim/core';
import { LOMIA_PATH, loadLomia } from '../../core/test/fixture.ts';
import { medievalPack } from '../../core/test/pack.ts';
import { buildApp } from '../src/app.ts';
import { AvatarKeeper } from '../src/avatar.ts';
import { WorldClock } from '../src/clock.ts';
import { importFile } from '../src/import-command.ts';
import { WorldStore } from '../src/storage.ts';

/** A limit for the tests that plan a whole town, with headroom for a slower machine. */
const SLOW = 60_000;

const pack = medievalPack();
const world = importAfmg(loadLomia());
const brief = world.world.settlements.find((entry) => entry.id === 'settlement-641')!;
const city = generateCity(brief, pack);
const layout = generateLayout(city, brief, pack);
// With the brief, as the server makes it: the outsiders in town are to be seen with the residents.
const expected = createLife({ city, layout, pack, brief });
const at = (day: number, hours: number, minutes = 0) => startOfDay(day) + hours * 3600 + minutes * 60;
const T0 = at(1, 7, 45);

/** A server with a clock driven by hand, paused at 07:45 on day 1, and an avatar that remembers what was saved. */
async function server(stored?: unknown) {
  const saved: AvatarState[] = [];
  const clock = new WorldClock({ now: () => 0, rates: pack.time.rates, defaultRate: pack.time.defaultRate, stored: { gameTime: T0, rate: 1 } });
  const avatar = new AvatarKeeper({ stored, save: (state) => saved.push(state) });
  const app = buildApp(world.world, world.report, pack, { clock, avatar });
  await app.ready();
  const get = async <T>(url: string) => {
    const response = await app.inject({ method: 'GET', url });
    return { status: response.statusCode, body: response.json() as T };
  };
  const post = async <T = AvatarReport>(path: string, payload: unknown = {}) => {
    const response = await app.inject({ method: 'POST', url: `/api/avatar/${path}`, payload: payload as object });
    return { status: response.statusCode, body: response.json() as T };
  };
  return { app, clock, avatar, saved, get, post };
}

let main: Awaited<ReturnType<typeof server>>;
const apps: FastifyInstance[] = [];
beforeAll(async () => {
  main = await server();
  apps.push(main.app);
}, SLOW);
afterAll(async () => {
  for (const app of apps) await app.close();
});

describe('a world with no avatar', () => {
  it('reports none, and refuses everything but a spawn, politely', async () => {
    const { get, post, app } = await server();
    apps.push(app);
    expect(await get<AvatarReport>('/api/avatar')).toEqual({ status: 200, body: { avatar: null } });
    for (const [path, payload] of [['walk-to-point', { point: [0, 0] }], ['walk-to-building', { buildingId: city.buildings[0]!.id }], ['stop', {}], ['leave', {}]] as const) {
      const { status, body } = await post<{ error: string }>(path, payload);
      expect(status, path).toBe(409);
      expect(body.error, path).toMatch(/there is no avatar yet: spawn one first/);
    }
    const seen = await get<{ error: string }>('/api/avatar/perception');
    expect(seen.status).toBe(409);
    expect(seen.body.error).toMatch(/there is no avatar yet/);
    expect((await get<AvatarReport>('/api/avatar')).body.avatar).toBeNull();
  });

  it('refuses a spawn that names no town or no point', async () => {
    const { post, app } = await server();
    apps.push(app);
    expect((await post<{ error: string }>('spawn', { settlementId: 'settlement-9999', point: [0, 0] })).body.error).toMatch(/needs a settlementId that exists; "settlement-9999" does not/);
    expect((await post<{ error: string }>('spawn', { settlementId: 'settlement-641' })).body.error).toMatch(/needs a point: \[x, y\]/);
    expect((await post('spawn', { settlementId: 'settlement-641', point: ['a', 2] })).status).toBe(400);
  });
});

describe('the avatar\'s actions', () => {
  it('spawns on the nearest street, and reports the state it is in', async () => {
    const { status, body } = await main.post('spawn', { settlementId: 'settlement-641', point: [-300, 100] });
    expect(status).toBe(200);
    expect(AvatarStateSchema.safeParse(body.avatar).success).toBe(true);
    expect(body.avatar).toMatchObject({ kind: 'standing', settlementId: 'settlement-641' });
    const state = body.avatar as Extract<AvatarState, { kind: 'standing' }>;
    const segment = layout.segments.find((entry) => entry.id === state.segmentId)!;
    expect(geometry.distanceToPolyline(state.point, segment.points)).toBeLessThan(1e-9);
    expect((await main.get<AvatarReport>('/api/avatar')).body).toEqual(body);
    expect(main.saved.at(-1)).toEqual(body.avatar);
  });

  it('sends a walk as a trip: the path, the departure, the speed and the destination, and no positions', async () => {
    const { body } = await main.post('walk-to-point', { point: [250, -150] });
    const walk = body.avatar as Extract<AvatarState, { kind: 'walking' }>;
    expect(walk).toMatchObject({ kind: 'walking', departAt: T0, speed: pack.avatar.walkingSpeed, destination: { kind: 'street' } });
    expect(Object.keys(walk).sort()).toEqual(['departAt', 'destination', 'kind', 'path', 'settlementId', 'speed']);
    expect(walk.path.length).toBeGreaterThan(300);
    // As the clock moves on, the same state gives the position; nothing more is sent or stored.
    const saves = main.saved.length;
    main.clock.setTime(T0 + 100);
    const later = (await main.get<AvatarReport>('/api/avatar')).body.avatar!;
    expect(later).toEqual(walk);
    expect(main.saved).toHaveLength(saves);
    const position = avatarPosition(later, main.clock.read().gameTime);
    expect(position).toMatchObject({ kind: 'street', walking: true });
    expect(geometry.projectOnPolyline(walk.path.points, (position as { point: [number, number] }).point).along).toBeCloseTo(100 * pack.avatar.walkingSpeed, 6);
  });

  it('stops where it is, turns mid-walk without a jump, enters a building and leaves it', async () => {
    const walking = (await main.get<AvatarReport>('/api/avatar')).body.avatar!;
    const here = avatarPosition(walking, T0 + 100) as { point: [number, number]; segmentId: string };
    const stopped = (await main.post('stop')).body.avatar!;
    expect(stopped).toEqual({ kind: 'standing', settlementId: 'settlement-641', segmentId: here.segmentId, point: here.point });
    expect((await main.post<{ error: string }>('stop')).body.error).toMatch(/standing still already/);

    const building = city.buildings.find((entry) => entry.type === 'market-stall')!;
    const toBuilding = (await main.post('walk-to-building', { buildingId: building.id })).body.avatar as Extract<AvatarState, { kind: 'walking' }>;
    expect(toBuilding.destination).toEqual({ kind: 'building', buildingId: building.id });
    expect(geometry.distance(toBuilding.path.points[0]!, here.point)).toBeLessThan(1e-6);
    main.clock.setTime(T0 + 130);
    const turned = (await main.post('walk-to-point', { point: [0, 0] })).body.avatar as Extract<AvatarState, { kind: 'walking' }>;
    expect(geometry.distance(turned.path.points[0]!, (avatarPosition(toBuilding, T0 + 130) as { point: [number, number] }).point)).toBeLessThan(1e-6);

    const again = (await main.post('walk-to-building', { buildingId: building.id })).body.avatar as Extract<AvatarState, { kind: 'walking' }>;
    main.clock.setTime(arrivalTime(again) + 1);
    expect(avatarPosition((await main.get<AvatarReport>('/api/avatar')).body.avatar!, main.clock.read().gameTime)).toEqual({ kind: 'building', buildingId: building.id });
    expect((await main.post<{ error: string }>('walk-to-building', { buildingId: building.id })).body.error).toMatch(/already in building-641-\d+/);
    const left = (await main.post('leave')).body.avatar!;
    const lot = layout.lots.find((entry) => entry.buildingId === building.id)!;
    expect(left).toMatchObject({ kind: 'standing', settlementId: 'settlement-641', segmentId: lot.entrance.segmentId });
    expect(geometry.distance((left as { point: [number, number] }).point, lot.entrance.point)).toBeLessThan(1e-6);
  });

  it('refuses what makes no sense with 409 and the reason, and a malformed request with 400', async () => {
    const leave = await main.post<{ error: string }>('leave');
    expect(leave.status).toBe(409);
    expect(leave.body.error).toMatch(/on a street, not in a building, so there is nothing to leave/);
    const unknown = await main.post<{ error: string }>('walk-to-building', { buildingId: 'building-641-999999' });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error).toMatch(/has no building with the ID "building-641-999999"/);
    expect((await main.post('walk-to-point', {})).status).toBe(400);
    expect((await main.post('walk-to-building', {})).status).toBe(400);
    // Nothing refused changes the avatar.
    expect((await main.get<AvatarReport>('/api/avatar')).body.avatar).toMatchObject({ kind: 'standing' });
  });

  it('moves to another town only by a fresh spawn', async () => {
    const { post, app } = await server();
    apps.push(app);
    await post('spawn', { settlementId: 'settlement-641', point: [0, 0] });
    const moved = (await post('spawn', { settlementId: 'settlement-455', point: [0, 0] })).body.avatar!;
    expect(moved).toMatchObject({ kind: 'standing', settlementId: 'settlement-455' });
    expect((await post<{ error: string }>('walk-to-building', { buildingId: city.buildings[0]!.id })).body.error).toMatch(/settlement-455 has no building/);
  });
});

describe('what the avatar perceives', () => {
  it('is, on a street, the residents walking or outside within the pack\'s radius, with who they are', { timeout: SLOW }, async () => {
    const { get, post, clock, app } = await server();
    apps.push(app);
    clock.setTime(at(1, 7, 50));
    const state = (await post('spawn', { settlementId: 'settlement-641', point: [0, 0] })).body.avatar as Extract<AvatarState, { kind: 'standing' }>;
    let seenSomeone = false;
    for (const time of [at(1, 7, 50), at(1, 12, 30), at(1, 3)]) {
      clock.setTime(time);
      const { status, body } = await get<AvatarPerception>('/api/avatar/perception');
      expect(status).toBe(200);
      if (body.where !== 'street') throw new Error('not on a street');
      expect(body).toMatchObject({ time, settlementId: 'settlement-641', point: state.point, radius: pack.avatar.perceptionRadius });
      const nearby = expected.nearby(state.point, pack.avatar.perceptionRadius, time);
      expect(body.nearby.map(({ person: _person, ...entry }) => entry)).toEqual(nearby);
      for (const entry of body.nearby) {
        expect(entry.person.id).toBe(entry.personId);
        const named = entry.kind === 'walking' ? [entry.fromBuildingId, entry.toBuildingId] : [entry.buildingId];
        for (const id of named.filter((entry): entry is string => entry !== undefined)) expect(body.buildings[id]).toBe(city.buildings.find((building) => building.id === id)!.type);
      }
      if (body.nearby.length > 0) seenSomeone = true;
    }
    expect(seenSomeone).toBe(true);
    // A time can be asked about without moving the clock.
    const asked = (await get<AvatarPerception>(`/api/avatar/perception?time=${at(1, 12, 30)}`)).body;
    expect(asked.time).toBe(at(1, 12, 30));
  });

  it('is, in a building, exactly that building\'s occupants', { timeout: SLOW }, async () => {
    const { get, post, clock, app } = await server();
    apps.push(app);
    // A stall with people at it at that hour: which one depends on where the stalls stand.
    const stall = city.buildings.filter((entry) => entry.type === 'market-stall').find((entry) => expected.occupants(entry.id, at(1, 11)).length > 0)!;
    await post('spawn', { settlementId: 'settlement-641', point: [0, 0] });
    const walk = (await post('walk-to-building', { buildingId: stall.id })).body.avatar as Extract<AvatarState, { kind: 'walking' }>;
    expect(arrivalTime(walk)).toBeLessThan(at(1, 11));
    clock.setTime(at(1, 11));
    const { body } = await get<AvatarPerception>('/api/avatar/perception');
    if (body.where !== 'building') throw new Error('not in a building');
    expect(body).toMatchObject({ buildingId: stall.id, buildingType: 'market-stall', settlementId: 'settlement-641' });
    expect(body.occupants.map(({ person: _person, ...occupant }) => occupant)).toEqual(expected.occupants(stall.id, at(1, 11)));
    expect(body.occupants.length).toBeGreaterThan(0);
    expect(body.occupants.every((occupant) => occupant.person.id === occupant.personId)).toBe(true);
  });
});

describe('notices to viewers', () => {
  it('sends the avatar on connecting, and again after every change', async () => {
    const { app, post } = await server();
    apps.push(app);
    const heard: AvatarReport[] = [];
    let waiting: (() => void) | undefined;
    const socket = await app.injectWS('/api/avatar/stream', {}, {
      onInit(ws) {
        ws.on('message', (data: Buffer) => {
          heard.push(JSON.parse(data.toString()) as AvatarReport);
          waiting?.();
        });
      },
    });
    const next = () => new Promise<void>((resolve) => (waiting = resolve));
    if (heard.length === 0) await next();
    expect(heard[0]).toEqual({ avatar: null });
    let wait = next();
    const spawned = (await post('spawn', { settlementId: 'settlement-641', point: [0, 0] })).body;
    await wait;
    expect(heard[1]).toEqual(spawned);
    wait = next();
    const walking = (await post('walk-to-point', { point: [200, 200] })).body;
    await wait;
    expect(heard[2]).toEqual(walking);
    expect(heard[2]!.avatar).toMatchObject({ kind: 'walking' });
    // A refused action changes nothing and sends nothing.
    await post('leave');
    wait = next();
    await post('stop');
    await wait;
    expect(heard).toHaveLength(4);
    socket.terminate();
  });
});

describe('storage', () => {
  let folder: string;
  let storePath: string;
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'worldsim-avatar-'));
    storePath = join(folder, 'world.sqlite');
    importFile(LOMIA_PATH, storePath);
  }, SLOW);
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it('keeps the avatar\'s state across a restart, written whenever it changes', async () => {
    const run = async (work: (post: (path: string, payload?: unknown) => Promise<AvatarReport>, report: () => Promise<AvatarReport>) => Promise<void>) => {
      const store = new WorldStore(storePath);
      const clock = new WorldClock({ now: () => 0, rates: pack.time.rates, defaultRate: 1, stored: { gameTime: T0, rate: 1 } });
      const avatar = new AvatarKeeper({ stored: store.loadAvatar(), save: (state) => store.saveAvatar(state) });
      const app = buildApp(store.loadWorld(), store.loadReport(), pack, { clock, avatar });
      await app.ready();
      await work(
        async (path, payload = {}) => (await app.inject({ method: 'POST', url: `/api/avatar/${path}`, payload: payload as object })).json() as AvatarReport,
        async () => (await app.inject({ method: 'GET', url: '/api/avatar' })).json() as AvatarReport,
      );
      await app.close();
      store.close();
    };
    let walking: AvatarReport | undefined;
    await run(async (post, report) => {
      expect(await report()).toEqual({ avatar: null });
      await post('spawn', { settlementId: 'settlement-641', point: [-300, 100] });
      walking = await post('walk-to-point', { point: [250, -150] });
      expect(walking.avatar).toMatchObject({ kind: 'walking' });
    });
    // A new server on the same store: the same walk, so the same position at every game time.
    await run(async (post, report) => {
      expect(await report()).toEqual(walking);
      await post('stop');
    });
    await run(async (_post, report) => expect((await report()).avatar).toMatchObject({ kind: 'standing' }));
    // The world itself is as it was imported.
    const store = new WorldStore(storePath);
    expect(store.loadWorld().settlements).toHaveLength(682);
    store.close();
  });

  it('ignores a stored avatar that is not a sound state, and forgets the avatar when a world is imported again', () => {
    expect(new AvatarKeeper({ stored: { kind: 'flying', settlementId: 'settlement-641' } }).read()).toBeUndefined();
    expect(new AvatarKeeper({ stored: undefined }).read()).toBeUndefined();
    const before = new WorldStore(storePath);
    expect(before.loadAvatar()).toMatchObject({ kind: 'standing' });
    before.close();
    importFile(LOMIA_PATH, storePath);
    const after = new WorldStore(storePath);
    expect(after.loadAvatar()).toBeUndefined();
    after.close();
  });
});
