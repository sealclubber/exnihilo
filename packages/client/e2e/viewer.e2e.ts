/**
 * The viewer, in a headless browser, against a server of its own: panes,
 * the hover marker, colour by role, the legend, people moving about outside,
 * and how fast the town map draws.
 *
 * Run with `npm run test:viewer`. It needs a browser: `npx playwright install chromium`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { type Browser, type Page, chromium } from 'playwright';
import { type ViteDevServer, createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AvatarReport,
  type CitySummary,
  type Layout,
  type PackLabels,
  type PersonNow,
  type SettingPack,
  type TripsWindow,
  geometry,
  parsePack,
  startOfDay,
} from '@worldsim/core';
import { LOMIA_PATH } from '../../core/test/fixture.ts';
import { medievalPack, rawMedievalPack } from '../../core/test/pack.ts';
import { buildApp } from '../../server/src/app.ts';
import { AvatarKeeper } from '../../server/src/avatar.ts';
import { WorldClock } from '../../server/src/clock.ts';
import { importFile } from '../../server/src/import-command.ts';
import { WorldStore } from '../../server/src/storage.ts';
import type { Drawn } from '../src/town-map.ts';

const BADANOS = 'settlement-641';
const POMBAL = 'settlement-5';
const OTHER_MILITARY = '#00aa55';
const OWN_COLOUR = '#3a2f6b';
const at = (day: number, hours: number, minutes = 0) => startOfDay(day) + hours * 3600 + minutes * 60;

/** A server on a port of its own, with a clock the test sets. */
interface Served {
  app: FastifyInstance;
  clock: WorldClock;
  url: string;
  get<T>(path: string): Promise<T>;
}
async function serve(storePath: string, pack: SettingPack): Promise<Served> {
  const store = new WorldStore(storePath);
  const world = store.loadWorld();
  const report = store.loadReport();
  store.close();
  const clock = new WorldClock({ now: () => Date.now(), rates: pack.time.rates, defaultRate: pack.time.defaultRate });
  const app = buildApp(world, report, pack, { clock, avatar: new AvatarKeeper() });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, clock, url, get: async <T>(path: string) => (await fetch(`${url}${path}`)).json() as Promise<T> };
}

let folder: string;
let main: Served;
let recoloured: Served;
let vite: ViteDevServer;
let viewer: string;
let browser: Browser;
let page: Page;
const errors: string[] = [];

/** What the town map last drew. */
const drawn = (from: Page = page) => from.evaluate(() => (window as unknown as { worldsim: { map(): Drawn } }).worldsim.map());
const canvasBox = async (on: Page = page) => (await on.locator('#inspector .town-map canvas').boundingBox())!;
/** Opens a town in the viewer and waits for its people to be drawn. */
async function open(server: Served, settlementId: string, on: Page = page): Promise<void> {
  await on.goto(`${viewer}/?api=${encodeURIComponent(server.url)}#${settlementId}/city`);
  await on.waitForFunction(() => /walking/.test(document.querySelector('#inspector .street-count')?.textContent ?? ''), null, { timeout: 90_000 });
  await settled(on);
}
/** Waits until the map has drawn the present moment. */
async function settled(on: Page = page): Promise<void> {
  await on.waitForTimeout(250);
  await on.waitForFunction(() => (window as unknown as { worldsim: { map(): Drawn } }).worldsim.map().frames > 0);
}
/** Sets the game time, paused, and waits for the map to show it. */
async function setTime(server: Served, time: number, on: Page = page): Promise<void> {
  server.clock.pause();
  server.clock.setTime(time);
  await on.waitForTimeout(1500);
}
const pane = (id: string, on: Page = page) => on.locator(`[data-pane="${id}"]`);
/** Whether a point of the canvas is clear of the panes that lie over the map, with room to spare. */
const inTheClear = (x: number, y: number, size: Drawn['size']) => x > 210 && x < size.width - 280 && y > 70 && y < size.height - 50;
const toScreen = (point: readonly [number, number], state: Drawn): [number, number] => [point[0] * state.view.scale + state.view.x, point[1] * state.view.scale + state.view.y];
/** A point of the canvas with no lot under it and nobody near it: open country, or a street. */
function emptySpot(state: Drawn, layout: Layout): [number, number] {
  for (let y = state.size.height - 60; y > 80; y -= 20) {
    for (let x = 220; x < state.size.width - 290; x += 20) {
      const point: [number, number] = [(x - state.view.x) / state.view.scale, (y - state.view.y) / state.view.scale];
      if (state.people.some((person) => Math.hypot(person.x - x, person.y - y) < 40)) continue;
      if (state.avatar && Math.hypot(state.avatar.x - x, state.avatar.y - y) < 40) continue;
      if (!layout.lots.some((lot) => geometry.pointInPolygon(point, lot.polygon))) return [x, y];
    }
  }
  throw new Error('the map has no empty spot in view');
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'worldsim-viewer-'));
  const storePath = join(folder, 'world.sqlite');
  importFile(LOMIA_PATH, storePath);
  main = await serve(storePath, medievalPack());
  const raw = rawMedievalPack();
  raw.display.categories.military = OTHER_MILITARY;
  // And two occupations with colours of their own: one Badanos has, and one it has not.
  raw.display.occupations = { tanner: OWN_COLOUR, harbourmaster: '#123456' };
  recoloured = await serve(storePath, parsePack(raw));
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  viewer = vite.resolvedUrls!.local[0]!.replace(/\/$/, '');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1800, height: 950 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  main.clock.setTime(at(1, 12, 30));
  await open(main, BADANOS);
});

