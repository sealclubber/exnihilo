/**
 * The districts stage (phase 6G, `sim-6g.md`): districts drawn over the kept
 * houses, block by block, after selection has decided which houses exist.
 *
 * A bank is a set of blocks joined without crossing a bridge; a unit is a
 * district, or the part of one on one bank; a bridgehead is the block at one
 * end of a bridge link. In five steps:
 *
 * 1. Seed. Each district is given one block with kept houses, the nearest to
 *    the centre of its forecast seed ward, the smallest districts first; no two
 *    share one.
 * 2. Share the districts among the banks. While a bank's units want more
 *    houses than it holds, a district crosses a bridge to the bank with most
 *    room: one already crossing there carries more over; otherwise the unit
 *    nearest the bridge goes over whole if it nearly fits, or splits, both
 *    parts seeded on their bridgeheads, which are theirs from then on. A bank
 *    with no bridge sends its largest unit to the bank with most room.
 * 3. Grow in turns. The unit furthest below its count claims the unclaimed
 *    block touching its ground on its own bank nearest its seed, empty blocks
 *    too; then blocks left over join the touching unit with the smallest
 *    surplus, and a block that touches none, the nearest unit.
 * 4. Pass surplus along chains. A unit short is handed border blocks along a
 *    path of touching units from the nearest with a surplus, each to the next,
 *    never a seed or a bridgehead and never leaving either side in more pieces.
 * 5. Make the counts exact. Single houses are lent along a path of touching
 *    districts through one border block per hop: the block stays its owner's
 *    ground, keeps at least one of its owner's houses, and lends to one
 *    neighbour only.
 *
 * The stage reads no randomness. Ties go to the first in the order blocks,
 * units and districts are given.
 */
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';

export type DistrictingSettings = NonNullable<StagedSettings['districts']['drawn']>;

export interface DistrictingInput {
  rules: DistrictingSettings;
  /** The blocks' outlines, in the plan's order. */
  blocks: ReadonlyArray<{ polygon: readonly Point[] }>;
  /** The wards' outlines, in the plan's order. */
  wards: ReadonlyArray<{ polygon: readonly Point[] }>;
  /** Every house made, with its block and its ward. */
  houses: ReadonlyArray<{ block: number; ward: number }>;
  /** The houses kept, by their place among `houses`. */
  kept: Iterable<number>;
  /** For each tile (the blocks first, then the plaza and the castle), the tiles whose ground touches its own. */
  tilesBeside: ReadonlyArray<readonly number[]>;
  /** The two tiles at the ends of each bridge. */
  links: ReadonlyArray<{ a: number; b: number }>;
  /** For each district, the ward the forecast started it from. */
  seeds: ReadonlyArray<number | undefined>;
  /** For each district, how many kept houses it is to have. Their sum is the number of kept houses. */
  targets: readonly number[];
}

/** One district, or its part on one bank. */
export interface DistrictUnit {
  district: number;
  target: number;
  seed: number;
  /** The bridgeheads that are this unit's, where its district crosses a bridge. */
  heads?: number[];
}

export interface Districting {
  /** For each block, its district; nothing for an empty block that no district reached. */
  blockDistrict: Array<number | undefined>;
  /** The blocks that lend some of their houses to a neighbouring district, and how many. */
  lent: Map<number, { to: number; houses: number }>;
  /** For each district, the whole number of houses it is to have, and how many it has at the end. */
  targets: number[];
  have: number[];
  /** The bank of each block, the units, and each unit's houses after the chains. */
  bank: number[];
  units: DistrictUnit[];
  unitHave: number[];
  /** How far the districts were from their counts after the chains, before single houses (half the sum of every miss). */
  offAfterChains: number;
  /** How far they are at the end. */
  off: number;
  /** Districts in more than one piece of blocks with houses, a bridge counting as a join. */
  inPieces: number;
  /** Districts with ground on both sides of a bridge. */
  spans: number;
  /** Units re-seeded on another bank for want of a bridge, units moved across whole, and blocks handed along chains. */
  reseeded: number;
  relocated: number;
  chainMoves: number;
  /** Kept houses in blocks that touched no unit on their bank, and so joined the nearest. */
  islands: number;
  /** Kept houses in blocks no unit claimed. */
  unclaimed: number;
}

