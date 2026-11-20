/**
 * Counts that must not move. The baseline was saved from generator version 1
 * before phase 2.5 changed how people are placed; category and occupation
 * counts are fixed points of every later change.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/index.ts';
import { medievalPack, settlement } from './pack.ts';

const baseline = JSON.parse(readFileSync(new URL('./baselines/badanos-counts.json', import.meta.url), 'utf8'));

describe('Badanos counts, against the saved baseline', () => {
  const { summary } = generateCity(settlement('settlement-641'), medievalPack());

  it('was saved from generator version 1 with the default seed', () => {
    expect(baseline).toMatchObject({ settlementId: 'settlement-641', generatorVersion: 1, seed: summary.seed });
  });

  it('has the same residents, workforce and category counts', () => {
    expect(summary.population).toBe(9607);
    expect(summary.workforce.working).toBe(4419);
    expect(summary.categories).toEqual({
      food: 637,
      utilities: 425,
      services: 1020,
      construction: 425,
      military: 213,
      luxury: 212,
      trade: 1487,
    });
    expect(summary.categories).toEqual(baseline.categories);
  });

  it('has the same count for every occupation', () => {
    expect(summary.occupations).toMatchObject({ tanner: 418, servant: 311, weaponsmith: 255, leatherworker: 251, armourer: 191 });
    expect(summary.occupations).toEqual(baseline.occupations);
  });
});
