/**
 * The roads of a grown town, laid as lines before any block: the road came
 * first, and the town grew along it.
 *
 * Every route of the brief is a highway from the centre to the far edge of the
 * ground. Two routes leaving nearly opposite each other are one road through
 * the centre. Arterials branch off each highway on alternating sides, longest
 * near the centre, and end where they meet the water, another road, or their
 * length. A port's quay is a highway of its own, with arterials running inland
 * from it; a town with no routes has one local road through its centre in their
 * place. Nothing here knows of blocks: the lines are what the blocks are seeded
 * around.
 */
import type { Rng } from '../city/random.ts';
import type { GrownSettings } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import { bearingVector, distance, pointAlongPolyline, slicePolyline } from './geometry.ts';
import { alongOf, chaikin, firstCrossing, normal, wander } from './lines.ts';
import type { Coast, River } from './water.ts';

/** What a road line is: a highway carries a route; a quay and a local road stand in for one. */
export type RoadKind = 'highway' | 'quay' | 'local' | 'arterial';

export interface RoadLine {
  kind: RoadKind;
  /** From where it begins to where it ends: a highway from the centre outward, an arterial from its highway. */
  points: Point[];
  /** For a highway: the index of its route in the brief. */
  route?: number;
  /** For an arterial: the road it branches from, and how far along that road. */
  from?: { road: number; along: number };
  /** May cross the river by a bridge. */
  crosses?: boolean;
}

export interface RoadPlan {
  roads: RoadLine[];
  /** Each highway, quay or local road with its arterials: the indices into `roads`. */
  trunks: number[];
}

const turn = (angle: number) => ((angle % 360) + 360) % 360;
const apart = (a: number, b: number) => Math.min(turn(a - b), turn(b - a));

export interface RoadInput {
  brief: SettlementBrief;
  settings: GrownSettings;
  /** The streams this step draws on, by name. */
  rng: (step: string) => Rng;
  /** How far out from the centre highways run. */
  far: number;
  /** The square root of the ground the town needs, in metres: what lengths along the road scale with. */
  root: number;
  /** How far a point is from any water: negative in it. */
  dryBy: (point: Point) => number;
  river?: River;
  coast?: Coast;
  /** How near the water a road may come before it has reached it. */
  bankside: number;
}

/** Cuts a line short where it first comes within `margin` of the water, after `skip` metres of it. */
function stopAtWater(points: Point[], dryBy: (point: Point) => number, margin: number, skip = 0): Point[] {
  const along = alongOf(points);
  for (let at = 0; at < points.length; at++) {
    if ((along[at] as number) < skip) continue;
    if (dryBy(points[at] as Point) < margin) return at < 2 ? points.slice(0, Math.min(points.length, 2)) : points.slice(0, at);
  }
  return points;
}

