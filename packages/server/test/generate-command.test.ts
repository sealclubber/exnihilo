import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CitySchema } from '@worldsim/core';
import { LOMIA_PATH } from '../../core/test/fixture.ts';
import { MEDIEVAL_PATH } from '../../core/test/pack.ts';
import { cityToJson, generateToDisk } from '../src/generate-command.ts';
import { importFile } from '../src/import-command.ts';
import { WorldStore } from '../src/storage.ts';

let folder: string;
let storePath: string;
const request = (settlementId: string, extra: object = {}) => ({
  settlementId,
  storePath,
  packPath: MEDIEVAL_PATH,
  outFolder: join(folder, 'cities'),
  ...extra,
});

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'worldsim-generate-'));
  storePath = join(folder, 'world.sqlite');
  importFile(LOMIA_PATH, storePath);
});
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the generate command', () => {
  it('writes a settlement\'s records as JSON and a readable summary', () => {
    const result = generateToDisk(request('settlement-641'));
    expect(result.recordsPath).toBe(join(folder, 'cities', 'settlement-641', 'city.json'));
    expect(result.summaryPath).toBe(join(folder, 'cities', 'settlement-641', 'summary.txt'));

    const written = JSON.parse(readFileSync(result.recordsPath, 'utf8'));
    expect(CitySchema.parse(written)).toEqual(result.city);
    expect(written.people).toHaveLength(9607);

    const text = readFileSync(result.summaryPath, 'utf8');
    expect(text).toBe(result.summaryText);
    expect(text).toContain('Badanos (settlement-641)');
    expect(text).toContain('pack medieval 0.5.0');
    expect(text).toMatch(/Residents\s+9,607/);
    expect(text).toMatch(/Working\s+4,419\s+46\.0%/);
    expect(text).toMatch(/Trade\s+1,487\s+33\.7%/);
    expect(text).toMatch(/Tanner\s+\d+/);
    expect(text).toMatch(/Provincial administration hall\s+1\n/);
    expect(text).not.toMatch(/undefined|NaN/);
  });

  it('writes one record per line', () => {
    const { city } = generateToDisk(request('settlement-455'));
    const lines = cityToJson(city).split('\n');
    expect(lines.filter((line) => line.startsWith('    {"id":"person-455-'))).toHaveLength(253);
    expect(JSON.parse(cityToJson(city))).toEqual(JSON.parse(JSON.stringify(city)));
  });

  it('writes the same bytes each time, and different people when the seed is overridden', () => {
    const first = readFileSync(generateToDisk(request('settlement-455')).recordsPath, 'utf8');
    const second = readFileSync(generateToDisk(request('settlement-455')).recordsPath, 'utf8');
    expect(second).toBe(first);
    const other = generateToDisk(request('settlement-455', { seed: 7 }));
    expect(other.city.summary.seed).toBe(7);
    expect(other.city.people).toHaveLength(253);
    expect(readFileSync(other.recordsPath, 'utf8')).not.toBe(first);
    expect(other.summaryText).toContain('seed 7');
  });

  it('fails with a readable message for an unknown settlement, a missing pack or an empty store', () => {
    expect(() => generateToDisk(request('badanos'))).toThrow(/no settlement has the ID "badanos"/);
    expect(() => generateToDisk(request('settlement-641', { packPath: join(folder, 'nopack') }))).toThrow(/cannot be read/);
    expect(() => generateToDisk(request('settlement-641', { storePath: join(folder, 'empty.sqlite') }))).toThrow(/import one first/);
  });

  it('leaves the world store exactly as it was', () => {
    const dump = () => {
      const store = new WorldStore(storePath);
      const text = store.dump();
      store.close();
      return text;
    };
    const before = dump();
    generateToDisk(request('settlement-641'));
    expect(dump()).toBe(before);
  });
});
