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
 * 3. Cells (or, falling back, growth in turns: the unit furthest below its
 *    count claims the unclaimed block touching its ground on its own bank
 *    nearest its seed, empty blocks too); then blocks left over join the
 *    touching unit with the smallest surplus, and a block that touches none,
 *    the nearest unit.
 * 4. Pass surplus along chains. A unit short is handed border blocks along a
 *    path of touching units from the nearest with a surplus, each to the next,
 *    never a seed or a bridgehead and never leaving either side in more pieces.
 * 5. Make the counts exact. Single houses are lent along a path of touching
 *    districts through one border block per hop: the block stays its owner's
 *    ground, keeps at least one of its owner's houses, and lends to one
 *    neighbour only.
 *
 * Open country is nobody's: a run of more than `openRun` touching empty
 * blocks (no kept house, no landmark, no bridgehead) is never claimed, but a
 * pocket of houses it would cut off keeps its shortest way back to the town.
 *
 * Step 3 is cells, not growth (Amendment 2 of `sim-6g.md`): on each bank every
 * unit has a centre, its seed with its own landmarks' blocks on that bank, and
 * a weight; a block goes to the unit for which its squared distance from the
 * centre less the weight is least, and the weights are raised and lowered
 * until each unit holds about its count. A unit left in pieces keeps its piece
 * with its bridgehead, or else with most houses, and lets the rest go to its
 * neighbours.
 *
 * A town that does not come out exact with cells is drawn again with growth,
 * the landmarks leading: each district claims its own landmarks' blocks and
 * grows toward them, lets go of what it cannot reach, and never chains a
 * landmark's block away. One still not exact so is drawn with plain growth. A
 * landmark whose block ends in another district's ground stays there.
 *
 * The stage reads no randomness. Ties go to the first in the order blocks,
 * units and districts are given.
 */
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { distanceToPolygonEdge } from '../geometry.ts';

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
  /** The landmarks reserved, each with its district and its block, if it has them. */
  landmarks?: ReadonlyArray<{ district?: number; block?: number }>;
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
  /** Landmark blocks claimed by their districts, and blocks let go for being out of reach of their unit's seed. */
  claimed: number;
  released: number;
  /** How the districts were drawn: with cells; with growth, the landmarks leading, because cells did not come out exact; or with plain growth, because neither did. */
  method: 'cells' | 'growth' | 'plain';
  /** Blocks of open country, and blocks of it kept as a way to a pocket of houses. */
  openCountry: number;
  connectors: number;
  /** Landmarks with a district and a block whose block ends in another district's ground. */
  landmarksOutside: number;
}

/** The mean of an outline's corners. */
const middle = (polygon: readonly Point[]): Point => [polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length, polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length];
const apart = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const half = (have: readonly number[], want: readonly number[]) => Math.round(have.reduce((sum, value, at) => sum + Math.abs(value - (want[at] as number)), 0) / 2);

export function drawDistricts(input: DistrictingInput): Districting {
  let drawn = draw(input, 'cells');
  if (drawn.off > 0) drawn = draw(input, 'growth');
  if (drawn.off > 0) drawn = draw(input, 'plain');
  drawn.landmarksOutside = (input.landmarks ?? []).filter((landmark) => landmark.district !== undefined && landmark.block !== undefined && landmark.block < input.blocks.length && drawn.blockDistrict[landmark.block] !== landmark.district).length;
  return drawn;
}

