/**
 * Stage 11 of the staged generator: selection. Make too many, keep the best.
 *
 * More houses were made than the town has. The town keeps exactly as many
 * as it has buildings, the best-placed first: the innermost are always
 * kept, as is everything inside the wall, and further out keeping a house
 * is more and more a matter of chance. The rest never existed. Each kept
 * house then belongs to the district of its block, and each district's
 * count is made exact at its borders: whole blocks change district first,
 * from one with too many kept houses to a neighbour with too few, and what
 * remains is settled house by house.
 */
import type { StagedSettings } from '../../pack/schema.ts';
import { type Block, wardRng } from './blocks.ts';
import { polygonCentroid } from '../geometry.ts';
import type { DistrictPlan } from './districts.ts';
import type { Ground } from './ground.ts';
import type { House } from './rows.ts';
import type { Wall } from './wall.ts';
import type { Ward } from './wards.ts';

export interface Selection {
  /** For each block, the district it belongs to: its ward's, unless it was moved to a neighbour that was short. */
  blockDistrict: Array<number | undefined>;
  /** How many blocks changed district at the borders. */
  moved: number;
  /** For each house made, the district that keeps it, by its place in the city's list; nothing for a house not kept. */
  district: Array<number | undefined>;
  /** How many houses each district keeps, and how many of them came from wards outside it. */
  kept: number[];
  borrowed: number[];
  /** How many houses the town is short of: nothing may be built until this is none. */
  short: number;
}

export interface SelectionInput {
  settings: StagedSettings;
  seed: number;
  houses: readonly House[];
  blocks: readonly Block[];
  wards: readonly Ward[];
  plan: DistrictPlan;
  /** How many houses each district is to keep. */
  wanted: readonly number[];
  ground: Ground;
  wall?: Wall;
}

