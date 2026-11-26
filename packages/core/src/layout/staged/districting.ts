/**
 * The districts stage (phase 6G, `sim-6g.md`): districts drawn over the kept
 * houses, block by block, after selection has decided which houses exist.
 *
 * The districts are cut for their shape. Each comes out near its count, not
 * exactly at it; the few houses over or under are settled house by house
 * afterwards (`houseDistricts`), so that every district has exactly its count
 * of houses while its ground stays whole and compact.
 *
 * A bank is a set of blocks joined without crossing a bridge; a unit is a
 * district, or the part of one on one bank; a bridgehead is the block at one
 * end of a bridge link.
 *
 * 1. Open country. A run of more than `openRun` touching empty blocks (no kept
 *    house, no landmark, no bridgehead) is nobody's ground, and so is an empty
 *    block with housed blocks on fewer than `fringeSides` of the eight sides
 *    about it. A pocket of houses this would cut off keeps its shortest way
 *    back to the town.
 * 2. Seed. Each district is given one block with kept houses, the nearest to
 *    the middle of its forecast seed ward, the smallest districts first; no two
 *    share one. A waterside district is seeded on a block at the water.
 * 3. Share the districts among the banks. While a bank's units want more
 *    houses than it holds, a district crosses a bridge to the bank with most
 *    room: one already crossing there carries more over; otherwise the unit
 *    whose centre is nearest the bridge goes over whole if it nearly fits, or
 *    splits, both parts seeded on their bridgeheads. A bank with no bridge
 *    sends its largest unit to the bank with most room.
 * 4. Cells. A unit on a bridgehead takes the blocks nearest its bridgehead,
 *    each touching the last, up to its count. The rest of each bank is cut
 *    into cells, one per unit: a unit has a centre (its seed with its own
 *    landmarks' blocks on that bank) and a weight; a block goes to the unit for
 *    which its squared distance from the centre less the weight is least, and
 *    the weights are raised and lowered until each unit holds about its count.
 * 5. Tidy. A unit left in pieces keeps the piece with most houses and lets
 *    the rest go; a block let go joins the unit most of its neighbours are in.
 *    A unit that crosses a bridge is given the shortest way of blocks to its
 *    bridgehead if it lacks one, and a waterside district to the water.
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
  /** The landmarks reserved, each with its district and its block, if it has them. */
  landmarks?: ReadonlyArray<{ district?: number; block?: number }>;
  /** For each district, whether it must touch the water; for each block, how far its ground is from the water; and how near counts as touching. */
  waterside?: readonly boolean[];
  water?: readonly number[];
  waterReach?: number;
}

/** One district, or its part on one bank. */
export interface DistrictUnit {
  district: number;
  target: number;
  seed: number;
  /** The bridgeheads that are this unit's, where its district crosses a bridge. */
  heads?: number[];
  /** A waterside district's unit: its seed is a block at the water, and stays its own. */
  anchored?: boolean;
}

export interface Districting {
  /** For each block, its district; nothing for an empty block that no district reached. */
  blockDistrict: Array<number | undefined>;
  /** For each district, the whole number of houses it is to have, and how many stand in its ground. */
  targets: number[];
  have: number[];
  /** The bank of each block, the units, and the houses in each unit's ground. */
  bank: number[];
  units: DistrictUnit[];
  unitHave: number[];
  /** How far the districts' ground is from their counts: half the sum of every miss. `houseDistricts` settles it. */
  off: number;
  /** Districts in more than one piece of blocks with houses, a bridge counting as a join. */
  inPieces: number;
  /** Districts with ground on both sides of a bridge. */
  spans: number;
  /** Units re-seeded on another bank for want of a bridge, and units moved across whole. */
  reseeded: number;
  relocated: number;
  /** Kept houses in blocks that touched no unit on their bank, and so joined the nearest. */
  islands: number;
  /** Kept houses in blocks no unit claimed. */
  unclaimed: number;
  /** Blocks of open country, and blocks of it kept as a way to a pocket of houses. */
  openCountry: number;
  connectors: number;
  /** Landmarks with a district and a block whose block ends in another district's ground. */
  landmarksOutside: number;
  /** Waterside districts that had to be given a way of blocks to the water. */
  waterPaths: number;
  /** Units that had to be given a way of blocks to their bridgehead. */
  headPaths: number;
}

