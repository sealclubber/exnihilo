/**
 * Fitting the city, last part: which building goes where.
 *
 * Every building the city made gets exactly one place, and none is added,
 * removed or changed. A landmark with a ward or a block has its place
 * already. Within each district the rest are sorted by the area of their
 * pack lot and the district's kept houses by the area of their footprint,
 * and paired largest to largest. Then the rule every generator shares lets
 * buildings with lots alike change places, so that trades gather along a
 * street and spread types stand apart; and last the types the pack wants on
 * a highway or main street change places so as to front one.
 */
import { type SettingPack, lotSizeOf } from '../../pack/schema.ts';
import type { Building } from '../../city/records.ts';
import type { Point } from '../../schema.ts';
import { distance } from '../geometry.ts';
import { LineIndex } from '../lines.ts';
import { arrangeTrades } from '../shared.ts';
import type { PlacedLandmark } from './landmarks.ts';
import type { House } from './rows.ts';

export interface Fitting {
  /** For each house made, the building that stands there; nothing for a house not kept. */
  holder: Array<string | undefined>;
  /** How many buildings of road-loving types front a highway or main street, and how many there are. */
  onRoads: { fronting: number; of: number };
}

export interface FittingInput {
  pack: SettingPack;
  /** The city's buildings, and each one's district by its place in the city's list. */
  buildings: readonly Building[];
  districtOf: (building: Building) => number;
  landmarks: readonly PlacedLandmark[];
  houses: readonly House[];
  /** For each house, the district that keeps it. */
  kept: ReadonlyArray<number | undefined>;
  /** Highways and main streets. */
  roads: ReadonlyArray<readonly Point[]>;
}

export function fitBuildings({ pack, buildings, districtOf, landmarks, houses, kept, roads }: FittingInput): Fitting {
  const rules = pack.layout.staged?.fitting ?? { onRoads: [], roadWithin: 0 };
  const placed = new Set(landmarks.map((landmark) => landmark.building));
  const lotArea = (building: Building) => {
    const lot = lotSizeOf(building.type, pack);
    return lot.frontage * lot.depth;
  };
  const districts = new Map<number, { buildings: Building[]; houses: number[] }>();
  const of = (district: number) => {
    let entry = districts.get(district);
    if (!entry) districts.set(district, (entry = { buildings: [], houses: [] }));
    return entry;
  };
  for (const building of buildings) if (!placed.has(building.id)) of(districtOf(building)).buildings.push(building);
  kept.forEach((district, house) => district !== undefined && of(district).houses.push(house));

  // ---- Largest to largest ------------------------------------------------------------------------------------------
  interface Slot {
    house: number;
    building: Building;
  }
  const slots: Slot[] = [];
  for (const [district, entry] of [...districts].sort(([a], [b]) => a - b)) {
    if (entry.buildings.length !== entry.houses.length) throw new Error(`district ${district} has ${entry.buildings.length} buildings to place and ${entry.houses.length} houses kept for them`);
    const bySize = [...entry.buildings].sort((a, b) => lotArea(b) - lotArea(a) || (a.id < b.id ? -1 : 1));
    const byArea = [...entry.houses].sort((a, b) => (houses[b] as House).area - (houses[a] as House).area || a - b);
    bySize.forEach((building, at) => slots.push({ house: byArea[at] as number, building }));
  }

  // ---- Streets of one trade, spread types apart -------------------------------------------------------------------
  const along = (house: House) => distance(house.edge[0], house.front[0]);
  const standsBefore = (a: Slot, b: Slot) => {
    const [one, other] = [houses[a.house] as House, houses[b.house] as House];
    return one.block - other.block || one.edge[0][0] - other.edge[0][0] || one.edge[0][1] - other.edge[0][1] || along(one) - along(other) || a.house - b.house;
  };
  const beside = (a: Slot, b: Slot) => {
    const [one, other] = [houses[a.house] as House, houses[b.house] as House];
    if (one.block !== other.block || one.edge[0][0] !== other.edge[0][0] || one.edge[0][1] !== other.edge[0][1]) return false;
    const [first, second] = along(one) <= along(other) ? [one, other] : [other, one];
    return along(second) - (along(first) + distance(first.front[0], first.front[1])) < NEXT_DOOR;
  };
  arrangeTrades(slots, pack, standsBefore, beside);

  // ---- On the roads ------------------------------------------------------------------------------------------------
  const lines = new LineIndex();
  for (const road of roads) lines.add(road);
  const middle = (house: House): Point => [(house.front[0][0] + house.front[1][0]) / 2, (house.front[0][1] + house.front[1][1]) / 2];
  const fronts = slots.map((slot) => lines.size > 0 && (lines.nearest(middle(houses[slot.house] as House), rules.roadWithin)?.distance ?? Infinity) <= rules.roadWithin);
  const wantsRoad = new Set(rules.onRoads);
  // A road-loving building off the road changes places with a building of a like lot, in its district, that fronts
  // one and does not care: the nearest such, so that the trades stay gathered as nearly as may be.
  const alike = new Map<string, number[]>();
  slots.forEach((slot, at) => {
    const lot = lotSizeOf(slot.building.type, pack);
    const key = `${districtOf(slot.building)}|${lot.frontage}|${lot.depth}`;
    if (!alike.has(key)) alike.set(key, []);
    alike.get(key)?.push(at);
  });
  for (const group of alike.values()) {
    const free = group.filter((at) => fronts[at] && !wantsRoad.has((slots[at] as Slot).building.type));
    for (const at of group) {
      const slot = slots[at] as Slot;
      if (!wantsRoad.has(slot.building.type) || fronts[at] || free.length === 0) continue;
      const here = middle(houses[slot.house] as House);
      let best = 0;
      for (let other = 1; other < free.length; other++) if (distance(here, middle(houses[(slots[free[other] as number] as Slot).house] as House)) < distance(here, middle(houses[(slots[free[best] as number] as Slot).house] as House))) best = other;
      const partner = slots[free.splice(best, 1)[0] as number] as Slot;
      [slot.building, partner.building] = [partner.building, slot.building];
    }
  }
  const holder: Array<string | undefined> = houses.map(() => undefined);
  let fronting = 0;
  let loving = 0;
  slots.forEach((slot, at) => {
    holder[slot.house] = slot.building.id;
    if (!wantsRoad.has(slot.building.type)) return;
    loving++;
    if (fronts[at]) fronting++;
  });
  return { holder, onRoads: { fronting, of: loving } };
}

/** How near along an edge the next house's front begins, in metres, for the two to be next door. */
const NEXT_DOOR = 1.5;
