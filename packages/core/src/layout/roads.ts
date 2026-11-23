/**
 * The roads of a grown town, laid before anything else: the road came first,
 * and the town grew along it.
 *
 * Every route of the brief is a highway from the centre out past the town.
 * Two routes leaving nearly opposite each other are one road through the
 * centre. Where a highway crosses a river it bends to meet a bridge set square
 * to the bank. Arterials branch off each highway on alternating sides, longest
 * near the centre, and stop at the water or where they meet another road. A
 * town large enough has a second bridge with an arterial of its own, a street
 * follows each bank of a river, and a port's quay stands in for a highway with
 * arterials running inland. A town with no routes has one local road through
 * its centre in their place.
 */
import type { Rng } from '../city/random.ts';
import type { GrownSettings } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import { simplify } from './cutting.ts';
import { bearingVector, distance, pointAlongPolyline, projectOnPolyline, slicePolyline } from './geometry.ts';
import { alongOf, chaikin, firstCrossing, normal, wander } from './lines.ts';
import type { Coast, River } from './water.ts';

/** A highway carries a route; a quay or a local road stands in for one; a bank street follows a river. */
export type RoadKind = 'highway' | 'quay' | 'local' | 'arterial' | 'bank';

export interface Road {
  kind: RoadKind;
  /** A highway from the centre outward, an arterial from where it leaves its road. */
  points: Point[];
  width: number;
  /** For a highway: the index of its route in the brief. */
  route?: number;
  /** For an arterial: the road it leaves. */
  from?: number;
  /** For a highway paired with another through the centre: that one. */
  partner?: number;
  /** The stretches carried on bridges: each a pair of consecutive corners of the line. */
  bridges: Array<[Point, Point]>;
}

export interface RoadPlan {
  roads: Road[];
  /** The roads arterials branch from: highways, quays and local roads. */
  trunks: number[];
}

const turn = (angle: number) => ((angle % 360) + 360) % 360;
const apart = (a: number, b: number) => Math.min(turn(a - b), turn(b - a));
/** Lines are smoothed finely and then thinned to within this many metres. */
const THIN = 0.15;

export interface RoadInput {
  brief: SettlementBrief;
  settings: GrownSettings;
  /** The streams this step draws on, by name. */
  rng: (step: string) => Rng;
  /** How far out from the centre highways run. */
  far: number;
  /** The town's radius: the radius of a circle of the ground it needs. */
  radius: number;
  /** How far a point is from any water: negative in it. */
  dryBy: (point: Point) => number;
  river?: River;
  coast?: Coast;
}

/** Cuts a line short where it first comes within `margin` of the water, after `skip` metres of it. */
function stopAtWater(points: Point[], dryBy: (point: Point) => number, margin: number, skip = 0): Point[] {
  const along = alongOf(points);
  for (let at = 1; at < points.length; at++) {
    if ((along[at] as number) < skip) continue;
    if (dryBy(points[at] as Point) < margin) return points.slice(0, at);
  }
  return points;
}

