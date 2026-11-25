/**
 * Districts after selection, second part (phase 6F, Part B, step 5): each
 * district grown over the kept blocks of its bank, to exactly its share.
 *
 * Bank by bank, the districts given a share of it are grown one at a time in
 * placement order. Each starts from a seed block: at its landmark if it owns
 * one there, at the bridge it crossed by if it spans from another bank, at the
 * block the district before it left part of, and otherwise by its placement:
 * a waterside district by the water, an edge district farthest out, any other
 * beside the ground already claimed, favouring wards forecast as its kind.
 * From there it claims the unclaimed blocks nearest by way of the land, where
 * crossing a highway, a main street or the wall costs extra, so those tend to
 * become its borders. Before it claims a block it looks at what that would cut
 * off: a pocket smaller than what it still needs it claims too; for one larger
 * it prefers another block. The last block is usually too big: the district
 * takes only the houses it needs, those nearest its own, and the next district
 * starts from the rest. The last district on a bank takes whatever remains.
 *
 * No house is dropped or added: every kept house gets exactly one district, and
 * every district exactly its count.
 */
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { distance, polygonCentroid } from '../geometry.ts';
import type { BankPlan } from './banks.ts';
import type { DistrictForecast, Placement, TownDistrict } from './districts.ts';
import type { PlacedLandmark } from './landmarks.ts';
import { crossingsAlong, dot } from './lines.ts';
import type { House } from './rows.ts';
import type { Coast, River } from './water.ts';

export interface GrownDistricts {
  /** For each house, its district if it is kept. */
  district: Array<number | undefined>;
  /** For each block, the district holding most of its kept houses, or its landmark's; nothing for a block with neither. */
  blockDistrict: Array<number | undefined>;
  /** Blocks whose kept houses two districts share, with the line between them: the first district's houses lie on the side `normal` points away from. */
  shared: Array<{ block: number; first: number; second: number; origin: Point; normal: Point }>;
  /** How many kept houses each district has: exactly its count. */
  kept: number[];
}

export interface GrowInput {
  settings: StagedSettings;
  blocks: ReadonlyArray<{ polygon: readonly Point[]; ward: number }>;
  houses: readonly House[];
  /** For each house, its district if kept, from selection: only which houses are kept is read. */
  keptBy: ReadonlyArray<number | undefined>;
  banks: BankPlan;
  /** Which tiles touch which: blocks first. */
  tilesBeside: ReadonlyArray<readonly number[]>;
  /** The tiles each bridge joins. */
  links: ReadonlyArray<{ a: number; b: number }>;
  tiles: ReadonlyArray<ReadonlyArray<readonly Point[]>>;
  landmarks: readonly PlacedLandmark[];
  wards: ReadonlyArray<{ polygon: readonly Point[] }>;
  forecast: DistrictForecast;
  districts: readonly TownDistrict[];
  placementOf: (kind: string) => Placement;
  /** The lines that cost extra to cross. */
  highways: ReadonlyArray<readonly Point[]>;
  streets: ReadonlyArray<readonly Point[]>;
  walls: ReadonlyArray<readonly Point[]>;
  /** Where the plaza is, or the centre. */
  from: Point;
  river?: River;
  coast?: Coast;
  quay?: readonly Point[];
}

const PLACEMENT_ORDER: readonly Placement[] = ['centre', 'middle', 'waterside', 'edge'];

