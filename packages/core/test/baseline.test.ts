/**
 * Counts that must not move, and the one time some of them did.
 *
 * `badanos-counts.json` was saved from generator version 1, before phase 2.5
 * changed how people are placed. Population, workforce and the seven category
 * counts are fixed points of every later change.
 *
 * `badanos-counts-v3.json` was saved from generator version 3 (phase 6B),
 * which gives a settlement civic buildings by its size. Their staff are fixed
 * posts, so occupation counts inside a category moved, once and on purpose;
 * the file's note says what moved and why.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/index.ts';
import { medievalPack, medievalPackBefore6B, settlement } from './pack.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`./baselines/${name}`, import.meta.url), 'utf8'));
const first = read('badanos-counts.json');
const baseline = read('badanos-counts-v3.json');

describe('Badanos counts, against the saved baselines', () => {
  const { summary, buildings } = generateCity(settlement('settlement-641'), medievalPack());

  it('were saved from generator versions 1 and 3 with the default seed', () => {
    expect(first).toMatchObject({ settlementId: 'settlement-641', generatorVersion: 1, seed: summary.seed });
    expect(baseline).toMatchObject({ settlementId: 'settlement-641', generatorVersion: 3, seed: summary.seed });
    expect(baseline.note).toMatch(/civic buildings/);
  });

  it('has the same residents, workforce and category counts as ever', () => {
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
    expect(summary.categories).toEqual(first.categories);
    expect(summary.categories).toEqual(baseline.categories);
    expect(baseline.population).toBe(first.population);
    expect(baseline.workforce).toBe(first.workforce);
  });

  it('has the same count for every occupation as the version 3 baseline', () => {
    expect(summary.occupations).toMatchObject({ tanner: 417, servant: 305, weaponsmith: 254, leatherworker: 250, armourer: 191 });
    expect(summary.occupations).toEqual(baseline.occupations);
    expect(buildings).toHaveLength(baseline.buildings);
  });

  it('moved only where the baseline says, by the civic posts and the slots they took', () => {
    const moved = baseline.moved as Record<string, [number, number]>;
    for (const id of new Set([...Object.keys(first.occupations), ...Object.keys(summary.occupations)])) {
      const before = first.occupations[id] ?? 0;
      const after = summary.occupations[id] ?? 0;
      if (id in moved) expect([before, after], id).toEqual(moved[id]);
      else expect(after, id).toBe(before);
    }
    // What the new posts gained, the rest of their categories gave up.
    const net = Object.values(moved).reduce((sum, [before, after]) => sum + after - before, 0);
    expect(net).toBe(0);
    expect(Object.entries(moved).filter(([, [before]]) => before === 0).map(([id]) => id).sort()).toEqual(
      ['alderman', 'bath-attendant', 'bath-keeper', 'granary-keeper', 'guild-clerk', 'guild-master', 'guild-registrar', 'guild-steward', 'infirmarer', 'nurse', 'oven-keeper', 'town-clerk'],
    );
  });

  it('are those of the first baseline again when the pack has no civic buildings', () => {
    const without = generateCity(settlement('settlement-641'), medievalPackBefore6B());
    expect(without.summary.occupations).toEqual(first.occupations);
    expect(without.buildings).toHaveLength(1772);
  });
});