afterAll(async () => {
  await browser?.close();
  await vite?.close();
  await main?.app.close();
  await recoloured?.app.close();
  if (folder) rmSync(folder, { recursive: true, force: true });
});

describe('collapsible panes', () => {
  const INSPECTOR_PANES: Array<[id: string, title: string, summary: RegExp]> = [
    ['summary', 'Summary', /Badanos, 9,607 residents/],
    ['households', 'Households', /2,390/],
    ['detail', 'Details', /nothing chosen/],
    ['legend', 'Legend', /9 colours/],
    ['around', 'Around you', /not in the world/],
    ['clock', 'Clock', /Moonday 12:30/],
  ];

  it('each fold to one line with a summary, unfold again, and keep their state after a reload', async () => {
    for (const [id, title, summary] of INSPECTOR_PANES) {
      const body = pane(id).locator('> .pane-body');
      const head = pane(id).locator('> .pane-head');
      expect(await body.isVisible(), id).toBe(true);
      await head.click();
      expect(await pane(id).getAttribute('class'), id).toContain('collapsed');
      expect(await body.isVisible(), id).toBe(false);
      // One line: the title and a short summary.
      const line = (await head.innerText()).replace(/\s+/g, ' ').trim();
      expect(line.toLowerCase().replace(' :', ':'), id).toContain(`${title.toLowerCase()}:`);
      expect(line, id).toMatch(summary);
      expect(await head.getAttribute('aria-expanded')).toBe('false');
    }
    await page.reload();
    await page.waitForFunction(() => /walking/.test(document.querySelector('#inspector .street-count')?.textContent ?? ''), null, { timeout: 90_000 });
    for (const [id] of INSPECTOR_PANES) {
      expect(await pane(id).getAttribute('class'), `${id} after a reload`).toContain('collapsed');
      expect(await pane(id).locator('> .pane-body').isVisible(), id).toBe(false);
    }
    // Unfolded one by one, and that is remembered too.
    for (const [id] of INSPECTOR_PANES) {
      await pane(id).locator('> .pane-head').click();
      expect(await pane(id).locator('> .pane-body').isVisible(), id).toBe(true);
    }
    await page.reload();
    await page.waitForFunction(() => /walking/.test(document.querySelector('#inspector .street-count')?.textContent ?? ''), null, { timeout: 90_000 });
    for (const [id] of INSPECTOR_PANES) expect(await pane(id).getAttribute('class'), id).not.toContain('collapsed');
  });

  it('give the map at least 90% of the window\'s width when all are folded by the one control', async () => {
    const width = async () => (await page.locator('#inspector .town-map').boundingBox())!.width;
    const before = await width();
    const control = page.locator('#inspector .fold-all');
    expect(await control.innerText()).toBe('Fold all');
    await control.click();
    for (const id of ['summary', 'households', 'detail', 'legend', 'around', 'clock', 'settlement']) expect(await pane(id).getAttribute('class'), id).toContain('collapsed');
    expect(await control.innerText()).toBe('Unfold all');
    const window = page.viewportSize()!.width;
    const folded = await width();
    console.log(`With every pane folded the map is ${folded} of ${window} px wide (${((folded / window) * 100).toFixed(1)}%); unfolded it was ${before}`);
    expect(folded / window).toBeGreaterThanOrEqual(0.9);
    expect(folded).toBeGreaterThan(before);
    // The canvas itself has taken up the room.
    await settled();
    expect((await drawn()).size.width).toBeCloseTo(folded, -1);
    await control.click();
    for (const id of ['summary', 'households', 'detail', 'legend', 'around', 'clock']) expect(await pane(id).getAttribute('class'), id).not.toContain('collapsed');
    expect(await width()).toBeCloseTo(before, 0);
  });

  it('include the settlement panel beside the world map', async () => {
    const world = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    await world.goto(`${viewer}/?api=${encodeURIComponent(main.url)}#${BADANOS}`);
    await world.waitForFunction(() => document.querySelector('#panel h2')?.textContent === 'Badanos', null, { timeout: 60_000 });
    const mapWidth = async () => (await world.locator('#map').boundingBox())!.width;
    const before = await mapWidth();
    await pane('settlement', world).locator('> .pane-head').click();
    expect(await pane('settlement', world).locator('> .pane-body').isVisible()).toBe(false);
    expect((await pane('settlement', world).locator('> .pane-head').innerText()).replace(/\s+/g, ' ')).toMatch(/settlement ?: Badanos/i);
    expect(await mapWidth()).toBeGreaterThan(before + 300);
    await world.reload();
    await world.waitForFunction(() => document.querySelector('#panel h2')?.textContent === 'Badanos', null, { timeout: 60_000 });
    expect(await pane('settlement', world).getAttribute('class')).toContain('collapsed');
    await pane('settlement', world).locator('> .pane-head').click();
    expect(await world.locator('#panel h2').isVisible()).toBe(true);
    await world.close();
  });
});

