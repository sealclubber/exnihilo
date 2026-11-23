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
import { type Rng, apportion } from '../city/random.ts';
import { type GrownSettings, type SettingPack, lotSizeOf } from '../pack/schema.ts';
import type { Point } from '../schema.ts';
import { type Piece, cutWard, shapeOf } from './buildings.ts';
import { area, boxAround, boxesMeet, inside, interiorPoint, merge, sharedLength, signedArea, subtract, toEdge, toLine, toPiece } from './cutting.ts';
import { Heap } from './heap.ts';
import { type Town, TooSmall } from './town.ts';
import { VERGE, roadStrip } from './wards.ts';

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
  /** Times a ward was cut again with a smaller building size because it had too few pieces. */
  finer: number;
  /** Lots the last pass joined to a neighbour for breaking the floor. */
  lastPass: number;
  /** Alleys run out from a piece with no way along it to the nearest way. */
  spurs: number;
  /** Lots a lane's roadway reached into, trimmed back from it. */
  trimmed: number;
  /** Pieces left open because a ward had too many. */
  opened: number;
  /** Pieces joined to a neighbour because a ward had too many. */
  merged: number;
  /** Pieces with no way along them, joined to a neighbour that has one. */
  frontless: number;
  /** Pieces left open because nothing else would do. */
  forced: number;
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
  /** Lines no lane may be carried across, such as the wall's. */
  barrier?: Point[][];
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

  /**
   * The pieces of ways that `touches` could find for any point between a and b: those filed within a square of the
   * box around them. Each as its two ends and its half width.
   */
  piecesNear(a: Point, b: Point): Array<[Point, Point, number]> {
    const seen = new Set<number>();
    const out: Array<[Point, Point, number]> = [];
    const x0 = Math.floor(Math.min(a[0], b[0]) / this.square) - 1;
    const x1 = Math.floor(Math.max(a[0], b[0]) / this.square) + 1;
    const y0 = Math.floor(Math.min(a[1], b[1]) / this.square) - 1;
    const y1 = Math.floor(Math.max(a[1], b[1]) / this.square) + 1;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (const [id, k] of this.filed.get(`${x}:${y}`) ?? []) {
          const key = id * 65536 + k;
          if (seen.has(key)) continue;
          seen.add(key);
          const way = this.ways[id] as Way;
          out.push([way.points[k - 1] as Point, way.points[k] as Point, way.width / 2]);
        }
      }
    }
    return out;
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

/** A district short of lots is cut again with its building size this much smaller, up to this many times; a ward short of pieces for its own buildings, up to this many. */
const FINER = 0.9;
const DISTRICT_FINER = 5;
const WARD_FINER = 5;
/** A district is balanced until its wards can make this many times the lots its buildings take. */
const LOTS_TO_SPARE = 1.1;
/** How far an alley is run out from a piece with no way along it, at the most. */
const SPUR_REACH = 40;
/** How many of a ward's smallest pieces are looked at for joining to a neighbour. */
const MERGE_POOL = 8;
/** A district with at least this share of the ground its buildings want takes no ward from its neighbours. */
const BALANCED = 0.92;
/** How close a lot's edge must come to a roadway's edge to open onto it. */
const BORDER = VERGE + 0.1;
/** How much of a lot's edge must run along a way for it to open onto it. */
const FRONTAGE = 1.5;

