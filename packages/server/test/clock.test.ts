import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClockState, importAfmg } from '@worldsim/core';
import { loadLomia } from '../../core/test/fixture.ts';
import { medievalPack } from '../../core/test/pack.ts';
import { buildApp } from '../src/app.ts';
import { ClockError, WorldClock } from '../src/clock.ts';
import { WorldStore } from '../src/storage.ts';

const pack = medievalPack();

/** A clock driven by hand: real time moves only when the test says so. */
function handDriven(stored?: { gameTime: number; rate: number }) {
  let real = 1_000_000;
  const saved: Array<{ gameTime: number; rate: number }> = [];
  const clock = new WorldClock({ now: () => real, rates: pack.time.rates, defaultRate: pack.time.defaultRate, stored, save: (state) => saved.push(state) });
  return { clock, saved, pass: (seconds: number) => (real += seconds * 1000) };
}

describe('the world clock', () => {
  it('starts paused at the beginning of day 1, at the pack\'s default rate', () => {
    const { clock } = handDriven();
    expect(clock.read()).toEqual({ gameTime: 0, rate: 1, running: false, rates: pack.time.rates });
  });

  it('advances game time by the rate: 2 seconds at rate 1, 60 seconds at rate 30', () => {
    const { clock, pass } = handDriven();
    clock.run();
    pass(2);
    expect(clock.read().gameTime).toBe(2);
    clock.setRate(30);
    pass(2);
    expect(clock.read().gameTime).toBe(62);
    // At rate 30 a game day takes 48 real minutes.
    pass(48 * 60);
    expect(clock.read().gameTime).toBe(62 + 86_400);
  });

  it('does not advance while paused', () => {
    const { clock, pass } = handDriven();
    clock.run();
    pass(10);
    clock.pause();
    pass(1000);
    expect(clock.read()).toMatchObject({ gameTime: 10, running: false });
    clock.run();
    pass(5);
    expect(clock.read().gameTime).toBe(15);
  });

  it('keeps the current game time when the rate changes', () => {
    const { clock, pass } = handDriven();
    clock.run();
    pass(7.5);
    const before = clock.read().gameTime;
    expect(clock.setRate(3600).gameTime).toBe(before);
    expect(clock.read().gameTime).toBe(before);
    pass(1);
    expect(clock.read().gameTime).toBe(before + 3600);
    expect(clock.setRate(1).gameTime).toBe(before + 3600);
  });

  it('takes a set game time at once, forward or back, running or paused', () => {
    const { clock, pass } = handDriven();
    clock.run();
    pass(100);
    expect(clock.setTime(500_000).gameTime).toBe(500_000);
    pass(3);
    expect(clock.read().gameTime).toBe(500_003);
    expect(clock.setTime(40).gameTime).toBe(40);
    expect(clock.read().running).toBe(true);
    clock.pause();
    expect(clock.setTime(86_400).gameTime).toBe(86_400);
    pass(60);
    expect(clock.read()).toMatchObject({ gameTime: 86_400, running: false });
  });

  it('refuses a rate that is not on offer and a time that is not a time', () => {
    const { clock } = handDriven();
    expect(() => clock.setRate(7)).toThrow(ClockError);
    expect(() => clock.setRate(7)).toThrow(/the rate must be one of 1, 10, 30/);
    expect(() => clock.setTime(-5)).toThrow(/zero or more/);
    expect(() => clock.setTime(Number.NaN)).toThrow(ClockError);
    expect(clock.read()).toMatchObject({ gameTime: 0, rate: 1 });
  });

  it('tells its listeners of every change, and of nothing else', () => {
    const { clock, pass } = handDriven();
    const heard: ClockState[] = [];
    const stop = clock.subscribe((state) => heard.push(state));
    clock.run();
    pass(5);
    clock.read();
    clock.setRate(30);
    clock.setTime(1000);
    clock.pause();
    expect(heard.map((state) => [state.gameTime, state.rate, state.running])).toEqual([[0, 1, true], [5, 30, true], [1000, 30, true], [1000, 30, false]]);
    stop();
    clock.run();
    expect(heard).toHaveLength(4);
  });

  it('is stored whenever it is paused, re-anchored or set, and when it is stopped', () => {
    const { clock, saved, pass } = handDriven();
    clock.run();
    pass(12.7);
    clock.setRate(30);
    pass(1);
    clock.setTime(5000);
    pass(2);
    clock.pause();
    pass(50);
    clock.stop();
    expect(saved).toEqual([
      { gameTime: 0, rate: 1 },
      { gameTime: 12, rate: 30 },
      { gameTime: 5000, rate: 30 },
      { gameTime: 5060, rate: 30 },
      { gameTime: 5060, rate: 30 },
    ]);
  });

  it('holds the stored game time after a restart, paused', () => {
    const first = handDriven();
    first.clock.run();
    first.clock.setRate(30);
    first.pass(100);
    first.clock.stop();
    const stored = first.saved.at(-1)!;
    expect(stored).toEqual({ gameTime: 3000, rate: 30 });

    const second = handDriven(stored);
    expect(second.clock.read()).toMatchObject({ gameTime: 3000, rate: 30, running: false });
    second.pass(500);
    expect(second.clock.read().gameTime).toBe(3000);
    // A stored rate the pack no longer offers gives way to the default.
    expect(handDriven({ gameTime: 10, rate: 7 }).clock.read()).toMatchObject({ gameTime: 10, rate: 1 });
  });
});

