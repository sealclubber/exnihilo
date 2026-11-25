/**
 * Stage 11 of the staged generator: selection. Make too many, keep the best.
 *
 * More houses were made than the town has. The town keeps exactly as many
 * as it has buildings, the best-placed first: the innermost are always
 * kept, as is everything inside the wall, and further out keeping a house
 * is more and more a matter of chance. The rest never existed. Each kept
 * house then belongs to the district of its block, and each district's
 * count is made exact at its borders: whole blocks change district where
 * their ground touches the taker's, and what remains is settled by single
 * houses at a shared border. No house is dropped or added.
 */
import type { StagedSettings } from '../../pack/schema.ts';
import { type Block, wardRng } from './blocks.ts';
import { distanceToPolygonEdge, polygonCentroid } from '../geometry.ts';
import type { DistrictForecast } from './districts.ts';
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
  /** How many houses each district keeps, and how many of them stand in a neighbour's block at their shared border. */
  kept: number[];
  borrowed: number[];
  /** How many houses came to a district from one whose ground does not touch its own: the last resort. */
  fallback: number;
  /** How many houses the town is short of: nothing may be built until this is none. */
  short: number;
}

export interface SelectionInput {
  settings: StagedSettings;
  seed: number;
  houses: readonly House[];
  blocks: readonly Block[];
  wards: readonly Ward[];
  plan: DistrictForecast;
  /** How many houses each district is to keep. */
  wanted: readonly number[];
  ground: Ground;
  wall?: Wall;
  /** For each block, the blocks whose ground touches its own, and those a bridge link joins it to: blocks and single houses change district across either. */
  beside: ReadonlyArray<readonly number[]>;
  /** Blocks that hold a landmark, and so stay in its district. */
  fixed: ReadonlyMap<number, number>;
}

/** How many chains are tried for each district, and how near exact a district's count must be for whole blocks to leave it alone. */
const CHAINS = 12;
const SETTLED = 3;
/** How many times a chain that stopped at a thin district is tried again, the district being thicker each time. */
const THICKENINGS = 8;