/** How long a stretch of a polygon's edge runs along any way in an index: sampled every metre or so. */
function frontageOf(polygon: readonly Point[], index: WayIndex, enough = Infinity): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(run));
    // The pieces any sample along this edge could touch, gathered once: a superset of what each sample's own squares hold.
    const pieces = index.piecesNear(a, b);
    if (pieces.length === 0) continue;
    // Each piece as its start, its run, its squared length and the squared reach of its roadway and the border.
    const flat = pieces.map(([from, to, half]) => {
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      return [from[0], from[1], dx, dy, dx * dx + dy * dy, (half + BORDER) * (half + BORDER)] as const;
    });
    for (let step = 0; step < steps; step++) {
      const t = (step + 0.5) / steps;
      const px = a[0] + (b[0] - a[0]) * t;
      const py = a[1] + (b[1] - a[1]) * t;
      let hit = false;
      for (const [fx, fy, dx, dy, span, reach] of flat) {
        const along = span === 0 ? 0 : Math.max(0, Math.min(1, ((px - fx) * dx + (py - fy) * dy) / span));
        const ex = px - fx - dx * along;
        const ey = py - fy - dy * along;
        if (ex * ex + ey * ey <= reach) {
          hit = true;
          break;
        }
      }
      if (hit) total += run / steps;
      if (total >= enough) return total;
    }
  }
  return total;
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
      // No smaller than a district cut as fine as it may be cut could live on.
      .filter((entry) => !seeded.has(entry.index) && entry.room >= FINER ** DISTRICT_FINER * smallest)
      .sort((a, b) => b.room - a.room || a.index - b.index);
    for (const { piece, room } of open) {
      if (waiting.length === 0) break;
      const wet = piece.some((id) => input.atWater((wards[id] as { polygon: Point[] }).polygon));
      // A district whose buildings the piece can hold all of, by the water one that belongs there, else one for the
      // edge; and if none fits whole, the one with fewest buildings, which cutting finer can fit.
      const fits = waiting.filter(({ index }) => (demand[index] as number) <= room);
      const fewest = [...waiting].sort((a, b) => (demand[a.index] as number) - (demand[b.index] as number) || a.index - b.index)[0] as (typeof waiting)[number];
      const chosen = fits.find(({ district }) => placementOf(district) === (wet ? 'waterside' : 'edge')) ?? fits[0] ?? fewest;
      const { index, district } = waiting.splice(waiting.indexOf(chosen), 1)[0] as { index: number; district: District };
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

  const shareRng = input.rng('grown-shares');
  const vary = wards.map(() => settings.vary.min + (settings.vary.max - settings.vary.min) * shareRng.next());

  // Buildings held from the districts that go to a ward all the same, such as a gatehouse by its gate.
  const extraIn: Building[][] = wards.map(() => []);
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
    (extraIn[ward] as Building[]).push(building);
  }

  // ---- Every way a lot may open onto, lanes included as they are cut ----------------------------------------------
  const fixes: Fixes = { finer: 0, opened: 0, merged: 0, frontless: 0, forced: 0, lastPass: 0, spurs: 0, trimmed: 0 };
  const placed: Placed[] = [];
  const lanes: Point[][] = [];
  const open: Point[][] = [];
  const characterOf = (district: number) => settings.character[(districts[district] as District).kind] ?? (settings.character.default as NonNullable<(typeof settings.character)[string]>);

  const barrier = input.barrier;
  const crossesBarrier = (a: Point, b: Point) => {
    if (!barrier) return false;
    for (const line of barrier) for (let k = 1; k < line.length; k++) if (crossing(a, b, line[k - 1] as Point, line[k] as Point)) return true;
    return false;
  };
  type Made = { placed: Placed[]; lanes: Point[][]; open: Point[][]; fixes: Fixes };
  /**
   * Cuts a ward for its buildings at a building size, no lot narrower than `floorWidth`; or says how many pieces it
   * fell short. Asked only to count, it says how many pieces the cutting leaves that keep every rule.
   */
  const cutOne = (at: number, buildings: Building[], size: number, floorWidth: number, bigAbove: number, countOnly = false): Made | { short: number } | { count: number } => {
    const ward = wards[at] as Town['wards']['wards'][number];
    const made: Made = { placed: [], lanes: [], open: [], fixes: { finer: 0, opened: 0, merged: 0, frontless: 0, forced: 0, lastPass: 0, spurs: 0, trimmed: 0 } };
    // Each ward has a stream of its own, so that cutting it again finer draws the same cuts.
    const cutRng = input.rng(`grown-buildings-${at}`);
    const gap = grown.widths.alley + 2 * VERGE;
    /** How much of a piece's edge runs along a lane, of those given. */
    const laneFrontage = (polygon: Point[], laneList: Point[][], enough = Infinity) => {
      if (laneList.length === 0) return 0;
      let total = 0;
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i] as Point;
        const b = polygon[(i + 1) % polygon.length] as Point;
        const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(1, Math.ceil(run));
        for (let step = 0; step < steps; step++) {
          const t = (step + 0.5) / steps;
          const point: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          if (laneList.some((lane) => toLine(point, lane) <= gap / 2 + BORDER)) total += run / steps;
          if (total >= enough) return total;
        }
      }
      return total;
    };
    const roadFrontage = new WeakMap<Point[], number>();
    const onWays = (polygon: Point[]) => {
      let found = roadFrontage.get(polygon);
      if (found === undefined) {
        found = frontageOf(polygon, index);
        roadFrontage.set(polygon, found);
      }
      return found;
    };
    const character = characterOf(districtOf[at] as number);
    const cost = costs[at] as number;
    const openShare = loose[at] ? settings.loose.open.min + (settings.loose.open.max - settings.loose.open.min) * ((cost - looseFrom) / (mostCost - looseFrom || 1)) : character.open;
    const scale = buildings.length === 0 ? 1 : (areas[at] as number) / buildings.reduce((sum, building) => sum + lotArea(building), 0);
    const targets = buildings.map((building) => lotArea(building) * scale);

    // Big: as the district judges it, by pack lot area.
    const bigOnes = buildings.map((building, k) => ({ building, target: targets[k] as number })).filter((entry) => lotArea(entry.building) > bigAbove).sort((a, b) => b.target - a.target || (a.building.id < b.building.id ? -1 : 1));
    const small = buildings.filter((building) => !bigOnes.some((entry) => entry.building === building));
    const gridChaos = character.gridChaos.min + (character.gridChaos.max - character.gridChaos.min) * cutRng.next();
    const cut = cutWard(
      {
        polygon: ward.polygon,
        size,
        gridChaos,
        sizeChaos: character.sizeChaos,
        open: 0,
        // The alley is cut a verge wider than the lane's roadway down it.
        alley: gap,
        alleyAbove: settings.alleyAbove,
        squareBelow: settings.squareBelow,
        big: bigOnes.map((entry) => entry.target),
        match: settings.bigMatch,
        leastWidth: floorWidth,
        longest: settings.longest,
        fronts: (polygon, laneList) => {
          const along = frontageOf(polygon, index, FRONTAGE);
          return along >= FRONTAGE || along + laneFrontage(polygon, laneList, FRONTAGE - along) >= FRONTAGE;
        },
        reaches: (lane, laneList) =>
          [lane[0] as Point, lane[lane.length - 1] as Point].some((end) => index.touches(end, BORDER + 0.05) || laneList.some((other) => toLine(end, other) <= gap / 2 + 0.1)),
      },
      cutRng,
    );
    // Lanes: each carried on to the way it meets at either end; those that meet none, directly or by another lane, go.
    const own: Way[] = [];
    const ownIndex = new WayIndex(15);
    const reachOut = Math.max(grown.widths.highway, grown.widths.arterial) / 2 + VERGE + 0.5;
    const carryLane = (lane: Point[]) => {
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
      // An end that meets nothing stops short of whatever it runs up to, so that its roadway stays in the alley.
      let body = lane;
      for (const end of [0, 1] as const) {
        if (ends[end]) continue;
        const ordered = end === 0 ? [...body].reverse() : body;
        const along = alongOf(ordered);
        const total = along[along.length - 1] as number;
        // Back far enough that its round end, met at any angle, stays a verge inside the alley.
        const back = gap / 2 + grown.widths.alley / 2;
        if (total <= back + 0.2) continue;
        const cut = cutTo(ordered, along, total - back);
        body = end === 0 ? cut.reverse() : cut;
      }
      const points = [...(ends[0] ? [ends[0].point] : []), ...body, ...(ends[1] ? [ends[1].point] : [])];
      own.push({ points: lane, width: grown.widths.alley });
      return { points, ends };
    };
    const carried = cut.lanes.map(carryLane);
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
    let known = new WeakMap<Point[], boolean>();
    const fronts = (polygon: Point[]) => {
      let found = known.get(polygon);
      if (found === undefined) {
        const along = frontageOf(polygon, index, FRONTAGE);
        found = along >= FRONTAGE || along + frontageOf(polygon, ownIndex, FRONTAGE - along) >= FRONTAGE;
        known.set(polygon, found);
      }
      return found;
    };

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
    // A piece with no way along it is given an alley of its own, run straight out to the nearest way through the pieces
    // between, as long as none of them is left narrower than the floor.
    for (const part of [...parts].sort((a, b) => area(b.polygon) - area(a.polygon))) {
      if (!parts.includes(part) || fronts(part.polygon)) continue;
      // From the middle of one of its sides, square out from that side to the first way it meets: a path to its
      // door. The nearest such way first, a few at most; the spur's end stops a verge short of the piece.
      const doors = (() => {
        const ring = signedArea(part.polygon) >= 0 ? part.polygon : [...part.polygon].reverse();
        const ways = [...index.near(interiorPoint(part.polygon), SPUR_REACH + Math.sqrt(area(part.polygon))).map((entry) => index.ways[entry.way] as Way), ...made.lanes.map((points) => ({ points, width: grown.widths.alley }))];
        const found: Array<{ from: Point; toward: Point; point: Point; run: number; half: number }> = [];
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k] as Point;
          const b = ring[(k + 1) % ring.length] as Point;
          const side = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (side < 2 * FRONTAGE) continue;
          // Outward: to the right of an anticlockwise ring with y up.
          const toward: Point = [(b[1] - a[1]) / side, -(b[0] - a[0]) / side];
          const door: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const far: Point = [door[0] + toward[0] * SPUR_REACH, door[1] + toward[1] * SPUR_REACH];
          let hit: { point: Point; along: number; half: number } | undefined;
          for (const way of ways) {
            for (let m = 1; m < way.points.length; m++) {
              const met = crossing(door, far, way.points[m - 1] as Point, way.points[m] as Point);
              if (met && (!hit || met.along < hit.along)) hit = { point: met.point, along: met.along, half: way.width / 2 };
            }
          }
          if (hit) found.push({ from: door, toward, point: hit.point, run: hit.along, half: hit.half });
        }
        found.sort((x, y) => x.run - y.run);
        // Failing a square path, straight from its middle to the nearest point of a way, from where that leaves it.
        const middle = interiorPoint(part.polygon);
        const straight: typeof found = [];
        for (const way of ways) {
          let best: { point: Point; away: number } | undefined;
          for (let m = 1; m < way.points.length; m++) {
            const a = way.points[m - 1] as Point;
            const b = way.points[m] as Point;
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const span = dx * dx + dy * dy;
            const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((middle[0] - a[0]) * dx + (middle[1] - a[1]) * dy) / span));
            const near: Point = [a[0] + dx * t, a[1] + dy * t];
            const away = Math.hypot(near[0] - middle[0], near[1] - middle[1]);
            if (!best || away < best.away) best = { point: near, away };
          }
          if (!best || best.away > SPUR_REACH + Math.sqrt(area(part.polygon)) || best.away < 1e-6) continue;
          const toward: Point = [(best.point[0] - middle[0]) / best.away, (best.point[1] - middle[1]) / best.away];
          let leave = 0;
          for (let along = 0; along <= best.away; along += 0.5) if (inside([middle[0] + toward[0] * along, middle[1] + toward[1] * along], part.polygon)) leave = along;
          let outside = leave + 0.5;
          for (let halving = 0; halving < 12; halving++) {
            const mid = (leave + outside) / 2;
            if (inside([middle[0] + toward[0] * mid, middle[1] + toward[1] * mid], part.polygon)) leave = mid;
            else outside = mid;
          }
          const from: Point = [middle[0] + toward[0] * outside, middle[1] + toward[1] * outside];
          straight.push({ from, toward, point: best.point, run: best.away - outside, half: way.width / 2 });
        }
        straight.sort((x, y) => x.run - y.run);
        return [...found.slice(0, 3), ...straight.slice(0, 2)];
      })();
      for (const door of doors) {
        const { toward, run } = door;
        const target = { point: door.point, half: door.half };
        const startAt = grown.widths.alley / 2 + VERGE + 0.05;
        if (startAt >= run - target.half) continue;
        const middle = door.from;
        const line: Point[] = [[middle[0] + toward[0] * startAt, middle[1] + toward[1] * startAt], target.point];
        if (crossesBarrier(line[0] as Point, line[1] as Point)) continue;
        // It stays within the ward until it reaches the way's own strip.
        let within = true;
        for (let along = 0; along < run - startAt && within; along += 1) {
          const point: Point = [(line[0] as Point)[0] + toward[0] * along, (line[0] as Point)[1] + toward[1] * along];
          if (Math.hypot(point[0] - target.point[0], point[1] - target.point[1]) <= target.half + VERGE + gap) break;
          within = inside(point, ward.polygon) || toEdge(point, ward.polygon) < 1e-3;
        }
        if (!within) continue;
        const strip = roadStrip(line, grown.widths.alley);
        const box = boxAround(strip);
        const next: Part[] = [];
        let fits = true;
        for (const other of parts) {
          if (!boxesMeet(boxAround(other.polygon), box)) {
            next.push(other);
            continue;
          }
          const { pieces: left, hole } = subtract(other.polygon, strip);
          const kept = left.filter((piece) => area(piece) > 6);
          if (hole || kept.length === 0 || (other.big !== undefined && kept.length > 1) || (other === part && kept.length !== 1) || kept.some((piece) => shapeOf(piece).width < floorWidth)) {
            fits = false;
            break;
          }
          if (kept.length === 1 && area(kept[0] as Point[]) === area(other.polygon)) next.push(other);
          else next.push(...kept.map((polygon, k) => (k === 0 ? { ...other, polygon } : { polygon })));
        }
        if (!fits) continue;
        parts = next;
        made.lanes.push(line);
        ownIndex.add({ points: line, width: grown.widths.alley });
        known = new WeakMap();
        made.fixes.spurs++;
        break;
      }
    }
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
    const breaks = (part: { polygon: Point[] }) => {
      const { width, ratio } = shapeOf(part.polygon);
      return width < floorWidth || ratio > settings.longest;
    };
    if (countOnly) return { count: parts.filter((part) => part.big === undefined && !part.open && !breaks(part)).length };
    const want = small.length;
    const plain = () => parts.filter((part) => part.big === undefined && !part.open);
    // Too few: the ward is cut again finer, by whoever called.
    if (plain().length < want) {
      return { short: want - plain().length };
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
    // Joining: of the pairs that share a wall, among the smaller pieces, the one whose joined shape is squarest.
    for (let guard = 0; spare > 0 && guard < 8 * want + 8; guard++) {
      const pool = plain();
      const smallest = [...pool].sort((a, b) => area(a.polygon) - area(b.polygon)).slice(0, MERGE_POOL);
      let best: { part: Part; other: Part; joined: Point[]; score: number } | undefined;
      for (const part of smallest) {
        for (const other of pool) {
          if (other === part || sharedLength(part.polygon, other.polygon, 1e-5) <= 0.5) continue;
          const joined = merge(part.polygon, other.polygon, 1e-5);
          if (!joined) continue;
          const score = shapeOf(joined).ratio + area(joined) / (area(ward.polygon) || 1);
          if (!best || score < best.score) best = { part, other, joined, score };
        }
      }
      if (!best) break;
      best.other.polygon = best.joined;
      parts = parts.filter((entry) => entry !== best.part);
      made.fixes.merged++;
      spare--;
    }
    // Nothing joins: the rest left open, farthest from a way first.
    if (spare > 0) {
      const farFirst = plain().map((part) => ({ part, away: away(part.polygon) })).sort((a, b) => b.away - a.away);
      for (const { part } of farFirst.slice(0, spare)) {
        part.open = true;
        made.fixes.forced++;
      }
    }
    // A last pass: a lot that still breaks the floor joins the neighbour it shares most wall with, and the ward's
    // largest lot is cut once to make the count again. Narrow lots are allowed for as many buildings as are narrow.
    const narrowBuildings = small.filter((building) => lotSizeOf(building.type, pack).frontage < settings.leastWidth).length;
    const breaksLeast = (part: Part) => {
      const { width, ratio } = shapeOf(part.polygon);
      return width < settings.leastWidth || ratio > settings.longest;
    };
    const skipped = new Set<Part>();
    for (let guard = 0; guard < want; guard++) {
      const breaking = plain().filter(breaksLeast).sort((a, b) => shapeOf(a.polygon).width - shapeOf(b.polygon).width);
      const allowed = breaking.filter((part) => shapeOf(part.polygon).ratio <= settings.longest && shapeOf(part.polygon).width >= floorWidth).slice(0, narrowBuildings);
      const part = breaking.find((one) => !allowed.includes(one) && !skipped.has(one));
      if (!part) break;
      const other = neighbourOf(part, plain());
      if (!other) {
        skipped.add(part);
        continue;
      }
      // First the lot that will make the count again: a piece left open that keeps the floor, or else the largest
      // lot that can be cut once; and only then the join.
      const reopen = parts.find((entry) => entry.open && entry.big === undefined && !breaksLeast(entry) && fronts(entry.polygon));
      let again: { largest: Part; parts: Point[][]; lanes: Point[][] } | undefined;
      if (!reopen) {
        for (const largest of plain().sort((x, y) => area(y.polygon) - area(x.polygon))) {
          if (largest === part || largest === other) continue;
          const cutAgain = cut.tryCut(largest.polygon);
          if (!cutAgain) continue;
          // Its alley must reach a way, and both halves must front a way or a lane that is kept.
          const newLanes = cutAgain.lanes.map(carryLane);
          if (newLanes.some((lane) => !lane.ends.some((end) => end))) continue;
          const laneLines = newLanes.map((lane) => lane.points);
          if (!cutAgain.parts.every((half) => onWays(half) + frontageOf(half, ownIndex) + laneFrontage(half, laneLines) >= FRONTAGE)) continue;
          again = { largest, parts: cutAgain.parts, lanes: laneLines };
          break;
        }
      }
      if (!reopen && !again) {
        skipped.add(part);
        continue;
      }
      if (!join(part, other)) {
        skipped.add(part);
        continue;
      }
      made.fixes.lastPass++;
      if (reopen) reopen.open = false;
      else if (again) {
        const { largest } = again;
        parts = parts.filter((entry) => entry !== largest);
        parts.push(...again.parts.map((polygon) => ({ polygon })));
        for (const lane of again.lanes) {
          made.lanes.push(lane);
          ownIndex.add({ points: lane, width: grown.widths.alley });
        }
        known = new WeakMap();
      }
    }
    const pieces = plain();
    if (pieces.length < want) return { short: want - pieces.length };
    // Pairs by size, largest to largest.
    const bySize = [...small].sort((a, b) => lotArea(b) - lotArea(a) || (a.id < b.id ? -1 : 1));
    const pieceBySize = [...pieces].sort((a, b) => area(b.polygon) - area(a.polygon));
    bySize.forEach((building, k) => made.placed.push({ building, polygon: (pieceBySize[k] as Part).polygon, ward: at, loose: loose[at] as boolean }));
    // Buildings whose own pack lot is narrow take the narrowest lots, changing places with whoever had them.
    if (narrowBuildings > 0) {
      const narrowest = [...made.placed].sort((a, b) => shapeOf(a.polygon).width - shapeOf(b.polygon).width).slice(0, narrowBuildings);
      const tiny = made.placed.filter((lot) => lotSizeOf(lot.building.type, pack).frontage < settings.leastWidth);
      for (const lot of narrowest) {
        if (lotSizeOf(lot.building.type, pack).frontage < settings.leastWidth) continue;
        const swap = tiny.find((other) => !narrowest.includes(other));
        if (!swap) break;
        [lot.building, swap.building] = [swap.building, lot.building];
        tiny.splice(tiny.indexOf(swap), 1);
      }
    }
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
    // Last of all, no lane's roadway reaches into a lot: where one does, its strip is taken out of the lot.
    const laneStrips = made.lanes.map((lane) => ({ lane, strip: roadStrip(lane, grown.widths.alley) })).map((entry) => ({ ...entry, box: boxAround(entry.strip) }));
    for (const lot of made.placed) {
      const box = boxAround(lot.polygon);
      for (const { lane, strip, box: laneBox } of laneStrips) {
        if (!boxesMeet(box, laneBox)) continue;
        if (!lot.polygon.some((point) => toLine(point, lane) < grown.widths.alley / 2 + VERGE / 2) && !lane.some((point) => inside(point, lot.polygon))) continue;
        const { pieces: left, hole } = subtract(lot.polygon, strip);
        if (hole || left.length === 0) continue;
        lot.polygon = left.reduce((best, piece) => (area(piece) > area(best) ? piece : best));
        made.fixes.trimmed++;
      }
    }
    // On the lots as they now stand: a building that is not narrow on a lot under the least width changes places with
    // a narrow one on a wider lot.
    const isNarrow = (building: Building) => lotSizeOf(building.type, pack).frontage < settings.leastWidth;
    for (const lot of made.placed) {
      if (isNarrow(lot.building) || shapeOf(lot.polygon).width >= settings.leastWidth) continue;
      const partner = made.placed.find((other) => isNarrow(other.building) && shapeOf(other.polygon).width >= settings.leastWidth);
      if (partner) [lot.building, partner.building] = [partner.building, lot.building];
    }
    if (made.placed.some((lot) => !isNarrow(lot.building) && shapeOf(lot.polygon).width < settings.leastWidth - 1e-9)) return { short: 1 };
    for (const part of parts) if (part.open) made.open.push(part.polygon);
    return made;
    };
  // Before any district is cut for its buildings, districts are balanced by the lots their wards can make: each ward
  // is counted once at its district's building size, and the district with fewest lots for its buildings takes a
  // bordering ward from the neighbour with most to spare, as long as both stay one piece and the poorer of the two
  // comes out better than the taker was.
  {
    const counted = new Map<number, number>();
    const sizing = (district: number) => {
      const own = districtOf.map((owner, ward) => (owner === district ? ward : -1)).filter((ward) => ward >= 0);
      const everyone = [...(buildingsOf[district] as Building[]), ...own.flatMap((ward) => extraIn[ward] as Building[])];
      const meanArea = everyone.reduce((sum, building) => sum + lotArea(building), 0) / (everyone.length || 1);
      const ordinary = everyone.filter((building) => lotArea(building) <= settings.big * meanArea);
      const ordinaryArea = ordinary.reduce((sum, building) => sum + lotArea(building), 0) / (ordinary.length || 1);
      const ground = own.reduce((sum, ward) => sum + (areas[ward] as number), 0);
      const packArea = everyone.reduce((sum, building) => sum + lotArea(building), 0);
      return { own, everyone, meanArea, ordinaryArea, ground, packArea };
    };
    const countOf = (ward: number) => {
      let found = counted.get(ward);
      if (found === undefined) {
        const district = districtOf[ward] as number;
        const { everyone, meanArea, ordinaryArea, ground, packArea } = sizing(district);
        const size = (ordinaryArea * (ground / packArea) * (vary[ward] as number)) / settings.pieceShare;
        const floor = Math.min(settings.leastWidth, ...everyone.map((building) => lotSizeOf(building.type, pack).frontage));
        const result = cutOne(ward, [], size, floor, settings.big * meanArea, true);
        found = 'count' in result ? result.count : 0;
        counted.set(ward, found);
      }
      return found;
    };
    /** Lots a district's wards can make over the lots its buildings take, with a ward more or less. */
    const share = (district: number, plus = -1, minus = -1) => {
      const { own, everyone, ground, packArea } = sizing(district);
      const wardsNow = [...own.filter((ward) => ward !== minus), ...(plus >= 0 ? [plus] : [])];
      const lots = wardsNow.reduce((sum, ward) => sum + countOf(ward), 0);
      const groundNow = wardsNow.reduce((sum, ward) => sum + (areas[ward] as number), 0) || ground;
      const meanArea = packArea / (everyone.length || 1);
      const needed = everyone.reduce((sum, building) => sum + (lotArea(building) > settings.big * meanArea ? Math.max(1, Math.ceil((lotArea(building) * (groundNow / packArea) * Math.max(lots, 1)) / groundNow)) : 1), 0);
      return lots / Math.max(needed, 1);
    };
    for (let guard = 0; guard < 2 * wards.length; guard++) {
      const shares = new Map(active.map((district) => [district, share(district)]));
      const neediest = [...active].filter((district) => (shares.get(district) as number) < LOTS_TO_SPARE).sort((a, b) => (shares.get(a) as number) - (shares.get(b) as number) || a - b);
      let moved = false;
      for (const district of neediest) {
        const offers = districtOf
          .map((owner, ward) => ({ owner, ward }))
          .filter(({ owner, ward }) => owner >= 0 && owner !== district && ward !== seeds.get(owner) && (neighbours[ward] ?? []).some((next) => districtOf[next.ward] === district && next.between !== 'water'))
          // Only where the poorer of the two is better off after than the taker is now.
          .filter(({ owner, ward }) => Math.min(share(owner, -1, ward), share(district, ward)) > (shares.get(district) as number) + 1e-9 && joinedWithout(owner, ward))
          .sort((a, b) => (shares.get(b.owner) as number) - (shares.get(a.owner) as number) || a.ward - b.ward);
        const offer = offers[0];
        if (!offer) continue;
        districtOf[offer.ward] = district;
        counted.delete(offer.ward);
        moved = true;
        break;
      }
      if (!moved) break;
    }
  }
  // District by district. Each ward is cut once to count the lots it can make that keep every rule; the district's
  // buildings are shared among its wards in proportion to those counts. A district whose wards cannot make lots
  // enough is cut again with a building size a tenth smaller, a few times, and then the town is laid out on more ground.
  for (const district of active) {
    const own = districtOf.map((owner, ward) => (owner === district ? ward : -1)).filter((ward) => ward >= 0);
    const buildings = [...(buildingsOf[district] as Building[])];
    const everyone = [...buildings, ...own.flatMap((ward) => extraIn[ward] as Building[])];
    const meanArea = everyone.reduce((sum, building) => sum + lotArea(building), 0) / (everyone.length || 1);
    const ordinary = everyone.filter((building) => lotArea(building) <= settings.big * meanArea);
    const ordinaryArea = ordinary.reduce((sum, building) => sum + lotArea(building), 0) / (ordinary.length || 1);
    const ground = own.reduce((sum, ward) => sum + (areas[ward] as number), 0);
    const groundPerArea = ground / everyone.reduce((sum, building) => sum + lotArea(building), 0);
    const floorWidth = Math.min(settings.leastWidth, ...everyone.map((building) => lotSizeOf(building.type, pack).frontage));
    const bigAbove = settings.big * meanArea;
    const sizeOf = (ward: number, finer: number) => {
      const character = characterOf(district);
      const cost = costs[ward] as number;
      const openShare = loose[ward] ? settings.loose.open.min + (settings.loose.open.max - settings.loose.open.min) * ((cost - looseFrom) / (mostCost - looseFrom || 1)) : character.open;
      return (ordinaryArea * groundPerArea * (1 - openShare) * (vary[ward] as number) * finer) / settings.pieceShare;
    };
    // A big building takes the room of as many of a ward's pieces as its share of the ground covers, and a margin.
    const needIn = (building: Building, ground: number, pieces: number, margin = 1 + settings.bigMatch) =>
      lotArea(building) > bigAbove ? Math.max(1, Math.ceil((margin * lotArea(building) * groundPerArea * Math.max(pieces, 1)) / ground)) : 1;
    // Which ward holds which. Each ward's own extras first; then the big buildings, largest first, each to the ward with
    // the most room left (a waterside district's to wards at the water while they have room); then the rest shared
    // among the wards in proportion to the room each has left, none given more than it has.
    const shareOut = (capacity: number[]) => {
    const lists: Building[][] = own.map((ward) => [...(extraIn[ward] as Building[])]);
    const left = own.map((ward, at) => (capacity[at] as number) - (extraIn[ward] as Building[]).reduce((sum, building) => sum + needIn(building, areas[ward] as number, capacity[at] as number), 0));
    const waterside = placementOf(districts[district] as District) === 'waterside';
    const wet = own.map((ward) => input.atWater((wards[ward] as { polygon: Point[] }).polygon));
    const byArea = [...buildings].sort((a, b) => lotArea(b) - lotArea(a) || (a.id < b.id ? -1 : 1));
    const bigOnes = byArea.filter((building) => lotArea(building) > bigAbove);
    for (const building of bigOnes) {
      // With its margin where some ward has room for that; else only its share of the ground.
      const roomy = own.some((_, at) => (left[at] as number) >= needIn(building, areas[own[at] as number] as number, capacity[at] as number));
      const need = (at: number) => needIn(building, areas[own[at] as number] as number, capacity[at] as number, roomy ? 1 + settings.bigMatch : 1);
      const fits = own.map((_, at) => (left[at] as number) >= need(at));
      const atWater = waterside && own.some((_, at) => wet[at] && fits[at]);
      let best = -1;
      for (let at = 0; at < own.length; at++) {
        if (atWater && !wet[at]) continue;
        const better = best < 0 || (fits[at] && !fits[best]) || (fits[at] === fits[best] && (left[at] as number) > (left[best] as number));
        if (better) best = at;
      }
      (lists[best] as Building[]).push(building);
      left[best] = (left[best] as number) - need(best);
    }
    const rest = byArea.filter((building) => lotArea(building) <= bigAbove);
    // The room the ordinary buildings have: what the big ones leave, each counted at its share of the ground.
    const room = own.map((ward, at) => Math.max(0, (capacity[at] as number) - (lists[at] as Building[]).reduce((sum, building) => sum + needIn(building, areas[ward] as number, capacity[at] as number, 1), 0)));
    const shares = apportion(rest.length, room.some((value) => value > 0) ? room.map((value) => Math.max(value, 1e-9)) : own.map(() => 1));
    // None more than its room, where others have room to spare; and none left empty while another can give one up.
    for (let guard = 0; guard < 4 * own.length + rest.length; guard++) {
      const over = shares.findIndex((count, at) => count > (room[at] as number) && shares.some((other, k) => other < (room[k] as number)));
      const empty = shares.findIndex((count, at) => count === 0 && (lists[at] as Building[]).length === 0 && (room[at] as number) > 0);
      if (over >= 0) {
        const spare = shares.map((count, k) => (room[k] as number) - count);
        const to = spare.indexOf(Math.max(...spare));
        shares[over] = (shares[over] as number) - 1;
        shares[to] = (shares[to] as number) + 1;
      } else if (empty >= 0) {
        const from = shares.indexOf(Math.max(...shares));
        if ((shares[from] as number) < 2) break;
        shares[from] = (shares[from] as number) - 1;
        shares[empty] = 1;
      } else break;
    }
    let next = 0;
    // Dealt out in turn, so that each ward has a run of sizes.
    for (let round = 0; next < rest.length && round < rest.length; round++) {
      for (let at = 0; at < own.length && next < rest.length; at++) {
        if ((lists[at] as Building[]).filter((building) => lotArea(building) <= bigAbove && !(extraIn[own[at] as number] as Building[]).includes(building)).length >= (shares[at] as number)) continue;
        (lists[at] as Building[]).push(rest[next++] as Building);
      }
    }
    return lists;
    };
    let finer = 1;
    let capacity: number[] = [];
    let lists: Building[][] = [];
    // Enough lots over the district, and shared out so that no ward is given more than its room; else finer.
    for (let round = 0; ; round++) {
      capacity = own.map((ward) => {
        const counted = cutOne(ward, [], sizeOf(ward, finer), floorWidth, bigAbove, true);
        return 'count' in counted ? counted.count : 0;
      });
      const total = capacity.reduce((sum, value) => sum + value, 0);
      // Over the district as a whole a big building needs only its share of the ground; the margin is for one ward.
      const needed = everyone.reduce((sum, building) => sum + needIn(building, ground, total, 1), 0);
      if (total >= needed) {
        lists = shareOut(capacity);
        const fits = own.every((ward, at) => (lists[at] as Building[]).reduce((sum, building) => sum + needIn(building, areas[ward] as number, capacity[at] as number, 1), 0) <= (capacity[at] as number));
        if (fits) break;
      }
      if (round >= DISTRICT_FINER) throw new TooSmall('the districts');
      finer *= FINER;
      fixes.finer++;
    }
    const used = own.map((ward, at) => (lists[at] as Building[]).reduce((sum, building) => sum + needIn(building, areas[ward] as number, capacity[at] as number), 0));
    own.forEach((ward, at) => {
      const list = lists[at] as Building[];
      if (list.length === 0) return;
      // The same cutting as was counted; finer a few times where big buildings took more than their share.
      for (let tries = 0; ; tries++) {
        const made = cutOne(ward, list, sizeOf(ward, finer * FINER ** tries), floorWidth, bigAbove);
        if ('placed' in made) {
          made.fixes.finer += tries;
          placed.push(...made.placed);
          lanes.push(...made.lanes);
          open.push(...made.open);
          for (const key of Object.keys(made.fixes) as Array<keyof Fixes>) fixes[key] += made.fixes[key];
          return;
        }
        if (tries >= WARD_FINER) throw new Error(`ward ${ward} of ${Math.round(areas[ward] as number)} m² can hold ${capacity[at]} lots but must hold ${list.length} buildings, taking the room of ${used[at]}`);
      }
    });
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

/** How far along a line each corner is. */
function alongOf(points: readonly Point[]): number[] {
  const out = [0];
  for (let k = 1; k < points.length; k++) out.push((out[k - 1] as number) + Math.hypot((points[k] as Point)[0] - (points[k - 1] as Point)[0], (points[k] as Point)[1] - (points[k - 1] as Point)[1]));
  return out;
}

/** A line cut short at a distance along it. */
function cutTo(points: readonly Point[], along: readonly number[], at: number): Point[] {
  const out: Point[] = [points[0] as Point];
  for (let k = 1; k < points.length; k++) {
    if ((along[k] as number) < at) {
      out.push(points[k] as Point);
      continue;
    }
    const a = points[k - 1] as Point;
    const b = points[k] as Point;
    const span = (along[k] as number) - (along[k - 1] as number);
    const t = span === 0 ? 1 : (at - (along[k - 1] as number)) / span;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    break;
  }
  return out;
}