describe('the clock in the world store', () => {
  let folder: string;
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'worldsim-clock-'));
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it('survives closing and reopening the store, and leaves the world as it was', () => {
    const path = join(folder, 'world.sqlite');
    const imported = importAfmg(loadLomia());
    const store = new WorldStore(path);
    store.save(imported.world, imported.report);
    expect(store.loadClock()).toBeUndefined();
    let real = 0;
    const clock = new WorldClock({ now: () => real, rates: pack.time.rates, defaultRate: 1, stored: store.loadClock(), save: (state) => store.saveClock(state) });
    clock.run();
    real += 90_000;
    clock.pause();
    store.close();

    const reopened = new WorldStore(path);
    expect(reopened.loadClock()).toEqual({ gameTime: 90, rate: 1 });
    expect(JSON.stringify(reopened.loadWorld())).toBe(JSON.stringify(imported.world));
    const restarted = new WorldClock({ now: () => real, rates: pack.time.rates, defaultRate: 1, stored: reopened.loadClock() });
    expect(restarted.read()).toMatchObject({ gameTime: 90, running: false });
    // Importing again starts the clock afresh, with the world.
    reopened.save(imported.world, imported.report);
    expect(reopened.loadClock()).toBeUndefined();
    reopened.close();
  });

  it('cannot be stored where there is no world', () => {
    const store = new WorldStore(':memory:');
    expect(() => store.saveClock({ gameTime: 1, rate: 1 })).toThrow(/import one first/);
    store.close();
  });
});

describe('the clock over the API', () => {
  let app: FastifyInstance;
  let real = 0;
  const world = importAfmg(loadLomia());
  beforeAll(async () => {
    const clock = new WorldClock({ now: () => real, rates: pack.time.rates, defaultRate: pack.time.defaultRate });
    app = buildApp(world.world, world.report, pack, { clock });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const post = async (path: string, payload?: object) => {
    const response = await app.inject({ method: 'POST', url: `/api/clock/${path}`, ...(payload && { payload }) });
    return { status: response.statusCode, body: response.json() as ClockState & { error?: string } };
  };

  it('can be read', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/clock' });
    expect(response.json()).toEqual({ gameTime: 0, rate: 1, running: false, rates: pack.time.rates });
  });

  it('can be run, paused, given a rate and set', async () => {
    expect((await post('run')).body).toMatchObject({ gameTime: 0, running: true });
    real += 4000;
    expect((await post('rate', { rate: 30 })).body).toMatchObject({ gameTime: 4, rate: 30, running: true });
    real += 2000;
    expect((await post('pause')).body).toMatchObject({ gameTime: 64, running: false });
    expect((await post('time', { gameTime: 7 * 86_400 })).body).toMatchObject({ gameTime: 604_800, running: false });
    expect((await app.inject({ method: 'GET', url: '/api/clock' })).json()).toMatchObject({ gameTime: 604_800, rate: 30 });
  });

  it('answers 400 with a message for a rate or a time it cannot take', async () => {
    for (const [path, payload] of [['rate', { rate: 7 }], ['rate', {}], ['time', { gameTime: -1 }], ['time', { gameTime: 'noon' }]] as const) {
      const { status, body } = await post(path, payload);
      expect(status, path).toBe(400);
      expect(body.error).toMatch(/the rate must be one of|the game time must be/);
    }
  });

  it('lets a page from another machine post to it', async () => {
    const response = await app.inject({ method: 'OPTIONS', url: '/api/clock/pause', headers: { origin: 'http://elsewhere:5173', 'access-control-request-method': 'POST' } });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('tells a connected viewer the state at once, and every change as it happens', async () => {
    const heard: ClockState[] = [];
    let waiting: (() => void) | undefined;
    // Listen from before the connection opens, so the first message is not missed.
    const socket = await app.injectWS('/api/clock/stream', {}, {
      onInit(ws) {
        ws.on('message', (data: Buffer) => {
          heard.push(JSON.parse(data.toString()) as ClockState);
          waiting?.();
        });
      },
    });
    const next = () => new Promise<void>((resolve) => (waiting = resolve));
    if (heard.length === 0) await next();
    expect(heard[0]).toMatchObject({ gameTime: 604_800, rate: 30, running: false });
    let wait = next();
    await post('run');
    await wait;
    wait = next();
    await post('time', { gameTime: 100 });
    await wait;
    expect(heard.slice(1).map((state) => [state.gameTime, state.running])).toEqual([[604_800, true], [100, true]]);
    socket.terminate();
    await post('pause');
  });
});
