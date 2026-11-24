/**
 * Fitting the city, first part: districts are groups of wards.
 *
 * Each of the city's districts starts from a seed ward chosen by its kind's
 * placement, and grows over neighbouring wards, nearest first. Crossing a
 * highway, a main street, the wall or the river costs extra, so those become
 * the borders between districts. A district stops when its wards have room
 * for its buildings and some to spare; the wards left over go to whichever
 * district is nearest, so that the town fades out at its edge. A district sets the
 * character of its wards.
 */
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { distance, distanceBetweenPolygons, distanceToPolygonEdge, distanceToPolyline, pointInPolygon, polygonCentroid } from '../geometry.ts';
import type { RoadPlan } from './highways.ts';
import { crossingsAlong } from './lines.ts';
import type { Mesh } from './mesh.ts';
import type { MainStreet } from './streets.ts';
import type { Wall } from './wall.ts';
import type { Ward } from './wards.ts';
import type { Coast, River } from './water.ts';

/** A district of the city: its kind, and how many buildings it has. */
export interface TownDistrict {
  id: string;
  kind: string;
  buildings: number;
}

export type Placement = 'centre' | 'middle' | 'edge' | 'waterside';

export interface Character {
  scale: number;
  blocks: number;
  wing: number;
  passage: number;
}

export interface DistrictPlan {
  /** For each ward, its district by its place in the city's list; nothing for a ward in none. */
  of: Array<number | undefined>;
  /** For each district, the ward it started from; nothing if no ward was left for it. */
  seeds: Array<number | undefined>;
  /** For each ward, the wards beside it and what it costs to pass between them. */
  beside: Array<Array<{ ward: number; cost: number }>>;
}

export interface DistrictInput {
  settings: StagedSettings;
  districts: readonly TownDistrict[];
  /** Where the pack's layout puts each kind of district. */
  placementOf: (kind: string) => Placement;
  buildings: number;
  wards: readonly Ward[];
  /** How much each ward's own houses vary in size from its district's. */
  variation: readonly number[];
  mesh: Mesh;
  roads: RoadPlan;
  streets: readonly MainStreet[];
  river?: River;
  coast?: Coast;
  wall?: Wall;
}

/** The character of the wards of a kind of district. */
export function characterOf(settings: StagedSettings, kind: string | undefined): Character {
  return { ...settings.character.default, ...(kind === undefined ? {} : settings.character.kinds[kind]) };
}

/** How many houses a ward has room for, of a character. */
export const roomIn = (ward: { area: number }, settings: StagedSettings, scale: number) => ward.area / (settings.districts.perHouse * scale);

