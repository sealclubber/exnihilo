/**
 * Districts on wards, and exactly the city's buildings on pieces of them.
 *
 * Each ward belongs to one of the city's districts: chunks of wards bounded by
 * roads and the river. A ward joins the district whose seed ward is nearest,
 * where crossing a highway, an arterial or the river counts for more, and the
 * districts' reach is adjusted over several rounds until each one's ground
 * matches its buildings. A district's buildings are shared among its wards by
 * area, and each ward is cut into pieces (`buildings.ts`) sized so that about
 * as many come out as it has buildings. Then the count is made exact: a piece
 * with no road, street or lane along it joins a neighbour that has one; too
 * few pieces, and the largest are cut again; too many, and some are left open
 * and the smallest joined to a neighbour. Buildings and pieces are paired by
 * size, largest to largest.
 */
import type { Building, City, District } from '../city/records.ts';
import type { Rng } from '../city/random.ts';
import { type GrownSettings, type SettingPack, lotSizeOf } from '../pack/schema.ts';
import type { Point } from '../schema.ts';
import { type CutWard, type Piece, cutWard } from './buildings.ts';
import { area, boxAround, boxesMeet, interiorPoint, lineThrough, merge, sharedLength, smallestRectangle, splitAlong, toLine, toPiece } from './cutting.ts';
import { Heap } from './heap.ts';
import type { Town } from './town.ts';
import { VERGE } from './wards.ts';

/** A line people walk along, with its roadway's width. */
export interface Way {
  points: Point[];
  width: number;
}

/** What lies between two neighbouring wards. */
type Between = 'highway' | 'arterial' | 'water' | 'street';

export interface Placed {
  building: Building;
  polygon: Point[];
  ward: number;
  loose: boolean;
}

export interface Fixes {
  /** Pieces cut again because a ward had too few. */
  extraCuts: number;
  /** Pieces left open because a ward had too many. */
  opened: number;
  /** Pieces joined to a neighbour because a ward had too many. */
  merged: number;
  /** Pieces with no way along them, joined to a neighbour that has one. */
  frontless: number;
  /** Pieces left open because nothing else would do. */
  forced: number;
  /** Buildings that went on to another ward of their district, their own having too few pieces. */
  carried: number;
}

export interface Allotment {
  /** Each ward's district, as an index into the city's districts. */
  districtOf: number[];
  /** Each ward's growth rank and whether it is loose. */
  rank: number[];
  loose: boolean[];
  placed: Placed[];
  /** Lanes down the alleys, each carried on to the way it meets at either end. */
  lanes: Point[][];
  /** Pieces left as open ground. */
  open: Point[][];
  fixes: Fixes;
}

export interface AllotInput {
  city: City;
  pack: SettingPack;
  grown: GrownSettings;
  town: Town;
  rng: (step: string) => Rng;
  /** Buildings placed some other way: the plaza's, the gatehouses. */
  held: (building: Building) => boolean;
  /** Every road and street, with what each is. */
  ways: Array<Way & { kind: Between | 'quay' }>;
  /** The river's centre line, if any. */
  river?: Point[];
  /** Whether a ward touches the water. */
  atWater: (ward: Point[]) => boolean;
  /** How far a point is from water. */
  dryBy?: (point: Point) => number;
  /** Buildings held from the districts that go to a given ward all the same, such as a gatehouse by its gate. */
  extra?: Array<{ ward: number; building: Building }>;
  /** A line no lane may be carried across, such as the wall. */
  barrier?: Point[];
  /** The wards beside the plaza: the plaza building's district starts from one of them. */
  besidePlaza?: { wards: number[]; district: number };
}

/** Ways filed by square, so that those near a point are found quickly. */
class WayIndex {
  private readonly filed = new Map<string, Array<[number, number]>>();
  readonly ways: Way[] = [];

  private readonly square: number;

  constructor(square = 40) {
    this.square = square;
  }

  add(way: Way): number {
    const id = this.ways.length;
    this.ways.push(way);
    for (let k = 1; k < way.points.length; k++) {
      const box = boxAround([way.points[k - 1] as Point, way.points[k] as Point], way.width);
      for (let x = Math.floor(box.minX / this.square); x <= Math.floor(box.maxX / this.square); x++) {
        for (let y = Math.floor(box.minY / this.square); y <= Math.floor(box.maxY / this.square); y++) {
          const key = `${x}:${y}`;
          const list = this.filed.get(key);
          if (list) list.push([id, k]);
          else this.filed.set(key, [[id, k]]);
        }
      }
    }
    return id;
  }

