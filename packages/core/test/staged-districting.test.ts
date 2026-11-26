import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/index.ts';
import { type DistrictingInput, drawDistricts } from '../src/layout/staged/districting.ts';
import { planTown, stagedSettings, townInput } from '../src/layout/staged/plan.ts';
import type { Point } from '../src/schema.ts';
import { lomiaWorld, medievalPack } from './pack.ts';

const rules = stagedSettings(medievalPack()).districts.drawn as NonNullable<ReturnType<typeof stagedSettings>['districts']['drawn']>;

/** A grid of square blocks, each its own ward, with so many kept houses in each; blocks beside each other touch. */
function grid(columns: number, rows: number, housesIn: (column: number, row: number) => number) {
  const blocks: Array<{ polygon: Point[] }> = [];
  const houses: Array<{ block: number; ward: number }> = [];
  const tilesBeside: number[][] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const block = blocks.length;
      blocks.push({ polygon: [[column * 10, row * 10], [column * 10 + 9, row * 10], [column * 10 + 9, row * 10 + 9], [column * 10, row * 10 + 9]] });
      for (let house = 0; house < housesIn(column, row); house++) houses.push({ block, ward: block });
      tilesBeside.push(
        [
          [column - 1, row],
          [column + 1, row],
          [column, row - 1],
          [column, row + 1],
        ]
          .filter(([c, r]) => (c as number) >= 0 && (c as number) < columns && (r as number) >= 0 && (r as number) < rows)
          .map(([c, r]) => (r as number) * columns + (c as number)),
      );
    }
  }
  return { blocks, wards: blocks, houses, kept: houses.map((_, index) => index), tilesBeside };
}

/** Every kept house in exactly one district, by its block, or lent from it. */
function housesBy(input: DistrictingInput, drawn: ReturnType<typeof drawDistricts>): number[] {
  const count = input.targets.map(() => 0);
  const inBlock = input.blocks.map(() => 0);
  for (const house of input.kept) {
    const block = (input.houses[house] as { block: number }).block;
    inBlock[block] = (inBlock[block] as number) + 1;
  }
  inBlock.forEach((houses, block) => {
    if (houses === 0) return;
    const of = drawn.blockDistrict[block];
    expect(of).toBeDefined();
    const lent = drawn.lent.get(block);
    count[of as number] = (count[of as number] as number) + houses - (lent?.houses ?? 0);
    if (lent) {
      expect(lent.houses).toBeLessThan(houses);
      count[lent.to] = (count[lent.to] as number) + lent.houses;
    }
  });
  return count;
}

describe('the districts stage', () => {
  it('draws districts of exactly their counts, each in one piece, on one bank', () => {
    const town = grid(6, 6, (column, row) => 1 + ((column * 7 + row * 3) % 4));
    const total = town.kept.length;
    const input: DistrictingInput = { rules, ...town, links: [], seeds: [0, 35, 5], targets: [Math.floor(total / 2), Math.floor(total / 3), total - Math.floor(total / 2) - Math.floor(total / 3)] };
    const drawn = drawDistricts(input);
    expect(drawn.off).toBe(0);
    expect(drawn.inPieces).toBe(0);
    expect(housesBy(input, drawn)).toEqual(input.targets);
    expect(drawn.have).toEqual(input.targets);
  });

  it('carries a district too large for its bank over a bridge, its two parts joined there', () => {
    // Two banks of 3 by 3 blocks, five houses each, a bridge from the right edge of one to the left edge of the other.
    const left = grid(3, 3, () => 5);
    const right = grid(3, 3, () => 5);
    const offset = left.blocks.length;
    const blocks = [...left.blocks, ...right.blocks.map((block) => ({ polygon: block.polygon.map(([x, y]) => [x + 100, y] as Point) }))];
    const houses = [...left.houses, ...right.houses.map((house) => ({ block: house.block + offset, ward: house.ward + offset }))];
    const tilesBeside = [...left.tilesBeside, ...right.tilesBeside.map((list) => list.map((block) => block + offset))];
    // Both districts start on the left bank; the larger wants more than that bank holds.
    const input: DistrictingInput = { rules, blocks, wards: blocks, houses, kept: houses.map((_, index) => index), tilesBeside, links: [{ a: 5, b: offset + 3 }], seeds: [0, 3], targets: [60, 30] };
    const drawn = drawDistricts(input);
    expect(drawn.spans).toBe(1);
    expect(drawn.inPieces).toBe(0);
    expect(drawn.off).toBe(0);
    expect(housesBy(input, drawn)).toEqual([60, 30]);
    // The bridgeheads are the crossing district's.
    expect(drawn.blockDistrict[5]).toBe(drawn.blockDistrict[offset + 3]);
  });

  it('gives the same districts for the same input', () => {
    const town = grid(5, 4, (column, row) => (column + row) % 3);
    const input: DistrictingInput = { rules, ...town, links: [], seeds: [0, 19], targets: [town.kept.length - 7, 7] };
    expect(drawDistricts(input)).toEqual(drawDistricts(input));
  });

  // The regression towns of sim-6g.md, beside the current pipeline, with the reference's targets (each district's
  // buildings scaled to the kept total): each figure is the reference's own.
  const expected: Record<string, { offAfterChains: number; off: number; lent: number; spans: number; reseeded: number }> = {
    Karlen: { offAfterChains: 5, off: 0, lent: 4, spans: 1, reseeded: 0 },
    Haurinen: { offAfterChains: 4, off: 0, lent: 7, spans: 2, reseeded: 1 },
    Borfino: { offAfterChains: 73, off: 26, lent: 29, spans: 1, reseeded: 0 },
  };
  for (const [name, want] of Object.entries(expected)) {
    it(`gives ${name} the reference's figures`, () => {
      const pack = medievalPack();
      const brief = lomiaWorld().settlements.find((settlement) => settlement.name === name);
      if (!brief) throw new Error(`no settlement ${name}`);
      const plan = planTown(brief, townInput(generateCity(brief, pack), pack), pack);
      const kept = plan.selection.district.flatMap((of, house) => (of === undefined ? [] : [house]));
      const all = plan.districts.reduce((sum, district) => sum + district.buildings, 0);
      const drawn = drawDistricts({ rules, blocks: plan.blocks, wards: plan.wards, houses: plan.houses, kept, tilesBeside: plan.tilesBeside, links: plan.links, seeds: plan.forecast.seeds, targets: plan.districts.map((district) => (district.buildings * kept.length) / all) });
      expect({ offAfterChains: drawn.offAfterChains, off: drawn.off, lent: drawn.lent.size, spans: drawn.spans, reseeded: drawn.reseeded }).toEqual(want);
      expect(drawn.inPieces).toBe(0);
      expect(drawn.islands).toBe(0);
    });
  }
});