export function growDistricts(input: GrowInput): GrownDistricts {
  const { settings, blocks, houses, keptBy, banks, tilesBeside, links, tiles, landmarks, wards, forecast, districts, placementOf, highways, streets, walls, from, river, coast, quay } = input;
  const { barriers } = settings.districts;
  const middles = blocks.map((block) => polygonCentroid(block.polygon));
  const district: Array<number | undefined> = houses.map(() => undefined);
  const kept = districts.map(() => 0);

  // ---- The land: blocks beside each other, and what passing between them costs -----------------------------------------------
  const costs = new Map<string, number>();
  const costOf = (a: number, b: number): number => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let cost = costs.get(key);
    if (cost === undefined) {
      const line = [middles[a] as Point, middles[b] as Point];
      cost = distance(line[0] as Point, line[1] as Point);
      if (highways.some((highway) => crossingsAlong(line, highway).length > 0)) cost += barriers.highway;
      if (streets.some((street) => crossingsAlong(line, street).length > 0)) cost += barriers.mainStreet;
      if (walls.some((wall) => crossingsAlong(line, wall).length > 0)) cost += barriers.wall;
      costs.set(key, cost);
    }
    return cost;
  };
  const neighbours = blocks.map((_, block) => (tilesBeside[block] ?? []).filter((other) => other < blocks.length && banks.bankOf[other] === banks.bankOf[block]));

  // ---- What is left to claim: each block's kept houses not yet given a district ---------------------------------------------
  const left = blocks.map((): number[] => []);
  houses.forEach((house, index) => {
    if (keptBy[index] !== undefined) (left[house.block] as number[]).push(index);
  });
  const houseMiddle = (index: number) => (houses[index] as House).centre;
  const count = (block: number) => (left[block] as number[]).length;
  const give = (index: number, to: number) => {
    district[index] = to;
    kept[to] = (kept[to] as number) + 1;
  };

  // ---- Seeds ---------------------------------------------------------------------------------------------------------------------
  const landmarkPoint = (landmark: PlacedLandmark): Point => (landmark.block !== undefined ? (middles[landmark.block] as Point) : polygonCentroid((wards[landmark.ward] as { polygon: readonly Point[] }).polygon));
  const waterGap = (point: Point) => Math.min(river ? river.gap(point) : Infinity, coast ? coast.gap(point) : Infinity, quay && quay.length > 1 ? nearestOnLine(point, quay) : Infinity);
  const tileMiddle = (tile: number): Point => {
    const rings = tiles[tile] ?? [];
    const ring = rings[0];
    return ring ? polygonCentroid(ring) : (middles[tile] as Point) ?? from;
  };

  const blockDistrict: Array<number | undefined> = blocks.map(() => undefined);
  const shared: GrownDistricts['shared'] = [];
  const order = districts
    .map((one, index) => ({ index, place: PLACEMENT_ORDER.indexOf(placementOf(one.kind)) }))
    .sort((a, b) => a.place - b.place || a.index - b.index)
    .map(({ index }) => index);
  /** The blocks landmarks stand in, by their districts: no other district grows through them. */
  const owned = new Map<number, number>();
  for (const landmark of landmarks) if (landmark.block !== undefined && landmark.district !== undefined) owned.set(landmark.block, landmark.district);
  /** Each district's houses given so far on each block, for drawing the line through a shared block. */
  const givenOn = new Map<number, Map<number, number[]>>();

  banks.banks.forEach((bank, bankIndex) => {
    // A district that spans banks grows first, from its bridge, so that its parts meet across it; then the rest in
    // placement order.
    const here = order.filter((one) => (banks.shares[one] ?? []).some((part) => part.bank === bankIndex));
    const spans = (one: number) => (banks.shares[one] ?? []).length > 1;
    const growing = [...here.filter(spans), ...here.filter((one) => !spans(one))];
    let remainder: number | undefined;
    // The kept blocks touching a district's landmark are kept for that district until it has grown here.
    const reservedFor = new Map<number, number>();
    for (const [block, of] of owned) {
      if (banks.bankOf[block] !== bankIndex || !growing.includes(of)) continue;
      for (const other of neighbours[block] ?? []) if (count(other) > 0 && !reservedFor.has(other)) reservedFor.set(other, of);
    }
    growing.forEach((one, position) => {
      const last = position === growing.length - 1;
      let need = ((banks.shares[one] ?? []).find((part) => part.bank === bankIndex) as { houses: number }).houses;
      const anyLeft = () => bank.blocks.filter((block) => count(block) > 0);
      // Blocks kept for another district are left to it, unless nothing else is left.
      const unclaimed = () => {
        const open = anyLeft().filter((block) => last || (reservedFor.get(block) ?? one) === one);
        return open.length > 0 ? open : anyLeft();
      };
      const reservedElsewhere = (block: number) => !last && (reservedFor.get(block) ?? one) !== one && anyLeft().some((other) => (reservedFor.get(other) ?? one) === one);
      if (unclaimed().length === 0 || need === 0) return;
      const claimedHere = new Set<number>();
      const take = (block: number, howMany: number, towards: Point) => {
        const here = left[block] as number[];
        // The houses nearest the district's own ground first: a run along one side.
        let taken: number[];
        if (howMany >= here.length) taken = here.splice(0, here.length);
        else {
          // A run of neighbouring houses round the block's edge: of every run of so many, the one nearest the district.
          const middle = middles[block] as Point;
          here.sort((a, b) => Math.atan2(houseMiddle(a)[1] - middle[1], houseMiddle(a)[0] - middle[0]) - Math.atan2(houseMiddle(b)[1] - middle[1], houseMiddle(b)[0] - middle[0]) || a - b);
          let best = 0;
          let least = Infinity;
          for (let start = 0; start < here.length; start++) {
            let sum = 0;
            for (let k = 0; k < howMany; k++) sum += distance(houseMiddle(here[(start + k) % here.length] as number), towards);
            if (sum < least - 1e-9) {
              least = sum;
              best = start;
            }
          }
          taken = Array.from({ length: howMany }, (_, k) => here[(best + k) % here.length] as number);
          const chosen = new Set(taken);
          const rest = here.filter((index) => !chosen.has(index));
          here.length = 0;
          here.push(...rest);
        }
        for (const index of taken) give(index, one);
        const map = givenOn.get(block) ?? new Map<number, number[]>();
        map.set(one, [...(map.get(one) ?? []), ...taken]);
        givenOn.set(block, map);
        claimedHere.add(block);
        need -= taken.length;
      };
      if (last) {
        // The last district on a bank takes whatever remains.
        for (const block of unclaimed()) take(block, count(block), middles[block] as Point);
        return;
      }

      // The seeds: its landmarks on this bank, and the end of its bridge if it spans; failing those, one block by the
      // rules below.
      const candidates = unclaimed();
      const nearestTo = (point: Point) => candidates.reduce((best, block) => (distance(middles[block] as Point, point) < distance(middles[best] as Point, point) ? block : best));
      const sources: number[] = [];
      for (const landmark of landmarks) {
        if (landmark.district !== one) continue;
        if (landmark.block !== undefined) {
          if (banks.bankOf[landmark.block] === bankIndex) sources.push(landmark.block);
        } else if (banks.pulled.get(one) === bankIndex) sources.push(nearestTo(landmarkPoint(landmark)));
      }
      const parts = banks.shares[one] ?? [];
      if (parts.length > 1) {
        const otherBanks = new Set(parts.map((part) => part.bank).filter((bank) => bank !== bankIndex));
        for (const link of links) {
          const ends = [link.a, link.b].filter((tile) => tile < blocks.length);
          const mine = ends.find((tile) => banks.bankOf[tile] === bankIndex);
          const theirs = ends.find((tile) => otherBanks.has(banks.bankOf[tile] as number));
          if (mine !== undefined && theirs !== undefined) sources.push(count(mine) > 0 ? mine : nearestTo(tileMiddle(mine)));
        }
      }
      if (sources.length === 0) {
        let seed: number;
        if (remainder !== undefined && count(remainder) > 0) seed = remainder;
        else {
          const placement = placementOf((districts[one] as TownDistrict).kind);
          const kind = (districts[one] as TownDistrict).kind;
          const forecastAs = (block: number) => {
            const of = forecast.of[(blocks[block] as { ward: number }).ward];
            return of !== undefined && districts[of]?.kind === kind;
          };
          if (placement === 'waterside' && (river || coast || quay)) seed = candidates.reduce((best, block) => (waterGap(middles[block] as Point) < waterGap(middles[best] as Point) ? block : best));
          else if (placement === 'edge') seed = candidates.reduce((best, block) => (distance(middles[block] as Point, from) > distance(middles[best] as Point, from) ? block : best));
          else {
            // Beside ground already claimed: a block next to a claimed one, or one partly claimed already.
            const beside = candidates.filter((block) => givenOn.has(block) || (neighbours[block] ?? []).some((other) => givenOn.has(other)));
            const pool = beside.length > 0 ? beside : candidates;
            seed = pool.reduce((best, block) => {
              const [a, b] = [forecastAs(block) ? 0 : 1, forecastAs(best) ? 0 : 1];
              if (a !== b) return a < b ? block : best;
              return distance(middles[block] as Point, from) < distance(middles[best] as Point, from) ? block : best;
            });
          }
        }
        sources.push(seed);
      }

      // Grow: nearest by way of the land, through blocks with no kept houses but never into another district's or
      // another district's landmark.
      const reach = new Map<number, number>(sources.map((block) => [block, 0]));
      const settled = new Set<number>();
      const deferred = new Set<number>();
      let towards = centreOf(new Set(sources));
      while (need > 0) {
        // The nearest block not yet settled.
        let best: number | undefined;
        for (const [block, cost] of reach) if (!settled.has(block) && (best === undefined || cost < (reach.get(best) as number) || (cost === reach.get(best) && block < best))) best = block;
        if (best === undefined) {
          // Cut off: the nearest unclaimed block of the bank, as the crow flies.
          const rest = unclaimed();
          if (rest.length === 0) break;
          const jump = rest.reduce((a, b) => (distance(middles[a] as Point, towards) <= distance(middles[b] as Point, towards) ? a : b));
          reach.set(jump, 0);
          settled.delete(jump);
          continue;
        }
        settled.add(best);
        if (reservedElsewhere(best)) continue;
        // Through a block with no kept houses, or one of this district's own; never through another district's.
        const passable = count(best) > 0 || ((!givenOn.has(best) || claimedHere.has(best)) && (owned.get(best) ?? one) === one);
        if (count(best) > 0) {
          const howMany = Math.min(need, count(best));
          // A pocket the claim would cut off: claimed too if it fits, otherwise another block is preferred.
          const pockets = howMany === count(best) ? cutOff(best) : [];
          const fits = pockets.reduce((sum, pocket) => sum + pocket.houses, 0) <= need - howMany;
          const alternatives = [...reach.keys()].some((block) => !settled.has(block) && count(block) > 0);
          if (pockets.length > 0 && !fits && alternatives && !deferred.has(best)) {
            deferred.add(best);
            settled.delete(best);
            reach.set(best, (reach.get(best) as number) + DEFER);
            continue;
          }
          take(best, howMany, towards);
          if (pockets.length > 0 && fits) for (const pocket of pockets) for (const block of pocket.blocks) take(block, count(block), towards);
          towards = centreOf(claimedHere);
          if (count(best) > 0) remainder = best;
        }
        if (!passable) continue;
        for (const other of neighbours[best] ?? []) {
          const cost = (reach.get(best) as number) + costOf(best, other);
          if (!reach.has(other) || cost < (reach.get(other) as number)) {
            reach.set(other, cost);
            settled.delete(other);
          }
        }
      }

      for (const [block, of] of [...reservedFor]) if (of === one) reservedFor.delete(block);

      /** The pockets of unclaimed blocks that claiming the whole of a block would cut off from the rest of the bank. */
      function cutOff(block: number): Array<{ blocks: number[]; houses: number }> {
        const open = (other: number) => other !== block && (count(other) > 0 || !givenOn.has(other));
        const seen = new Set<number>();
        const groups: Array<{ blocks: number[]; houses: number }> = [];
        for (const start of bank.blocks) {
          if (!open(start) || count(start) === 0 || seen.has(start)) continue;
          const group = { blocks: [] as number[], houses: 0 };
          const queue = [start];
          seen.add(start);
          while (queue.length > 0) {
            const at = queue.pop() as number;
            if (count(at) > 0) {
              group.blocks.push(at);
              group.houses += count(at);
            }
            for (const other of neighbours[at] ?? []) {
              if (seen.has(other) || !open(other)) continue;
              seen.add(other);
              queue.push(other);
            }
          }
          groups.push(group);
        }
        if (groups.length <= 1) return [];
        groups.sort((a, b) => b.houses - a.houses);
        return groups.slice(1);
      }
      function centreOf(set: ReadonlySet<number>): Point {
        const points = [...set].map((block) => middles[block] as Point);
        return points.reduce((sum, point): Point => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]);
      }
    });
  });

  // ---- Each block's district, and the line through a block two districts share ---------------------------------------------------
  for (const [block, byDistrict] of [...givenOn.entries()].sort((a, b) => a[0] - b[0])) {
    const ranked = [...byDistrict.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
    blockDistrict[block] = (ranked[0] as [number, number[]])[0];
    if (ranked.length < 2) continue;
    const [first, second] = [ranked[0] as [number, number[]], ranked[1] as [number, number[]]];
    const middleOf = (list: number[]) => list.map(houseMiddle).reduce((sum, point): Point => [sum[0] + point[0] / list.length, sum[1] + point[1] / list.length], [0, 0]);
    const [a, b] = [middleOf(first[1]), middleOf(second[1])];
    const length = distance(a, b) || 1;
    const normal: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    // Between the farthest of the first district's houses and the nearest of the second's, along the line from one to the other.
    const reachOf = (list: number[], sign: number) => Math.max(...list.flatMap((index) => (houses[index] as House).outline.map((corner) => sign * dot([corner[0] - a[0], corner[1] - a[1]], normal))));
    const split = (reachOf(first[1], 1) - reachOf(second[1], -1)) / 2;
    shared.push({ block, first: first[0], second: second[0], origin: [a[0] + normal[0] * split, a[1] + normal[1] * split], normal });
  }
  for (const landmark of landmarks) if (landmark.block !== undefined && landmark.district !== undefined) blockDistrict[landmark.block] = landmark.district;
  return { district, blockDistrict, shared, kept };
}

/** How much farther a block is pushed for now when claiming it would cut off a pocket too big to take. */
const DEFER = 1e6;

function nearestOnLine(point: Point, line: readonly Point[]): number {
  let best = Infinity;
  for (let k = 1; k < line.length; k++) {
    const [a, b] = [line[k - 1] as Point, line[k] as Point];
    const [ux, uy] = [b[0] - a[0], b[1] - a[1]];
    const run = ux * ux + uy * uy;
    const t = run === 0 ? 0 : Math.min(Math.max(((point[0] - a[0]) * ux + (point[1] - a[1]) * uy) / run, 0), 1);
    best = Math.min(best, Math.hypot(point[0] - a[0] - ux * t, point[1] - a[1] - uy * t));
  }
  return best;
}
