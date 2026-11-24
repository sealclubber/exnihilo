/**
 * The viewer, in a headless browser, against a server of its own: panes,
 * the hover marker, colour by role, the legend, people moving about outside,
 * outsiders, the town as laid out with its river, wall and plaza, and how
 * fast the town map draws.
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
  type BuildingTypes,
  type CitySummary,
  type Layout,
  type OccupantsNow,
  type OutsiderDetail,
  type OutsidersToday,
  type PackLabels,
  type PersonNow,
  type SettingPack,
  type TripsWindow,
  geometry,
  isOutsiderId,
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
const OTHER_MERCHANT = '#b000b5';
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
  // The day's outsiders arrive after the town does, and bring their colours to the legend.
  await on.waitForFunction(() => document.querySelector('#inspector .in-town[data-day]') !== null, null, { timeout: 90_000 });
  await settled(on);
}
/** The outsiders in a town on a day, as the server lists them. */
const inTown = (server: Served, settlementId: string, day: number) => server.get<OutsidersToday>(`/api/settlements/${settlementId}/life/outsiders?day=${day}`);
/** The legend's entries for outsiders that a day calls for: each kind of traveller in town, in the pack's order, then the vagrants. */
function outsiderColours(today: OutsidersToday, labels: PackLabels): Array<[role: string, colour: string, name: string]> {
  return [
    ...Object.entries(labels.travellerKinds).filter(([kindId]) => (today.byKind[kindId] ?? 0) > 0).map(([kindId, name]): [string, string, string] => [`traveller:${kindId}`, labels.roleColours[`traveller:${kindId}`]!, name]),
    ...(today.vagrants.length > 0 ? [['vagrant', labels.roleColours.vagrant!, labels.vagrantName!] as [string, string, string]] : []),
  ];
}
/** The legend's colours as the page shows them: role, colour and name. */
const legendRows = () => pane('legend').locator('li[data-role]').evaluateAll((items) => items.map((item) => [item.getAttribute('data-role'), item.getAttribute('data-colour'), item.textContent?.trim()]));
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
  // And another colour for one kind of traveller.
  raw.display.travellers = { ...raw.display.travellers, merchant: OTHER_MERCHANT };
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
  // The legend's nine colours for residents were all it had before phase 6C; it now has those of the day's outsiders
  // as well, and the day's outsiders have a pane of their own. Both figures are worked out from what the server says.
  const INSPECTOR_PANES: Array<[id: string, title: string, summary: RegExp]> = [
    ['summary', 'Summary', /Badanos, 9,607 residents/],
    ['households', 'Households', /2,390/],
    ['detail', 'Details', /nothing chosen/],
    ['legend', 'Legend', /colours/],
    ['in-town', 'In town today', /\d+/],
    ['around', 'Around you', /not in the world/],
    ['clock', 'Clock', /Moonday 12:30/],
  ];

  it('each fold to one line with a summary, unfold again, and keep their state after a reload', async () => {
    const today = await inTown(main, BADANOS, 1);
    const outsiders = today.travellers.length + today.vagrants.length;
    expect(outsiders).toBeGreaterThan(29);
    const exact: Record<string, RegExp> = {
      legend: new RegExp(`: ${9 + outsiderColours(today, await main.get<PackLabels>('/api/pack')).length} colours$`),
      'in-town': new RegExp(`: ${outsiders}$`),
    };
    for (const [id, title, loose] of INSPECTOR_PANES) {
      const summary = exact[id] ?? loose;
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
    for (const id of ['summary', 'households', 'detail', 'legend', 'in-town', 'around', 'clock', 'settlement']) expect(await pane(id).getAttribute('class'), id).toContain('collapsed');
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
    for (const id of ['summary', 'households', 'detail', 'legend', 'in-town', 'around', 'clock']) expect(await pane(id).getAttribute('class'), id).not.toContain('collapsed');
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
    const listed = await legendRows();
    // In use: each category that has workers, and the two states of those not at work, if anyone is in them.
    const residents = [
      ...labels.categories.filter((category) => summary.categories[category.id] > 0).map((category) => [category.id, labels.roleColours[category.id], category.name]),
      ...(summary.workforce.keepingHouse > 0 ? [['keeping-house', labels.roleColours['keeping-house'], 'Keeping house']] : []),
      ...(summary.workforce.notWorking > 0 ? [['not-working', labels.roleColours['not-working'], 'Not working']] : []),
    ];
    // Since phase 6C outsiders are on the map too, so the colours in use include those of the day's outsiders: the
    // residents' nine come first and are what they were.
    const outsiders = outsiderColours(await inTown(main, BADANOS, 1), labels);
    expect(residents).toHaveLength(9);
    expect(listed).toEqual([...residents, ...outsiders]);
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
    const own = await legendRows();
    // The nine and the tanners' own colour, and the outsiders' as before.
    expect(own).toHaveLength(10 + outsiders.length);
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
  const alone = (people: Drawn['people'], size: Drawn['size'], wanted: (person: Drawn['people'][number]) => boolean = () => true) => {
    const found = people.find((person) => wanted(person) && inTheClear(person.x, person.y, size) && people.every((other) => other === person || Math.hypot(other.x - person.x, other.y - person.y) > 26));
    if (!found) throw new Error('nobody drawn stands alone');
    return found;
  };

  it('marks the person under the cursor and nobody else, with their name and occupation, and goes when the cursor does', async () => {
    await setTime(main, at(1, 12, 30));
    await open(main, BADANOS);
    const before = await drawn();
    expect(before.hover).toBeUndefined();
    // A resident: outsiders are on the map as well since phase 6C, and have a test of their own below.
    const target = alone(before.people, before.size, (person) => !isOutsiderId(person.personId));
    const box = await canvasBox();
    // A generous target: a few pixels off the dot is near enough.
    await page.mouse.move(box.x + target.x + 4, box.y + target.y - 3);
    await settled();
    const during = await drawn();
    const who = (await main.get<PersonNow>(`/api/settlements/${BADANOS}/life/people/${target.personId}/now`)).person;
    expect(during.hover).toMatchObject({ kind: 'person', id: target.personId });
    expect(during.hover!.label).toContain(`${who.givenName} ${who.familyName}`);
    if ('group' in who) throw new Error(`${who.id} is not a resident`);
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

  it('outlines the lot under the cursor and names its building, a home that is a workplace as both', async () => {
    const layout = await main.get<Layout>(`/api/settlements/${BADANOS}/layout`);
    const types = await main.get<BuildingTypes>(`/api/settlements/${BADANOS}/city/building-types`);
    const labels = await main.get<PackLabels>('/api/pack');
    const state = await drawn();
    const box = await canvasBox();
    expect(labels.homeAndWorkLabel).toBe('{workplace} and home');
    /**
     * A lot of a kind of building, with nobody on it, away from the panes. Nobody is within 16 pixels of its middle,
     * which is beyond the 12 from which the marker takes to a person. It was 30 until phase 6C, whose busier midday
     * streets leave no plain workplace in view that far from everyone.
     */
    const lotOf = (kind: string) => {
      const found = layout.lots.find((entry) => {
        const [sx, sy] = toScreen(geometry.polygonCentroid(entry.polygon), state);
        return types[entry.buildingId]!.kind === kind && inTheClear(sx, sy, state.size) && state.people.every((person) => Math.hypot(person.x - sx, person.y - sy) > 16);
      });
      if (!found) throw new Error(`no ${kind} in view has nobody near it`);
      return found;
    };
    const hoverOn = async (lot: Layout['lots'][number]) => {
      const [sx, sy] = toScreen(geometry.polygonCentroid(lot.polygon), state);
      await page.mouse.move(box.x + sx, box.y + sy);
      await settled();
      return (await drawn()).hover;
    };
    // A plain dwelling and a plain workplace are named by their type alone.
    for (const kind of ['dwelling', 'workplace']) {
      const lot = lotOf(kind);
      expect(await hoverOn(lot), kind).toEqual({ kind: 'lot', id: lot.id, label: labels.buildingTypes[types[lot.buildingId]!.type] });
    }
    // A building in which a household lives and people work is named as both, by the pack's pattern.
    const both = lotOf('both');
    const name = `${labels.buildingTypes[types[both.buildingId]!.type]} and home`;
    expect(await hoverOn(both)).toEqual({ kind: 'lot', id: both.id, label: name });
    // Its panel says the same, and lists the household that lives there before the people who work there.
    const [sx, sy] = toScreen(geometry.polygonCentroid(both.polygon), state);
    await page.mouse.click(box.x + sx, box.y + sy);
    await page.waitForFunction((wanted) => document.querySelector('#inspector .detail h2')?.textContent === wanted, name, { timeout: 10_000 });
    const headings = await page.locator('#inspector .detail h3').allInnerTexts();
    const living = headings.findIndex((heading) => /households living here \(1\)/i.test(heading));
    const working = headings.findIndex((heading) => /people working here/i.test(heading));
    expect(living).toBeGreaterThanOrEqual(0);
    expect(living).toBeLessThan(working);
    expect((await pane('detail').locator('> .pane-head').innerText()).replace(/\s+/g, ' ')).toMatch(/building/i);
    await page.keyboard.press('Escape');
    // On the map it is marked, by a second outline and not by colour: every such building that has a footprint.
    const expected = layout.lots.filter((lot) => types[lot.buildingId]!.kind === 'both' && lot.footprints.length > 0).length;
    expect(expected).toBeGreaterThan(500);
    expect((await drawn()).homesWithWork).toBe(expected);
    expect(await pane('legend').locator('li[data-mark="home-and-work"]').innerText()).toMatch(/home and workplace/i);
    // A plain workplace's panel lists its workers first.
    const shop = lotOf('workplace');
    const [wx, wy] = toScreen(geometry.polygonCentroid(shop.polygon), state);
    await page.mouse.click(box.x + wx, box.y + wy);
    await page.waitForFunction((wanted) => document.querySelector('#inspector .detail h2')?.textContent === wanted, labels.buildingTypes[types[shop.buildingId]!.type]!, { timeout: 10_000 });
    const plain = await page.locator('#inspector .detail h3').allInnerTexts();
    expect(plain.findIndex((heading) => /people working here/i.test(heading))).toBeLessThan(plain.findIndex((heading) => /households living here/i.test(heading)));
    await page.keyboard.press('Escape');
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
      // An outsider has no household.
      if ('group' in person || person.role !== 'head') continue;
      await page.locator('#inspector input[type="search"]').fill(person.familyName);
      // Wait for the search to have narrowed the list, or the row would move from under the cursor when it does.
      await page.waitForFunction(
        (id) => document.querySelectorAll('#inspector .households li[data-person]').length < 60 && document.querySelector(`#inspector .households li[data-person="${id}"]`) !== null,
        person.id,
        { timeout: 10_000 },
      );
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
    // The stay each person is in at the moment looked at.
    const stays = new Map(window.outside.filter((stay) => stay.from <= time && time < stay.to).map((stay) => [stay.personId, stay]));
    const before = (await drawn()).people.filter((person) => person.shape === 'square');
    expect(before.length).toBeGreaterThan(700);
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
      // Only someone in the same stay for the whole minute: a carter may leave one stop and reach the next in that time.
      const whole = stays.get(person.personId)!;
      if (whole.from > time || whole.to < time + 60) continue;
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

describe('outsiders', () => {
  const DAY = 2;
  const detailTitle = () => page.locator('#inspector .detail h2').innerText();
  const field = (name: string) => page.locator(`#inspector .detail dd[data-field="${name}"]`).innerText();
  /** Waits for the detail pane to show the outsider with an ID. */
  const shows = (outsiderId: string) => page.waitForFunction((id) => document.querySelector('#inspector .detail [data-outsider]')?.getAttribute('data-outsider') === id, outsiderId, { timeout: 10_000 });
  it('show their kind and where they are from on hover, and have a panel', async () => {
    await setTime(main, at(DAY, 11));
    await open(main, BADANOS);
    const labels = await main.get<PackLabels>('/api/pack');
    const partyOf = new Map((await inTown(main, BADANOS, DAY)).travellers.map((traveller) => [traveller.id, traveller.partyId]));
    // Few travellers are out of doors at any one moment, and they go where others are: the first half hour of the
    // day at which one is drawn with nobody else within a few pixels, so that with the cursor on them they are the
    // nearest by far. A party keeps together, on the very same spot, so their companions may be there with them.
    let time = 0;
    let found: { spot: Drawn['people'][number]; seen: Map<string, TripsWindow['trips'][number] | TripsWindow['outside'][number]> } | undefined;
    for (let half = 16; half <= 40 && !found; half++) {
      time = at(DAY, 0, half * 30);
      await setTime(main, time);
      const window = await main.get<TripsWindow>(`/api/settlements/${BADANOS}/life/trips?from=${time}&to=${time + 1}`);
      const seen = new Map([...window.trips, ...window.outside].filter((entry) => entry.outsider && entry.kindId !== undefined).map((entry) => [entry.personId, entry]));
      const state = await drawn();
      const apart = (person: Drawn['people'][number], other: Drawn['people'][number]) => Math.hypot(other.x - person.x, other.y - person.y);
      const spot = state.people.find(
        (person) =>
          seen.has(person.personId) &&
          inTheClear(person.x, person.y, state.size) &&
          state.people.every((other) => other === person || apart(person, other) > 7 || (apart(person, other) < 0.5 && partyOf.get(other.personId) === partyOf.get(person.personId))),
      );
      if (spot) found = { spot, seen };
    }
    if (!found) throw new Error('no traveller is drawn clear of everyone else at any half hour of the day');
    const { spot, seen } = found;
    const before = await page.locator('#inspector .detail').innerText();
    const box = await canvasBox();
    await page.mouse.move(box.x + spot.x, box.y + spot.y);
    await settled();
    // The marker is on them, or on a companion standing on the same spot. Its label: their name, the kind of
    // traveller they are, and where they came from.
    const hovered = (await drawn()).hover!;
    expect(hovered.kind).toBe('person');
    expect(partyOf.get(hovered.id)).toBe(partyOf.get(spot.personId));
    const target = (await drawn()).people.find((person) => person.personId === hovered.id)!;
    const who = seen.get(target.personId)!;
    const kind = labels.travellerKinds[who.kindId!]!;
    expect(who.origin).toBeTruthy();
    expect(hovered.label).toBe(`${who.name} · ${kind} from ${who.origin}`);
    // They are drawn in their kind's colour, from the pack.
    expect(target.colour).toBe(labels.roleColours[`traveller:${who.kindId}`]);
    // Hovering changed nothing.
    expect(await page.locator('#inspector .detail').innerText()).toBe(before);
    // Clicking opens the panel of the one the marker named.
    await page.mouse.click(box.x + spot.x, box.y + spot.y);
    await shows(target.personId);
    const detail = await main.get<OutsiderDetail>(`/api/settlements/${BADANOS}/life/outsiders/${target.personId}?time=${time}`);
    if (detail.outsider.group !== 'traveller') throw new Error('expected a traveller');
    expect(await detailTitle()).toBe(who.name);
    expect(await page.locator('#inspector .detail .subtitle').innerText()).toContain(`${kind} from ${who.origin}`);
    expect((await pane('detail').locator('> .pane-head').innerText()).replace(/\s+/g, ' ').toLowerCase()).toContain(kind.toLowerCase());
    expect(await field('origin')).toContain(who.origin!);
    /** A game time as the time of its day; a traveller may have come before day 1, at a time below zero. */
    const clock = (moment: number) => {
      const minutes = Math.floor((((moment % 86_400) + 86_400) % 86_400) / 60);
      return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    };
    // When they came and when they leave: how many days from today, the day's name and the time, and by which route.
    const dayNames = labels.calendar.week.map((weekday) => weekday.name).join('|');
    const apart = (moment: number) => Math.floor(moment / 86_400) - Math.floor(time / 86_400);
    const { arrival, departure } = detail.outsider;
    expect(apart(arrival.time)).toBeLessThanOrEqual(0);
    expect(apart(departure.time)).toBeGreaterThanOrEqual(0);
    expect(await field('arrival')).toMatch(new RegExp(`^${apart(arrival.time) === 0 ? 'Today' : apart(arrival.time) === -1 ? 'Yesterday' : `${-apart(arrival.time)} days ago`}, (${dayNames}) ${clock(arrival.time)}, by `));
    expect(await field('departure')).toMatch(new RegExp(`^${apart(departure.time) === 0 ? 'Today' : apart(departure.time) === 1 ? 'Tomorrow' : `In ${apart(departure.time)} days`}, (${dayNames}) ${clock(departure.time)}, by `));
    expect(await field('destination')).toContain(detail.outsider.destination.settlement?.name ?? detail.outsider.destination.routeName ?? '');
    // Today's plan, as the timeline a resident has, with what they are doing now marked.
    expect(await page.locator('#inspector .detail table.timeline tr').count()).toBe(detail.plan.activities.length);
    expect(await page.locator('#inspector .detail table.timeline tr.current').count()).toBe(1);
    expect(await page.locator('#inspector .detail .whereabouts').innerText()).not.toMatch(/at home|undefined/i);
    // And they can be followed on the map, as a resident can.
    await page.locator('#follow-person').check();
    await settled();
    const followed = (await drawn()).people.find((person) => person.personId === target.personId)!;
    const size = (await drawn()).size;
    expect(Math.abs(followed.x - size.width / 2)).toBeLessThan(3);
    expect(Math.abs(followed.y - size.height / 2)).toBeLessThan(3);
    await page.locator('#follow-person').uncheck();
  });

  it('have a panel that leads to their companions and their lodging, and an inn\'s panel lists its guests', async () => {
    const time = at(DAY, 15);
    await setTime(main, time);
    const labels = await main.get<PackLabels>('/api/pack');
    const today = await inTown(main, BADANOS, DAY);
    // Someone who travels with another and stays the night.
    const guest = today.travellers.find((traveller) => traveller.lodgingId !== undefined && today.travellers.some((other) => other.partyId === traveller.partyId && other.id !== traveller.id))!;
    expect(guest).toBeDefined();
    const detail = await main.get<OutsiderDetail>(`/api/settlements/${BADANOS}/life/outsiders/${guest.id}?time=${time}`);
    const others = detail.companions!.filter((companion) => companion.id !== guest.id);
    await pane('in-town').locator(`li[data-person="${guest.id}"] button`).click();
    await shows(guest.id);
    // The party: every companion by name, and not themselves.
    expect(await page.locator('#inspector .detail ul.party li').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-person')))).toEqual(others.map((companion) => companion.id));
    expect(await page.locator('#inspector .detail ul.party li button').first().innerText()).toBe(`${others[0]!.givenName} ${others[0]!.familyName}`);
    // The lodging is a link that selects the building, whose panel lists its guests.
    const lodging = labels.buildingTypes[today.buildings[guest.lodgingId!]!]!;
    expect(await field('lodging')).toBe(lodging);
    await page.locator('#inspector .detail dd[data-field="lodging"] button').click();
    await page.waitForFunction((wanted) => document.querySelector('#inspector .detail h2')?.textContent === wanted, lodging, { timeout: 10_000 });
    const occupants = await main.get<OccupantsNow>(`/api/settlements/${BADANOS}/life/buildings/${guest.lodgingId}/occupants?time=${time}`);
    expect(occupants.guests.map((entry) => entry.id)).toContain(guest.id);
    expect(await page.locator('#inspector .detail h3').allInnerTexts()).toContain(`Guests lodging here today (${occupants.guests.length})`.toUpperCase());
    expect(await page.locator('#inspector .detail ul.guests li').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-person')))).toEqual(occupants.guests.map((entry) => entry.id));
    expect(await page.locator(`#inspector .detail ul.guests li[data-person="${guest.id}"]`).innerText()).toContain(`${labels.travellerKinds[guest.kindId]} from `);
    // A guest's name opens their panel; a companion's name, theirs.
    await page.locator(`#inspector .detail ul.guests li[data-person="${guest.id}"] button`).click();
    await shows(guest.id);
    await page.locator('#inspector .detail ul.party li button').first().click();
    await shows(others[0]!.id);
    expect(await detailTitle()).toBe(`${others[0]!.givenName} ${others[0]!.familyName}`);
    expect(await page.locator('#inspector .detail ul.party li').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-person')))).toContain(guest.id);
  });

  it('are listed by kind in the In town today pane, which follows the day and collapses like the others', async () => {
    const labels = await main.get<PackLabels>('/api/pack');
    /** The pane's groups as the page shows them: heading, and the IDs listed. */
    const groups = () =>
      pane('in-town').locator('section').evaluateAll((sections) => sections.map((section) => [section.getAttribute('data-kind') ?? section.getAttribute('data-group'), section.querySelector('h4')?.textContent, [...section.querySelectorAll('li[data-person]')].map((row) => row.getAttribute('data-person'))]));
    const expected = (today: OutsidersToday) => [
      ...Object.entries(labels.travellerKinds)
        .filter(([kindId]) => (today.byKind[kindId] ?? 0) > 0)
        .map(([kindId, name]) => [kindId, `${name} (${today.byKind[kindId]})`, today.travellers.filter((traveller) => traveller.kindId === kindId).map((traveller) => traveller.id)]),
      ['vagrant', `${labels.vagrantName} (${today.vagrants.length})`, today.vagrants.map((vagrant) => vagrant.id)],
    ];
    const today = await inTown(main, BADANOS, DAY);
    expect(today.vagrants).toHaveLength(29);
    expect(today.travellers.length).toBeGreaterThan(40);
    expect(Object.keys(today.byKind).length).toBeGreaterThan(2);
    expect(await pane('in-town').locator('.in-town').getAttribute('data-day')).toBe(String(DAY));
    expect(await groups()).toEqual(expected(today));
    // Each name is there to be read, with where a traveller is from.
    const first = today.travellers[0]!;
    expect(await pane('in-town').locator(`li[data-person="${first.id}"]`).innerText()).toBe(`${first.givenName} ${first.familyName} from ${first.origin.settlement?.name ?? first.origin.routeName ?? first.origin.routeId}`);
    // A name opens that outsider's panel: a vagrant's has no party and no visit.
    const vagrant = today.vagrants[3]!;
    await pane('in-town').locator(`li[data-person="${vagrant.id}"] button`).click();
    await shows(vagrant.id);
    expect(await detailTitle()).toBe(`${vagrant.givenName} ${vagrant.familyName}`);
    expect(await page.locator('#inspector .detail .subtitle').innerText()).toContain(` · ${labels.vagrantName} · `);
    expect(await page.locator('#inspector .detail .party, #inspector .detail dl.visit').count()).toBe(0);
    expect(await page.locator('#inspector .detail table.timeline tr').count()).toBeGreaterThan(0);
    // It folds to one line, its title and how many there are, and unfolds again, like the other panes.
    const head = pane('in-town').locator('> .pane-head');
    const body = pane('in-town').locator('> .pane-body');
    expect(await body.isVisible()).toBe(true);
    await head.click();
    expect(await pane('in-town').getAttribute('class')).toContain('collapsed');
    expect(await body.isVisible()).toBe(false);
    expect((await head.innerText()).replace(/\s+/g, ' ').trim().replace(' :', ':')).toMatch(new RegExp(`^. ?in town today: ${today.travellers.length + today.vagrants.length}$`, 'i'));
    expect(await head.getAttribute('aria-expanded')).toBe('false');
    await head.click();
    expect(await body.isVisible()).toBe(true);
    expect(await head.getAttribute('aria-expanded')).toBe('true');
    // When the clock's day changes, the list is the new day's.
    await setTime(main, at(DAY + 1, 9));
    await page.waitForFunction((day) => document.querySelector('#inspector .in-town')?.getAttribute('data-day') === day, String(DAY + 1), { timeout: 20_000 });
    const tomorrow = await inTown(main, BADANOS, DAY + 1);
    expect(tomorrow.travellers.map((traveller) => traveller.id)).not.toEqual(today.travellers.map((traveller) => traveller.id));
    expect(await groups()).toEqual(expected(tomorrow));
  });

  it('have their colours in the legend when they are in town, each kind\'s from the pack', async () => {
    // At three in the morning the travellers are indoors: the outsiders to be seen are the vagrants, asleep on the streets.
    const night = at(DAY, 3);
    await setTime(main, night);
    await open(main, BADANOS);
    const labels = await main.get<PackLabels>('/api/pack');
    const today = await inTown(main, BADANOS, DAY);
    const wanted = outsiderColours(today, labels);
    expect(wanted.length).toBeGreaterThan(3);
    expect(wanted[wanted.length - 1]).toEqual(['vagrant', labels.roleColours.vagrant, 'Vagrant']);
    const outsidersListed = async () => (await legendRows()).filter(([role]) => role === 'vagrant' || role!.startsWith('traveller:'));
    expect(await outsidersListed()).toEqual(wanted);
    // No two of them share a colour, or there would be nothing to tell them apart by.
    expect(new Set(wanted.map((entry) => entry[1])).size).toBe(wanted.length);
    const asleep = (await drawn()).people.filter((person) => isOutsiderId(person.personId));
    expect(asleep).toHaveLength(today.vagrants.length);
    expect(new Set(asleep.map((person) => person.personId))).toEqual(new Set(today.vagrants.map((vagrant) => vagrant.id)));
    expect(asleep.every((person) => person.colour === labels.roleColours.vagrant && person.shape === 'square')).toBe(true);
    // A vagrant under the cursor is named as the pack names vagrants, and their panel says they are asleep in the street.
    const state = await drawn();
    const sleeper = state.people.find((person) => isOutsiderId(person.personId) && inTheClear(person.x, person.y, state.size) && state.people.every((other) => other === person || Math.hypot(other.x - person.x, other.y - person.y) > 26))!;
    const box = await canvasBox();
    await page.mouse.move(box.x + sleeper.x, box.y + sleeper.y);
    await settled();
    const who = today.vagrants.find((vagrant) => vagrant.id === sleeper.personId)!;
    expect((await drawn()).hover).toEqual({ kind: 'person', id: who.id, label: `${who.givenName} ${who.familyName} · ${labels.vagrantName}` });
    await page.mouse.click(box.x + sleeper.x, box.y + sleeper.y);
    await shows(who.id);
    expect(await page.locator('#inspector .detail .whereabouts').innerText()).toMatch(/^Asleep in the street, until \d\d:\d\d$/);
    // Late in the morning, every outsider drawn is in the colour the legend gives their kind, and several kinds are about.
    const time = at(DAY, 11);
    await setTime(main, time);
    const window = await main.get<TripsWindow>(`/api/settlements/${BADANOS}/life/trips?from=${time}&to=${time + 1}`);
    const roles = new Map([...window.trips, ...window.outside].filter((entry) => entry.outsider).map((entry) => [entry.personId, entry.role]));
    const colourOf = new Map(wanted.map(([role, colour]) => [role, colour]));
    const about = (await drawn()).people.filter((person) => isOutsiderId(person.personId));
    expect(about.length).toBeGreaterThan(20);
    for (const person of about) expect(person.colour, person.personId).toBe(colourOf.get(roles.get(person.personId)!));
    expect(new Set(about.map((person) => person.colour)).size).toBeGreaterThan(2);
    // The swatches show those colours.
    const swatches = await pane('legend').locator('li[data-role="vagrant"] .swatch, li[data-role^="traveller:"] .swatch').evaluateAll((items) => items.map((item) => getComputedStyle(item).backgroundColor));
    const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    expect(swatches).toEqual(wanted.map((entry) => rgb(entry[1])));
    // A copy of the pack that gives merchants another colour: the legend and the map follow it.
    expect(labels.roleColours['traveller:merchant']).not.toBe(OTHER_MERCHANT);
    await setTime(recoloured, time);
    await open(recoloured, BADANOS);
    expect(await outsidersListed()).toContainEqual(['traveller:merchant', OTHER_MERCHANT, labels.travellerKinds.merchant]);
    const merchants = new Set([...roles].filter(([, role]) => role === 'traveller:merchant').map(([personId]) => personId));
    const drawnMerchants = (await drawn()).people.filter((person) => merchants.has(person.personId));
    expect(drawnMerchants.length).toBeGreaterThan(0);
    expect(drawnMerchants.every((person) => person.colour === OTHER_MERCHANT)).toBe(true);
  });
});

describe('the town as laid out', () => {
  const CEVILEFON = 'settlement-3';
  const VERECELDO = 'settlement-455';
  const fact = (key: string, on: Page = page) => pane('summary', on).locator(`dd[data-fact="${key}"]`);
  const layoutOf = (settlementId: string, query = '') => main.get<Layout>(`/api/settlements/${settlementId}/layout${query}`);
  /** Opens a town as a named generator lays it out, and waits for the map to have drawn it. No people are waited for: none are shown. */
  async function openAs(settlementId: string, generator: string, on: Page = page): Promise<void> {
    await on.goto(`${viewer}/?api=${encodeURIComponent(main.url)}&generator=${generator}#${settlementId}/city`);
    await on.waitForFunction(() => document.querySelector('#inspector [data-fact="generator"]') !== null, null, { timeout: 90_000 });
    await settled(on);
  }

  it('names the generator in the town pane, and draws a town with a river', async () => {
    await setTime(main, at(1, 12, 30));
    await open(main, BADANOS);
    const layout = await layoutOf(BADANOS);
    expect(layout.summary.generator).toBe('grid');
    const rivers = layout.waters.filter((water) => water.kind === 'river');
    expect(rivers.length).toBeGreaterThan(0);
    expect(await fact('generator').innerText()).toBe('grid');
    expect(await pane('summary').locator('.layout-note').count()).toBe(0);
    // Badanos has no wall, so nothing is said of gates.
    expect(layout.walls).toHaveLength(0);
    expect(await fact('gates').count()).toBe(0);
    const state = await drawn();
    expect(state.town).toEqual({ generator: 'grid', rivers: rivers.length, walls: 0, gates: 0, places: layout.places.length, living: true });
    expect(state.people.length).toBeGreaterThan(900);
    expect(errors).toEqual([]);
  });

  // The grid has no walls or plazas: the staged generator's town is looked at beside it, by name, until it is the pack's.
  it('says how many gates a walled town has and how large its plaza is, and draws them, as the staged generator lays it out', async () => {
    for (const settlementId of [POMBAL, CEVILEFON, VERECELDO]) {
      await openAs(settlementId, 'staged');
      const layout = await layoutOf(settlementId, '?generator=staged');
      expect(layout.walls.length, settlementId).toBeGreaterThan(0);
      expect(layout.summary.counts.gates, settlementId).toBeGreaterThan(0);
      expect(await fact('generator').innerText(), settlementId).toBe('staged');
      expect(await fact('gates').innerText(), settlementId).toBe(String(layout.summary.counts.gates));
      const plazas = layout.places.filter((place) => place.kind === 'plaza');
      if (plazas.length > 0) {
        const area = plazas.reduce((sum, place) => sum + geometry.polygonArea(place.polygon), 0);
        expect(await fact('plaza').innerText(), settlementId).toBe(`${Math.round(area).toLocaleString('en-US')} m²`);
      } else {
        expect(await fact('plaza').count(), settlementId).toBe(0);
      }
      expect((await drawn()).town, settlementId).toEqual({
        generator: 'staged',
        rivers: layout.waters.filter((water) => water.kind === 'river').length,
        walls: layout.walls.length,
        gates: layout.summary.counts.gates,
        places: layout.places.length,
        living: false,
      });
    }
    // Pombal and Cevilefon have a plaza each.
    for (const settlementId of [POMBAL, CEVILEFON]) expect((await layoutOf(settlementId, '?generator=staged')).places.length, settlementId).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it('shows the grid\'s layout of the same town on ?generator=grid, without its people, and says so', async () => {
    const asked: string[] = [];
    const listen = (request: { url(): string }) => asked.push(request.url());
    page.on('request', listen);
    await setTime(main, at(1, 12, 30));
    await openAs(POMBAL, 'grid');
    expect(await fact('generator').innerText()).toBe('grid');
    // The grid has no wall and no plaza.
    expect(await fact('gates').count()).toBe(0);
    expect(await fact('plaza').count()).toBe(0);
    const note = await pane('summary').locator('.layout-note').innerText();
    expect(note).toMatch(/grid generator/);
    expect(note).toMatch(/People are not shown/);
    await page.waitForTimeout(1500);
    const state = await drawn();
    expect(state.town).toMatchObject({ generator: 'grid', walls: 0, gates: 0, places: 0, living: false });
    expect(state.people).toEqual([]);
    expect(state.avatar).toBeUndefined();
    expect(await page.locator('#inspector .street-count').innerText()).toBe('');
    // Nothing was asked of the server about anyone's movements, and the tools that act through the streets are put away.
    expect(asked.some((url) => url.includes('generator=grid'))).toBe(true);
    // (The page it was opened from may still have had a question in flight, so only what was asked after the
    // layout by name is looked at.)
    const since = asked.slice(asked.findIndex((url) => url.includes('generator=grid')));
    expect(since.filter((url) => /\/life\/trips|\/avatar\/perception/.test(url))).toEqual([]);
    expect(await page.locator('#inspector .map-tools button:visible').allInnerTexts()).toEqual(['⌂']);
    // A lot can still be looked at: hovering names it and clicking shows its building, and no menu offers to walk there.
    const layout = await layoutOf(POMBAL, '?generator=grid');
    const lot = layout.lots.find((entry) => {
      const [x, y] = toScreen(geometry.polygonCentroid(entry.polygon), state);
      return inTheClear(x, y, state.size);
    })!;
    const box = await canvasBox();
    const [x, y] = toScreen(geometry.polygonCentroid(lot.polygon), state);
    await page.mouse.move(box.x + x, box.y + y);
    await settled();
    expect((await drawn()).hover).toMatchObject({ kind: 'lot', id: lot.id });
    const avatarBefore = JSON.stringify(await main.get<AvatarReport>('/api/avatar'));
    await page.mouse.click(box.x + x, box.y + y);
    await page.waitForFunction(() => /building/i.test(document.querySelector('[data-pane="detail"] > .pane-head')?.textContent ?? ''), null, { timeout: 10_000 });
    expect(await page.locator('#inspector .map-menu').isVisible()).toBe(false);
    expect(JSON.stringify(await main.get<AvatarReport>('/api/avatar'))).toBe(avatarBefore);
    page.off('request', listen);
    // The layout served without the query is the pack's, as before.
    expect((await layoutOf(POMBAL)).summary.generator).toBe('grid');
    expect(errors).toEqual([]);
  });

  it('shows the staged layout when asked for by name, with the plaza a lot like any other under the cursor', async () => {
    await openAs(POMBAL, 'staged');
    expect(await fact('generator').innerText()).toBe('staged');
    expect(await pane('summary').locator('.layout-note').innerText()).toMatch(/staged generator.*People are not shown/s);
    const layout = await layoutOf(POMBAL, '?generator=staged');
    const state = await drawn();
    expect(state.town).toMatchObject({ generator: 'staged', walls: layout.walls.length, gates: layout.summary.counts.gates, places: layout.places.length, living: false });
    expect(state.people).toEqual([]);
    // The plaza is no rectangle's worth of assumption: the lot found under a point inside its polygon is its own.
    const plaza = layout.places.find((place) => place.kind === 'plaza') as Extract<(typeof layout.places)[number], { kind: 'plaza' }>;
    const lot = layout.lots.find((entry) => entry.buildingId === plaza.buildingId)!;
    expect(lot.footprints).toEqual([]);
    const inside = geometry.pointInPolygon(geometry.polygonCentroid(plaza.polygon), plaza.polygon) ? geometry.polygonCentroid(plaza.polygon) : undefined;
    expect(inside, 'the plaza\'s middle is inside it').toBeDefined();
    const [x, y] = toScreen(inside!, state);
    expect(inTheClear(x, y, state.size)).toBe(true);
    const box = await canvasBox();
    await page.mouse.move(box.x + x, box.y + y);
    await settled();
    expect((await drawn()).hover).toMatchObject({ kind: 'lot', id: lot.id });
    await page.mouse.move(5, 5);
    expect(errors).toEqual([]);
  });

  it('says what is wrong with a generator it does not have', async () => {
    // On a page of its own: the server's refusal is logged by the browser as a failed request.
    const other = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    await other.goto(`${viewer}/?api=${encodeURIComponent(main.url)}&generator=rings#${BADANOS}/city`);
    await other.waitForFunction(() => /generator must be one of grid, staged;/.test(document.querySelector('#inspector .map-note')?.textContent ?? ''), null, { timeout: 90_000 });
    expect(await fact('generator', other).count()).toBe(0);
    await other.close();
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
