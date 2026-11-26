import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/index.ts';
import { type DistrictingInput, drawDistricts, houseDistricts } from '../src/layout/staged/districting.ts';
import { planTown, stagedSettings, townInput } from '../src/layout/staged/plan.ts';
import type { Point } from '../src/schema.ts';
import { lomiaWorld, medievalPack } from './pack.ts';

const rules = stagedSettings(medievalPack()).districts.drawn as NonNullable<ReturnType<typeof stagedSettings>['districts']['drawn']>;

type House = { block: number; ward: number; centre: Point };

/** A grid of square blocks, each its own ward, with so many kept houses in each; blocks beside each other touch. */
function grid(columns: number, rows: number, housesIn: (column: number, row: number) => number, shift = 0) {
  const blocks: Array<{ polygon: Point[] }> = [];
  const houses: House[] = [];
  const tilesBeside: number[][] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const block = blocks.length;
      const x = column * 10 + shift;
      blocks.push({ polygon: [[x, row * 10], [x + 9, row * 10], [x + 9, row * 10 + 9], [x, row * 10 + 9]] });
      for (let house = 0; house < housesIn(column, row); house++) houses.push({ block, ward: block, centre: [x + 1 + house, row * 10 + 4.5] });
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

/** How many pieces a district's blocks make, blocks beside each other or joined by a bridge counting as touching. */
function piecesOf(input: DistrictingInput, blockDistrict: ReadonlyArray<number | undefined>, district: number): number {
  const mine = new Set(blockDistrict.flatMap((of, block) => (of === district ? [block] : [])));
  const beside = (block: number) => [...(input.tilesBeside[block] ?? []), ...input.links.flatMap((link) => (link.a === block ? [link.b] : link.b === block ? [link.a] : []))];
  let pieces = 0;
  while (mine.size > 0) {
    pieces++;
    const stack = [mine.values().next().value as number];
    mine.delete(stack[0] as number);
    while (stack.length > 0) {
      for (const next of beside(stack.pop() as number)) {
        if (!mine.has(next)) continue;
        mine.delete(next);
        stack.push(next);
      }
    }
  }
  return pieces;
}

describe('the districts stage', () => {
  it('cuts one bank into districts near their counts, each in one piece, and every house gets exactly one district', () => {
    const town = grid(8, 8, (column, row) => 1 + ((column * 7 + row * 3) % 4));
    const total = town.kept.length;
    const targets = [Math.floor(total / 2), Math.floor(total / 3), total - Math.floor(total / 2) - Math.floor(total / 3)];
    const input = { rules, ...town, links: [], seeds: [0, 63, 7], targets };
    const drawn = drawDistricts(input);
    expect(drawn.inPieces).toBe(0);
    expect(drawn.islands).toBe(0);
    for (let district = 0; district < targets.length; district++) expect(piecesOf(input, drawn.blockDistrict, district)).toBe(1);
    // Every block with houses has a district.
    town.houses.forEach((house) => expect(drawn.blockDistrict[house.block]).toBeDefined());
    // The ground is near the counts; the houses are exactly at them.
    expect(drawn.off).toBeLessThanOrEqual(Math.ceil(total * 0.05));
    const settled = houseDistricts(drawn, input);
    expect(settled.kept).toEqual(targets);
    expect(settled.district.every((of) => of !== undefined)).toBe(true);
  });

  it('carries a district too large for its bank over a bridge, its two parts joined there', () => {
    // Two banks of 3 by 3 blocks, five houses each, a bridge from the right edge of one to the left edge of the other.
    const left = grid(3, 3, () => 5);
    const right = grid(3, 3, () => 5, 100);
    const offset = left.blocks.length;
    const blocks = [...left.blocks, ...right.blocks];
    const houses = [...left.houses, ...right.houses.map((house) => ({ ...house, block: house.block + offset, ward: house.ward + offset }))];
    const tilesBeside = [...left.tilesBeside, ...right.tilesBeside.map((list) => list.map((block) => block + offset))];
    // Both districts start on the left bank; the larger wants more than that bank holds.
    const input = { rules, blocks, wards: blocks, houses, kept: houses.map((_, index) => index), tilesBeside, links: [{ a: 5, b: offset + 3 }], seeds: [0, 3], targets: [60, 30] };
    const drawn = drawDistricts(input);
    expect(drawn.spans).toBe(1);
    expect(drawn.inPieces).toBe(0);
    // The bridgeheads are the crossing district's, and the bridge is what joins its two parts.
    expect(drawn.blockDistrict[5]).toBe(drawn.blockDistrict[offset + 3]);
    expect(piecesOf(input, drawn.blockDistrict, drawn.blockDistrict[5] as number)).toBe(1);
    expect(houseDistricts(drawn, input).kept).toEqual([60, 30]);
  });

  it('leaves open country to nobody', () => {
    // Four columns of houses, then eleven empty columns.
    const town = grid(15, 3, (column) => (column < 4 ? 4 : 0));
    const input = { rules, ...town, links: [], seeds: [0, 3], targets: [24, 24] };
    const drawn = drawDistricts(input);
    expect(drawn.openCountry).toBeGreaterThan(20);
    for (let row = 0; row < 3; row++) expect(drawn.blockDistrict[row * 15 + 14]).toBeUndefined();
    expect(houseDistricts(drawn, input).kept).toEqual([24, 24]);
  });

  it('brings a waterside district to the water', () => {
    // The water lies along the left edge; the waterside district's forecast seed is at the far right.
    const town = grid(8, 4, () => 3);
    const water = town.blocks.map((_, block) => (block % 8) * 10);
    const input = { rules, ...town, links: [], seeds: [31, 16], targets: [48, 48], waterside: [true, false], water, waterReach: 5 };
    const drawn = drawDistricts(input);
    expect(drawn.blockDistrict.some((of, block) => of === 0 && (water[block] as number) <= 5)).toBe(true);
    expect(drawn.inPieces).toBe(0);
  });

  it('gives the same districts for the same input', () => {
    const town = grid(5, 4, (column, row) => (column + row) % 3);
    const input: DistrictingInput = { rules, ...town, links: [], seeds: [0, 19], targets: [town.kept.length - 7, 7] };
    expect(drawDistricts(input)).toEqual(drawDistricts(input));
  });

  // Towns that each broke an earlier version of the stage: bank sharing (Karlen), a bank with no bridge (Haurinen),
  // a far bank hemmed in at its bridgehead (Borfino), a district striped across the river (Charoy), a bridgehead
  // inland of the plaza (Puerda), and a harbour that did not reach the water (Pombal, in `staged-town.test.ts`).
  for (const name of ['Karlen', 'Haurinen', 'Borfino', 'Charoy', 'Puerda']) {
    it(`draws ${name} whole, near its counts, and exact house by house`, () => {
      const pack = medievalPack();
      const brief = lomiaWorld().settlements.find((settlement) => settlement.name === name);
      if (!brief) throw new Error(`no settlement ${name}`);
      const plan = planTown(brief, townInput(generateCity(brief, pack), pack), pack);
      const drawn = plan.drawn;
      expect(drawn.inPieces).toBe(0);
      expect(drawn.islands).toBe(0);
      expect(drawn.unclaimed).toBe(0);
      // The ground misses the counts by under 2% of the town's houses.
      expect(drawn.off / plan.selection.chosen.length).toBeLessThan(0.02);
      // Every district has exactly its count of houses.
      expect(drawn.kept).toEqual(drawn.targets);
    });
  }
});