/** The mean of an outline's corners. */
const middle = (polygon: readonly Point[]): Point => [polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length, polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length];
const apart = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const half = (have: readonly number[], want: readonly number[]) => Math.round(have.reduce((sum, value, at) => sum + Math.abs(value - (want[at] as number)), 0) / 2);

export function drawDistricts(input: DistrictingInput): Districting {
  const drawn = draw(input);
  drawn.landmarksOutside = (input.landmarks ?? []).filter((landmark) => landmark.district !== undefined && landmark.block !== undefined && landmark.block < input.blocks.length && drawn.blockDistrict[landmark.block] !== landmark.district).length;
  return drawn;
}

function draw({ rules, blocks, wards, houses, kept, tilesBeside, links, seeds, targets, landmarks = [], waterside = [], water, waterReach = 0 }: DistrictingInput): Districting {
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
  // So is an empty block at the town's edge: one without housed blocks on enough sides of it.
  const housed = blocks.flatMap((_, block) => ((keptB[block] as number) > 0 ? [block] : []));
  for (let block = 0; block < B; block++) {
    if (outside[block] || !empty(block)) continue;
    const sides = new Set<number>();
    const at = blockMiddle[block] as Point;
    for (const other of housed) {
      const to = blockMiddle[other] as Point;
      if (apart(at, to) > rules.fringeRadius) continue;
      sides.add(Math.floor(((Math.atan2(to[1] - at[1], to[0] - at[0]) + Math.PI) / (2 * Math.PI)) * 8) % 8);
    }
    if (sides.size < rules.fringeSides) outside[block] = true;
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
  const atWater = (block: number) => water !== undefined && (water[block] ?? Infinity) <= waterReach;
  /** The free block with kept houses nearest the water, on the bank given or any. */
  const nearestWater = (onBank: number | undefined): number => {
    let best = -1;
    let least = Infinity;
    for (let block = 0; block < B; block++) {
      if (taken.has(block) || keptB[block] === 0 || (bank[block] as number) < 0 || (onBank !== undefined && bank[block] !== onBank)) continue;
      const away = water?.[block] ?? Infinity;
      if (away < least) {
        least = away;
        best = block;
      }
    }
    return best;
  };
  const nearestKept = (from: Point, onBank: number | undefined, byWater = false): number => {
    let best = -1;
    let least = Infinity;
    for (let block = 0; block < B; block++) {
      if (taken.has(block) || keptB[block] === 0 || (onBank !== undefined && bank[block] !== onBank)) continue;
      if (byWater && !atWater(block)) continue;
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
    const from: Point = ward >= 0 ? (wardMiddle[ward] as Point) : [0, 0];
    // A waterside district starts on a block at the water: the nearest such to its ward, or failing any, the block
    // nearest the water.
    const anchored = waterside[district] === true && water !== undefined;
    let block = anchored ? nearestKept(from, undefined, true) : nearestKept(from, undefined);
    if (block < 0 && anchored) block = nearestWater(undefined);
    if (block < 0) continue;
    taken.add(block);
    units.push({ district, target: T[district] as number, seed: block, ...(anchored && { anchored }) });
  }

  /**
   * A unit's centre: its seed's middle with those of its district's own landmarks' blocks on its bank. A unit on a
   * bridgehead, or at the water, keeps its seed's.
   */
  const centreOf = (unit: DistrictUnit): Point => {
    const from = blockMiddle[unit.seed] as Point;
    if (unit.heads || unit.anchored) return [from[0], from[1]];
    let x = from[0];
    let y = from[1];
    let count = 1;
    for (const landmark of landmarks) {
      if (landmark.district !== unit.district || landmark.block === undefined || landmark.block >= B || (bank[landmark.block] as number) < 0 || bank[landmark.block] !== bank[unit.seed]) continue;
      x += (blockMiddle[landmark.block] as Point)[0];
      y += (blockMiddle[landmark.block] as Point)[1];
      count++;
    }
    return [x / count, y / count];
  };
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
    const toNear = (unit: DistrictUnit) => apart(centreOf(unit), blockMiddle[near] as Point);
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

  // A waterside unit that the sharing moved is put back at the water on the bank it went to.
  for (const unit of units) {
    if (!unit.anchored || unit.heads || atWater(unit.seed)) continue;
    const onBank = bank[unit.seed] as number;
    taken.delete(unit.seed);
    let block = nearestKept(blockMiddle[unit.seed] as Point, onBank, true);
    if (block < 0) block = nearestWater(onBank);
    if (block >= 0) unit.seed = block;
    taken.add(unit.seed);
  }

  // ---- 4. Cells ------------------------------------------------------------------------------------------------
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
  /**
   * Each bank cut into cells, one per unit: a block goes to the unit for which its squared distance from the unit's
   * centre less the unit's weight is least, and the weights are moved toward each unit's count.
   */
  function cells(centre: readonly Point[], want: readonly number[]) {
    const weight: number[] = units.map(() => 0);
    // A unit on a bridgehead first: it takes the blocks nearest its bridgehead, each touching the last, up to its
    // count. Its ground is then about the bridge whatever stands beside it, and the cells are cut from the rest.
    // (A waterside unit is not drawn so: the blocks along a quay seldom touch enough others to make its count.)
    const atBridge = new Set<number>();
    units.forEach((unit, at) => {
      const head = unit.heads?.[0];
      if (head === undefined || atBridge.has(head)) return;
      const from = blockMiddle[head] as Point;
      const edge = new Set<number>([head]);
      let have = 0;
      while (edge.size > 0) {
        let next = -1;
        let least = Infinity;
        for (const block of edge) {
          const away = apart(blockMiddle[block] as Point, from);
          if (away < least) {
            least = away;
            next = block;
          }
        }
        if (have + (keptB[next] as number) / 2 > (want[at] as number)) break;
        edge.delete(next);
        atBridge.add(next);
        g[next] = at;
        have += keptB[next] as number;
        for (const other of badj[next] as number[]) if (!atBridge.has(other) && bank[other] === bank[head]) edge.add(other);
      }
    });
    for (let onBank = 0; onBank < banks; onBank++) {
      const here = [...Array(U).keys()].filter((at) => bank[(units[at] as DistrictUnit).seed] === onBank && !(units[at] as DistrictUnit).heads);
      const ground = blocks.flatMap((_, block) => (bank[block] === onBank && !atBridge.has(block) ? [block] : []));
      if (here.length === 0 || ground.length === 0) continue;
      const mx = ground.reduce((sum, block) => sum + (blockMiddle[block] as Point)[0], 0) / ground.length;
      const my = ground.reduce((sum, block) => sum + (blockMiddle[block] as Point)[1], 0) / ground.length;
      const spread = ground.reduce((sum, block) => sum + ((blockMiddle[block] as Point)[0] - mx) ** 2 + ((blockMiddle[block] as Point)[1] - my) ** 2, 0) / ground.length;
      const scale = spread / Math.max(1, ground.reduce((sum, block) => sum + (keptB[block] as number), 0));
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
        const miss = here.reduce((sum, at) => sum + Math.abs((held.get(at) as number) - (want[at] as number)), 0);
        if (miss < bestMiss) {
          bestMiss = miss;
          best = new Map(cell);
        }
        if (miss <= here.length) break;
        const step = round < rules.cellStepRounds ? rules.cellStep : rules.cellStepLate;
        for (const at of here) weight[at] = (weight[at] as number) + step * scale * ((want[at] as number) - (held.get(at) as number));
      }
      for (const block of ground) g[block] = best.get(block);
    }
    tidy(false);
    hv.fill(0);
    for (let block = 0; block < B; block++) if (g[block] !== undefined) hv[g[block] as number] = (hv[g[block] as number] as number) + (keptB[block] as number);
  }
  /**
   * A unit cut in pieces keeps the one with most houses (a waterside unit, the one at the water with most), or,
   * once its bridgeheads are joined to it, the one with a bridgehead; the rest is let go.
   */
  function tidy(byHead: boolean) {
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
        let wet = false;
        for (let i = 0; i < piece.length; i++) {
          const block = piece[i] as number;
          count += keptB[block] as number;
          if ((unit.heads ?? []).includes(block)) head = true;
          if (unit.anchored === true && atWater(block)) wet = true;
          for (const next of badj[block] as number[]) {
            if (g[next] !== at || bank[next] !== bank[block] || seen.has(next)) continue;
            seen.add(next);
            piece.push(next);
          }
        }
        // A waterside unit keeps a piece at the water before a larger one away from it.
        const score = (byHead && head ? Number.MAX_SAFE_INTEGER / 2 : 0) + (wet ? Number.MAX_SAFE_INTEGER / 8 : 0) + count;
        if (score > keepScore) {
          keepScore = score;
          keep = piece;
        }
      }
      const kept = new Set(keep);
      for (const block of mine) {
        if (kept.has(block)) continue;
        g[block] = undefined;
        hv[at] = (hv[at] as number) - (keptB[block] as number);
      }
    }
  }
  /** A unit takes the shortest way of blocks on its bank from its ground to a block, and the block; false if there is none. */
  const takeWayTo = (at: number, ends: (block: number) => boolean): boolean => {
    const mine = blocks.flatMap((_, block) => (g[block] === at ? [block] : []));
    if (mine.some(ends)) return true;
    const onBank = bank[(units[at] as DistrictUnit).seed];
    const before = new Map<number, number>(mine.map((block) => [block, -1]));
    const queue = [...mine];
    let found = -1;
    if (mine.length === 0) {
      // No ground at all: it starts from the nearest block on its bank that will do.
      let least = Infinity;
      for (let block = 0; block < B; block++) {
        if (bank[block] !== onBank || !ends(block)) continue;
        const away = apart(blockMiddle[block] as Point, blockMiddle[(units[at] as DistrictUnit).seed] as Point);
        if (away < least) {
          least = away;
          found = block;
        }
      }
      if (found < 0) return false;
      before.set(found, -1);
    }
    for (let i = 0; i < queue.length && found < 0; i++) {
      const block = queue[i] as number;
      for (const next of badj[block] as number[]) {
        if (before.has(next) || bank[next] !== onBank) continue;
        before.set(next, block);
        if (ends(next)) {
          found = next;
          break;
        }
        queue.push(next);
      }
    }
    if (found < 0) return false;
    for (let block = found; block !== -1 && g[block] !== at; block = before.get(block) as number) {
      const was = g[block];
      if (was !== undefined) hv[was] = (hv[was] as number) - (keptB[block] as number);
      g[block] = at;
      hv[at] = (hv[at] as number) + (keptB[block] as number);
    }
    return true;
  };
  // Blocks left over join a touching unit on their bank.
  const fillIn = () => {
    for (let pass = 0; pass < rules.fills; pass++) {
      let any = false;
      for (let block = 0; block < B; block++) {
        if (g[block] !== undefined) continue;
        let best = -1;
        let least = Infinity;
        // A block let go joins the unit most of its neighbours are in, the one with the smaller surplus where two are
        // level: that keeps the cells' shapes.
        const besideOf = new Map<number, number>();
        for (const next of badj[block] as number[]) {
          const at = g[next];
          if (at === undefined || bank[next] !== bank[block]) continue;
          besideOf.set(at, (besideOf.get(at) ?? 0) + 1);
        }
        for (const [at, count] of besideOf) {
          const value = -count * 1e6 + (hv[at] as number) - (UT[at] as number);
          if (value >= least) continue;
          least = value;
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
  // The cells are cut, tidied and filled in up to `cellTries` times. A cell that a wall or the water cuts in two
  // loses its smaller part to its neighbours, and so comes out under its count: the next try asks more of it, and
  // less of those that came out over. The try nearest the counts is kept.
  const centre = units.map(centreOf);
  const want = [...UT];
  let nearest: Array<number | undefined> = [];
  let leastMiss = Infinity;
  for (let attempt = 0; attempt < rules.cellTries; attempt++) {
    g.fill(undefined);
    cells(centre, want);
    fillIn();
    const miss = units.reduce((sum, _, at) => sum + Math.abs((hv[at] as number) - (UT[at] as number)), 0);
    if (miss < leastMiss) {
      leastMiss = miss;
      nearest = [...g];
    }
    if (miss <= U) break;
    units.forEach((_, at) => (want[at] = Math.max(1, (want[at] as number) + rules.cellCorrection * ((UT[at] as number) - (hv[at] as number)))));
  }
  nearest.forEach((at, block) => (g[block] = at));
  hv.fill(0);
  for (let block = 0; block < B; block++) if (g[block] !== undefined) hv[g[block] as number] = (hv[g[block] as number] as number) + (keptB[block] as number);
  // Its seed is then its housed block nearest its centre.
  for (let at = 0; at < U; at++) {
    const unit = units[at] as DistrictUnit;
    if (unit.heads || unit.anchored) continue;
    let seed = -1;
    let least = Infinity;
    for (let block = 0; block < B; block++) {
      if (g[block] !== at || (keptB[block] as number) === 0) continue;
      const away = ((blockMiddle[block] as Point)[0] - (centre[at] as Point)[0]) ** 2 + ((blockMiddle[block] as Point)[1] - (centre[at] as Point)[1]) ** 2;
      if (away < least) {
        least = away;
        seed = block;
      }
    }
    if (seed >= 0) unit.seed = seed;
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
  let waterPaths = 0;
  let headPaths = 0;
  {
    // A unit that crosses a bridge reaches its bridgehead: the bridge is what joins its two parts.
    units.forEach((unit, at) => {
      for (const head of unit.heads ?? []) {
        if (g[head] !== at) headPaths++;
        takeWayTo(at, (block) => block === head);
      }
    });
    tidy(true);
    fillIn();
    // A waterside district whose ground does not come to the water is given the shortest way of blocks to it.
    if (water !== undefined) {
      for (let district = 0; district < D; district++) {
        if (waterside[district] !== true) continue;
        const parts = units.flatMap((unit, at) => (unit.district === district ? [at] : []));
        if (parts.length === 0 || blocks.some((_, block) => g[block] !== undefined && parts.includes(g[block] as number) && atWater(block))) continue;
        // Its largest part goes to the water.
        const most = [...parts].sort((a, b) => (hv[b] as number) - (hv[a] as number) || a - b)[0] as number;
        if (takeWayTo(most, atWater)) waterPaths++;
      }
    }
    // A way taken through another unit may have cut it in two: it keeps its larger part.
    if (waterPaths > 0 || headPaths > 0) {
      tidy(true);
      fillIn();
    }
  }
  const unclaimed = keptB.reduce((sum, value, block) => sum + (g[block] === undefined ? value : 0), 0);

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
  const have: number[] = new Array<number>(D).fill(0);
  units.forEach((unit, at) => (have[unit.district] = (have[unit.district] as number) + (hv[at] as number)));

  // Whole-number counts, the remainders given largest first.
  const IT = T.map((value) => Math.floor(value));
  const remainder = total - IT.reduce((sum, value) => sum + value, 0);
  const fractions = order.map((district) => [(T[district] as number) - (IT[district] as number), district] as const).sort((x, y) => y[0] - x[0]);
  for (let at = 0; at < remainder; at++) {
    const district = (fractions[at % D] as readonly [number, number])[1];
    IT[district] = (IT[district] as number) + 1;
  }

  return { blockDistrict, targets: IT, have, bank, units, unitHave: hv, off: half(have, IT), inPieces, spans, reseeded, relocated, islands, unclaimed, openCountry, connectors, landmarksOutside: 0, waterPaths, headPaths };
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
      // The nearest district by touching with houses to spare, and the way back from it.
      let giver = -1;
      const before = new Map<number, number>([[short, -1]]);
      for (let queue = [short]; queue.length > 0 && giver < 0; ) {
        const next: number[] = [];
        for (const x of queue) {
          for (const y of [...(touching.get(x) ?? [])].sort((a, b) => a - b)) {
            if (before.has(y)) continue;
            before.set(y, x);
            next.push(y);
          }
        }
        giver = next.find(spare) ?? -1;
        queue = next;
      }
      // None by touching: any district with houses to spare gives straight to it.
      if (giver < 0) {
        giver = count.findIndex((_, of) => spare(of));
        if (giver < 0) throw new Error(`district ${short} is short of houses and no district has any to spare`);
        before.clear();
        before.set(short, -1);
        before.set(giver, short);
      }
      const amount = Math.min((drawn.targets[short] as number) - (count[short] as number), (count[giver] as number) - (drawn.targets[giver] as number));
      // Hop by hop from the giver: each district on the way hands the next the houses nearest that one's ground, so
      // a house only ever joins a district whose ground is next to it.
      for (let from = giver; before.get(from) !== -1; from = before.get(from) as number) {
        const to = before.get(from) as number;
        const own = drawn.blockDistrict.flatMap((of, block) => (of === to ? [block] : []));
        const away = (house: number) => Math.min(...own.map((block) => Math.hypot((houses[house] as { centre: Point }).centre[0] - (middle[block] as Point)[0], (houses[house] as { centre: Point }).centre[1] - (middle[block] as Point)[1])));
        const theirs = district.flatMap((of, house) => (of === from ? [house] : [])).map((house) => [away(house), house] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        for (const [, house] of theirs.slice(0, amount)) district[house] = to;
        leftovers += amount;
      }
      count[short] = (count[short] as number) + amount;
      count[giver] = (count[giver] as number) - amount;
    }
  }
  return { district, kept: count, leftovers };
}
