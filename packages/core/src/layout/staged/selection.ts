/**
 * Stage 11 of the staged generator: selection. Make too many, keep the best.
 *
 * More houses were made than the town has. Each district keeps exactly its
 * own number from the houses in its own wards, the best-placed first: the
 * innermost are always kept, as is everything inside the wall, and further
 * out keeping a house is more and more a matter of chance. The rest never
 * existed. A district whose wards hold too few houses first takes whole
 * blocks from the edges of its neighbours; failing that it takes unkept
 * houses from the nearest wards beside it, and those houses change district.
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

  // ---- Borders adjusted: a district with too few houses takes whole blocks from the edges of its neighbours ----
  // Wards are coarse, and a district's wards may hold a little less than it needs. It takes the nearest blocks
  // of the wards beside it, but never from a neighbour that would then be short itself. Nothing is made again.
  const blockDistrict = blocks.map((block) => plan.of[block.ward]);
  const housesIn = blocks.map(() => 0);
  for (const house of houses) housesIn[house.block] = (housesIn[house.block] as number) + 1;
  const have = wanted.map(() => 0);
  blockDistrict.forEach((of, block) => {
    if (of !== undefined) have[of] = (have[of] as number) + (housesIn[block] as number);
  });
  const middles = blocks.map((block) => polygonCentroid(block.polygon));
  let moved = 0;
  wanted.forEach((want, of) => {
    let need = want - (have[of] as number);
    if (need <= 0) return;
    const own = middles.filter((_, block) => blockDistrict[block] === of);
    if (own.length === 0) return;
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
      .filter(({ index, ward }) => blockDistrict[index] !== of && (housesIn[index] as number) > 0 && near.has(ward))
      .map(({ index }) => ({ index, away: Math.min(...own.map((middle) => Math.hypot(middle[0] - (middles[index] as [number, number])[0], middle[1] - (middles[index] as [number, number])[1]))) }))
      .sort((a, b) => a.away - b.away || a.index - b.index);
    for (const { index } of candidates) {
      if (need <= 0) break;
      const donor = blockDistrict[index];
      if (donor !== undefined && (have[donor] as number) - (housesIn[index] as number) < (wanted[donor] as number)) continue;
      if (donor !== undefined) have[donor] = (have[donor] as number) - (housesIn[index] as number);
      blockDistrict[index] = of;
      have[of] = (have[of] as number) + (housesIn[index] as number);
      need -= housesIn[index] as number;
    }
  });
  moved = blockDistrict.filter((of, block) => of !== plan.of[(blocks[block] as Block).ward]).length;

  const district: Array<number | undefined> = houses.map(() => undefined);
  const score = new Float64Array(houses.length);
  const own: number[][] = wanted.map(() => []);
  const loose: number[] = [];
  houses.forEach((house, index) => {
    const of = blockDistrict[house.block];
    if (of === undefined) loose.push(index);
    else (own[of] as number[]).push(index);
    score[index] = base[index] as number;
  });
  const kept = wanted.map(() => 0);
  const borrowed = wanted.map(() => 0);
  own.forEach((candidates, of) => {
    const want = wanted[of] as number;
    const inOrder = [...candidates].sort((a, b) => (base[a] as number) - (base[b] as number) || a - b);
    // The innermost of the district's count are solid; beyond that edge, luck.
    const edge = base[inOrder[Math.min(inOrder.length - 1, Math.floor(rules.solid * want))] as number] ?? 0;
    for (const index of candidates) score[index] = (base[index] as number) + (walled[index] ? 0 : Math.max((base[index] as number) - edge, 0) * (luck[index] as number));
    const ranked = [...candidates].sort((a, b) => (score[a] as number) - (score[b] as number) || a - b);
    for (const index of ranked.slice(0, want)) district[index] = of;
    kept[of] = Math.min(want, ranked.length);
  });

  // ---- Districts with too few: unkept houses of the nearest wards beside them -----------------------------------
  const byWard = new Map<number, number[]>();
  houses.forEach((house, index) => byWard.set(house.ward, [...(byWard.get(house.ward) ?? []), index]));
  let short = 0;
  wanted.forEach((want, of) => {
    let need = want - (kept[of] as number);
    if (need <= 0) return;
    // Wards in order of how near they are, across the ground between: the district's own first, at no distance.
    const away = wards.map(() => Infinity);
    const starts = wards.map((_, index) => index).filter((index) => plan.of[index] === of);
    // A district with no ward of its own looks from the heart of the town outward.
    const from = starts.length > 0 ? starts : wards.map((ward, index) => ({ ward, index })).filter(({ ward }) => ward.kind === 'ordinary').sort((a, b) => a.ward.growthRank - b.ward.growthRank || a.index - b.index).slice(0, 1).map(({ index }) => index);
    for (const index of from) away[index] = 0;
    const done = new Set<number>();
    for (;;) {
      let next = -1;
      for (let index = 0; index < wards.length; index++) if (!done.has(index) && (away[index] as number) < Infinity && (next < 0 || (away[index] as number) < (away[next] as number))) next = index;
      if (next < 0 || need <= 0) break;
      done.add(next);
      const spare = (byWard.get(next) ?? []).filter((index) => district[index] === undefined).sort((a, b) => (score[a] as number) - (score[b] as number) || a - b);
      for (const index of spare.slice(0, need)) {
        district[index] = of;
        kept[of] = (kept[of] as number) + 1;
        borrowed[of] = (borrowed[of] as number) + 1;
        need--;
      }
      for (const beside of plan.beside[next] ?? []) away[beside.ward] = Math.min(away[beside.ward] as number, (away[next] as number) + beside.cost);
    }
    short += Math.max(need, 0);
  });
  return { blockDistrict, moved, district, kept, borrowed, short };
}