function draw({ rules, blocks, wards, houses, kept, tilesBeside, links, seeds, targets, landmarks = [] }: DistrictingInput, method: Districting['method']): Districting {
  const led = method === 'growth';
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

  // Open country: a run of more than `openRun` touching empty blocks, where empty is no kept house, no landmark
  // and no bridgehead. It is nobody's ground.
  const markBlocks = new Set(landmarks.flatMap((landmark) => (landmark.block === undefined ? [] : [landmark.block])));
  const linkEnds = new Set(links.flatMap((link) => [link.a, link.b]));
  const empty = (block: number) => keptB[block] === 0 && !markBlocks.has(block) && !linkEnds.has(block);
  const outside: boolean[] = blocks.map(() => false);
  const seenEmpty: boolean[] = blocks.map(() => false);
  for (let start = 0; start < B; start++) {
    if (seenEmpty[start] || !empty(start)) continue;
    const run = [start];
    seenEmpty[start] = true;
    for (let at = 0; at < run.length; at++) {
      for (const next of badj[run[at] as number] as number[]) {
        if (seenEmpty[next] || !empty(next)) continue;
        seenEmpty[next] = true;
        run.push(next);
      }
    }
    if (run.length > rules.openRun) for (const block of run) outside[block] = true;
  }
  // A pocket of houses that open country cuts off from the town keeps the shortest way of blocks back to it.
  let connectors = 0;
  {
    const piece: number[] = blocks.map(() => -1);
    const housesIn: number[] = [];
    for (let start = 0; start < B; start++) {
      if ((piece[start] as number) >= 0 || outside[start]) continue;
      const id = housesIn.length;
      housesIn.push(0);
      const stack = [start];
      piece[start] = id;
      while (stack.length > 0) {
        const at = stack.pop() as number;
        housesIn[id] = (housesIn[id] as number) + (keptB[at] as number);
        for (const next of badj[at] as number[]) {
          if ((piece[next] as number) >= 0 || outside[next]) continue;
          piece[next] = id;
          stack.push(next);
        }
      }
    }
    let town = 0;
    housesIn.forEach((count, id) => {
      if (count > (housesIn[town] as number)) town = id;
    });
    const joined = new Set([town]);
    for (let id = 0; id < housesIn.length; id++) {
      if (joined.has(id) || housesIn[id] === 0) continue;
      const previous = new Map<number, number>();
      const queue: number[] = [];
      for (let block = 0; block < B; block++) {
        if (piece[block] !== id) continue;
        queue.push(block);
        previous.set(block, -1);
      }
      let hit = -1;
      for (let head = 0; head < queue.length && hit < 0; head++) {
        const at = queue[head] as number;
        for (const next of badj[at] as number[]) {
          if (previous.has(next)) continue;
          previous.set(next, at);
          if ((piece[next] as number) >= 0 && joined.has(piece[next] as number)) {
            hit = next;
            break;
          }
          queue.push(next);
        }
      }
      if (hit < 0) continue;
      for (let at = previous.get(hit) as number; at >= 0 && piece[at] !== id; at = previous.get(at) as number) {
        if (!outside[at]) continue;
        outside[at] = false;
        connectors++;
      }
      joined.add(id);
    }
  }
  const openCountry = outside.filter(Boolean).length;

  const bank: number[] = blocks.map(() => -1);
  let banks = 0;
  for (let start = 0; start < B; start++) {
    if ((bank[start] as number) >= 0 || outside[start]) continue;
    const stack = [start];
    bank[start] = banks;
    while (stack.length > 0) {
      const at = stack.pop() as number;
      for (const next of badj[at] as number[]) {
        if ((bank[next] as number) >= 0 || outside[next] || across.has(`${at}:${next}`)) continue;
        bank[next] = banks;
        stack.push(next);
      }
    }
    banks++;
  }
  const cap: number[] = new Array<number>(banks).fill(0);
  keptB.forEach((value, block) => {
    if ((bank[block] as number) >= 0) cap[bank[block] as number] = (cap[bank[block] as number] as number) + value;
  });
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

  // ---- 3. Cells, or growth in turns ----------------------------------------------------------------------------
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
  // Each district claims its own landmarks' blocks, on any bank where it has a unit: the first of its units there.
  const marks: number[][] = units.map(() => []);
  let claimed = 0;
  if (led) {
    for (const landmark of landmarks) {
      if (landmark.district === undefined || landmark.block === undefined || landmark.block >= B) continue;
      const block = landmark.block;
      const at = units.findIndex((unit) => unit.district === landmark.district && bank[unit.seed] === bank[block]);
      if (at < 0) continue;
      if (g[block] === undefined) {
        g[block] = at;
        hv[at] = (hv[at] as number) + (keptB[block] as number);
      }
      if (g[block] === at && !(marks[at] as number[]).includes(block)) {
        (marks[at] as number[]).push(block);
        claimed++;
      }
    }
  }
  const front = units.map(() => new Set<number>());
  const reach = (at: number, block: number) => {
    for (const next of badj[block] as number[]) if (g[next] === undefined && bank[next] === bank[(units[at] as DistrictUnit).seed]) (front[at] as Set<number>).add(next);
  };
  units.forEach((unit, at) => {
    reach(at, unit.seed);
    for (const block of unit.heads ?? []) if (g[block] === at) reach(at, block);
    for (const block of marks[at] as number[]) reach(at, block);
  });
  if (method === 'cells') cells();
  const stopped: boolean[] = units.map(() => false);
  const furthestBelow = (a: number, b: number) => (hv[a] as number) / (UT[a] as number) - (hv[b] as number) / (UT[b] as number);
  while (method !== 'cells') {
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
        // Nearest the seed, or a landmark's block with part of that block's own way from the seed.
        let away = apart(blockMiddle[block] as Point, seedAt);
        for (const mark of marks[at] as number[]) away = Math.min(away, apart(blockMiddle[block] as Point, blockMiddle[mark] as Point) + apart(blockMiddle[mark] as Point, seedAt) * rules.landmarkPull);
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
  /**
   * Each bank cut into cells, one per unit: a block goes to the unit for which its squared distance from the unit's
   * centre less the unit's weight is least, and the weights are moved toward each unit's count.
   */
  function cells() {
    const centre: Point[] = units.map((unit) => [...(blockMiddle[unit.seed] as Point)] as Point);
    // A unit's centre is its seed's with its own landmarks' blocks on its bank; a unit on a bridgehead keeps that.
    const sums = units.map((_, at) => [(centre[at] as Point)[0], (centre[at] as Point)[1], 1] as [number, number, number]);
    for (const landmark of landmarks) {
      if (landmark.district === undefined || landmark.block === undefined || landmark.block >= B || (bank[landmark.block] as number) < 0) continue;
      const block = landmark.block;
      const at = units.findIndex((unit) => unit.district === landmark.district && bank[unit.seed] === bank[block] && !unit.heads);
      if (at < 0) continue;
      const sum = sums[at] as [number, number, number];
      sum[0] += (blockMiddle[block] as Point)[0];
      sum[1] += (blockMiddle[block] as Point)[1];
      sum[2]++;
    }
    sums.forEach((sum, at) => (centre[at] = [sum[0] / sum[2], sum[1] / sum[2]]));
    const weight: number[] = units.map(() => 0);
    for (let onBank = 0; onBank < banks; onBank++) {
      const here = [...Array(U).keys()].filter((at) => bank[(units[at] as DistrictUnit).seed] === onBank);
      const ground = blocks.flatMap((_, block) => (bank[block] === onBank ? [block] : []));
      if (here.length === 0 || ground.length === 0) continue;
      const mx = ground.reduce((sum, block) => sum + (blockMiddle[block] as Point)[0], 0) / ground.length;
      const my = ground.reduce((sum, block) => sum + (blockMiddle[block] as Point)[1], 0) / ground.length;
      const spread = ground.reduce((sum, block) => sum + ((blockMiddle[block] as Point)[0] - mx) ** 2 + ((blockMiddle[block] as Point)[1] - my) ** 2, 0) / ground.length;
      const scale = spread / Math.max(1, cap[onBank] as number);
      const cell = new Map<number, number>();
      let bestMiss = Infinity;
      let best = new Map<number, number>();
      for (let round = 0; round < rules.cellRounds; round++) {
        const held = new Map<number, number>(here.map((at) => [at, 0]));
        for (const block of ground) {
          let owner = -1;
          let least = Infinity;
          for (const at of here) {
            const value = ((blockMiddle[block] as Point)[0] - (centre[at] as Point)[0]) ** 2 + ((blockMiddle[block] as Point)[1] - (centre[at] as Point)[1]) ** 2 - (weight[at] as number);
            if (value < least) {
              least = value;
              owner = at;
            }
          }
          cell.set(block, owner);
          held.set(owner, (held.get(owner) as number) + (keptB[block] as number));
        }
        const miss = here.reduce((sum, at) => sum + Math.abs((held.get(at) as number) - (UT[at] as number)), 0);
        if (miss < bestMiss) {
          bestMiss = miss;
          best = new Map(cell);
        }
        if (miss <= here.length) break;
        const step = round < rules.cellStepRounds ? rules.cellStep : rules.cellStepLate;
        for (const at of here) weight[at] = (weight[at] as number) + step * scale * ((UT[at] as number) - (held.get(at) as number));
      }
      for (const block of ground) g[block] = best.get(block);
    }
    units.forEach((unit, at) => {
      for (const head of unit.heads ?? []) g[head] = at;
    });
    // A unit cut in pieces keeps the piece with its bridgehead, or else the one with most houses; the rest is let go.
    // Its seed is then its housed block nearest its centre.
    for (let at = 0; at < U; at++) {
      const unit = units[at] as DistrictUnit;
      const mine = blocks.flatMap((_, block) => (g[block] === at ? [block] : []));
      const seen = new Set<number>();
      let keep: number[] = [];
      let keepScore = -1;
      for (const start of mine) {
        if (seen.has(start)) continue;
        const piece = [start];
        seen.add(start);
        let count = 0;
        let head = false;
        for (let i = 0; i < piece.length; i++) {
          const block = piece[i] as number;
          count += keptB[block] as number;
          if ((unit.heads ?? []).includes(block)) head = true;
          for (const next of badj[block] as number[]) {
            if (g[next] !== at || bank[next] !== bank[block] || seen.has(next)) continue;
            seen.add(next);
            piece.push(next);
          }
        }
        const score = head ? Number.MAX_SAFE_INTEGER / 2 + count : count;
        if (score > keepScore) {
          keepScore = score;
          keep = piece;
        }
      }
      const kept = new Set(keep);
      for (const block of mine) if (!kept.has(block)) g[block] = undefined;
      let seed = -1;
      let least = Infinity;
      for (const block of keep) {
        if ((keptB[block] as number) === 0) continue;
        const away = ((blockMiddle[block] as Point)[0] - (centre[at] as Point)[0]) ** 2 + ((blockMiddle[block] as Point)[1] - (centre[at] as Point)[1]) ** 2;
        if (away < least) {
          least = away;
          seed = block;
        }
      }
      if (seed >= 0 && !unit.heads) unit.seed = seed;
    }
    hv.fill(0);
    for (let block = 0; block < B; block++) if (g[block] !== undefined) hv[g[block] as number] = (hv[g[block] as number] as number) + (keptB[block] as number);
  }
  // Blocks left over join the touching unit on their bank with the smallest surplus.
  const fillIn = () => {
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
  };
  fillIn();
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
  // A block its unit cannot reach from its seed or its bridgeheads is let go, and joins a neighbour as leftovers do.
  let released = 0;
  if (led) {
    units.forEach((unit, at) => {
      const seen = new Set<number>([unit.seed]);
      const stack = [unit.seed];
      for (const head of unit.heads ?? []) {
        if (g[head] !== at || seen.has(head)) continue;
        seen.add(head);
        stack.push(head);
      }
      while (stack.length > 0) {
        const block = stack.pop() as number;
        for (const next of badj[block] as number[]) {
          if (g[next] !== at || bank[next] !== bank[block] || seen.has(next)) continue;
          seen.add(next);
          stack.push(next);
        }
      }
      for (let block = 0; block < B; block++) {
        if (g[block] !== at || seen.has(block)) continue;
        g[block] = undefined;
        hv[at] = (hv[at] as number) - (keptB[block] as number);
        released++;
        marks[at] = (marks[at] as number[]).filter((mark) => mark !== block);
      }
    });
    fillIn();
  }
  const unclaimed = keptB.reduce((sum, value, block) => sum + (g[block] === undefined ? value : 0), 0);

  // ---- 4. Pass surplus along chains ----------------------------------------------------------------------------
  /** How many pieces some blocks make, counting only pieces with kept houses, or with a block `counts` says. */
  const pieces = (nodes: number[], beside: (node: number) => number[], counts: (node: number) => boolean = () => false) => {
    const left = new Set(nodes);
    let count = 0;
    while (left.size > 0) {
      const stack = [left.values().next().value as number];
      left.delete(stack[0] as number);
      let houses = false;
      while (stack.length > 0) {
        const node = stack.pop() as number;
        if ((keptB[node] as number) > 0 || counts(node)) houses = true;
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
  // A unit's own landmark blocks count as pieces too, so that no chain cuts one off.
  const unitPieces = (at: number) => pieces(blocksOf(at), besideIn(at), (node) => (marks[at] as number[]).includes(node));
  /** A giver hands the receiver one border block; it says how many houses went. */
  const give = (from: number, to: number, want: number): number => {
    const giver = units[from] as DistrictUnit;
    const choices: number[] = [];
    for (let block = 0; block < B; block++) {
      if (g[block] !== from || keptB[block] === 0 || block === giver.seed || (giver.heads ?? []).includes(block) || (marks[from] as number[]).includes(block)) continue;
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

  // A district is whole if its blocks join, a bridge counting as a join; a piece counts if it has houses or one of
  // the district's own landmarks.
  const blockDistrict = g.map((at) => (at === undefined ? undefined : (units[at] as DistrictUnit).district));
  const ownMark = new Set(landmarks.flatMap((landmark) => (landmark.district === undefined || landmark.block === undefined ? [] : [`${landmark.district}:${landmark.block}`])));
  const inPieces = order.filter(
    (district) =>
      pieces(
        blockDistrict.flatMap((of, block) => (of === district ? [block] : [])),
        (node) => (badj[node] as number[]).filter((next) => blockDistrict[next] === district),
        (node) => ownMark.has(`${district}:${node}`),
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
    claimed,
    released,
    method,
    openCountry,
    connectors,
    landmarksOutside: 0,
  };
}

export interface HouseDistricts {
  /** For each house made, its district; nothing for a house not kept. */
  district: Array<number | undefined>;
  /** How many kept houses each district has: its count. */
  kept: number[];
  /** Houses given to a district from the ground of the nearest touching district with houses to spare, because the districts did not come out exact. */
  leftovers: number;
}

/**
 * Each kept house's district: its block's, but for a block that lends houses, whose houses nearest the
 * neighbour's ground are the neighbour's. Where the districts did not come out exact, a district short of houses
 * takes those it lacks from the nearest touching district with houses to spare, the houses nearest its own
 * ground; they are counted.
 */
export function houseDistricts(drawn: Districting, { blocks, houses, kept, tilesBeside, links }: Pick<DistrictingInput, 'blocks' | 'houses' | 'kept' | 'tilesBeside' | 'links'> & { houses: ReadonlyArray<{ block: number; ward: number; centre: Point }> }): HouseDistricts {
  const B = blocks.length;
  const badj: number[][] = blocks.map((_, block) => (tilesBeside[block] ?? []).filter((other) => other < B));
  for (const link of links) {
    if (link.a >= B || link.b >= B) continue;
    (badj[link.a] as number[]).push(link.b);
    (badj[link.b] as number[]).push(link.a);
  }
  const district: Array<number | undefined> = houses.map(() => undefined);
  const inBlock = blocks.map((): number[] => []);
  for (const house of kept) (inBlock[(houses[house] as { block: number }).block] as number[]).push(house);
  inBlock.forEach((list, block) => {
    const of = drawn.blockDistrict[block];
    if (list.length === 0) return;
    if (of === undefined) throw new Error(`block ${block} has ${list.length} kept houses and no district`);
    for (const house of list) district[house] = of;
    const lent = drawn.lent.get(block);
    if (!lent) return;
    const theirs = (badj[block] as number[]).filter((other) => drawn.blockDistrict[other] === lent.to);
    const away = (house: number) => Math.min(...theirs.map((other) => distanceToPolygonEdge((houses[house] as { centre: Point }).centre, (blocks[other] as { polygon: readonly Point[] }).polygon)));
    const nearest = [...list].sort((a, b) => away(a) - away(b) || a - b).slice(0, lent.houses);
    for (const house of nearest) district[house] = lent.to;
  });
  const count = drawn.targets.map(() => 0);
  for (const of of district) if (of !== undefined) count[of] = (count[of] as number) + 1;
  // What the districts could not make exact: from the nearest touching district with houses to spare.
  let leftovers = 0;
  const middle = blocks.map((block) => block.polygon.reduce((sum, point): Point => [sum[0] + point[0] / block.polygon.length, sum[1] + point[1] / block.polygon.length], [0, 0]));
  for (let short = 0; short < count.length; short++) {
    while ((count[short] as number) < (drawn.targets[short] as number)) {
      const touching = new Map<number, Set<number>>();
      for (let block = 0; block < B; block++) {
        const x = drawn.blockDistrict[block];
        if (x === undefined) continue;
        for (const next of badj[block] as number[]) {
          const y = drawn.blockDistrict[next];
          if (y === undefined || y === x) continue;
          if (!touching.has(x)) touching.set(x, new Set());
          touching.get(x)?.add(y);
        }
      }
      const spare = (of: number) => (count[of] as number) > (drawn.targets[of] as number);
      let giver = -1;
      const seen = new Set([short]);
      for (let queue = [short]; queue.length > 0 && giver < 0; ) {
        const next: number[] = [];
        for (const x of queue) for (const y of [...(touching.get(x) ?? [])].sort((a, b) => a - b)) if (!seen.has(y)) (seen.add(y), next.push(y));
        giver = next.find(spare) ?? -1;
        queue = next;
      }
      if (giver < 0) giver = count.findIndex((_, of) => spare(of));
      if (giver < 0) throw new Error(`district ${short} is short of houses and no district has any to spare`);
      const own = drawn.blockDistrict.flatMap((of, block) => (of === short ? [block] : []));
      const away = (house: number) => Math.min(...own.map((block) => Math.hypot((houses[house] as { centre: Point }).centre[0] - (middle[block] as Point)[0], (houses[house] as { centre: Point }).centre[1] - (middle[block] as Point)[1])));
      const amount = Math.min((drawn.targets[short] as number) - (count[short] as number), (count[giver] as number) - (drawn.targets[giver] as number));
      const theirs = district.flatMap((of, house) => (of === giver ? [house] : [])).sort((a, b) => away(a) - away(b) || a - b);
      for (const house of theirs.slice(0, amount)) district[house] = short;
      count[short] = (count[short] as number) + amount;
      count[giver] = (count[giver] as number) - amount;
      leftovers += amount;
    }
  }
  return { district, kept: count, leftovers };
}