/** Which wards lie beside which, and what passing between them costs. */
export function wardsBeside({ settings, wards, mesh, roads, streets, river, wall }: Pick<DistrictInput, 'settings' | 'wards' | 'mesh' | 'roads' | 'streets' | 'river' | 'wall'>): DistrictPlan['beside'] {
  const { barriers } = settings.districts;
  const middles = wards.map((ward) => polygonCentroid(ward.polygon));
  const walls = wall ? wall.parts.map((part) => (part.closed ? [...part.points, part.points[0] as Point] : part.points)) : [];
  // Two wards are beside each other if nothing wider than a road and its verges lies between them.
  const near = Math.max(settings.widths.highway + 2 * settings.wards.highwayVerge, 2 * settings.wards.fromWall) + settings.widths.wardBorder + 1;
  const beside: DistrictPlan['beside'] = wards.map(() => []);
  const joined = new Set<string>();
  const join = (a: number, b: number, extra = 0) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (a === b || joined.has(key)) return;
    joined.add(key);
    const line = [middles[a] as Point, middles[b] as Point];
    let cost = distance(line[0] as Point, line[1] as Point) + extra;
    if (roads.highways.some((highway) => crossingsAlong(line, highway.points).length > 0)) cost += barriers.highway;
    if (streets.some((street) => crossingsAlong(line, street.points).length > 0)) cost += barriers.mainStreet;
    if (walls.some((part) => crossingsAlong(line, part).length > 0)) cost += barriers.wall;
    (beside[a] as Array<{ ward: number; cost: number }>).push({ ward: b, cost });
    (beside[b] as Array<{ ward: number; cost: number }>).push({ ward: a, cost });
  };
  const inCell = new Map<number, number[]>();
  wards.forEach((ward, index) => {
    if (ward.kind === 'ordinary') inCell.set(ward.cell, [...(inCell.get(ward.cell) ?? []), index]);
  });
  const close = (a: number, b: number) => distanceBetweenPolygons((wards[a] as Ward).polygon, (wards[b] as Ward).polygon) <= near;
  for (const pieces of inCell.values()) pieces.forEach((a, at) => pieces.slice(at + 1).forEach((b) => close(a, b) && join(a, b)));
  for (const edge of mesh.edges) {
    if (edge.cells.length < 2) continue;
    for (const a of inCell.get(edge.cells[0] as number) ?? []) for (const b of inCell.get(edge.cells[1] as number) ?? []) if (close(a, b)) join(a, b);
  }
  // Across the river only at a bridge: the wards at its two ends.
  if (river) {
    const at = (point: Point): number | undefined => {
      let best: number | undefined;
      let least = Infinity;
      wards.forEach((ward, index) => {
        if (ward.kind !== 'ordinary') return;
        const away = pointInPolygon(point, ward.polygon) ? 0 : distanceToPolygonEdge(point, ward.polygon);
        if (away < least) {
          least = away;
          best = index;
        }
      });
      return best;
    };
    for (const bridge of roads.bridges) {
      const [a, b] = [at(bridge.a), at(bridge.b)];
      if (a !== undefined && b !== undefined) join(a, b, barriers.river);
    }
  }
  for (const list of beside) list.sort((x, y) => x.ward - y.ward);
  return beside;
}

