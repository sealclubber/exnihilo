/**
 * What every layout generator does the same way, whatever shape its streets
 * have: the order in which a district's buildings are given lots, and the
 * rule that settles last which building holds which lot.
 */
import type { Building } from '../city/records.ts';
import type { Rng } from '../city/random.ts';
import { type SettingPack, footprintCoverageOf, lotSizeOf } from '../pack/schema.ts';

/** The civic buildings a pack spreads across the districts, such as wells: within a district they are kept apart. */
export function spreadCivicTypes(pack: SettingPack): Set<string> {
  return new Set(pack.landmarks.filter((landmark) => landmark.spread).map((landmark) => landmark.id));
}

/**
 * The order in which a district's buildings take their lots. Landmarks take their larger lots first, then the
 * rest in an order drawn from the stream given; the civic buildings that are spread take their turns at even
 * steps among them, so that the district has grown on by the time the next of a type is placed. `held` are
 * buildings placed some other way, which are left out.
 */
export function placementOrder(buildings: readonly Building[], pack: SettingPack, rng: Rng, held: (building: Building) => boolean): Array<{ building: Building; apart: boolean }> {
  const spreadCivic = spreadCivicTypes(pack);
  const area = (building: Building) => {
    const size = lotSizeOf(building.type, pack);
    return size.frontage * size.depth;
  };
  const apart = buildings.filter((building) => spreadCivic.has(building.type) && !held(building));
  const landmarks = buildings.filter((building) => building.kind === 'landmark' && !held(building) && !spreadCivic.has(building.type)).sort((a, b) => area(b) - area(a) || (a.id < b.id ? -1 : 1));
  const others = buildings.filter((building) => building.kind !== 'landmark' && !held(building));
  for (let index = others.length - 1; index > 0; index--) {
    const other = rng.int(0, index);
    [others[index], others[other]] = [others[other] as Building, others[index] as Building];
  }
  const rest = [...landmarks, ...others];
  const order: Array<{ building: Building; apart: boolean }> = [];
  let next = 0;
  rest.forEach((building, turn) => {
    while (next < apart.length && Math.floor(((next + 0.5) * rest.length) / apart.length) <= turn) order.push({ building: apart[next++] as Building, apart: true });
    order.push({ building, apart: false });
  });
  while (next < apart.length) order.push({ building: apart[next++] as Building, apart: true });
  return order;
}

/** A lot as the arrangement rule sees it: the building on it, which may be changed for another. */
export interface Slot {
  building: Building;
}

/**
 * Streets of one trade. Which building holds which lot is settled last, and changes no lot. Within a district,
 * buildings whose lots are alike (the same size, covered by the same share of building) change places, so that
 * buildings of one type stand on neighbouring lots along a street, while types the pack spreads stand apart
 * from each other.
 *
 * `slots` are the lots that may change hands; `standsBefore` puts two of them in the order they stand, street by
 * street and along each; `beside` says whether one stands directly beside the next.
 */
export function arrangeTrades<T extends Slot>(slots: readonly T[], pack: SettingPack, standsBefore: (a: T, b: T) => number, beside: (a: T, b: T) => boolean): void {
  const spreadTypes = new Set([...pack.workplaces, ...pack.landmarks].filter((type) => type.spread).map((type) => type.id));
  const alike = new Map<string, T[]>();
  for (const slot of slots) {
    const size = lotSizeOf(slot.building.type, pack);
    const key = `${slot.building.districtId}|${size.frontage}|${size.depth}|${footprintCoverageOf(slot.building.type, pack)}`;
    const list = alike.get(key);
    if (list) list.push(slot);
    else alike.set(key, [slot]);
  }
  for (const lots of alike.values()) {
    const types = new Map<string, Building[]>();
    for (const { building } of lots) types.set(building.type, [...(types.get(building.type) ?? []), building]);
    if (types.size < 2) continue;
    // The lots in the order they stand.
    const ordered = [...lots].sort(standsBefore);
    const byId = (a: Building, b: Building) => (a.id < b.id ? -1 : 1);
    for (const list of types.values()) list.sort(byId);
    // Spread types, the commonest first. They are to stand apart from their own kind.
    const spread = [...types].filter(([type]) => spreadTypes.has(type)).sort(([a, one], [b, other]) => other.length - one.length || (a < b ? -1 : 1));
    const apart = spread.flatMap(([, list]) => list);
    // The rest stand together by type, the commonest first.
    const together = [...types].filter(([type]) => !spreadTypes.has(type)).sort(([a, one], [b, other]) => other.length - one.length || (a < b ? -1 : 1)).flatMap(([, list]) => list);
    // Lots that stand side by side form a run; a lot with no like lot beside it stands alone, and whatever is put
    // there has no neighbour of its own type. So the spread types, which are meant to stand apart, take the lone
    // lots first, and the trades that gather take the runs.
    const inRun = ordered.map((slot, index) => (index > 0 && beside(ordered[index - 1] as T, slot)) || (index + 1 < ordered.length && beside(slot, ordered[index + 1] as T)));
    const alone = ordered.filter((_, index) => !inRun[index]);
    const runs = ordered.filter((_, index) => inRun[index]);
    const given = new Map<T, Building>();
    const evenly = (buildings: Building[], among: T[]) => buildings.forEach((building, turn) => given.set(among[Math.floor(((turn + 0.5) * among.length) / buildings.length)] as T, building));
    // A lone lot has no like lot beside it, so nothing put there is beside its own kind: the commonest spread
    // types, which are the hardest to keep apart, go there first.
    evenly(apart.slice(0, alone.length), alone);
    // The rest go into the runs at even steps, in an order that never has two of a type in a row unless one type
    // is more than half of them: every other place is filled first, commonest type first, then the places between.
    const rest = apart.slice(alone.length);
    const mixed = new Array<Building>(rest.length);
    rest.forEach((building, turn) => (mixed[turn * 2 < rest.length ? turn * 2 : (turn - Math.ceil(rest.length / 2)) * 2 + 1] = building));
    evenly(mixed, runs);
    let next = 0;
    for (const slot of [...runs, ...alone]) slot.building = given.get(slot) ?? (together[next++] as Building);
  }
}