export function planRoads(input: RoadInput): RoadPlan {
  const { brief, settings, far, radius, dryBy, river, coast } = input;
  const widths = settings.widths;
  const roads: Road[] = [];
  const trunks: number[] = [];
  const ray = (bearing: number, reach: number): Point => {
    const [x, y] = bearingVector(bearing);
    return [x * reach, y * reach];
  };

  // ---- Highways --------------------------------------------------------------------------------------------
  const rng = input.rng('grown-highways');
  const bearings = brief.routes.map((route) => route.bearing);
  // Pairs of routes nearly opposite each other, nearest to opposite first, are one road through the centre.
  const pairs: Array<[number, number]> = [];
  const paired = new Set<number>();
  const candidates: Array<{ a: number; b: number; off: number }> = [];
  bearings.forEach((a, i) => bearings.forEach((b, j) => {
    if (j > i && apart(a, b) >= 180 - settings.highways.through) candidates.push({ a: i, b: j, off: 180 - apart(a, b) });
  }));
  candidates.sort((x, y) => x.off - y.off || x.a - y.a || x.b - y.b);
  for (const { a, b } of candidates) {
    if (paired.has(a) || paired.has(b)) continue;
    paired.add(a).add(b);
    pairs.push([a, b]);
  }
  /** A highway from the centre outward, cut short where it reaches the sea, carried over the river on bridges. */
  const arm = (points: Point[], route: number | undefined, kind: RoadKind) => {
    let line = points;
    if (coast) line = stopAtWater(line, (point) => coast.gap(point), widths.highway, 0);
    const road: Road = { kind, points: line, width: widths.highway, ...(route !== undefined && { route }), bridges: [] };
    if (river) bridgeOver(road, river);
    road.points = thin(road.points, road.bridges);
    roads.push(road);
    trunks.push(roads.length - 1);
    return roads.length - 1;
  };
  /** The two ends of a bridge square to the river at a point, the first on the side of `toward`. */
  const bridgeAt = (riverNow: River, point: Point, toward: Point): [Point, Point] => {
    const near = riverNow.nearest(point);
    const { direction, width } = riverNow.at(near.along);
    const across: Point = [-direction[1], direction[0]];
    const reach = width / 2 + settings.bridges.landing;
    const one: Point = [near.point[0] - across[0] * reach, near.point[1] - across[1] * reach];
    const two: Point = [near.point[0] + across[0] * reach, near.point[1] + across[1] * reach];
    return distance(one, toward) <= distance(two, toward) ? [one, two] : [two, one];
  };
  /** Where a road crosses the river, a bridge square to the bank, the road leaving its line either side to meet it. */
  const bridgeOver = (road: Road, riverNow: River) => {
    for (let guard = 0; guard < 6; guard++) {
      const along = alongOf(road.points);
      const total = along[along.length - 1] as number;
      // The first crossing not already on a bridge.
      let crossing: number | undefined;
      let skip = 0;
      for (;;) {
        const found = firstCrossing(road.points, riverNow.line, skip);
        if (found === undefined) break;
        const point = pointAlongPolyline(road.points, found);
        if (!road.bridges.some(([a, b]) => distance(a, point) + distance(point, b) < distance(a, b) + 1)) {
          crossing = found;
          break;
        }
        skip = found + 1;
      }
      if (crossing === undefined) return;
      const point = pointAlongPolyline(road.points, crossing);
      // The approach is shortened where another bridge or the road's end is near.
      const behind = Math.max(...road.bridges.map(([, b]) => projectOnPolyline(road.points, b).along).filter((at) => at < crossing), 0);
      const reachBack = Math.min(settings.highways.approach, (crossing - behind) * 0.8);
      const reachOn = Math.min(settings.highways.approach, (total - crossing) * 0.8);
      const before = slicePolyline(road.points, 0, crossing - reachBack);
      const after = slicePolyline(road.points, crossing + reachOn, total);
      const [a, b] = bridgeAt(riverNow, point, before[before.length - 1] as Point);
      road.points = [...before, a, b, ...after];
      road.bridges.push([a, b]);
    }
  };
  /** A line thinned to fewer corners, the ends of its bridges kept. */
  const thin = (points: Point[], bridges: Array<[Point, Point]>) => {
    if (bridges.length === 0) return simplify(points, THIN);
    const keep = new Set(bridges.flat());
    const out: Point[] = [];
    let run: Point[] = [];
    for (const point of points) {
      run.push(point);
      if (keep.has(point)) {
        const part = simplify(run, THIN);
        out.push(...(out.length > 0 ? part.slice(1) : part));
        run = [point];
      }
    }
    if (run.length > 1) out.push(...simplify(run, THIN).slice(1));
    return out;
  };
  const amplitude = settings.highways.wander;
  for (const [a, b] of pairs) {
    // One line through the centre, so that it bends as one road; then cut at the centre into the two routes.
    const inward = wander(rng, ray(bearings[a] as number, far), [0, 0], amplitude);
    const outward = wander(rng, [0, 0], ray(bearings[b] as number, far), amplitude);
    const one = arm([...inward].reverse(), a, 'highway');
    const two = arm(outward, b, 'highway');
    (roads[one] as Road).partner = two;
    (roads[two] as Road).partner = one;
  }
  bearings.forEach((bearing, index) => {
    if (paired.has(index)) return;
    arm(wander(rng, [0, 0], ray(bearing, far), amplitude), index, 'highway');
  });

  // A port's quay: the shore near the centre, a little inland, either way from its middle.
  const extent = settings.arterials.span * radius;
  if (brief.flags.port && coast) {
    const quay = (sign: number) => {
      const points: Point[] = [];
      for (let along = 0; along <= 1.2 * extent; along += settings.coast.pieceLength * 2) {
        const at = sign * along;
        const out = coast.shoreAt(at) - settings.ground.waterClear - widths.highway / 2;
        points.push([coast.seaward[0] * out + coast.alongShore[0] * at, coast.seaward[1] * out + coast.alongShore[1] * at]);
      }
      return chaikin(points, 2);
    };
    for (const sign of [1, -1]) {
      const line = quay(sign);
      if (line.length > 2 && distance(line[0] as Point, [0, 0]) < 1.5 * extent) {
        roads.push({ kind: 'quay', points: simplify(line, THIN), width: widths.highway, bridges: [] });
        trunks.push(roads.length - 1);
      }
    }
  }
  // A town with no routes has one local road through its centre.
  if (trunks.length === 0) {
    const bearing = rng.next() * 360;
    const reach = 2 * extent;
    for (const out of [bearing, bearing + 180]) {
      const road: Road = { kind: 'local', points: wander(rng, [0, 0], ray(out, reach), amplitude / 2), width: widths.highway, bridges: [] };
      if (coast) road.points = stopAtWater(road.points, (point) => coast.gap(point), widths.highway, 0);
      if (river) bridgeOver(road, river);
      road.points = thin(road.points, road.bridges);
      roads.push(road);
      trunks.push(roads.length - 1);
    }
  }

  // ---- Arterials ---------------------------------------------------------------------------------------------
  // Along each trunk from the centre outward, on alternating sides; the side carries on from one trunk to the
  // next, so that a road through the centre alternates along its whole length.
  const branch = input.rng('grown-arterials');
  const { arterials } = settings;
  const drawn: Road[] = [];
  let side = 1;
  for (const trunk of trunks) {
    const road = roads[trunk] as Road;
    const along = alongOf(road.points);
    const length = along[along.length - 1] as number;
    // The first leaves some way from the centre: none starts at the junction there.
    let at = arterials.spacing.min * (0.3 + 0.3 * branch.next());
    const stretch = Math.min(length, extent);
    while (at < stretch) {
      const base = pointAlongPolyline(road.points, at);
      const ahead = pointAlongPolyline(road.points, Math.min(length, at + 5));
      const run = distance(base, ahead) || 1;
      const tangent: Point = [(ahead[0] - base[0]) / run, (ahead[1] - base[1]) / run];
      const sideways: Point = [-tangent[1] * side, tangent[0] * side];
      const reach = (arterials.reach * radius - arterials.fall * at) * (arterials.spread.min + (arterials.spread.max - arterials.spread.min) * branch.next());
      const lean = normal(branch) * arterials.lean;
      const direction: Point = [sideways[0] + tangent[0] * lean, sideways[1] + tangent[1] * lean];
      const size = Math.hypot(direction[0], direction[1]) || 1;
      const seaward = road.kind === 'quay' && coast ? sideways[0] * coast.seaward[0] + sideways[1] * coast.seaward[1] > 0 : false;
      const onBridge = road.bridges.some(([a, b]) => distance(a, base) + distance(base, b) < distance(a, b) + 30);
      if (reach >= arterials.shortest && !seaward && !onBridge && dryBy(base) > arterials.bank) {
        const end: Point = [base[0] + (direction[0] / size) * reach, base[1] + (direction[1] / size) * reach];
        drawn.push({ kind: 'arterial', points: wander(branch, base, end, arterials.wander), width: widths.arterial, from: trunk, bridges: [] });
      }
      at += arterials.spacing.min + (arterials.spacing.max - arterials.spacing.min) * branch.next();
      side = -side;
    }
  }
  /** An arterial ends at the water, and where it first meets another road. */
  const finish = (line: Road, skipFrom = 15) => {
    let points = stopAtWater(line.points, dryBy, arterials.bank, 0);
    let stop = Infinity;
    for (const other of roads) {
      const meets = firstCrossing(points, other.points, skipFrom);
      if (meets !== undefined) stop = Math.min(stop, meets);
    }
    if (stop < Infinity) points = slicePolyline(points, 0, stop);
    if (points.length < 2 || (alongOf(points)[points.length - 1] as number) < arterials.shortest) return;
    roads.push({ ...line, points: simplify(points, THIN) });
  };
  for (const line of drawn) finish(line);

  // ---- Bridges in town -----------------------------------------------------------------------------------------
  // A town by a river crosses it near the centre: where a highway does, or else the arterial that meets the river
  // nearest the centre is carried over on a bridge. A large town has a second, some way along the river.
  const bridgeRng = input.rng('grown-bridges');
  const reachOfTown = arterials.reach * radius;
  /** The road on from a bridge's far end, straight out from the bank and straying a little. */
  const beyondBridge = (a: Point, b: Point): Point[] => {
    const outward: Point = [(b[0] - a[0]) / distance(a, b), (b[1] - a[1]) / distance(a, b)];
    const reach = radius * settings.bridges.beyond;
    const end: Point = [b[0] + outward[0] * reach + normal(bridgeRng) * 40, b[1] + outward[1] * reach + normal(bridgeRng) * 40];
    let beyond = stopAtWater(wander(bridgeRng, b, end, settings.bridges.wander), dryBy, arterials.bank, 30);
    let stop = Infinity;
    for (const other of roads) {
      const meets = firstCrossing(beyond, other.points, 5);
      if (meets !== undefined) stop = Math.min(stop, meets);
    }
    if (stop < Infinity) beyond = slicePolyline(beyond, 0, stop);
    // The bridge's own end, so that the bridge is a stretch of the line.
    return [b, ...simplify(beyond, THIN).slice(1)];
  };
  const middleOf = ([a, b]: [Point, Point]): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const inTown = (bridge: [Point, Point]) => Math.hypot(...middleOf(bridge)) < reachOfTown;
  if (river && !roads.some((road) => road.bridges.some(inTown))) {
    // The arterial that stopped at the river nearest the centre.
    const atRiver = roads
      .map((road, index) => ({ road, index }))
      .filter(({ road }) => road.kind === 'arterial' && river.gap(road.points[road.points.length - 1] as Point) < 2 * arterials.bank)
      .filter(({ road }) => Math.hypot(...(road.points[road.points.length - 1] as Point)) < reachOfTown)
      .sort((x, y) => Math.hypot(...(x.road.points[x.road.points.length - 1] as Point)) - Math.hypot(...(y.road.points[y.road.points.length - 1] as Point)) || x.index - y.index);
    for (const { road } of atRiver) {
      const end = road.points[road.points.length - 1] as Point;
      const [a, b] = bridgeAt(river, river.nearest(end).point, end);
      // The way from where it stopped to the bridge must be dry, and so must the far bank.
      let dry = true;
      for (let step = 1; step < 8 && dry; step++) dry = dryBy([end[0] + ((a[0] - end[0]) * step) / 8, end[1] + ((a[1] - end[1]) * step) / 8]) > 0;
      if (!dry || dryBy(b) < settings.bridges.landing / 2) continue;
      const beyond = beyondBridge(a, b);
      road.points = [...road.points, a, ...beyond];
      road.bridges.push([a, b]);
      break;
    }
  }
  const firstBridge = roads.flatMap((road) => road.bridges).filter(inTown)[0];
  if (river && firstBridge && brief.population > settings.bridges.secondAbove) {
    const along = river.nearest(middleOf(firstBridge)).along;
    const options = [along - settings.bridges.apart, along + settings.bridges.apart]
      .filter((at) => at > 0 && at < (river.along[river.along.length - 1] as number))
      .map((at) => river.at(at).point)
      .sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
    for (const spot of options) {
      const [a, b] = bridgeAt(river, spot, [0, 0]);
      // It leaves the nearest point of a highway on its own bank: one the way to which crosses no water.
      let start: Point | undefined;
      let nearest = Infinity;
      let from = -1;
      roads.forEach((road, index) => {
        if (road.kind !== 'highway') return;
        for (const point of road.points) {
          const away = distance(point, a);
          if (away >= nearest || away < 20) continue;
          let dry = true;
          for (let step = 1; step < 12 && dry; step++) dry = dryBy([point[0] + ((a[0] - point[0]) * step) / 12, point[1] + ((a[1] - point[1]) * step) / 12]) > 0;
          if (dry) {
            nearest = away;
            start = point;
            from = index;
          }
        }
      });
      if (!start || dryBy(b) < settings.bridges.landing / 2) continue;
      const toBridge = wander(bridgeRng, start, a, settings.bridges.wander);
      if (toBridge.some((point, at) => at < toBridge.length - 1 && dryBy(point) < widths.arterial / 2)) continue;
      const points = [...simplify(toBridge, THIN).slice(0, -1), a, ...beyondBridge(a, b)];
      roads.push({ kind: 'arterial', points, width: widths.arterial, from, bridges: [[a, b]] });
      break;
    }
  }

  // ---- Streets along the banks -------------------------------------------------------------------------------
  if (river) {
    const out = settings.quays.offset;
    for (const sign of [1, -1]) {
      let run: Point[] = [];
      const flush = () => {
        if (run.length > 3) roads.push({ kind: 'bank', points: simplify(chaikin(run, 1), THIN), width: widths.street, bridges: [] });
        run = [];
      };
      for (let along = 0; along < (river.along[river.along.length - 1] as number); along += 6) {
        const { point, direction, width } = river.at(along);
        const reach = width / 2 + out;
        const on: Point = [point[0] - direction[1] * sign * reach, point[1] + direction[0] * sign * reach];
        // Not where another stretch of the river comes nearer, at a bend, nor in the sea, nor beyond the roads.
        if (Math.hypot(on[0], on[1]) > far || river.gap(on) < out - 1 || (coast && coast.gap(on) < out)) flush();
        else run.push(on);
      }
      flush();
    }
    // Arterials that stopped at the bank run on to the street along it.
    const banks = roads.filter((road) => road.kind === 'bank');
    for (const road of roads) {
      if (road.kind !== 'arterial' || road.bridges.length > 0) continue;
      const end = road.points[road.points.length - 1] as Point;
      if (dryBy(end) > arterials.bank + 2) continue;
      let best: { point: Point; distance: number } | undefined;
      for (const bank of banks) {
        const found = projectOnPolyline(bank.points, end);
        if (!best || found.distance < best.distance) best = found;
      }
      if (best && best.distance < arterials.bank) road.points = [...road.points, best.point];
    }
  }
  return { roads, trunks };
}
