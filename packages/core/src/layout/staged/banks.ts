/**
 * Districts after selection, first part (phase 6F, Part B, steps 3 and 4):
 * banks, and how many of each district's houses go to each bank.
 *
 * Once the town knows which houses exist, the blocks that hold kept houses
 * are grouped into banks: the land the blocks stand on, connected through the
 * ground about them and never across water. A town with no river is one
 * bank. Each bank has a fixed number of kept houses.
 *
 * The districts are then shared among the banks. A district that owns the
 * plaza, the castle or a block landmark goes first to the bank where that
 * landmark stands: each such district is given a foothold there before any
 * takes more, so that one does not fill the bank before another's turn. The rest, in placement order (centre first), fill the
 * banks in order of distance from the plaza: the first bank is filled until
 * it is full, and the district that overflows continues on the next, so that
 * it is the only one to span the two. A district that spans goes on to a bank
 * a bridge joins to its own where there is one.
 *
 * Nothing here changes the town yet: the plan carries it so that it can be
 * measured, until the districts are grown from it (Part B, step 5).
 */
import type { Point } from '../../schema.ts';
import { distance, polygonCentroid } from '../geometry.ts';
import type { Placement, TownDistrict } from './districts.ts';
import type { PlacedLandmark } from './landmarks.ts';
import type { River } from './water.ts';

export interface Bank {
  /** The blocks on it that hold kept houses, by their places in the plan. */
  blocks: number[];
  /** How many kept houses stand on it. */
  houses: number;
  /** How far its nearest such block is from the plaza, or the centre where there is no plaza, in metres. */
  away: number;
  /** The banks a bridge joins it to, by their places in `banks`. */
  bridged: number[];
}

export interface BankPlan {
  /** In order of distance from the plaza. */
  banks: Bank[];
  /** For every block, kept houses or not, the bank whose land it stands on; nothing for land that holds no kept house. */
  bankOf: Array<number | undefined>;
  /** For each district, its share of each bank it is given, in the order given. */
  shares: Array<Array<{ bank: number; houses: number }>>;
  /** The districts given more than one bank. */
  spanning: number[];
  /** Of those, the ones whose banks no bridge joins. */
  unjoined: number[];
  /** For each district that owns a landmark, the bank it was pulled to. */
  pulled: Map<number, number>;
}

export interface BankInput {
  blocks: ReadonlyArray<{ polygon: readonly Point[] }>;
  /** For each house, its block; and for each house, its district if it is kept. */
  houseBlocks: readonly number[];
  kept: ReadonlyArray<number | undefined>;
  /** The ground about each block, then about the plaza and the castle: which tiles touch which. */
  tilesBeside: ReadonlyArray<readonly number[]>;
  /** The tiles each bridge joins. */
  links: ReadonlyArray<{ a: number; b: number }>;
  /** The wards whose tiles follow the blocks', in order: the plaza and the castle. */
  specials: ReadonlyArray<{ ward: number; kind: 'plaza' | 'castle'; polygon: readonly Point[] }>;
  landmarks: readonly PlacedLandmark[];
  districts: readonly TownDistrict[];
  placementOf: (kind: string) => Placement;
  /** How many kept houses each district has. */
  houses: readonly number[];
  /** Where distances are measured from: the plaza, or the centre. */
  from: Point;
  river?: River;
}

/** The order in which districts of each placement are shared out: the centre first. */
const PLACEMENT_ORDER: readonly Placement[] = ['centre', 'middle', 'waterside', 'edge'];

