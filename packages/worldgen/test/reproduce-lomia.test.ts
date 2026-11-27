/**
 * Phase 7A, step 1: AFMG's generator, bundled from `vendor/afmg/` and run headless with Lomia's saved `map` and
 * `generation` options, makes Lomia again, as `fixtures/afmg/lomia.json` was exported: every raw and refined
 * cell, and every burg in every field but its coat of arms (`coa`).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildBundle } from '../scripts/build.ts';
import { type Generated, loadGenerator } from '../src/generator.ts';

const lomia = JSON.parse(readFileSync(new URL('../../../fixtures/afmg/lomia.json', import.meta.url), 'utf8'));
const lomiaOptions = { map: lomia.settings.options.map, generation: lomia.settings.options.generation };
/** Burgs that exist: AFMG keeps an empty first entry, and removed burgs in place. */
const live = (burgs: any[]) => burgs.filter((burg) => burg && burg.i && !burg.removed);

let made: Generated;

beforeAll(async () => {
  await buildBundle();
  made = await (await loadGenerator()).generate(lomiaOptions);
});

/** For each field, how many cells of the fixture's list the generated column matches. */
const equalCells = (columns: Record<string, ArrayLike<unknown>>, cells: any[], fields: string[]) =>
  Object.fromEntries(fields.map((field) => [field, cells.filter((cell, index) => columns[field]?.[index] === cell[field]).length]));

describe("Lomia's cells", () => {
  it('has every raw cell as exported: height, temperature, rainfall', () => {
    expect(made.grid.cells.h.length).toBe(9936);
    expect(equalCells(made.grid.cells, lomia.grid.cells, ['h', 'temp', 'prec'])).toEqual({ h: 9936, temp: 9936, prec: 9936 });
  });

  it('has every refined cell as exported: height, biome, river, burg, state, culture, population', () => {
    const fields = ['h', 'biome', 'r', 'burg', 'state', 'culture', 'pop'];
    expect(made.pack.cells.h.length).toBe(4605);
    expect(equalCells(made.pack.cells, lomia.pack.cells, fields)).toEqual(Object.fromEntries(fields.map((field) => [field, 4605])));
  });
});

describe("Lomia's burgs, states, routes and rivers", () => {
  it('has the 682 burgs as exported in every field but the coat of arms', () => {
    const mine = live(made.pack.burgs);
    const theirs = live(lomia.pack.burgs);
    expect(mine.length).toBe(682);
    expect(theirs.length).toBe(682);
    const differing: Record<string, number> = {};
    theirs.forEach((burg, index) => {
      for (const field of new Set([...Object.keys(burg), ...Object.keys(mine[index])])) {
        if (JSON.stringify(mine[index][field]) !== JSON.stringify(burg[field])) differing[field] = (differing[field] ?? 0) + 1;
      }
    });
    expect(differing).toEqual({ coa: 682 });
  });

  it('has 24 states, 606 routes and 156 rivers, as exported', () => {
    expect([made.pack.states.length, made.pack.routes.length, made.pack.rivers.length]).toEqual([24, 606, 156]);
    expect([lomia.pack.states.length, lomia.pack.routes.length, lomia.pack.rivers.length]).toEqual([24, 606, 156]);
  });
});