describe('colour by role and the legend', () => {
  it('draws a watchman in the pack\'s military colour, and in another when a copy of the pack says so', async () => {
    // Just before 06:00 the day watch is on its way to work.
    const time = at(2, 5, 50);
    for (const [server, colour] of [[main, medievalPack().display.categories.military], [recoloured, OTHER_MILITARY]] as const) {
      server.clock.setTime(time);
      await open(server, BADANOS);
      const labels = await server.get<PackLabels>('/api/pack');
      expect(labels.roleColours.military).toBe(colour);
      const window = await server.get<TripsWindow>(`/api/settlements/${BADANOS}/life/trips?from=${time}&to=${time + 1}`);
      const watch = new Set(window.trips.filter((trip) => trip.occupationId === 'watchman').map((trip) => trip.personId));
      expect(watch.size).toBeGreaterThan(10);
      const people = (await drawn()).people;
      const seen = people.filter((person) => watch.has(person.personId));
      expect(seen.length).toBeGreaterThan(10);
      expect(new Set(seen.map((person) => person.colour))).toEqual(new Set([colour]));
      // And nobody who is not military is in that colour.
      const military = new Set([...window.trips, ...window.outside].filter((entry) => entry.role === 'military').map((entry) => entry.personId));
      expect(people.filter((person) => person.colour === colour).every((person) => military.has(person.personId))).toBe(true);
    }
    expect(medievalPack().display.categories.military).not.toBe(OTHER_MILITARY);
  });

  it('lists in the legend every colour in use and no others', async () => {
    main.clock.setTime(at(1, 12, 30));
    await open(main, BADANOS);
    const labels = await main.get<PackLabels>('/api/pack');
    const summary = await main.get<CitySummary>(`/api/settlements/${BADANOS}/city`);
    const listed = await pane('legend').locator('li[data-role]').evaluateAll((items) => items.map((item) => [item.getAttribute('data-role'), item.getAttribute('data-colour'), item.textContent?.trim()]));
    // In use: each category that has workers, and the two states of those not at work, if anyone is in them.
    const inUse = [
      ...labels.categories.filter((category) => summary.categories[category.id] > 0).map((category) => [category.id, labels.roleColours[category.id], category.name]),
      ...(summary.workforce.keepingHouse > 0 ? [['keeping-house', labels.roleColours['keeping-house'], 'Keeping house']] : []),
      ...(summary.workforce.notWorking > 0 ? [['not-working', labels.roleColours['not-working'], 'Not working']] : []),
    ];
    expect(listed).toEqual(inUse);
    expect(listed).toHaveLength(9);
    // Everyone drawn is in one of the legend's colours, and the swatches show those colours.
    const colours = new Set(listed.map((entry) => entry[1]));
    const people = (await drawn()).people;
    expect(people.length).toBeGreaterThan(900);
    expect(people.every((person) => colours.has(person.colour))).toBe(true);
    const swatches = await pane('legend').locator('li[data-role] .swatch').evaluateAll((items) => items.map((item) => getComputedStyle(item).backgroundColor));
    const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    expect(swatches).toEqual(listed.map((entry) => rgb(entry[1] as string)));
    // A pack that gives an occupation its own colour: it is listed if the town has any, and not otherwise.
    recoloured.clock.setTime(at(1, 12, 30));
    await open(recoloured, BADANOS);
    const own = await pane('legend').locator('li[data-role]').evaluateAll((items) => items.map((item) => [item.getAttribute('data-role'), item.getAttribute('data-colour'), item.textContent?.trim()]));
    expect(own).toHaveLength(10);
    expect(own).toContainEqual(['tanner', OWN_COLOUR, 'Tanner']);
    expect(own.map((entry) => entry[0])).not.toContain('harbourmaster');
    expect(own).toContainEqual(['military', OTHER_MILITARY, 'Military']);
    const inOwn = new Set(own.map((entry) => entry[1]));
    expect((await drawn()).people.every((person) => inOwn.has(person.colour))).toBe(true);
  });

  it('tells walking from staying outside by shape as well as colour', async () => {
    main.clock.setTime(at(1, 7, 50));
    await open(main, BADANOS);
    const time = Math.floor(main.clock.read().gameTime);
    const window = await main.get<TripsWindow>(`/api/settlements/${BADANOS}/life/trips?from=${time}&to=${time + 1}`);
    const walking = new Set(window.trips.filter((trip) => trip.departAt <= time && time < trip.arriveAt).map((trip) => trip.personId));
    const people = (await drawn()).people;
    expect(people.filter((person) => person.shape === 'dot').length).toBeGreaterThan(300);
    for (const person of people) expect(person.shape, person.personId).toBe(walking.has(person.personId) ? 'dot' : 'square');
  });
});