/** The mean of an outline's corners. */
const middle = (polygon: readonly Point[]): Point => [polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length, polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length];
const apart = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const half = (have: readonly number[], want: readonly number[]) => Math.round(have.reduce((sum, value, at) => sum + Math.abs(value - (want[at] as number)), 0) / 2);

export function drawDistricts({ rules, blocks, wards, houses, kept, tilesBeside, links, seeds, targets }: DistrictingInput): Districting {
  const B = blocks.length;
  const D = targets.length;
  const keptB: number[] = blocks.map(() => 0);
  const keptW: number[] = wards.map(() => 0);
  for (const index of kept) {
    const house = houses[index] as { block: number; ward: number };
    keptB[house.block] = (keptB[house.block] as number) + 1;
    keptW[house.ward] = (keptW[house.ward] as number) + 1;
  }
  const total = keptB.reduce((sum, value) => sum + value, 0);
  const T = targets;
  const wardMiddle = wards.map((ward) => middle(ward.polygon));
  const blockMiddle = blocks.map((block) => middle(block.polygon));
  const order = targets.map((_, district) => district);

  // Blocks beside each other: their ground touches, or a bridge joins them.
  const badj: number[][] = blocks.map((_, block) => (tilesBeside[block] ?? []).filter((other) => other < B));
  const bridged = links.filter((link) => link.a < B && link.b < B);
  for (const link of bridged) {
    (badj[link.a] as number[]).push(link.b);
    (badj[link.b] as number[]).push(link.a);
  }
  const across = new Set(bridged.flatMap((link) => [`${link.a}:${link.b}`, `${link.b}:${link.a}`]));

  // ---- 1. Seed -------------------------------------------------------------------------------------------------
  // Each district's seed ward is the forecast's, or, where that is taken or keeps no house, the free ward with kept
  // houses nearest it; in the city's order. Its seed block is then the free block with kept houses nearest that
  // ward's middle, the smallest districts choosing first.
  const wardTaken = wards.map(() => false);
  const seedWard: number[] = [];
  for (const district of order) {
    let ward = seeds[district];
    if (ward === undefined || wardTaken[ward] || keptW[ward] === 0) {
      const from = ward !== undefined ? (wardMiddle[ward] as Point) : ([0, 0] as Point);
      let best = -1;
      let least = Infinity;
      for (let other = 0; other < wards.length; other++) {
        if (wardTaken[other] || keptW[other] === 0) continue;
        const away = apart(wardMiddle[other] as Point, from);
        if (away < least) {
          least = away;
          best = other;
        }
      }
      ward = best;
    }
    if (ward >= 0) wardTaken[ward] = true;
    seedWard.push(ward);
  }

  const bank: number[] = blocks.map(() => -1);
  let banks = 0;
  for (let start = 0; start < B; start++) {
    if ((bank[start] as number) >= 0) continue;
    const stack = [start];
    bank[start] = banks;
    while (stack.length > 0) {
      const at = stack.pop() as number;
      for (const next of badj[at] as number[]) {
        if ((bank[next] as number) >= 0 || across.has(`${at}:${next}`)) continue;
        bank[next] = banks;
        stack.push(next);
      }
    }
    banks++;
  }
  const cap: number[] = new Array<number>(banks).fill(0);
  keptB.forEach((value, block) => (cap[bank[block] as number] = (cap[bank[block] as number] as number) + value));
  const taken = new Set<number>();
  /** The free block with kept houses nearest a point, on the bank given or any. */
  const nearestKept = (from: Point, onBank: number | undefined): number => {
    let best = -1;
    let least = Infinity;
    for (let block = 0; block < B; block++) {
      if (taken.has(block) || keptB[block] === 0 || (onBank !== undefined && bank[block] !== onBank)) continue;
      const away = apart(blockMiddle[block] as Point, from);
      if (away < least) {
        least = away;
        best = block;
      }
    }
    return best;
  };
  const units: DistrictUnit[] = [];
  for (const district of [...order].sort((a, b) => (T[a] as number) - (T[b] as number))) {
    const ward = seedWard[district] as number;
    const block = nearestKept(ward >= 0 ? (wardMiddle[ward] as Point) : [0, 0], undefined);
    if (block < 0) continue;
    taken.add(block);
    units.push({ district, target: T[district] as number, seed: block });
  }

  // ---- 2. Share the districts among the banks ------------------------------------------------------------------
  const demand = () => {
    const wants: number[] = new Array<number>(banks).fill(0);
    for (const unit of units) wants[bank[unit.seed] as number] = (wants[bank[unit.seed] as number] as number) + unit.target;
    return wants;
  };
  const ends = bridged.map((link) => [link.a, link.b] as const);
  let spans = 0;
  let relocated = 0;
  let reseeded = 0;
  /** Makes a bridgehead a unit's own, and seeds it there; a unit seeded on it already moves to the nearest free block. */
  const claim = (unit: DistrictUnit, block: number): boolean => {
    if (units.some((other) => other !== unit && (other.heads ?? []).includes(block))) return false;
    const there = units.find((other) => other !== unit && other.seed === block);
    taken.add(block);
    if (there) {
      const next = nearestKept(blockMiddle[block] as Point, bank[block]);
      if (next < 0) return false;
      there.seed = next;
      taken.add(next);
    }
    if (!unit.heads) {
      if (unit.seed !== block) taken.delete(unit.seed);
      unit.seed = block;
      unit.heads = [];
    }
    unit.heads.push(block);
    return true;
  };
  for (let round = 0; round < rules.rounds; round++) {
    const wants = demand();
    let over = -1;
    let excess = rules.over;
    for (let at = 0; at < banks; at++) {
      if ((wants[at] as number) - (cap[at] as number) > excess) {
        excess = (wants[at] as number) - (cap[at] as number);
        over = at;
      }
    }
    if (over < 0) break;
    // The bridge from the crowded bank to the bank with most room.
    let bridge: [number, number] | undefined;
    let room = 0;
    for (const [p, q] of ends) {
      for (const [x, y] of [
        [p, q],
        [q, p],
      ] as const) {
        const other = bank[y] as number;
        if (bank[x] === over && other !== over && (cap[other] as number) - (wants[other] as number) > room) {
          room = (cap[other] as number) - (wants[other] as number);
          bridge = [x, y];
        }
      }
    }
    if (!bridge) {
      // No bridge off this bank: its largest unit starts on the bank with most room instead.
      let to = -1;
      let most = -Infinity;
      for (let at = 0; at < banks; at++) {
        if (at !== over && (cap[at] as number) > 0 && (cap[at] as number) - (wants[at] as number) > most) {
          most = (cap[at] as number) - (wants[at] as number);
          to = at;
        }
      }
      const largest = units.filter((unit) => bank[unit.seed] === over).sort((a, b) => b.target - a.target)[0];
      if (to < 0 || !largest) break;
      const block = nearestKept(blockMiddle[largest.seed] as Point, to);
      if (block < 0) break;
      taken.delete(largest.seed);
      taken.add(block);
      largest.seed = block;
      reseeded++;
      continue;
    }
    const [near, far] = bridge;
    const move = Math.min(excess, room);
    // A district already crossing this bridge carries more over, rather than a second district crossing here.
    const nearPart = units.find((unit) => (unit.heads ?? []).includes(near));
    const farPart = nearPart && units.find((unit) => unit.district === nearPart.district && (unit.heads ?? []).includes(far));
    if (nearPart && farPart) {
      const more = Math.min(move, nearPart.target - rules.nearLeast);
      if (more > 0) {
        nearPart.target -= more;
        farPart.target += more;
        continue;
      }
      farPart.target += nearPart.target;
      delete farPart.heads;
      taken.delete(nearPart.seed);
      units.splice(units.indexOf(nearPart), 1);
      spans--;
      relocated++;
      continue;
    }
    // Otherwise the unit on the crowded bank nearest the bridge that does not already cross goes over, whole if it
    // fits, else in part.
    const toNear = (unit: DistrictUnit) => apart(blockMiddle[unit.seed] as Point, blockMiddle[near] as Point);
    const unit = units
      .filter((one) => bank[one.seed] === over)
      .sort((a, b) => toNear(a) - toNear(b))
      .find((one) => !one.heads);
    if (!unit) break;
    if (unit.target <= move + rules.whole) {
      const block = nearestKept(blockMiddle[far] as Point, bank[far]);
      if (block < 0) break;
      taken.delete(unit.seed);
      unit.seed = block;
      taken.add(block);
      relocated++;
    } else {
      const part: DistrictUnit = { district: unit.district, target: move, seed: far };
      if (!claim(part, far)) break;
      unit.target -= move;
      units.push(part);
      spans++;
      claim(unit, near);
    }
  }

  // ---- 3. Grow in turns ----------------------------------------------------------------------------------------
  const U = units.length;
  const UT = units.map((unit) => unit.target);
  const g: Array<number | undefined> = blocks.map(() => undefined);
  const hv: number[] = units.map(() => 0);
  units.forEach((unit, at) => {
    g[unit.seed] = at;
    hv[at] = (hv[at] as number) + (keptB[unit.seed] as number);
  });
  units.forEach((unit, at) => {
    for (const block of unit.heads ?? []) {
      if (g[block] !== undefined) continue;
      g[block] = at;
      hv[at] = (hv[at] as number) + (keptB[block] as number);
    }
  });
  const front = units.map(() => new Set<number>());
  const reach = (at: number, block: number) => {
    for (const next of badj[block] as number[]) if (g[next] === undefined && bank[next] === bank[(units[at] as DistrictUnit).seed]) (front[at] as Set<number>).add(next);
  };
  units.forEach((unit, at) => {
    reach(at, unit.seed);
    for (const block of unit.heads ?? []) if (g[block] === at) reach(at, block);
  });
  const stopped: boolean[] = units.map(() => false);
  const furthestBelow = (a: number, b: number) => (hv[a] as number) / (UT[a] as number) - (hv[b] as number) / (UT[b] as number);
  for (;;) {
    const turn = [...Array(U).keys()].filter((at) => !stopped[at] && (hv[at] as number) < (UT[at] as number)).sort(furthestBelow);
    if (turn.length === 0) break;
    let claimed = false;
    for (const at of turn) {
      const seedAt = blockMiddle[(units[at] as DistrictUnit).seed] as Point;
      let best = -1;
      let least = Infinity;
      for (const block of front[at] as Set<number>) {
        if (g[block] !== undefined) {
          (front[at] as Set<number>).delete(block);
          continue;
        }
        const away = apart(blockMiddle[block] as Point, seedAt);
        if (away < least) {
          least = away;
          best = block;
        }
      }
      if (best < 0) {
        stopped[at] = true;
        continue;
      }
      g[best] = at;
      hv[at] = (hv[at] as number) + (keptB[best] as number);
      (front[at] as Set<number>).delete(best);
      reach(at, best);
      claimed = true;
      break;
    }
    if (!claimed) break;
  }
  // Blocks left over join the touching unit on their bank with the smallest surplus.
  for (let pass = 0; pass < rules.fills; pass++) {
    let any = false;
    for (let block = 0; block < B; block++) {
      if (g[block] !== undefined) continue;
      let best = -1;
      let least = Infinity;
      for (const next of badj[block] as number[]) {
        const at = g[next];
        if (at === undefined || bank[next] !== bank[block] || (hv[at] as number) - (UT[at] as number) >= least) continue;
        least = (hv[at] as number) - (UT[at] as number);
        best = at;
      }
      if (best < 0) continue;
      g[block] = best;
      hv[best] = (hv[best] as number) + (keptB[block] as number);
      any = true;
    }
    if (!any) break;
  }
  // Houses that touch no unit on their bank join the nearest, as an island.
  let islands = 0;
  for (let block = 0; block < B; block++) {
    if (g[block] !== undefined || keptB[block] === 0) continue;
    let best = -1;
    let least = Infinity;
    units.forEach((unit, at) => {
      const away = apart(blockMiddle[block] as Point, blockMiddle[unit.seed] as Point);
      if (away < least) {
        least = away;
        best = at;
      }
    });
    if (best < 0) continue;
    g[block] = best;
    hv[best] = (hv[best] as number) + (keptB[block] as number);
    islands += keptB[block] as number;
  }
  const unclaimed = keptB.reduce((sum, value, block) => sum + (g[block] === undefined ? value : 0), 0);

  // ---- 4. Pass surplus along chains ----------------------------------------------------------------------------
  /** How many pieces some blocks make, counting only pieces with kept houses. */
  const pieces = (nodes: number[], beside: (node: number) => number[]) => {
    const left = new Set(nodes);
    let count = 0;
    while (left.size > 0) {
      const stack = [left.values().next().value as number];
      left.delete(stack[0] as number);
      let houses = false;
      while (stack.length > 0) {
        const node = stack.pop() as number;
        if ((keptB[node] as number) > 0) houses = true;
        for (const next of beside(node)) {
          if (!left.has(next)) continue;
          left.delete(next);
          stack.push(next);
        }
      }
      if (houses) count++;
    }
    return count;
  };
  const blocksOf = (at: number) => g.flatMap((of, block) => (of === at ? [block] : []));
  const besideIn = (at: number) => (node: number) => (badj[node] as number[]).filter((next) => g[next] === at && bank[next] === bank[node]);
  const unitPieces = (at: number) => pieces(blocksOf(at), besideIn(at));
  /** A giver hands the receiver one border block; it says how many houses went. */
  const give = (from: number, to: number, want: number): number => {
    const giver = units[from] as DistrictUnit;
    const choices: number[] = [];
    for (let block = 0; block < B; block++) {
      if (g[block] !== from || keptB[block] === 0 || block === giver.seed || (giver.heads ?? []).includes(block)) continue;
      if ((badj[block] as number[]).some((next) => g[next] === to && bank[next] === bank[block])) choices.push(block);
    }
    const fitting = choices.filter((block) => (keptB[block] as number) <= want + rules.chainOver).sort((a, b) => (keptB[b] as number) - (keptB[a] as number));
    const before = unitPieces(from);
    const beforeTo = unitPieces(to);
    for (const block of fitting.slice(0, rules.chainTries)) {
      g[block] = to;
      if (unitPieces(from) <= before && unitPieces(to) <= beforeTo) {
        hv[from] = (hv[from] as number) - (keptB[block] as number);
        hv[to] = (hv[to] as number) + (keptB[block] as number);
        return keptB[block] as number;
      }
      g[block] = from;
    }
    return 0;
  };
  /** For each unit (or district), those whose blocks touch its own; on the same bank where asked. */
  const touching = (of: ReadonlyArray<number | undefined>, sameBank: boolean) => {
    const beside = new Map<number, Set<number>>();
    for (let block = 0; block < B; block++) {
      const x = of[block];
      if (x === undefined) continue;
      for (const next of badj[block] as number[]) {
        const y = of[next];
        if (y === undefined || y === x || (sameBank && bank[next] !== bank[block])) continue;
        let set = beside.get(x);
        if (!set) beside.set(x, (set = new Set()));
        set.add(y);
      }
    }
    return beside;
  };
  /** The nearest by touching to `from` with enough surplus, and the path from it back to `from`, the giver first. */
  const pathTo = (from: number, beside: Map<number, Set<number>>, dead: Set<string>, rich: (at: number) => boolean): number[] | undefined => {
    const previous = new Map<number, number>();
    const queue = [from];
    const seen = new Set([from]);
    let source = -1;
    while (queue.length > 0 && source < 0) {
      const x = queue.shift() as number;
      for (const y of beside.get(x) ?? []) {
        if (seen.has(y) || dead.has(`${y}>${x}`)) continue;
        seen.add(y);
        previous.set(y, x);
        if (rich(y)) {
          source = y;
          break;
        }
        queue.push(y);
      }
    }
    if (source < 0) return undefined;
    const path = [source];
    for (let x = source; x !== from; ) path.push((x = previous.get(x) as number));
    return path;
  };
  let chainMoves = 0;
  const dead = new Set<string>();
  for (let step = 0; step < rules.chainSteps; step++) {
    const short = [...Array(U).keys()].filter((at) => (UT[at] as number) - (hv[at] as number) >= rules.chainAt).sort((x, y) => (UT[y] as number) - (hv[y] as number) - ((UT[x] as number) - (hv[x] as number)));
    let moved = false;
    const beside = touching(g, true);
    for (const at of short) {
      const path = pathTo(at, beside, dead, (y) => (hv[y] as number) - (UT[y] as number) >= rules.chainAt);
      if (!path) continue;
      const source = path[0] as number;
      const want = Math.min((hv[source] as number) - (UT[source] as number), (UT[at] as number) - (hv[at] as number));
      for (let hop = 0; hop < path.length - 1; hop++) {
        if (!give(path[hop] as number, path[hop + 1] as number, want)) {
          dead.add(`${path[hop]}>${path[hop + 1]}`);
          break;
        }
        chainMoves++;
      }
      moved = true;
      break;
    }
    if (!moved) break;
  }

  // A district is whole if its blocks join, a bridge counting as a join.
  const blockDistrict = g.map((at) => (at === undefined ? undefined : (units[at] as DistrictUnit).district));
  const inPieces = order.filter(
    (district) =>
      pieces(
        blockDistrict.flatMap((of, block) => (of === district ? [block] : [])),
        (node) => (badj[node] as number[]).filter((next) => blockDistrict[next] === district),
      ) > 1,
  ).length;
  const afterChains: number[] = new Array<number>(D).fill(0);
  units.forEach((unit, at) => (afterChains[unit.district] = (afterChains[unit.district] as number) + (hv[at] as number)));

  // ---- 5. Make the counts exact --------------------------------------------------------------------------------
  // Whole-number counts, the remainders given largest first.
  const IT = T.map((value) => Math.floor(value));
  const remainder = total - IT.reduce((sum, value) => sum + value, 0);
  const fractions = order.map((district) => [(T[district] as number) - (IT[district] as number), district] as const).sort((x, y) => y[0] - x[0]);
  for (let at = 0; at < remainder; at++) {
    const district = (fractions[at % D] as readonly [number, number])[1];
    IT[district] = (IT[district] as number) + 1;
  }
  const hX = [...afterChains];
  const lent = new Map<number, { to: number; houses: number }>();
  const deadX = new Set<string>();
  const offAfterChains = half(hX, IT);
  for (let step = 0; step < rules.exactSteps; step++) {
    const short = order.filter((district) => (IT[district] as number) - (hX[district] as number) >= 1).sort((x, y) => (IT[y] as number) - (hX[y] as number) - ((IT[x] as number) - (hX[x] as number)));
    let moved = false;
    const beside = touching(blockDistrict, false);
    for (const at of short) {
      const path = pathTo(at, beside, deadX, (y) => (hX[y] as number) - (IT[y] as number) >= 1);
      if (!path) continue;
      const source = path[0] as number;
      let amount = Math.min((hX[source] as number) - (IT[source] as number), (IT[at] as number) - (hX[at] as number));
      const picks: number[] = [];
      let ok = true;
      for (let hop = 0; hop < path.length - 1 && ok; hop++) {
        const a = path[hop] as number;
        const b = path[hop + 1] as number;
        let best = -1;
        let room = 0;
        for (let block = 0; block < B; block++) {
          if (blockDistrict[block] !== a || (keptB[block] as number) <= 1 || !(badj[block] as number[]).some((next) => blockDistrict[next] === b)) continue;
          const already = lent.get(block);
          if (already && already.to !== b) continue;
          const free = (keptB[block] as number) - 1 - (already?.houses ?? 0);
          if (free > room) {
            room = free;
            best = block;
          }
        }
        if (best < 0) {
          deadX.add(`${a}>${b}`);
          ok = false;
        } else {
          amount = Math.min(amount, room);
          picks.push(best);
        }
      }
      moved = true;
      if (!ok) break;
      picks.forEach((block, hop) => {
        const entry = lent.get(block) ?? { to: path[hop + 1] as number, houses: 0 };
        entry.houses += amount;
        lent.set(block, entry);
      });
      hX[source] = (hX[source] as number) - amount;
      hX[at] = (hX[at] as number) + amount;
      break;
    }
    if (!moved) break;
  }

  return {
    blockDistrict,
    lent,
    targets: IT,
    have: hX,
    bank,
    units,
    unitHave: hv,
    offAfterChains,
    off: half(hX, IT),
    inPieces,
    spans,
    reseeded,
    relocated,
    chainMoves,
    islands,
    unclaimed,
  };
}
