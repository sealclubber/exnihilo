/**
 * Phase 7A, step 6: the world command makes a world from a seed, a template and a number of points and stores
 * it as the import command stores an export, replacing what the store held.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorldStore } from '../src/storage.ts';
import { createWorldFile } from '../src/world-command.ts';
import { importFile } from '../src/import-command.ts';
import { LOMIA_PATH } from '../../core/test/fixture.ts';

const saved = JSON.parse(readFileSync(new URL('../../../fixtures/worlds/archipelago-5000.json', import.meta.url), 'utf8'));
let folder: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'worldsim-world-'));
});
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the world command', () => {
  it('stores a world made from a seed, in place of the one the store held', async () => {
    const path = join(folder, 'made.sqlite');
    importFile(LOMIA_PATH, path);
    const report = await createWorldFile(saved.options, path);
    expect(report.counts.settlements).toBe(saved.fingerprint.burgs);
    expect(report.source.version).toBe('1.159.0');
    const store = new WorldStore(path);
    const world = store.loadWorld();
    expect(world.info.name).not.toBe('Lomia');
    expect(world.settlements).toHaveLength(saved.fingerprint.burgs);
    expect(store.loadReport()).toEqual(report);
    store.close();
  });

  it('refuses a template that is not procedural, storing nothing', async () => {
    const path = join(folder, 'refused.sqlite');
    await expect(createWorldFile({ ...saved.options, template: 'europe' }, path)).rejects.toThrow(/generation\.template must be one of/);
    const store = new WorldStore(path);
    expect(store.hasWorld()).toBe(false);
    store.close();
  });
});