describe('the hover marker', () => {
  /** Someone drawn with nobody else near them, clear of the panes that lie over the map. */
  const alone = (people: Drawn['people'], size: Drawn['size']) => {
    const found = people.find((person) => inTheClear(person.x, person.y, size) && people.every((other) => other === person || Math.hypot(other.x - person.x, other.y - person.y) > 26));
    if (!found) throw new Error('nobody drawn stands alone');
    return found;
  };

  it('marks the person under the cursor and nobody else, with their name and occupation, and goes when the cursor does', async () => {
    await setTime(main, at(1, 12, 30));
    await open(main, BADANOS);
    const before = await drawn();
    expect(before.hover).toBeUndefined();
    const target = alone(before.people, before.size);
    const box = await canvasBox();
    // A generous target: a few pixels off the dot is near enough.
    await page.mouse.move(box.x + target.x + 4, box.y + target.y - 3);
    await settled();
    const during = await drawn();
    const who = (await main.get<PersonNow>(`/api/settlements/${BADANOS}/life/people/${target.personId}/now`)).person;
    expect(during.hover).toMatchObject({ kind: 'person', id: target.personId });
    expect(during.hover!.label).toContain(`${who.givenName} ${who.familyName}`);
    if (who.occupationId) {
      const labels = await main.get<PackLabels>('/api/pack');
      expect(during.hover!.label.toLowerCase()).toContain(labels.occupations[who.occupationId]!.name.toLowerCase());
    }
    // Away over open ground, the marker goes.
    const [ex, ey] = emptySpot(during, await main.get<Layout>(`/api/settlements/${BADANOS}/layout`));
    await page.mouse.move(box.x + ex, box.y + ey);
    await settled();
    expect((await drawn()).hover).toBeUndefined();
    // And off the map altogether.
    await page.mouse.move(box.x + target.x + 4, box.y + target.y - 3);
    await settled();
    expect((await drawn()).hover?.id).toBe(target.personId);
    await page.mouse.move(5, 5);
    await settled();
    expect((await drawn()).hover).toBeUndefined();
  });

  it('prefers the nearest of several people in range', async () => {
    const state = await drawn();
    const { people } = state;
    const box = await canvasBox();
    // Two people close together: the cursor nearer one of them marks that one.
    let pair: [Drawn['people'][number], Drawn['people'][number]] | undefined;
    for (const a of people) {
      const b = people.find((other) => other !== a && Math.hypot(other.x - a.x, other.y - a.y) > 3 && Math.hypot(other.x - a.x, other.y - a.y) < 9);
      if (b && inTheClear(a.x, a.y, (state.size)) && people.every((other) => other === a || other === b || Math.hypot(other.x - a.x, other.y - a.y) > 14)) {
        pair = [a, b];
        break;
      }
    }
    expect(pair).toBeDefined();
    const [a, b] = pair!;
    // A point beyond `a`, on the far side from `b`.
    const away = Math.hypot(a.x - b.x, a.y - b.y);
    await page.mouse.move(box.x + a.x + ((a.x - b.x) / away) * 2, box.y + a.y + ((a.y - b.y) / away) * 2);
    await settled();
    expect((await drawn()).hover).toMatchObject({ kind: 'person', id: a.personId });
  });

  it('outlines the lot under the cursor and names its building', async () => {
    const layout = await main.get<Layout>(`/api/settlements/${BADANOS}/layout`);
    const types = await main.get<Record<string, string>>(`/api/settlements/${BADANOS}/city/building-types`);
    const labels = await main.get<PackLabels>('/api/pack');
    const state = await drawn();
    const box = await canvasBox();
    // A lot with nobody on it, away from the panes.
    const lot = layout.lots.find((entry) => {
      const [sx, sy] = toScreen(geometry.polygonCentroid(entry.polygon), state);
      return inTheClear(sx, sy, state.size) && state.people.every((person) => Math.hypot(person.x - sx, person.y - sy) > 30);
    })!;
    const [sx, sy] = toScreen(geometry.polygonCentroid(lot.polygon), state);
    await page.mouse.move(box.x + sx, box.y + sy);
    await settled();
    expect((await drawn()).hover).toEqual({ kind: 'lot', id: lot.id, label: labels.buildingTypes[types[lot.buildingId]!] });
  });

  it('marks on the map the person whose entry is hovered in the around-you panel, and the entry of the person hovered on the map', async () => {
    // Stand in the middle of town at midday, where people are about.
    const first = await drawn();
    // Beside someone who is clear of the panes, with a few others about.
    const centre = first.people.find((person) => inTheClear(person.x, person.y, first.size) && first.people.filter((other) => Math.hypot(other.x - person.x, other.y - person.y) < 12).length >= 3)!;
    await fetch(`${main.url}/api/avatar/spawn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settlementId: BADANOS, point: centre.point }) });
    await page.waitForFunction(() => document.querySelectorAll('#inspector .around-you li[data-person]').length > 0, null, { timeout: 20_000 });
    const entry = page.locator('#inspector .around-you li[data-person]').first();
    const personId = (await entry.getAttribute('data-person'))!;
    expect((await drawn()).marked).toBeUndefined();
    await entry.hover();
    await settled();
    expect((await drawn()).marked).toBe(personId);
    // The reverse: the cursor on that person on the map lights their entry in the list.
    const state = await drawn();
    const dot = state.people.find((person) => person.personId === personId)!;
    const box = await canvasBox();
    await page.mouse.move(box.x + dot.x, box.y + dot.y);
    await settled();
    const hovered = (await drawn()).hover;
    expect(hovered?.kind).toBe('person');
    const lit = await page.locator('#inspector [data-person].hovered').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-person')));
    expect(lit).toContain(hovered!.id);
    await page.mouse.move(5, 5);
    await settled();
    expect(await page.locator('#inspector [data-person].hovered').count()).toBe(0);
  });

  it('marks on the map the person a household row shows, when they can be seen', async () => {
    // Someone drawn who is the head of their household, found through the list's search.
    const { people } = await drawn();
    for (const candidate of people.slice(0, 80)) {
      const { person } = await main.get<PersonNow>(`/api/settlements/${BADANOS}/life/people/${candidate.personId}/now`);
      if (person.role !== 'head') continue;
      await page.locator('#inspector input[type="search"]').fill(person.familyName);
      await page.waitForFunction((id) => document.querySelector(`#inspector .households li[data-person="${id}"]`) !== null, person.id, { timeout: 10_000 });
      await page.locator(`#inspector .households li[data-person="${person.id}"]`).hover();
      await settled();
      expect((await drawn()).marked).toBe(person.id);
      await page.locator('#inspector input[type="search"]').fill('');
      return;
    }
    throw new Error('nobody drawn is the head of a household');
  });

  it('selects nothing and moves nothing', async () => {
    const before = {
      avatar: JSON.stringify(await main.get<AvatarReport>('/api/avatar')),
      detail: await page.locator('#inspector .detail').innerText(),
      selected: await page.locator('#inspector .household.selected').count(),
      address: page.url(),
      clock: main.clock.read().gameTime,
    };
    const state = await drawn();
    const box = await canvasBox();
    // Over people, lots, the avatar and the lists, without a click.
    const clear = state.people.filter((person) => inTheClear(person.x, person.y, state.size));
    for (const person of clear.slice(0, 25)) await page.mouse.move(box.x + person.x, box.y + person.y);
    await settled();
    expect((await drawn()).hover?.kind).toBeDefined();
    for (const row of await page.locator('#inspector .households li[data-person]').all().then((rows) => rows.slice(0, 5))) await row.hover();
    await settled();
    expect(JSON.stringify(await main.get<AvatarReport>('/api/avatar'))).toBe(before.avatar);
    expect(await page.locator('#inspector .detail').innerText()).toBe(before.detail);
    expect(await page.locator('#inspector .household.selected').count()).toBe(before.selected);
    expect(page.url()).toBe(before.address);
    expect(main.clock.read().gameTime).toBe(before.clock);
    // The avatar has its own marker.
    if (state.avatar) {
      await page.mouse.move(box.x + state.avatar.x, box.y + state.avatar.y);
      await settled();
      expect(['avatar', 'person']).toContain((await drawn()).hover?.kind);
    }
  });
});

