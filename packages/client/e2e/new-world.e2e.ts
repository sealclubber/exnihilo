/**
 * Phase 7A, step 6: a world made from a seed by the world command opens in the viewer, and a town in it can be
 * entered: its map is drawn with its people walking.
 *
 * Run with `npm run test:viewer`. It needs a browser: `npx playwright install chromium`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { type Browser, type Page, chromium } from 'playwright';
import { type ViteDevServer, createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { World } from '@worldsim/core';
import { medievalPack } from '../../core/test/pack.ts';
import { buildApp } from '../../server/src/app.ts';
import { AvatarKeeper } from '../../server/src/avatar.ts';
import { WorldClock } from '../../server/src/clock.ts';
import { WorldStore } from '../../server/src/storage.ts';
import { createWorldFile } from '../../server/src/world-command.ts';

const saved = JSON.parse(readFileSync(new URL('../../../fixtures/worlds/archipelago-5000.json', import.meta.url), 'utf8'));

let folder: string;
let world: World;
let app: FastifyInstance;
let api: string;
let vite: ViteDevServer;
let viewer: string;
let browser: Browser;
let page: Page;
const errors: string[] = [];

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'worldsim-new-world-'));
  const storePath = join(folder, 'world.sqlite');
  await createWorldFile(saved.options, storePath);
  const store = new WorldStore(storePath);
  world = store.loadWorld();
  const report = store.loadReport();
  store.close();
  const pack = medievalPack();
  const clock = new WorldClock({ now: () => Date.now(), rates: pack.time.rates, defaultRate: pack.time.defaultRate });
  app = buildApp(world, report, pack, { clock, avatar: new AvatarKeeper() });
  api = await app.listen({ host: '127.0.0.1', port: 0 });
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  viewer = vite.resolvedUrls!.local[0]!.replace(/\/$/, '');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
});

afterAll(async () => {
  await browser?.close();
  await vite?.close();
  await app?.close();
  if (folder) rmSync(folder, { recursive: true, force: true });
});

describe('a world made from a seed, in the viewer', () => {
  it('opens on its world map with its name and its settlements', async () => {
    await page.goto(`${viewer}/?api=${encodeURIComponent(api)}`);
    await page.waitForFunction(() => /settlements/.test(document.querySelector('#status')?.textContent ?? ''), null, { timeout: 60_000 });
    expect(await page.locator('#world-name').textContent()).toBe(world.info.name);
    expect(await page.locator('#status').textContent()).toBe(`${world.settlements.length.toLocaleString('en-US')} settlements`);
    expect(errors).toEqual([]);
  });

  it('lets its largest town be entered, its people walking', async () => {
    const largest = [...world.settlements].sort((a, b) => b.population - a.population)[0]!;
    await page.goto(`${viewer}/?api=${encodeURIComponent(api)}#${largest.id}/city`);
    await page.waitForFunction(() => /walking/.test(document.querySelector('#inspector .street-count')?.textContent ?? ''), null, { timeout: 90_000 });
    expect(await page.locator('#inspector .town-map canvas').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  });
});