export function chooseHouses({ settings, seed, houses, blocks, wards, plan, wanted, ground, wall }: SelectionInput): Selection {
  const rules = settings.selection;
  const base = houses.map((house) => ground.rank(house.centre) * (wall?.inside(house.centre) ? rules.insideWall : 1));
  const walled = houses.map((house) => wall?.inside(house.centre) ?? false);
  // A house's luck comes from its ward's own stream, in the order its houses were made.
  const luck = new Float64Array(houses.length);
  const streams = new Map<number, ReturnType<typeof wardRng>>();
  houses.forEach((house, index) => {
    let rng = streams.get(house.ward);
    if (!rng) streams.set(house.ward, (rng = wardRng(seed, wards[house.ward] as Ward, 'selection')));
    luck[index] = -Math.log(1 - rng.next()) * rules.luck;
  });

  // ---- The town's houses, chosen as one town --------------------------------------------------------------------
  // The innermost of the town's count are solid, as is everything inside the wall; beyond that edge, luck.
  const total = wanted.reduce((sum, want) => sum + want, 0);
  const inOrder = houses.map((_, index) => index).sort((a, b) => (base[a] as number) - (base[b] as number) || a - b);
  const edge = base[inOrder[Math.min(inOrder.length - 1, Math.floor(rules.solid * total))] as number] ?? 0;
  const score = new Float64Array(houses.length);
  houses.forEach((_, index) => (score[index] = (base[index] as number) + (walled[index] ? 0 : Math.max((base[index] as number) - edge, 0) * (luck[index] as number))));
  const chosen = houses.map((_, index) => index).sort((a, b) => (score[a] as number) - (score[b] as number) || a - b).slice(0, total);
  const short = total - chosen.length;
  const isKept = new Uint8Array(houses.length);
  for (const index of chosen) isKept[index] = 1;

  // ---- Each district's count made exact -----------------------------------------------------------------------
  // A kept house belongs to the district of its block. Wards are coarse, so a district may hold more kept houses
  // than it has buildings, or fewer. Whole blocks at the borders change district first, from a district with
  // too many to a neighbour with too few; what remains is settled house by house. Nothing is made again.
  const blockDistrict = blocks.map((block) => plan.of[block.ward]);
  const keptIn = blocks.map(() => 0);
  for (const index of chosen) keptIn[(houses[index] as House).block] = (keptIn[(houses[index] as House).block] as number) + 1;
  const have = wanted.map(() => 0);
  blockDistrict.forEach((of, block) => {
    if (of !== undefined) have[of] = (have[of] as number) + (keptIn[block] as number);
  });
  const middles = blocks.map((block) => polygonCentroid(block.polygon));
  const nearestOwn = (of: number) => {
    const own = middles.filter((_, block) => blockDistrict[block] === of);
    return (point: readonly [number, number]) => (own.length === 0 ? Math.hypot(point[0], point[1]) : Math.min(...own.map((middle) => Math.hypot(middle[0] - point[0], middle[1] - point[1]))));
  };
  // Several rounds, in each of which a district takes the nearest blocks of a neighbour that has more to spare
  // than it has itself, so long as the neighbour is left no worse off than the district then is. Surpluses and
  // shortages so even out from neighbour to neighbour, wherever in the town they began.
  for (let round = 0; round < rules.rounds; round++) wanted.forEach((want, of) => {
    const away = nearestOwn(of);
    // The wards beside the district's own, and those beside them.
    const near = new Set<number>();
    plan.of.forEach((district, ward) => {
      if (district !== of) return;
      for (const beside of plan.beside[ward] ?? []) {
        near.add(beside.ward);
        for (const further of plan.beside[beside.ward] ?? []) near.add(further.ward);
      }
    });
    const candidates = blocks
      .map((block, index) => ({ index, ward: block.ward }))
      .filter(({ index, ward }) => blockDistrict[index] !== of && (keptIn[index] as number) > 0 && near.has(ward))
      .map(({ index }) => ({ index, away: away(middles[index] as [number, number]) }))
      .sort((a, b) => a.away - b.away || a.index - b.index);
    for (const { index } of candidates) {
      const donor = blockDistrict[index];
      const count = keptIn[index] as number;
      const balance = (have[of] as number) - want;
      // From a ward in no district only what the district is short of.
      if (donor === undefined ? count > -balance : (have[donor] as number) - count - (wanted[donor] as number) < balance + count) continue;
      if (donor !== undefined) have[donor] = (have[donor] as number) - count;
      blockDistrict[index] = of;
      have[of] = (have[of] as number) + count;
    }
  });
  const moved = blockDistrict.filter((of, block) => of !== plan.of[(blocks[block] as Block).ward]).length;

  // House by house: a district with too many gives up those of its kept houses that lie nearest a district with
  // too few, and those houses change district.
  const district: Array<number | undefined> = houses.map(() => undefined);
  for (const index of chosen) district[index] = blockDistrict[(houses[index] as House).block];
  const borrowed = wanted.map(() => 0);
  wanted.forEach((want, of) => {
    const need = want - (have[of] as number);
    if (need <= 0) return;
    const away = nearestOwn(of);
    const spare = chosen
      .filter((index) => district[index] === undefined || (have[district[index] as number] as number) > (wanted[district[index] as number] as number))
      .map((index) => ({ index, away: away((houses[index] as House).centre) }))
      .sort((a, b) => a.away - b.away || a.index - b.index);
    let taken = 0;
    for (const { index } of spare) {
      if (taken >= need) break;
      const donor = district[index];
      if (donor !== undefined) {
        if ((have[donor] as number) <= (wanted[donor] as number)) continue;
        have[donor] = (have[donor] as number) - 1;
      }
      district[index] = of;
      taken++;
    }
    have[of] = (have[of] as number) + taken;
    borrowed[of] = taken;
  });
  const kept = wanted.map((_, of) => district.filter((held) => held === of).length);
  return { blockDistrict, moved, district, kept, borrowed, short };
}