export function chooseHouses({ settings, seed, houses, blocks, wards, plan, wanted, ground, wall, beside, fixed }: SelectionInput): Selection {
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

  // ---- Each district's count made exact -----------------------------------------------------------------------
  // The town-wide choice above decides which houses exist; nothing below drops or adds one. A kept house belongs
  // to the district of its block. Wards are coarse, so a district may hold more kept houses than it has
  // buildings, or fewer. A block changes district only where its ground touches the taker's; surplus flows
  // through the districts between, border by border, over several rounds. What whole blocks cannot settle is
  // settled by single houses, again only at a shared border.
  const blockDistrict: Array<number | undefined> = blocks.map((block, index) => fixed.get(index) ?? plan.of[block.ward]);
  const keptIn = blocks.map(() => 0);
  for (const index of chosen) keptIn[(houses[index] as House).block] = (keptIn[(houses[index] as House).block] as number) + 1;
  // A block with kept houses that no district reached goes to a district whose ground touches it, spreading
  // outward from the blocks that have one; failing any, to the district whose blocks are nearest.
  const spread = blocks.map((_, index) => index).filter((index) => blockDistrict[index] !== undefined);
  for (let head = 0; head < spread.length; head++) {
    for (const next of beside[spread[head] as number] ?? []) {
      if (blockDistrict[next] !== undefined) continue;
      blockDistrict[next] = blockDistrict[spread[head] as number];
      spread.push(next);
    }
  }
  const middles = blocks.map((block) => polygonCentroid(block.polygon));
  if (wanted.length > 0) {
    blocks.forEach((_, index) => {
      if (blockDistrict[index] !== undefined || (keptIn[index] as number) === 0) return;
      let best = 0;
      let least = Infinity;
      blockDistrict.forEach((of, other) => {
        const away = of === undefined ? Infinity : Math.hypot((middles[other] as number[])[0] as number - ((middles[index] as number[])[0] as number), ((middles[other] as number[])[1] as number) - ((middles[index] as number[])[1] as number));
        if (away < least) {
          least = away;
          best = of as number;
        }
      });
      blockDistrict[index] = best;
    });
  }
  // A district's body is the largest piece of its blocks that touch one another. A block apart from it, as one
  // may be that lies in a ward a landmark of another district was reserved in, is no ground to grow from: but for
  // a landmark's own block it goes to the district whose body it touches.
  const inBody = new Uint8Array(blocks.length);
  const embody = () => {
    inBody.fill(0);
    const seen = new Uint8Array(blocks.length);
    const best = new Map<number, { weight: number; piece: number[] }>();
    blockDistrict.forEach((of, index) => {
      if (of === undefined || seen[index]) return;
      const piece = [index];
      seen[index] = 1;
      let weight = 0;
      for (let head = 0; head < piece.length; head++) {
        weight += (keptIn[piece[head] as number] as number) + 0.001;
        for (const next of beside[piece[head] as number] ?? []) {
          if (seen[next] || blockDistrict[next] !== of) continue;
          seen[next] = 1;
          piece.push(next);
        }
      }
      if (weight > (best.get(of)?.weight ?? -1)) best.set(of, { weight, piece });
    });
    for (const { piece } of best.values()) for (const index of piece) inBody[index] = 1;
  };
  embody();
  if (wanted.length > 0 && blockDistrict.some((of, index) => of !== undefined && !inBody[index] && !fixed.has(index))) {
    blockDistrict.forEach((of, index) => {
      if (of !== undefined && !inBody[index] && !fixed.has(index)) blockDistrict[index] = undefined;
    });
    const out = blocks.map((_, index) => index).filter((index) => inBody[index]);
    for (let head = 0; head < out.length; head++) {
      for (const next of beside[out[head] as number] ?? []) {
        if (blockDistrict[next] !== undefined) continue;
        blockDistrict[next] = blockDistrict[out[head] as number];
        out.push(next);
      }
    }
    blocks.forEach((_, index) => {
      if (blockDistrict[index] !== undefined || (keptIn[index] as number) === 0) return;
      let best = 0;
      let least = Infinity;
      blockDistrict.forEach((of, other) => {
        const away = of === undefined ? Infinity : Math.hypot(((middles[other] as number[])[0] as number) - ((middles[index] as number[])[0] as number), ((middles[other] as number[])[1] as number) - ((middles[index] as number[])[1] as number));
        if (away < least) {
          least = away;
          best = of as number;
        }
      });
      blockDistrict[index] = best;
    });
    embody();
  }
  const have = wanted.map(() => 0);
  blockDistrict.forEach((of, block) => {
    if (of !== undefined) have[of] = (have[of] as number) + (keptIn[block] as number);
  });
  const balance = (of: number) => (have[of] as number) - (wanted[of] as number);
  /** The blocks of other districts whose ground touches a district's body. */
  const frontier = (of: number): number[] => {
    const out = new Set<number>();
    blockDistrict.forEach((district, index) => {
      if (district !== of || !inBody[index]) return;
      for (const next of beside[index] ?? []) if (blockDistrict[next] !== undefined && blockDistrict[next] !== of) out.add(next);
    });
    return [...out].sort((a, b) => a - b);
  };
  /** Whether a district's blocks stay in one piece without one of them: a block is never taken if its loss would part the district that gives it. */
  /** Blocks that have given single houses to a neighbour: no longer ground that holds their district together. */
  const lent = new Set<number>();
  const held = (donor: number, block: number) => blockDistrict[block] === donor && !lent.has(block);
  const whole = (donor: number, index: number): boolean => {
    const others = (beside[index] ?? []).filter((next) => held(donor, next));
    if (others.length <= 1) return true;
    const seen = new Set([others[0] as number]);
    const queue = [others[0] as number];
    let found = 1;
    for (let head = 0; head < queue.length && found < others.length; head++) {
      for (const next of beside[queue[head] as number] ?? []) {
        if (next === index || seen.has(next) || !held(donor, next)) continue;
        seen.add(next);
        queue.push(next);
        if (others.includes(next)) found++;
      }
    }
    return found === others.length;
  };
  // Whole blocks. A district takes a block that touches its ground from a neighbour that has more to spare than
  // it has itself, so long as the neighbour is left no worse off than the district then is.
  for (let round = 0; round < rules.rounds; round++) {
    let any = false;
    wanted.forEach((_, of) => {
      for (const index of frontier(of)) {
        const donor = blockDistrict[index] as number;
        const count = keptIn[index] as number;
        if (count === 0 || fixed.has(index) || blockDistrict[index] === of) continue;
        if (balance(donor) - count < balance(of) + count || !whole(donor, index)) continue;
        have[donor] = (have[donor] as number) - count;
        have[of] = (have[of] as number) + count;
        blockDistrict[index] = of;
        inBody[index] = 1;
        any = true;
      }
    });
    if (!any) break;
  }
  // Empty ground is no border. A district still short takes the blocks beside its body that hold no kept house,
  // and those beyond them, until it stands against houses: otherwise a strip of unbuilt ground would keep it from
  // the neighbour that has them to spare.
  const reachHouses = () => {
    const short = wanted.map((_, of) => of).filter((of) => balance(of) < 0).sort((a, b) => balance(a) - balance(b) || a - b);
    for (const of of short) {
      const out = blocks.map((_, index) => index).filter((index) => blockDistrict[index] === of && inBody[index]);
      for (let head = 0; head < out.length; head++) {
        for (const next of beside[out[head] as number] ?? []) {
          const donor = blockDistrict[next];
          if (donor === undefined || donor === of || (keptIn[next] as number) > 0 || fixed.has(next) || !whole(donor, next)) continue;
          blockDistrict[next] = of;
          inBody[next] = 1;
          out.push(next);
        }
      }
    }
  };
  reachHouses();
  // Then along chains. A district still short is supplied from the nearest district with houses to spare, through
  // the districts between: across each shared border on the way a block of about the right size changes hands,
  // so that each district between gains one block and gives up another. What is left for single houses is a
  // handful.
  const stuck = new Set<number>();
  const tries = new Map<number, number>();
  for (let turn = 0; turn < CHAINS * wanted.length; turn++) {
    const borders = new Map<string, number[]>();
    blockDistrict.forEach((from, index) => {
      if (from === undefined || fixed.has(index) || (keptIn[index] as number) === 0) return;
      for (const next of beside[index] ?? []) {
        const to = blockDistrict[next];
        if (to === undefined || to === from || !inBody[next]) continue;
        const key = `${from}>${to}`;
        const list = borders.get(key);
        if (!list) borders.set(key, [index]);
        else if (list[list.length - 1] !== index) list.push(index);
      }
    });
    let short: number | undefined;
    wanted.forEach((_, of) => {
      if (stuck.has(of) || balance(of) > -SETTLED) return;
      if (short === undefined || balance(of) < balance(short)) short = of;
    });
    if (short === undefined) break;
    const taker = short as number;
    // The nearest district with houses to spare, counted in borders crossed.
    const from = new Map<number, number>([[taker, -1]]);
    const queue = [taker];
    let source: number | undefined;
    for (let head = 0; head < queue.length && source === undefined; head++) {
      const here = queue[head] as number;
      for (let other = 0; other < wanted.length; other++) {
        if (from.has(other) || !borders.has(`${other}>${here}`)) continue;
        from.set(other, here);
        // A district with houses to spare is the source if it has a block it can give this way. A thin one has
        // none, and is passed through like any district between.
        if (balance(other) >= SETTLED && (borders.get(`${other}>${here}`) ?? []).some((index) => blockDistrict[index] === other && whole(other, index))) {
          source = other;
          break;
        }
        queue.push(other);
      }
    }
    if (source === undefined) {
      stuck.add(taker);
      continue;
    }
    const amount = Math.min(-balance(taker), balance(source));
    const fits = (giver: number, to: number) => (borders.get(`${giver}>${to}`) ?? []).filter((index) => blockDistrict[index] === giver && (keptIn[index] as number) <= 2 * amount);
    let passed = true;
    let gave = false;
    for (let giver = source; giver !== taker && passed; giver = from.get(giver) as number) {
      const to = from.get(giver) as number;
      // A thin district between two others can give nothing without coming apart: every block of it holds it
      // together. It is passed through by being made thicker first. Where the district that takes here must give
      // further on and has no block it can spare, it takes, of the blocks that fit, one that frees a block of
      // its own at the border beyond, or failing that one that lies behind that border.
      const beyond = to === taker ? undefined : (from.get(to) as number);
      const onward = beyond === undefined ? [] : fits(to, beyond);
      const blocked = beyond !== undefined && !onward.some((index) => whole(to, index));
      const behind = new Set<number>();
      if (blocked) for (const index of onward) for (const next of beside[index] ?? []) if (blockDistrict[next] === to) behind.add(next);
      let best: number | undefined;
      let rank = Infinity;
      for (const index of fits(giver, to)) {
        if (!whole(giver, index)) continue;
        let tier = 0;
        if (blocked) {
          blockDistrict[index] = to;
          const frees = onward.some((other) => whole(to, other));
          blockDistrict[index] = giver;
          tier = frees ? 0 : (beside[index] ?? []).some((next) => behind.has(next) || onward.includes(next)) ? 1 : 2;
        }
        const score = tier * 1e6 + Math.abs((keptIn[index] as number) - amount);
        if (score < rank) {
          rank = score;
          best = index;
        }
      }
      if (best === undefined) {
        passed = false;
        break;
      }
      have[giver] = (have[giver] as number) - (keptIn[best] as number);
      have[to] = (have[to] as number) + (keptIn[best] as number);
      blockDistrict[best] = to;
      inBody[best] = 1;
      gave = true;
    }
    // A chain that stopped part of the way has still thickened the district it stopped at, and is tried again; one
    // that moved nothing, or has been tried often enough, is given up.
    if (!passed) {
      tries.set(taker, (tries.get(taker) ?? 0) + 1);
      if (!gave || (tries.get(taker) as number) > THICKENINGS) stuck.add(taker);
    }
  }

  // Single houses. A district still short is supplied from the nearest district with a house to spare, through
  // the districts between: across each shared border on the way one house, in a block at that border, changes
  // district to the neighbour whose ground its block touches.
  const district: Array<number | undefined> = houses.map(() => undefined);
  for (const index of chosen) district[index] = blockDistrict[(houses[index] as House).block];
  const inBlock: number[][] = blocks.map(() => []);
  for (const index of chosen) (inBlock[(houses[index] as House).block] as number[]).push(index);
  const borrowed = wanted.map(() => 0);
  // The blocks of each district that touch each other district's body, or stand across a bridge from it, once,
  // each with the block it meets there: block moves are done.
  const borderBlocks = new Map<string, Array<{ index: number; next: number }>>();
  blockDistrict.forEach((from, index) => {
    if (from === undefined || (keptIn[index] as number) === 0) return;
    for (const next of beside[index] ?? []) {
      const to = blockDistrict[next];
      if (to === undefined || to === from || !inBody[next]) continue;
      const key = `${from}>${to}`;
      const list = borderBlocks.get(key);
      if (!list) borderBlocks.set(key, [{ index, next }]);
      else if (!list.some((entry) => entry.index === index)) list.push({ index, next });
    }
  });
  const ownIn = inBlock.map((list) => list.length);
  /**
   * A house of a district that stands in one of its own blocks at its border with another: the house of the block
   * nearest the neighbour's ground. Houses go only from a block that could go itself: not from a landmark's
   * block, nor from one that holds its district together, since a block most of whose houses are a neighbour's
   * is as good as the neighbour's ground.
   */
  /** A block's kept houses, those nearest a neighbouring block's outline first: found once for each pair. */
  const orders = new Map<string, number[]>();
  const nearestFirst = (block: number, next: number): number[] => {
    const name = `${block}:${next}`;
    let order = orders.get(name);
    if (!order) {
      const outline = (blocks[next] as Block).polygon;
      const away = new Map((inBlock[block] as number[]).map((index) => [index, distanceToPolygonEdge((houses[index] as House).centre, outline)]));
      order = [...(inBlock[block] as number[])].sort((a, b) => (away.get(a) as number) - (away.get(b) as number) || a - b);
      orders.set(name, order);
    }
    return order;
  };
  const spared = new Map<number, boolean>();
  const couldGo = (from: number, block: number): boolean => {
    let known = spared.get(block);
    if (known === undefined) spared.set(block, (known = lent.has(block) || (!fixed.has(block) && whole(from, block))));
    return known;
  };
  // Second, where that leaves a district short: a block that holds its district together gives too, so long as
  // most of its houses stay its district's, for then it stays its district's ground.
  let freely = false;
  const mayGive = (from: number, block: number): boolean =>
    couldGo(from, block) || (freely && !fixed.has(block) && 2 * ((ownIn[block] as number) - 1) > (inBlock[block] as number[]).length);
  const atBorder = (from: number, to: number): number | undefined => {
    for (const { index: block, next } of borderBlocks.get(`${from}>${to}`) ?? []) {
      if (blockDistrict[block] !== from || (ownIn[block] as number) === 0) continue;
      if (!mayGive(from, block)) continue;
      const best = nearestFirst(block, next).find((index) => district[index] === from);
      if (best !== undefined) return best;
    }
    return undefined;
  };
  for (const second of [false, true]) {
   freely = second;
   for (const of of wanted.keys()) stuck.delete(-1 - of);
   for (let turn = 0; turn < chosen.length; turn++) {
    let taker: number | undefined;
    wanted.forEach((_, of) => {
      if (stuck.has(-1 - of) || balance(of) >= 0) return;
      if (taker === undefined || balance(of) < balance(taker)) taker = of;
    });
    if (taker === undefined) break;
    const end = taker as number;
    // The nearest district with a house to spare, counted in borders crossed, each of which has a house to pass.
    const from = new Map<number, number>([[end, -1]]);
    const queue = [end];
    let source: number | undefined;
    for (let head = 0; head < queue.length && source === undefined; head++) {
      const here = queue[head] as number;
      for (let other = 0; other < wanted.length; other++) {
        if (from.has(other) || atBorder(other, here) === undefined) continue;
        from.set(other, here);
        if (balance(other) > 0) {
          source = other;
          break;
        }
        queue.push(other);
      }
    }
    if (source === undefined) {
      stuck.add(-1 - end);
      continue;
    }
    for (let giver = source; giver !== end; giver = from.get(giver) as number) {
      const to = from.get(giver) as number;
      const index = atBorder(giver, to) as number;
      district[index] = to;
      have[giver] = (have[giver] as number) - 1;
      have[to] = (have[to] as number) + 1;
      borrowed[to] = (borrowed[to] as number) + 1;
      // A block whose every house has gone to the neighbour is the neighbour's block.
      const block = (houses[index] as House).block;
      ownIn[block] = (ownIn[block] as number) - 1;
      if (!lent.has(block) && couldGo(giver, block)) {
        lent.add(block);
        spared.clear();
      }
      if (ownIn[block] === 0 && (inBlock[block] as number[]).every((other) => district[other] === to)) {
        blockDistrict[block] = to;
        inBody[block] = 1;
        ownIn[block] = (inBlock[block] as number[]).length;
        // Its houses stand in their own district's block again.
        borrowed[to] = (borrowed[to] as number) - (inBlock[block] as number[]).length;
        spared.clear();
      }
    }
   }
  }
  // The last resort, counted: a district still short, with no neighbour across a shared border that has houses to
  // spare, takes the nearest kept houses of whichever districts have too many.
  let fallback = 0;
  wanted.forEach((_, of) => {
    if (balance(of) >= 0) return;
    const own = middles.filter((__, block) => blockDistrict[block] === of);
    const away = (point: readonly [number, number]) => (own.length === 0 ? Math.hypot(point[0], point[1]) : Math.min(...own.map((middle) => Math.hypot(middle[0] - point[0], middle[1] - point[1]))));
    const spare = chosen
      .filter((index) => district[index] !== undefined && district[index] !== of && balance(district[index] as number) > 0)
      .map((index) => ({ index, away: away((houses[index] as House).centre) }))
      .sort((a, b) => a.away - b.away || a.index - b.index);
    for (const { index } of spare) {
      if (balance(of) >= 0) break;
      const donor = district[index] as number;
      if (balance(donor) <= 0) continue;
      district[index] = of;
      have[donor] = (have[donor] as number) - 1;
      have[of] = (have[of] as number) + 1;
      borrowed[of] = (borrowed[of] as number) + 1;
      fallback++;
    }
  });
  const moved = blockDistrict.filter((of, block) => of !== undefined && plan.of[(blocks[block] as Block).ward] !== undefined && of !== plan.of[(blocks[block] as Block).ward]).length;
  const kept = wanted.map((_, of) => district.filter((held) => held === of).length);
  return { blockDistrict, moved, district, kept, borrowed, fallback, short: short + wanted.reduce((sum, want, of) => sum + Math.max(want - (kept[of] as number), 0), 0) };
}