  /** Whether any way's roadway edge comes within `reach` of a point. */
  touches(point: Point, reach: number): boolean {
    const x = Math.floor(point[0] / this.square);
    const y = Math.floor(point[1] / this.square);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const [id, k] of this.filed.get(`${x + dx}:${y + dy}`) ?? []) {
          const way = this.ways[id] as Way;
          if (toPiece(point, way.points[k - 1] as Point, way.points[k] as Point) - way.width / 2 <= reach) return true;
        }
      }
    }
    return false;
  }

  /** The ways whose roadway edge comes within `reach` of a point, nearest first: by how far beyond its edge the point lies. */
  near(point: Point, reach: number): Array<{ way: number; beyond: number }> {
    const found = new Map<number, number>();
    const x = Math.floor(point[0] / this.square);
    const y = Math.floor(point[1] / this.square);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const [id, k] of this.filed.get(`${x + dx}:${y + dy}`) ?? []) {
          const way = this.ways[id] as Way;
          const beyond = toPiece(point, way.points[k - 1] as Point, way.points[k] as Point) - way.width / 2;
          if (beyond <= reach && beyond < (found.get(id) ?? Infinity)) found.set(id, beyond);
        }
      }
    }
    return [...found].map(([way, beyond]) => ({ way, beyond })).sort((a, b) => a.beyond - b.beyond || a.way - b.way);
  }
}

/** A district with at least this share of the ground its buildings want takes no ward from its neighbours. */
const BALANCED = 0.92;
/** How close a lot's edge must come to a roadway's edge to open onto it. */
const BORDER = VERGE + 0.1;
/** How much of a lot's edge must run along a way for it to open onto it. */
const FRONTAGE = 1.5;

/** How long a stretch of a polygon's edge runs along any way in an index: sampled every metre or so. */
function frontageOf(polygon: readonly Point[], index: WayIndex): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(run));
    for (let step = 0; step < steps; step++) {
      const t = (step + 0.5) / steps;
      if (index.touches([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], BORDER)) total += run / steps;
    }
  }
  return total;
}

/** The edge of a polygon that runs furthest along a way: its two ends. */
function frontEdge(polygon: readonly Point[], index: WayIndex): [Point, Point] | undefined {
  let best: [Point, Point] | undefined;
  let most = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (run > most && index.touches(middle, BORDER)) {
      most = run;
      best = [a, b];
    }
  }
  return best;
}