describe('people outside', () => {
  it('are drawn on open ground, never on a footprint, and move over a minute of game time', async () => {
    const time = at(1, 12, 30);
    await setTime(main, time);
    await open(main, BADANOS);
    const layout = await main.get<Layout>(`/api/settlements/${BADANOS}/layout`);
    const lots = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
    const window = await main.get<TripsWindow>(`/api/settlements/${BADANOS}/life/trips?from=${time}&to=${time + 61}`);
    const stays = new Map(window.outside.map((stay) => [stay.personId, stay]));
    const before = (await drawn()).people.filter((person) => person.shape === 'square');
    expect(before.length).toBeGreaterThan(900);
    // A centimetre's leeway, since points are sent to the nearest centimetre.
    const NEAR = 0.02;
    let onYards = 0;
    for (const person of before) {
      const stay = stays.get(person.personId)!;
      // Someone stopped on a street, or out in front of a building, is on the street and not on a lot.
      if (stay.buildingId === undefined || stay.onStreet) continue;
      const lot = lots.get(stay.buildingId)!;
      const inLot = geometry.pointInPolygon(person.point, lot.polygon) || geometry.distanceToPolygonEdge(person.point, lot.polygon) <= NEAR;
      const inBuilding = lot.footprints.some((footprint) => geometry.strictlyInside(person.point, footprint) && geometry.distanceToPolygonEdge(person.point, footprint) > NEAR);
      expect(inLot, `${person.personId} is off the lot`).toBe(true);
      expect(inBuilding, `${person.personId} is drawn on a building`).toBe(false);
      if (lot.footprints.length > 0) onYards++;
    }
    // Some of them share their lot with a building, and are on the ground beside it.
    expect(onYards).toBeGreaterThan(50);
    // A minute later, those whose wander has them move in that minute are somewhere else.
    await setTime(main, time + 60);
    const after = new Map((await drawn()).people.map((person) => [person.personId, person]));
    let moved = 0;
    let shouldMove = 0;
    for (const person of before) {
      const later = after.get(person.personId);
      if (!later) continue;
      const { times, points } = stays.get(person.personId)!.wander;
      const moves = times.some((t, index) => index > 0 && t > time && times[index - 1]! < time + 60 && geometry.distance(points[index]!, points[index - 1]!) > 0.5);
      const shifted = geometry.distance(person.point, later.point);
      if (shifted > 0.05) moved++;
      if (moves) shouldMove++;
      // Nobody moves faster than a slow walk.
      expect(shifted).toBeLessThanOrEqual(0.5 * 60 + 0.1);
    }
    console.log(`Of ${before.length} people outside in Badanos at 12:30, ${moved} are drawn somewhere else a minute later`);
    expect(shouldMove).toBeGreaterThan(50);
    expect(moved).toBeGreaterThan(50);
    expect(moved).toBeLessThan(before.length);
  });
});

