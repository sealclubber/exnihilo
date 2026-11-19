import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImportResult, importAfmg } from '@worldsim/core';
import { LOMIA_PATH, loadLomia } from '../../core/test/fixture.ts';
import { formatReport, importFile } from '../src/import-command.ts';
import { WorldStore, WorldStoreError } from '../src/storage.ts';

let folder: string;
let imported: ImportResult;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'worldsim-test-'));
  imported = importAfmg(loadLomia());
});
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('WorldStore', () => {
  it('returns exactly the world and report that were saved', () => {
    const store = new WorldStore(':memory:');
    store.save(imported.world, imported.report);
    expect(store.hasWorld()).toBe(true);
    expect(JSON.stringify(store.loadWorld())).toBe(JSON.stringify(imported.world));
    expect(store.loadReport()).toEqual(imported.report);
    store.close();
  });

  it('refuses to load from a store that holds no world', () => {
    const store = new WorldStore(':memory:');
    expect(store.hasWorld()).toBe(false);
    expect(() => store.loadWorld()).toThrow(WorldStoreError);
    expect(() => store.loadReport()).toThrow(/import/);
    store.close();
  });

  it('replaces the previous world rather than adding to it', () => {
    const store = new WorldStore(':memory:');
    const smaller = { ...imported.world, settlements: imported.world.settlements.slice(0, 3) };
    store.save(imported.world, imported.report);
    store.save(smaller, imported.report);
    expect(store.loadWorld().settlements).toHaveLength(3);
    store.close();
  });

  it('keeps a world on disk between openings, creating the folder if needed', () => {
    const path = join(folder, 'nested', 'kept.sqlite');
    const first = new WorldStore(path);
    first.save(imported.world, imported.report);
    first.close();
    const second = new WorldStore(path);
    expect(second.loadWorld().info.name).toBe('Lomia');
    second.close();
  });
});

describe('the import command', () => {
  it('stores the Lomia export and reports what it imported', () => {
    const path = join(folder, 'lomia.sqlite');
    const report = importFile(LOMIA_PATH, path);
    expect(report.counts.settlements).toBe(682);

    const store = new WorldStore(path);
    const world = store.loadWorld();
    store.close();
    expect(world.settlements).toHaveLength(682);
    expect(world.settlements.find((brief) => brief.id === 'settlement-641')?.name).toBe('Badanos');

    const text = formatReport(report);
    expect(text).toContain('settlements    682');
    expect(text).toContain('province-without-seat');
    expect(text).toContain('pack.markets');
  });

  it('leaves identical data when the same file is imported twice', () => {
    const once = join(folder, 'once.sqlite');
    const twice = join(folder, 'twice.sqlite');
    importFile(LOMIA_PATH, once);
    importFile(LOMIA_PATH, twice);
    importFile(LOMIA_PATH, twice);

    const dump = (path: string) => {
      const store = new WorldStore(path);
      const text = store.dump();
      store.close();
      return text;
    };
    expect(dump(twice)).toBe(dump(once));
    expect(dump(once).length).toBeGreaterThan(1_000_000);
  });

  it('fails with a readable message when the file is missing or not JSON', () => {
    expect(() => importFile(join(folder, 'absent.json'), ':memory:')).toThrow(/cannot read/);
    expect(() => importFile(join(folder, 'lomia.sqlite'), ':memory:')).toThrow(/cannot read/);
  });

  it('leaves the stored world untouched when an import fails', () => {
    const path = join(folder, 'guarded.sqlite');
    importFile(LOMIA_PATH, path);
    expect(() => importFile(join(folder, 'absent.json'), path)).toThrow();
    const store = new WorldStore(path);
    expect(store.loadWorld().settlements).toHaveLength(682);
    store.close();
  });
});