export function allot(input: AllotInput): Allotment {
  const { city, pack, grown, town } = input;
  const wards = town.wards.wards;
  const faces = town.wards.faces;
  const settings = grown.buildings;
  const lotArea = (building: Building) => {
    const size = lotSizeOf(building.type, pack);
    return size.frontage * size.depth;
  };

  // ---- The wards: where each is, what it costs, and which are loose --------------------------------------------
  const index = new WayIndex(15);
  for (const way of input.ways) index.add(way);
  // A ward with no way along it is no part of the town: it can be reached from nowhere.
  const frontages = wards.map((ward) => frontageOf(ward.polygon, index));
  const usable = frontages.map((frontage) => frontage >= FRONTAGE);
  const middles = wards.map((ward) => interiorPoint(ward.polygon));
  const areas = wards.map((ward) => area(ward.polygon));
  const costs = middles.map((point) => town.ground.cost(point));
  const rank = costs.map((cost) => town.ground.rank(cost));
  const sortedCosts = [...costs].sort((a, b) => a - b);
  const looseFrom = sortedCosts[Math.min(sortedCosts.length - 1, Math.floor((1 - settings.loose.share) * sortedCosts.length))] as number;
  const mostCost = sortedCosts[sortedCosts.length - 1] as number;
  const loose = costs.map((cost) => settings.loose.share > 0 && cost >= looseFrom);

  // ---- Neighbours, and what lies between them --------------------------------------------------------------------
  const wardOfFace = new Map(wards.map((ward, index) => [ward.face, index]));
  const boxes = faces.map((face) => boxAround(face, 1e-3));
  const kindAt = (point: Point): Between => {
    let found: Between = 'street';
    for (const way of input.ways) {
      if (toLine(point, way.points) > 1e-3) continue;
      if (way.kind === 'highway' || way.kind === 'quay') return 'highway';
      if (way.kind === 'arterial') found = 'arterial';
    }
    if (found === 'street' && input.river && toLine(point, input.river) < 1e-3) return 'water';
    return found;
  };
  const neighbours: Array<Array<{ ward: number; cost: number; shared: number; between: Between }>> = wards.map(() => []);
  for (let a = 0; a < faces.length; a++) {
    for (let b = a + 1; b < faces.length; b++) {
      if (!boxesMeet(boxes[a] as ReturnType<typeof boxAround>, boxes[b] as ReturnType<typeof boxAround>)) continue;
      const one = faces[a] as Point[];
      const other = faces[b] as Point[];
      const shared = sharedLength(one, other, 1e-5);
      if (shared < 1) continue;
      const wa = wardOfFace.get(a);
      const wb = wardOfFace.get(b);
      if (wa === undefined || wb === undefined || !usable[wa] || !usable[wb]) continue;
      // What runs along the stretch they share: looked for at the middle of the longest edge of it.
      let longest = 0;
      let middle: Point = one[0] as Point;
      for (let i = 0; i < one.length; i++) {
        const p = one[i] as Point;
        const q = one[(i + 1) % one.length] as Point;
        const run = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const mid: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (run > longest && sharedLength([p, q, mid], other, 1e-5) > 0.9 * 2 * run) {
          longest = run;
          middle = mid;
        }
      }
      const between = kindAt(middle);
      const penalty = between === 'highway' ? grown.districts.penalty.highway : between === 'arterial' ? grown.districts.penalty.arterial : between === 'water' ? grown.districts.penalty.water : 0;
      const step = Math.hypot((middles[wa] as Point)[0] - (middles[wb] as Point)[0], (middles[wa] as Point)[1] - (middles[wb] as Point)[1]) + penalty;
      (neighbours[wa] as Array<{ ward: number; cost: number; shared: number; between: Between }>).push({ ward: wb, cost: step, shared, between });
      (neighbours[wb] as Array<{ ward: number; cost: number; shared: number; between: Between }>).push({ ward: wa, cost: step, shared, between });
    }
  }

  // ---- Districts ---------------------------------------------------------------------------------------------------
  const districts = city.districts;
  const districtIndex = new Map(districts.map((district, index) => [district.id, index]));
  const buildingsOf: Building[][] = districts.map(() => []);
  for (const building of city.buildings) if (!input.held(building)) (buildingsOf[districtIndex.get(building.districtId) as number] as Building[]).push(building);
  const demand = buildingsOf.map((list) => list.reduce((sum, building) => sum + lotArea(building), 0));
  const placements = new Map(pack.districts.kinds.map((kind) => [kind.id, kind.placement]));
  const placementOf = (district: District) => placements.get(district.kind);
  const seeds = new Map<number, number>();
  const taken = new Set<number>();
  const byRank = wards.map((_, index) => index).filter((index) => usable[index]).sort((a, b) => (costs[a] as number) - (costs[b] as number) || a - b);
  const distance = (a: number, b: number) => Math.hypot((middles[a] as Point)[0] - (middles[b] as Point)[0], (middles[a] as Point)[1] - (middles[b] as Point)[1]);
  /** Of some wards, the one furthest from every seed laid so far. */
  const farthest = (among: number[]) => {
    let best: number | undefined;
    let bestAway = -1;
    for (const id of among) {
      if (taken.has(id)) continue;
      const away = Math.min(Infinity, ...[...seeds.values()].map((other) => distance(id, other)));
      if (away > bestAway) {
        bestAway = away;
        best = id;
      }
    }
    return best;
  };
  const seed = (district: number, ward: number | undefined) => {
    if (ward === undefined) return;
    seeds.set(district, ward);
    taken.add(ward);
  };
  const wanting = (placement: string) => districts.map((district, index) => ({ district, index })).filter(({ district, index }) => placementOf(district) === placement && (demand[index] as number) > 0 && !seeds.has(index));
  // The plaza's district beside it; the centre's first district on the oldest ward, the rest of the centre about it.
  if (input.besidePlaza && input.besidePlaza.wards.length > 0 && (demand[input.besidePlaza.district] as number) > 0) {
    seed(input.besidePlaza.district, [...input.besidePlaza.wards].sort((a, b) => (costs[a] as number) - (costs[b] as number) || a - b)[0]);
  }
  for (const { index } of wanting('centre')) seed(index, seeds.size === 0 ? byRank[0] : (farthest(byRank.filter((id) => (rank[id] as number) <= 0.3)) ?? farthest(byRank)));
  // Every piece of ground parted from the rest by water gets a district of its own where it is big enough.
  {
    const component = new Map<number, number>();
    const pieces: number[][] = [];
    for (const start of byRank) {
      if (component.has(start)) continue;
      const piece = [start];
      component.set(start, pieces.length);
      for (let at = 0; at < piece.length; at++) {
        for (const next of neighbours[piece[at] as number] ?? []) {
          if (next.between === 'water' || component.has(next.ward)) continue;
          component.set(next.ward, pieces.length);
          piece.push(next.ward);
        }
      }
      pieces.push(piece);
    }
    const seeded = new Set([...seeds.values()].map((id) => component.get(id)));
    const waiting = districts.map((district, index) => ({ district, index })).filter(({ district, index }) => (demand[index] as number) > 0 && !seeds.has(index) && placementOf(district) !== 'centre');
    const totalArea = areas.reduce((sum, value) => sum + value, 0);
    const totalDemand = demand.reduce((sum, value) => sum + value, 0);
    const smallest = Math.min(Infinity, ...waiting.map(({ index }) => demand[index] as number));
    const open = pieces
      .map((piece, index) => ({ piece, index, room: (piece.reduce((sum, id) => sum + (areas[id] as number), 0) / totalArea) * totalDemand }))
      .filter((entry) => !seeded.has(entry.index) && entry.room >= 0.4 * smallest)
      .sort((a, b) => b.room - a.room || a.index - b.index);
    for (const { piece } of open) {
      if (waiting.length === 0) break;
      const wet = piece.some((id) => input.atWater((wards[id] as { polygon: Point[] }).polygon));
      const pick = waiting.findIndex(({ district }) => placementOf(district) === (wet ? 'waterside' : 'edge'));
      const { index, district } = waiting.splice(pick >= 0 ? pick : 0, 1)[0] as { index: number; district: District };
      // A waterside district starts at the water.
      const atTheWater = placementOf(district) === 'waterside' ? piece.find((id) => input.atWater((wards[id] as { polygon: Point[] }).polygon)) : undefined;
      seed(index, atTheWater ?? piece[0]);
    }
  }
  const atWater = byRank.filter((id) => input.atWater((wards[id] as { polygon: Point[] }).polygon));
  for (const { index } of wanting('waterside')) {
    const wet = atWater.filter((id) => (rank[id] as number) <= 0.7);
    seed(index, farthest(wet) ?? farthest(atWater) ?? farthest(byRank));
  }
  for (const { index } of wanting('middle')) seed(index, farthest(byRank.filter((id) => (rank[id] as number) >= 0.15 && (rank[id] as number) <= 0.75)) ?? farthest(byRank));
  for (const { index } of wanting('edge')) seed(index, farthest(byRank.filter((id) => loose[id])) ?? farthest(byRank.filter((id) => (rank[id] as number) >= 0.55)) ?? farthest(byRank));
  for (let index = 0; index < districts.length; index++) {
    if ((demand[index] as number) > 0 && !seeds.has(index)) throw new Error(`the district ${(districts[index] as District).name} found no ward to start from: there are ${wards.length} wards for ${districts.length} districts`);
  }
  const active = [...seeds.keys()].sort((a, b) => a - b);
  // How far each ward is from each seed, going from ward to ward.
  const reach = new Map<number, Float64Array>();
  for (const district of active) {
    const far = new Float64Array(wards.length).fill(Infinity);
    const heap = new Heap();
    const start = seeds.get(district) as number;
    far[start] = 0;
    heap.push(0, start);
    while (heap.size > 0) {
      const [cost, ward] = heap.pop();
      if (cost > (far[ward] as number)) continue;
      for (const next of neighbours[ward] ?? []) {
        const through = cost + next.cost;
        if (through < (far[next.ward] as number)) {
          far[next.ward] = through;
          heap.push(through, next.ward);
        }
      }
    }
    reach.set(district, far);
  }
  const weight = new Map(active.map((district) => [district, 1]));
  const totalDemand = active.reduce((sum, district) => sum + (demand[district] as number), 0);
  const totalArea = areas.reduce((sum, value) => sum + value, 0);
  const districtOf = new Array<number>(wards.length).fill(-1);
  const assign = () => {
    for (let ward = 0; ward < wards.length; ward++) {
      if (!usable[ward]) {
        districtOf[ward] = -1;
        continue;
      }
      let best = -1;
      let bestCost = Infinity;
      for (const district of active) {
        const cost = ((reach.get(district) as Float64Array)[ward] as number) * (weight.get(district) as number);
        if (cost < bestCost) {
          bestCost = cost;
          best = district;
        }
      }
      districtOf[ward] = best;
    }
    for (const [district, ward] of seeds) districtOf[ward] = district;
  };
  for (let round = 0; round < grown.districts.rounds; round++) {
    assign();
    for (const district of active) {
      const share = districtOf.reduce((sum, owner, ward) => sum + (owner === district ? (areas[ward] as number) : 0), 0) / totalArea;
      const wanted = (demand[district] as number) / totalDemand;
      weight.set(district, (weight.get(district) as number) * ((share + 1e-3) / wanted) ** 0.35);
    }
  }
  assign();
  // Each district one piece: any part cut off from its seed joins the neighbour it shares most with.
  for (let guard = 0; guard < 4 * wards.length; guard++) {
    let moved = false;
    for (const district of active) {
      const own = new Set(districtOf.map((owner, ward) => (owner === district ? ward : -1)).filter((ward) => ward >= 0));
      const start = seeds.get(district) as number;
      const joined = new Set([start]);
      const queue = [start];
      for (let at = 0; at < queue.length; at++) for (const next of neighbours[queue[at] as number] ?? []) if (own.has(next.ward) && !joined.has(next.ward)) (joined.add(next.ward), queue.push(next.ward));
      for (const ward of own) {
        if (joined.has(ward)) continue;
        const options = (neighbours[ward] ?? []).filter((next) => districtOf[next.ward] !== district);
        if (options.length === 0) continue;
        const best = options.reduce((a, b) => (b.shared > a.shared || (b.shared === a.shared && b.ward < a.ward) ? b : a));
        districtOf[ward] = districtOf[best.ward] as number;
        moved = true;
      }
    }
    if (!moved) break;
  }
  // Then ward by ward, the district with least ground for its buildings takes a ward from the neighbour with most,
  // as long as the neighbour stays in one piece.
  const ratio = (district: number, change = 0) => (districtOf.reduce((sum, owner, ward) => sum + (owner === district ? (areas[ward] as number) : 0), 0) + change) / totalArea / ((demand[district] as number) / totalDemand);
  const joinedWithout = (district: number, without: number) => {
    const own = districtOf.map((owner, ward) => (owner === district && ward !== without ? ward : -1)).filter((ward) => ward >= 0);
    if (own.length === 0) return false;
    const set = new Set(own);
    const seen = new Set([own[0] as number]);
    const queue = [own[0] as number];
    for (let at = 0; at < queue.length; at++) for (const next of neighbours[queue[at] as number] ?? []) if (set.has(next.ward) && !seen.has(next.ward)) (seen.add(next.ward), queue.push(next.ward));
    return seen.size === own.length;
  };
  for (let guard = 0; guard < 2 * wards.length; guard++) {
    const neediest = [...active].sort((a, b) => ratio(a) - ratio(b) || a - b);
    let moved = false;
    for (const district of neediest) {
      if (ratio(district) >= BALANCED) break;
      // Its bordering wards held by others, best first: from the neighbour with the most to spare.
      const offers = districtOf
        .map((owner, ward) => ({ owner, ward }))
        .filter(({ owner, ward }) => owner >= 0 && owner !== district && ward !== seeds.get(owner) && (neighbours[ward] ?? []).some((next) => districtOf[next.ward] === district && next.between !== 'water'))
        .filter(({ owner, ward }) => ratio(owner, -(areas[ward] as number)) > ratio(district, areas[ward] as number) && joinedWithout(owner, ward))
        .sort((a, b) => ratio(b.owner) - ratio(a.owner) || a.ward - b.ward);
      const offer = offers[0];
      if (!offer) continue;
      districtOf[offer.ward] = district;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  // A district needs a building for each of its wards: one with too few gives its farthest wards to its neighbours.
  for (const district of active) {
    const own = () => districtOf.map((owner, ward) => (owner === district ? ward : -1)).filter((ward) => ward >= 0);
    const far = reach.get(district) as Float64Array;
    for (let guard = 0; own().length > (buildingsOf[district] as Building[]).length && guard < wards.length; guard++) {
      const candidates = own()
        .filter((ward) => ward !== seeds.get(district) && (neighbours[ward] ?? []).some((next) => districtOf[next.ward] !== district))
        .sort((a, b) => (far[b] as number) - (far[a] as number) || a - b);
      const ward = candidates[0];
      if (ward === undefined) break;
      const best = (neighbours[ward] ?? []).filter((next) => districtOf[next.ward] !== district).reduce((a, b) => (b.shared > a.shared ? b : a));
      districtOf[ward] = districtOf[best.ward] as number;
    }
  }

  // ---- Each district's buildings shared among its wards -----------------------------------------------------------
  const shareRng = input.rng('grown-shares');
  const vary = wards.map(() => settings.vary.min + (settings.vary.max - settings.vary.min) * shareRng.next());
  const buildingsIn: Building[][] = wards.map(() => []);
  for (const district of active) {
    const own = districtOf.map((owner, ward) => (owner === district ? ward : -1)).filter((ward) => ward >= 0);
    const buildings = [...(buildingsOf[district] as Building[])].sort((a, b) => lotArea(b) - lotArea(a) || (a.id < b.id ? -1 : 1));
    // A ward is built from the ways along it: one with little road along it holds no more than that road serves.
    const weights = own.map((ward) => Math.min(areas[ward] as number, (frontages[ward] as number) * settings.frontDepth) * (vary[ward] as number));
    const total = weights.reduce((sum, value) => sum + value, 0);
    const room = own.map((_, at) => ((weights[at] as number) / total) * (demand[district] as number));
    // Largest first, each to the ward with the most room left. A waterside district's big buildings, such as a
    // harbour's, take wards at the water while they have room.
    const meanArea = (demand[district] as number) / buildings.length;
    const waterside = placementOf(districts[district] as District) === 'waterside';
    const wet = own.map((ward) => input.atWater((wards[ward] as { polygon: Point[] }).polygon));
    for (const building of buildings) {
      const toWater = waterside && lotArea(building) > settings.big * meanArea && wet.some(Boolean);
      let best = -1;
      for (let at = 0; at < own.length; at++) {
        if (toWater && !wet[at]) continue;
        if (best < 0 || (room[at] as number) > (room[best] as number)) best = at;
      }
      (buildingsIn[own[best] as number] as Building[]).push(building);
      room[best] = (room[best] as number) - lotArea(building);
    }
    // No ward without a building: the smallest of the ward with the most is moved.
    for (const ward of own) {
      if ((buildingsIn[ward] as Building[]).length > 0) continue;
      const donor = own.reduce((a, b) => ((buildingsIn[b] as Building[]).length > (buildingsIn[a] as Building[]).length ? b : a));
      const list = buildingsIn[donor] as Building[];
      if (list.length < 2) break;
      (buildingsIn[ward] as Building[]).push(list.pop() as Building);
    }
  }

  const fixed = new Set<Building>();
  for (const { ward: asked, building } of input.extra ?? []) {
    // A ward with no district is no part of the town: the nearest that is takes it.
    let ward = asked;
    if ((districtOf[ward] as number) < 0) {
      let gap = Infinity;
      districtOf.forEach((owner, at) => {
        if (owner < 0) return;
        const away = distance(asked, at);
        if (away < gap) {
          gap = away;
          ward = at;
        }
      });
    }
    (buildingsIn[ward] as Building[]).push(building);
    fixed.add(building);
  }

  // ---- Every way a lot may open onto, lanes included as they are cut ----------------------------------------------
  const fixes: Fixes = { extraCuts: 0, opened: 0, merged: 0, frontless: 0, forced: 0, carried: 0 };
  const cutRng = input.rng('grown-buildings');
  const placed: Placed[] = [];
  const lanes: Point[][] = [];
  const open: Point[][] = [];
  const characterOf = (district: number) => settings.character[(districts[district] as District).kind] ?? (settings.character.default as NonNullable<(typeof settings.character)[string]>);

  const barrier = input.barrier;
  const crossesBarrier = (a: Point, b: Point) => {
    if (!barrier) return false;
    for (let k = 0; k < barrier.length; k++) if (crossing(a, b, barrier[k] as Point, barrier[(k + 1) % barrier.length] as Point)) return true;
    return false;
  };
  type Made = { placed: Placed[]; lanes: Point[][]; open: Point[][]; fixes: Fixes };
  /** Cuts a ward for its buildings, the pieces `finer` times the usual size; or says how many pieces it fell short. */
  const cutOne = (at: number, buildings: Building[], finer: number): Made | { short: number } => {
    const ward = wards[at] as Town['wards']['wards'][number];
    const made: Made = { placed: [], lanes: [], open: [], fixes: { extraCuts: 0, opened: 0, merged: 0, frontless: 0, forced: 0, carried: 0 } };
    const character = characterOf(districtOf[at] as number);
    const cost = costs[at] as number;
    const openShare = loose[at] ? settings.loose.open.min + (settings.loose.open.max - settings.loose.open.min) * ((cost - looseFrom) / (mostCost - looseFrom || 1)) : character.open;
    const scale = (areas[at] as number) / buildings.reduce((sum, building) => sum + lotArea(building), 0);
    const targets = buildings.map((building) => lotArea(building) * scale);
    const mean = targets.reduce((sum, value) => sum + value, 0) / targets.length;
    const bigOnes = buildings.map((building, k) => ({ building, target: targets[k] as number })).filter((entry) => entry.target > settings.big * mean).sort((a, b) => b.target - a.target || (a.building.id < b.building.id ? -1 : 1));
    const small = buildings.filter((building) => !bigOnes.some((entry) => entry.building === building));
    const smallMean = small.length === 0 ? mean : small.reduce((sum, building) => sum + lotArea(building) * scale, 0) / small.length;
    const gridChaos = character.gridChaos.min + (character.gridChaos.max - character.gridChaos.min) * cutRng.next();
    const cut: CutWard = cutWard(
      {
        polygon: ward.polygon,
        size: (smallMean * (1 - openShare) * finer) / settings.pieceShare,
        gridChaos,
        sizeChaos: character.sizeChaos,
        open: 0,
        // The alley is cut a verge wider than the lane's roadway down it.
        alley: grown.widths.alley + 2 * VERGE,
        alleyAbove: settings.alleyAbove,
        squareBelow: settings.squareBelow,
        big: bigOnes.map((entry) => entry.target),
        match: settings.bigMatch,
      },
      cutRng,
    );
    // Lanes: each carried on to the way it meets at either end; those that meet none, directly or by another lane, go.
    const own: Way[] = [];
    const ownIndex = new WayIndex(15);
    const reachOut = Math.max(grown.widths.highway, grown.widths.arterial) / 2 + VERGE + 0.5;
    const carried = cut.lanes.map((lane) => {
      const ends = [0, lane.length - 1].map((end) => {
        const point = lane[end] as Point;
        const before = lane[end === 0 ? 1 : lane.length - 2] as Point;
        const run = Math.hypot(point[0] - before[0], point[1] - before[1]) || 1;
        const outward: Point = [(point[0] - before[0]) / run, (point[1] - before[1]) / run];
        // Along its own line out to the nearest way's centre line, or to an earlier lane's.
        const ray: Point[] = [point, [point[0] + outward[0] * reachOut, point[1] + outward[1] * reachOut]];
        let hit: { point: Point; along: number; lane: boolean } | undefined;
        const look = (ways: readonly Way[], isLane: boolean) => {
          for (const way of ways) {
            for (let k = 1; k < way.points.length; k++) {
              const found = crossing(ray[0] as Point, ray[1] as Point, way.points[k - 1] as Point, way.points[k] as Point);
              if (found && found.along <= way.width / 2 + VERGE + 0.3 && (!hit || found.along < hit.along) && !crossesBarrier(point, found.point)) hit = { point: found.point, along: found.along, lane: isLane };
            }
          }
        };
        look(index.near(point, reachOut).map((entry) => index.ways[entry.way] as Way), false);
        look(own, true);
        return hit;
      });
      const points = [...(ends[0] ? [ends[0].point] : []), ...lane, ...(ends[1] ? [ends[1].point] : [])];
      own.push({ points: lane, width: grown.widths.alley });
      return { points, ends };
    });
    // Kept: those that reach a road, and in turn those that reach a kept lane.
    const keep = carried.map((lane) => lane.ends.some((end) => end && !end.lane));
    for (let changed = true; changed; ) {
      changed = false;
      carried.forEach((lane, k) => {
        if (keep[k]) return;
        const meets = lane.ends.some((end) => end?.lane && carried.some((other, j) => keep[j] && j !== k && toLine(end.point, other.points) < 1e-6));
        if (meets) {
          keep[k] = true;
          changed = true;
        }
      });
    }
    carried.forEach((lane, k) => {
      if (!keep[k]) return;
      made.lanes.push(lane.points);
      ownIndex.add({ points: lane.points, width: grown.widths.alley });
    });
    const known = new WeakMap<Point[], boolean>();
    const fronts = (polygon: Point[]) => {
      let found = known.get(polygon);
      if (found === undefined) {
        found = frontageOf(polygon, index) + frontageOf(polygon, ownIndex) >= FRONTAGE;
        known.set(polygon, found);
      }
      return found;
    };
    const frontEdgeOf = (polygon: Point[]) => frontEdge(polygon, index) ?? frontEdge(polygon, ownIndex);

    // The pieces: those of big buildings kept apart; a piece with no way along it joins a neighbour.
    type Part = { polygon: Point[]; big?: number; open?: boolean };
    let parts: Part[] = cut.pieces.map((piece: Piece) => ({ polygon: piece.polygon, ...(piece.big !== undefined && { big: piece.big }) }));
    const neighbourOf = (part: Part, among: Part[], keepBig = true) => {
      let best: { other: Part; shared: number } | undefined;
      for (const other of among) {
        if (other === part || other.open || (keepBig && other.big !== undefined)) continue;
        const shared = sharedLength(part.polygon, other.polygon, 1e-5);
        if (shared > 0.5 && (!best || shared > best.shared)) best = { other, shared };
      }
      return best?.other;
    };
    const join = (part: Part, other: Part): boolean => {
      const joined = merge(part.polygon, other.polygon, 1e-5);
      if (!joined) return false;
      other.polygon = joined;
      parts = parts.filter((entry) => entry !== part);
      return true;
    };
    for (let changed = true; changed; ) {
      changed = false;
      for (const part of [...parts]) {
        if (part.big !== undefined || fronts(part.polygon)) continue;
        const withFront = parts.filter((other) => other !== part && fronts(other.polygon));
        const other = neighbourOf(part, withFront) ?? neighbourOf(part, parts);
        if (other && join(part, other)) {
          made.fixes.frontless++;
          changed = true;
        }
      }
    }
    // A big building's piece with no way along it takes in a neighbour that has one.
    for (const part of [...parts]) {
      if (part.big === undefined || fronts(part.polygon)) continue;
      const withFront = parts.filter((other) => other !== part && other.big === undefined && fronts(other.polygon));
      const other = neighbourOf(part, withFront);
      if (other) {
        const joined = merge(part.polygon, other.polygon, 1e-5);
        if (joined) {
          part.polygon = joined;
          parts = parts.filter((entry) => entry !== other);
          made.fixes.frontless++;
        }
      }
    }
    for (const part of [...parts]) {
      if (!fronts(part.polygon)) {
        // A big building's piece that still has none gives up its building to the largest piece that does.
        if (part.big !== undefined) {
          delete part.big;
        }
        part.open = true;
        made.fixes.forced++;
      }
    }
    // A big building whose piece was not cut for it takes the largest piece there is.
    for (let k = 0; k < bigOnes.length; k++) {
      if (parts.some((part) => part.big === k)) continue;
      const largest = parts.filter((part) => part.big === undefined && !part.open).sort((a, b) => area(b.polygon) - area(a.polygon))[0];
      if (largest) largest.big = k;
    }
    const want = small.length;
    const plain = () => parts.filter((part) => part.big === undefined && !part.open);
    // Too few: the largest pieces cut again across their fronts, both halves keeping the front.
    for (let guard = 0; plain().length < want && guard < 4 * want; guard++) {
      const candidates = plain().sort((a, b) => area(b.polygon) - area(a.polygon));
      let done = false;
      for (const part of candidates) {
        const edge = frontEdgeOf(part.polygon);
        const tries: Point[][] = [];
        if (edge) {
          const [a, b] = edge;
          for (const share of [0.5, 0.35, 0.65]) tries.push(lineThrough([a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share], [-(b[1] - a[1]), b[0] - a[0]], 1000));
        }
        // Or across its long axis, as the plain cuts were made.
        const rect = smallestRectangle(part.polygon);
        for (const share of [0.5, 0.35, 0.65]) {
          const middle: Point = [rect.corner[0] + rect.long[0] * share + rect.short[0] * 0.5, rect.corner[1] + rect.long[1] * share + rect.short[1] * 0.5];
          tries.push(lineThrough(middle, [-rect.long[1], rect.long[0]], 1000), lineThrough(middle, rect.long, 1000));
        }
        for (const line of tries) {
          const halves = splitAlong(part.polygon, line).pieces;
          if (halves.length !== 2 || !halves.every((half) => fronts(half) && area(half) > 6)) continue;
          parts = parts.filter((entry) => entry !== part);
          parts.push(...halves.map((polygon) => ({ polygon })));
          made.fixes.extraCuts++;
          done = true;
          break;
        }
        if (done) break;
      }
      if (!done) break;
    }
    // Too many: up to the ward's open share left open, those farthest from a way first; then the smallest joined to a neighbour.
    const away = (polygon: Point[]) => {
      const point = interiorPoint(polygon);
      const near = index.near(point, 60)[0] ?? ownIndex.near(point, 60)[0];
      return near ? near.beyond : 60;
    };
    let spare = plain().length - want;
    if (spare > 0) {
      const allowed = Math.floor(openShare * plain().length);
      const farFirst = plain().map((part) => ({ part, away: away(part.polygon) })).sort((a, b) => b.away - a.away);
      for (const { part } of farFirst.slice(0, Math.min(spare, allowed))) {
        part.open = true;
        made.fixes.opened++;
        spare--;
      }
    }
    for (let guard = 0; spare > 0 && guard < 8 * want + 8; guard++) {
      const smallest = plain().sort((a, b) => area(a.polygon) - area(b.polygon));
      let done = false;
      for (const part of smallest) {
        const other = neighbourOf(part, plain());
        if (other && join(part, other)) {
          made.fixes.merged++;
          spare--;
          done = true;
          break;
        }
      }
      if (!done) break;
    }
    // Nothing joins: the rest left open, farthest from a way first.
    if (spare > 0) {
      const farFirst = plain().map((part) => ({ part, away: away(part.polygon) })).sort((a, b) => b.away - a.away);
      for (const { part } of farFirst.slice(0, spare)) {
        part.open = true;
        made.fixes.forced++;
      }
    }
    const pieces = plain();
    if (pieces.length < want) return { short: want - pieces.length };
    // Pairs by size, largest to largest.
    const bySize = [...small].sort((a, b) => lotArea(b) - lotArea(a) || (a.id < b.id ? -1 : 1));
    const pieceBySize = [...pieces].sort((a, b) => area(b.polygon) - area(a.polygon));
    bySize.forEach((building, k) => made.placed.push({ building, polygon: (pieceBySize[k] as Part).polygon, ward: at, loose: loose[at] as boolean }));
    if (bigOnes.some((_, k) => !parts.some((candidate) => candidate.big === k))) return { short: 1 };
    bigOnes.forEach((entry, k) => {
      const part = parts.find((candidate) => candidate.big === k);
      if (!part) return;
      made.placed.push({ building: entry.building, polygon: part.polygon, ward: at, loose: loose[at] as boolean });
    });
    // In a waterside district, the big buildings change places with whatever stands nearest the water, where it is of
    // a size with theirs.
    if (placementOf(districts[districtOf[at] as number] as District) === 'waterside' && input.dryBy) {
      const dryBy = input.dryBy;
      const wetness = (polygon: Point[]) => Math.min(...polygon.map(dryBy));
      for (const entry of bigOnes) {
        const own = made.placed.find((lot) => lot.building === entry.building) as Placed;
        const better = made.placed
          .filter((lot) => lot !== own && Math.abs(area(lot.polygon) - area(own.polygon)) <= settings.bigMatch * area(own.polygon) && wetness(lot.polygon) < wetness(own.polygon))
          .sort((a, b) => wetness(a.polygon) - wetness(b.polygon))[0];
        if (better) [own.building, better.building] = [better.building, own.building];
      }
    }
    for (const part of parts) if (part.open) made.open.push(part.polygon);
    return made;
    };
  // District by district, nearest its seed first. A ward that cannot be cut into pieces enough for its buildings is
  // cut finer; failing that, its smallest buildings go on to the next ward of the district.
  for (const district of active) {
    const far = reach.get(district) as Float64Array;
    const own = districtOf.map((owner, ward) => (owner === district ? ward : -1)).filter((ward) => ward >= 0).sort((a, b) => (far[a] as number) - (far[b] as number) || a - b);
    let carried: Building[] = [];
    for (const at of own) {
      let buildings = [...(buildingsIn[at] as Building[]), ...carried];
      carried = [];
      let result: Made | { short: number } = { short: buildings.length };
      for (let tries = 0; buildings.length > 0; tries++) {
        result = cutOne(at, buildings, 0.8 ** Math.min(tries, 3));
        if (!('short' in result)) break;
        if (tries >= 3) {
          const bySize = buildings.filter((building) => !fixed.has(building)).sort((a, b) => lotArea(a) - lotArea(b) || (a.id < b.id ? -1 : 1));
          const moving = bySize.slice(0, Math.max(1, result.short));
          if (moving.length === 0) break;
          carried.push(...moving);
          buildings = buildings.filter((building) => !moving.includes(building));
          fixes.carried += moving.length;
        }
      }
      if ('short' in result) continue;
      placed.push(...result.placed);
      lanes.push(...result.lanes);
      open.push(...result.open);
      for (const key of Object.keys(result.fixes) as Array<keyof Fixes>) fixes[key] += result.fixes[key];
    }
    if (carried.length > 0) throw new Error(`the district ${(districts[district] as District).name} has ${carried.length} buildings its wards could not be cut for`);
  }
  return { districtOf, rank, loose, placed, lanes, open, fixes };
}

/** Where a ray's piece crosses another piece: the point, and how far along the ray. */
function crossing(a: Point, b: Point, c: Point, d: Point): { point: Point; along: number } | undefined {
  const ab: Point = [b[0] - a[0], b[1] - a[1]];
  const cd: Point = [d[0] - c[0], d[1] - c[1]];
  const denominator = ab[0] * cd[1] - ab[1] * cd[0];
  if (Math.abs(denominator) < 1e-12) return undefined;
  const ac: Point = [c[0] - a[0], c[1] - a[1]];
  const t = (ac[0] * cd[1] - ac[1] * cd[0]) / denominator;
  const u = (ac[0] * ab[1] - ac[1] * ab[0]) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return undefined;
  return { point: [a[0] + ab[0] * t, a[1] + ab[1] * t], along: t * Math.hypot(ab[0], ab[1]) };
}