describe('cost', () => {
  /** Frames drawn per second with the clock running in real time, and the time spent on each. */
  async function frameRate(server: Served, settlementId: string): Promise<{ rate: number; each: number; people: number }> {
    server.clock.pause();
    server.clock.setTime(at(1, 12, 30));
    await open(server, settlementId);
    server.clock.run();
    await page.waitForTimeout(1500);
    const first = await drawn();
    const began = Date.now();
    await page.waitForTimeout(4000);
    const last = await drawn();
    const seconds = (Date.now() - began) / 1000;
    server.clock.pause();
    return { rate: (last.frames - first.frames) / seconds, each: (last.drawMs - first.drawMs) / Math.max(1, last.frames - first.frames), people: last.people.length };
  }

  it('holds 30 frames a second in Badanos at midday with everything drawn', async () => {
    const { rate, each, people } = await frameRate(main, BADANOS);
    console.log(`Badanos at midday: ${rate.toFixed(0)} frames a second, ${each.toFixed(2)} ms to draw each, ${people} people drawn`);
    expect(people).toBeGreaterThan(900);
    expect(rate).toBeGreaterThanOrEqual(30);
  });

  it('reports the figure for Pombal', async () => {
    const { rate, each, people } = await frameRate(main, POMBAL);
    console.log(`Pombal at midday: ${rate.toFixed(0)} frames a second, ${each.toFixed(2)} ms to draw each, ${people} people drawn`);
    expect(people).toBeGreaterThan(3000);
    expect(rate).toBeGreaterThan(0);
  });

  it('ran without an error on the page', () => {
    expect(errors).toEqual([]);
  });
});