export function shareBanks(input: BankInput): BankPlan {
  const { blocks, houseBlocks, kept, tilesBeside, links, specials, landmarks, districts, placementOf, houses, from, river } = input;
  const middles = blocks.map((block) => polygonCentroid(block.polygon));
  const sideOf = (point: Point) => (river ? river.side(point) : 1);

  // ---- The land: blocks joined through their ground, never across water ---------------------------------------------------
  const land = blocks.map(() => -1);
  let lands = 0;
  for (let start = 0; start < blocks.length; start++) {
    if ((land[start] as number) >= 0) continue;
    land[start] = lands;
    const queue = [start];
    while (queue.length > 0) {
      const at = queue.pop() as number;
      for (const other of tilesBeside[at] ?? []) {
        if (other >= blocks.length || (land[other] as number) >= 0) continue;
        if (sideOf(middles[at] as Point) !== sideOf(middles[other] as Point)) continue;
        land[other] = lands;
        queue.push(other);
      }
    }
    lands++;
  }

  // ---- Banks: the land that holds kept houses, nearest the plaza first ----------------------------------------------------------
  const keptIn = blocks.map(() => 0);
  houseBlocks.forEach((block, house) => {
    if (kept[house] !== undefined) keptIn[block] = (keptIn[block] as number) + 1;
  });
  const byLand = new Map<number, Bank>();
  blocks.forEach((_, block) => {
    if ((keptIn[block] as number) === 0) return;
    const id = land[block] as number;
    const bank = byLand.get(id) ?? { blocks: [], houses: 0, away: Infinity, bridged: [] };
    bank.blocks.push(block);
    bank.houses += keptIn[block] as number;
    bank.away = Math.min(bank.away, distance(middles[block] as Point, from));
    byLand.set(id, bank);
  });
  const ordered = [...byLand.entries()].sort((a, b) => a[1].away - b[1].away || (a[1].blocks[0] as number) - (b[1].blocks[0] as number));
  const banks = ordered.map(([, bank]) => bank);
  const bankOfLand = new Map(ordered.map(([id], index) => [id, index]));
  /** The bank of a tile: a block's land, or for the plaza or the castle the land of the blocks about it. */
  const bankOfTile = (tile: number): number | undefined => {
    if (tile < blocks.length) return bankOfLand.get(land[tile] as number);
    const counts = new Map<number, number>();
    for (const other of tilesBeside[tile] ?? []) {
      const bank = other < blocks.length ? bankOfLand.get(land[other] as number) : undefined;
      if (bank !== undefined) counts.set(bank, (counts.get(bank) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  };
  for (const link of links) {
    const [a, b] = [bankOfTile(link.a), bankOfTile(link.b)];
    if (a === undefined || b === undefined || a === b) continue;
    if (!(banks[a] as Bank).bridged.includes(b)) (banks[a] as Bank).bridged.push(b);
    if (!(banks[b] as Bank).bridged.includes(a)) (banks[b] as Bank).bridged.push(a);
  }
  for (const bank of banks) bank.bridged.sort((a, b) => a - b);

  /** The bank nearest a point on its own side of the water, for a landmark on land that holds no kept house. */
  const nearestBank = (point: Point): number | undefined => {
    let best: { bank: number; away: number } | undefined;
    banks.forEach((bank, index) => {
      for (const block of bank.blocks) {
        const middle = middles[block] as Point;
        const away = distance(middle, point) + (sideOf(middle) === sideOf(point) ? 0 : Number.MAX_SAFE_INTEGER / 2);
        if (!best || away < best.away) best = { bank: index, away };
      }
    });
    return best?.bank;
  };

  // ---- Landmarks pull their owners: the plaza first, then the castle, then block landmarks ---------------------------------
  const pulled = new Map<number, number>();
  const kindOf = new Map(specials.map((special) => [special.ward, special.kind]));
  const rank = (landmark: PlacedLandmark) => (landmark.block !== undefined ? 2 : kindOf.get(landmark.ward) === 'plaza' ? 0 : 1);
  const ranked = [...landmarks].sort((a, b) => rank(a) - rank(b) || (a.building < b.building ? -1 : 1));
  for (const landmark of ranked) {
    if (landmark.district === undefined || pulled.has(landmark.district)) continue;
    let bank: number | undefined;
    if (landmark.block !== undefined) bank = bankOfLand.get(land[landmark.block] as number) ?? nearestBank(middles[landmark.block] as Point);
    else {
      const special = specials.findIndex((one) => one.ward === landmark.ward);
      if (special >= 0) bank = bankOfTile(blocks.length + special) ?? nearestBank(polygonCentroid((specials[special] as { polygon: readonly Point[] }).polygon));
    }
    if (bank !== undefined) pulled.set(landmark.district, bank);
  }

  // ---- Share the districts out --------------------------------------------------------------------------------------------------
  const room = banks.map((bank) => bank.houses);
  const shares = districts.map((): Array<{ bank: number; houses: number }> => []);
  /** The bank a district goes on to from one that is full: one a bridge joins to it if any has room, else the nearest with room. */
  const nextFrom = (bank: number): number | undefined => {
    const joined = (banks[bank] as Bank).bridged.find((other) => (room[other] as number) > 0);
    if (joined !== undefined) return joined;
    const open = room.findIndex((left) => left > 0);
    return open >= 0 ? open : undefined;
  };
  const given = (district: number) => (shares[district] as Array<{ houses: number }>).reduce((sum, part) => sum + part.houses, 0);
  /** Gives a district so many houses on a bank, adding to what it already has there. */
  const put = (district: number, bank: number, count: number) => {
    const parts = shares[district] as Array<{ bank: number; houses: number }>;
    const part = parts.find((one) => one.bank === bank);
    if (part) part.houses += count;
    else parts.push({ bank, houses: count });
    room[bank] = (room[bank] as number) - count;
  };
  const give = (district: number, first: number) => {
    let need = (houses[district] as number) - given(district);
    let bank: number | undefined = (room[first] as number) > 0 ? first : nextFrom(first);
    while (need > 0 && bank !== undefined) {
      const take = Math.min(need, room[bank] as number);
      if (take > 0) {
        put(district, bank, take);
        need -= take;
      }
      if (need > 0) bank = nextFrom(bank);
    }
  };
  const order = districts
    .map((district, index) => ({ index, place: PLACEMENT_ORDER.indexOf(placementOf(district.kind)) }))
    .sort((a, b) => a.place - b.place || a.index - b.index)
    .map(({ index }) => index);
  // Every district a landmark pulls first has a foothold on its landmark's bank, so that no other pulled district
  // fills that bank before it; then each takes what more it needs from there.
  for (const district of order) {
    const bank = pulled.get(district);
    if (bank !== undefined && (houses[district] as number) > 0 && (room[bank] as number) > 0) put(district, bank, 1);
  }
  for (const district of order) if (pulled.has(district)) give(district, pulled.get(district) as number);
  for (const district of order) {
    if (pulled.has(district)) continue;
    const open = room.findIndex((left) => left > 0);
    if (open >= 0) give(district, open);
  }

  const spanning = shares.flatMap((parts, district) => (parts.length > 1 ? [district] : []));
  const unjoined = spanning.filter((district) => {
    const parts = shares[district] as Array<{ bank: number }>;
    return parts.some((part, at) => at > 0 && !(banks[(parts[at - 1] as { bank: number }).bank] as Bank).bridged.includes(part.bank));
  });
  const bankOf = blocks.map((_, block) => bankOfLand.get(land[block] as number));
  return { banks, bankOf, shares, spanning, unjoined, pulled };
}