export function planRoads(input: RoadInput): RoadPlan {
  const { brief, settings, far, root, dryBy, bankside } = input;
  const roads: RoadLine[] = [];
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
  /** A highway from the centre outward toward a bearing, cut short where it reaches the sea. */
  const arm = (points: Point[], route: number | undefined, kind: RoadKind) => {
    let line = points;
    if (input.coast) {
      const coast = input.coast;
      line = stopAtWater(line, (point) => coast.gap(point), bankside, 0);
    }
    roads.push({ kind, points: line, ...(route !== undefined && { route }), crosses: true });
    trunks.push(roads.length - 1);
  };
  const amplitude = settings.highways.wander;
  for (const [a, b] of pairs) {
    // One line through the centre, so that it bends as one road; then cut at the centre into the two routes.
    const inward = wander(rng, ray(bearings[a] as number, far), [0, 0], amplitude);
    const outward = wander(rng, [0, 0], ray(bearings[b] as number, far), amplitude);
    arm([...inward].reverse(), a, 'highway');
    arm(outward, b, 'highway');
  }
  bearings.forEach((bearing, index) => {
    if (paired.has(index)) return;
    arm(wander(rng, [0, 0], ray(bearing, far), amplitude), index, 'highway');
  });

  // A port's quay: the shore near the centre, a little inland, as a highway either way from its middle.
  const extent = settings.arterials.span * root;
  if (brief.flags.port && input.coast) {
    const coast = input.coast;
    const quay = (sign: number) => {
      const points: Point[] = [];
      for (let along = 0; along <= 1.2 * extent; along += settings.coast.pieceLength * 2) {
        const at = sign * along;
        const out = coast.shoreAt(at) - bankside;
        points.push([coast.seaward[0] * out + coast.alongShore[0] * at, coast.seaward[1] * out + coast.alongShore[1] * at]);
      }
      return chaikin(points, 2);
    };
    // Only where the quay is on the town's side of the sea and not further out than the town reaches.
    for (const sign of [1, -1]) {
      const line = quay(sign);
      if (line.length > 2 && distance(line[0] as Point, [0, 0]) < 1.5 * extent) {
        roads.push({ kind: 'quay', points: line });
        trunks.push(roads.length - 1);
      }
    }
  }
  // A town with no routes has one local road through its centre.
  if (trunks.length === 0) {
    const bearing = rng.next() * 360;
    const reach = 1.6 * extent;
    roads.push({ kind: 'local', points: wander(rng, [0, 0], ray(bearing, reach), amplitude / 2) });
    trunks.push(roads.length - 1);
    roads.push({ kind: 'local', points: wander(rng, [0, 0], ray(bearing + 180, reach), amplitude / 2) });
    trunks.push(roads.length - 1);
  }

  // ---- Arterials ---------------------------------------------------------------------------------------------
  // Along each trunk from the centre outward, on alternating sides; the side carries on from one trunk to the
  // next, so that a road through the centre alternates along its whole length.
  const branch = input.rng('grown-arterials');
  const { arterials } = settings;
  const branches: RoadLine[] = [];
  let side = 1;
  for (const trunk of trunks) {
    const road = roads[trunk] as RoadLine;
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
      const reach = (arterials.reach * root - arterials.fall * at) * (arterials.spread.min + (arterials.spread.max - arterials.spread.min) * branch.next());
      const angle = ((arterials.turn * Math.PI) / 180) * normal(branch);
      const lean = normal(branch) * arterials.lean;
      const direction: Point = [sideways[0] * Math.cos(angle) + tangent[0] * lean, sideways[1] * Math.cos(angle) + tangent[1] * lean];
      const size = Math.hypot(direction[0], direction[1]) || 1;
      const quaySide = road.kind === 'quay' && input.coast ? sideways[0] * input.coast.seaward[0] + sideways[1] * input.coast.seaward[1] > 0 : false;
      if (reach >= arterials.shortest && !quaySide) {
        const end: Point = [base[0] + (direction[0] / size) * reach, base[1] + (direction[1] / size) * reach];
        branches.push({ kind: 'arterial', points: wander(branch, base, end, arterials.wander), from: { road: trunk, along: at } });
      }
      at += arterials.spacing.min + (arterials.spacing.max - arterials.spacing.min) * branch.next();
      side = -side;
    }
  }
  // One crosses the river by a bridge, and a second where the town is large enough: those that would cross it
  // nearest the centre. The rest stop at the bank, where they meet the street along it.
  const crossing = (line: RoadLine) => line.points.findIndex((point) => (input.river ? input.river.gap(point) < 0 : false));
  const wet = branches.map((line, index) => ({ index, at: crossing(line) })).filter((entry) => entry.at >= 0);
  wet.sort((a, b) => distance(branches[a.index]!.points[a.at] as Point, [0, 0]) - distance(branches[b.index]!.points[b.at] as Point, [0, 0]) || a.index - b.index);
  const bridges = brief.population >= settings.river.secondBridgeAbove ? 2 : 1;
  const bridging = new Set(wet.slice(0, bridges).map((entry) => entry.index));
  // Where too few of them reach the river, those whose ends come nearest it are carried across.
  while (input.river && bridging.size < bridges && bridging.size < branches.length) {
    const river = input.river;
    let nearest = -1;
    let gap = Infinity;
    branches.forEach((line, index) => {
      if (bridging.has(index)) return;
      const end = line.points[line.points.length - 1] as Point;
      const away = river.gap(end);
      if (away < gap) {
        gap = away;
        nearest = index;
      }
    });
    if (nearest < 0) break;
    const line = branches[nearest] as RoadLine;
    const end = line.points[line.points.length - 1] as Point;
    const near = river.nearest(end);
    if (gap < 2 * arterials.spacing.max) {
      const away = distance(near.point, end) || 1;
      const beyond = near.width / 2 + arterials.spacing.max;
      const across: Point = [near.point[0] + ((near.point[0] - end[0]) / away) * beyond, near.point[1] + ((near.point[1] - end[1]) / away) * beyond];
      const start = line.points[0] as Point;
      line.points = wander(branch, start, across, arterials.wander);
      bridging.add(nearest);
    } else break;
  }
  branches.forEach((line, index) => {
    let points = line.points;
    if (bridging.has(index)) line.crosses = true;
    else points = stopAtWater(points, dryBy, bankside, 0);
    if (input.coast) {
      const coast = input.coast;
      points = stopAtWater(points, (point) => coast.gap(point), bankside, 0);
    }
    // An arterial ends where it meets another road: at the first highway, or an arterial laid before it, that it crosses.
    let stop = Infinity;
    for (const trunk of trunks) {
      const other = (roads[trunk] as RoadLine).points;
      const meets = firstCrossing(points, other, 15);
      if (meets !== undefined) stop = Math.min(stop, meets);
    }
    for (const other of roads) {
      if (other.kind !== 'arterial') continue;
      const meets = firstCrossing(points, other.points, 15);
      if (meets !== undefined) stop = Math.min(stop, meets);
    }
    if (stop < Infinity) points = slicePolyline(points, 0, stop);
    if (points.length < 2 || alongOf(points)[points.length - 1]! < arterials.shortest) return;
    roads.push({ ...line, points });
  });
  return { roads, trunks };
}
