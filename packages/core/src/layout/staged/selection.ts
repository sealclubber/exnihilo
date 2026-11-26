/**
 * Stage 11 of the staged generator: selection. Make too many, keep the best.
 *
 * More houses were made than the town has. The town keeps exactly as many
 * as it has buildings that need a house, the best-placed first: the
 * innermost are always kept, as is everything inside the wall, and further
 * out keeping a house is more and more a matter of chance. The rest never
 * existed. Selection gives no house a district: the districts are drawn over
 * the kept houses afterwards (`districting.ts`).
 */
import type { StagedSettings } from '../../pack/schema.ts';
import { wardRng } from './blocks.ts';
import type { Ground } from './ground.ts';
import type { House } from './rows.ts';
import type { Wall } from './wall.ts';
import type { Ward } from './wards.ts';

export interface Selection {
  /** The houses kept, by their places among the houses made, in no particular order. */
  chosen: number[];
  /** How many houses the town is short of: nothing may be built until this is none. */
  short: number;
}

export interface SelectionInput {
  settings: StagedSettings;
  seed: number;
  houses: readonly House[];
  wards: readonly Ward[];
  ground: Ground;
  wall?: Wall;
  /** How many houses the town keeps: its buildings that need one. */
  total: number;
}

export function chooseHouses({ settings, seed, houses, wards, ground, wall, total }: SelectionInput): Selection {
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
  // The innermost of the town's count are solid, as is everything inside the wall; beyond that edge, luck.
  const inOrder = houses.map((_, index) => index).sort((a, b) => (base[a] as number) - (base[b] as number) || a - b);
  const edge = base[inOrder[Math.min(inOrder.length - 1, Math.floor(rules.solid * total))] as number] ?? 0;
  const score = new Float64Array(houses.length);
  houses.forEach((_, index) => (score[index] = (base[index] as number) + (walled[index] ? 0 : Math.max((base[index] as number) - edge, 0) * (luck[index] as number))));
  const chosen = houses.map((_, index) => index).sort((a, b) => (score[a] as number) - (score[b] as number) || a - b).slice(0, total);
  return { chosen, short: total - chosen.length };
}