export function growDistricts(input: DistrictInput): DistrictPlan {
  const { settings, districts, placementOf, buildings, wards, variation, roads, river, coast } = input;
  const rules = settings.districts;
  const beside = wardsBeside(input);
  const ordinary = wards.map((ward, index) => ({ ward, index })).filter(({ ward }) => ward.kind === 'ordinary');
  const middles = wards.map((ward) => polygonCentroid(ward.polygon));

  // ---- The town proper, ranked by growth -------------------------------------------------------------------------
  // Ground is ranked as it is when the town's houses are chosen: inside the wall before outside it. Otherwise a
  // district would be given ground whose houses the town then does not keep.
  const { wall } = input;
  const rank = wards.map((ward, index) => ward.growthRank * (wall?.inside(middles[index] as Point) ? settings.selection.insideWall : 1));
  const ranked = [...ordinary].sort((a, b) => (rank[a.index] as number) - (rank[b.index] as number) || a.index - b.index);
  const proper: number[] = [];
  let held = 0;
  for (const { ward, index } of ranked) {
    if (held >= rules.town * buildings) break;
    proper.push(index);
    held += roomIn(ward, settings, variation[index] as number);
  }
  const place = new Map(proper.map((index, at) => [index, at / proper.length]));

  // ---- Seeds ------------------------------------------------------------------------------------------------------
  const water = roads.harbour?.quay ?? coast?.shore ?? river?.line;
  const seeds: Array<number | undefined> = districts.map(() => undefined);
  const taken = new Set<number>();
  /** Whether a district has started at the heart of the town yet: the first that is not at the water does. */
  let heart = false;
  // A waterside district chooses first: the water is where it is, and the others can start anywhere in their band.
  const byWater = (district: (typeof districts)[number]) => placementOf(district.kind) === 'waterside' && water !== undefined;
  const inTurn = [...districts.keys()].sort((a, b) => Number(byWater(districts[b] as (typeof districts)[number])) - Number(byWater(districts[a] as (typeof districts)[number])) || a - b);
  for (const turn of inTurn) {
    const district = districts[turn] as (typeof districts)[number];
    const placement = placementOf(district.kind);
    const band = rules.bands[placement] ?? [0, 1];
    const free = (list: readonly number[]) => list.filter((index) => !taken.has(index));
    let candidates = free(proper.filter((index) => (place.get(index) as number) >= band[0] && (place.get(index) as number) < band[1]));
    if (candidates.length === 0) candidates = free(proper);
    if (candidates.length === 0) candidates = free(ordinary.map(({ index }) => index));
    let best: number | undefined;
    let most = -Infinity;
    for (const index of candidates) {
      const middle = middles[index] as Point;
      let score: number;
      // By the water; or where no district has started yet, at the heart of the band; otherwise far from the others.
      // The ward whose own ground comes nearest the water, and of those the one whose middle does.
      if (placement === 'waterside' && water) score = -Math.min(...(wards[index] as Ward).polygon.map((corner) => distanceToPolyline(corner, water))) - 1e-3 * distanceToPolyline(middle, water);
      else if (!heart) score = -(rank[index] as number);
      else score = Math.min(...[...taken].map((other) => distance(middle, middles[other] as Point)));
      if (score > most) {
        most = score;
        best = index;
      }
    }
    seeds[turn] = best;
    if (!byWater(district)) heart = true;
    if (best !== undefined) taken.add(best);
  }

  // ---- Growth -----------------------------------------------------------------------------------------------------
  const of: Array<number | undefined> = wards.map(() => undefined);
  const room = districts.map(() => 0);
  const reached: number[] = wards.map(() => Infinity);
  const scales = districts.map((district) => characterOf(settings, district.kind).scale);
  const wanted = districts.map((district) => (rules.room[placementOf(district.kind)] ?? rules.roomDefault) * district.buildings);
  // A ward is claimed in order of how far it is from the district's seed and how late in the town's growth it
  // lies: districts fill the inner ground first, and compete for it.
  type Claim = { order: number; cost: number; district: number; ward: number };
  let frontier: Claim[] = [];
  const claim = (cost: number, district: number, ward: number): Claim => ({ order: cost + rules.inward * (rank[ward] as number), cost, district, ward });
  const grow = (capped: boolean) => {
    for (;;) {
      let pick = -1;
      for (let at = 0; at < frontier.length; at++) {
        const entry = frontier[at] as Claim;
        const best = frontier[pick] as Claim | undefined;
        if (!best || entry.order < best.order || (entry.order === best.order && (entry.district < best.district || (entry.district === best.district && entry.ward < best.ward)))) pick = at;
      }
      if (pick < 0) return;
      const { cost, district, ward } = frontier.splice(pick, 1)[0] as Claim;
      if (of[ward] !== undefined || (capped && (room[district] as number) >= (wanted[district] as number))) continue;
      of[ward] = district;
      reached[ward] = cost;
      room[district] = (room[district] as number) + roomIn(wards[ward] as Ward, settings, (scales[district] as number) * (variation[ward] as number));
      for (const next of beside[ward] as Array<{ ward: number; cost: number }>) if (of[next.ward] === undefined) frontier.push(claim(cost + next.cost, district, next.ward));
    }
  };
  seeds.forEach((ward, district) => ward !== undefined && frontier.push(claim(0, district, ward)));
  grow(true);
  // What is left over goes to whichever district is nearest: no ward within the town is left to none, and the
  // town's fringe belongs to the districts at its edge.
  frontier = [];
  of.forEach((district, ward) => {
    if (district === undefined) return;
    for (const next of beside[ward] as Array<{ ward: number; cost: number }>) if (of[next.ward] === undefined) frontier.push(claim((reached[ward] as number) + next.cost, district, next.ward));
  });
  grow(false);
  return { of, seeds, beside };
}
