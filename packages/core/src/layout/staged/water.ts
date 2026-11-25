/**
 * Stage 1 of the staged generator: water, in calm shapes only.
 *
 * A river enters and leaves on the brief's bearings and passes the centre at
 * a distance drawn here, since the brief gives none. It has two broad bends
 * and a constant width. A coast is a line on the brief's side with wide bays
 * and headlands. Nothing later moves either.
 */
import { stepRng } from '../../city/random.ts';
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point, SettlementBrief } from '../../schema.ts';
import { bearingVector, crossingsOfPolyline, pointAlongPolyline, polylineLength, projectOnPolyline } from '../geometry.ts';
import { chaikin, normal } from '../lines.ts';
import { add, between, dot, drawFrom, evened, left, size, tangentAt, unit } from './lines.ts';

export interface River {
  /** The centre line, from upstream to downstream. */
  line: Point[];
  width: number;
  length: number;
  /** How far from the centre the river's centre line passes, in metres: the distance drawn, or the least there is room for. */
  distance: number;
  /** The nearest point of the centre line, how far along the line it is, and how far away. */
  nearest(point: Point): { point: Point; along: number; distance: number };
  /** How far a point is from the water's edge: negative in the water. */
  gap(point: Point): number;
  /** The point at a distance along the line, and the direction the river runs there. */
  at(along: number): { point: Point; direction: Point };
  /** Which bank a point is on: 1 to the left of the flow, -1 to the right. */
  side(point: Point): 1 | -1;
  /** Whether the straight line between two points crosses the centre line. */
  crossed(a: Point, b: Point): boolean;
}

export interface Coast {
  /** The unit vector toward open water, and the one along the shore. */
  seaward: Point;
  alongShore: Point;
  /** The shore line. */
  shore: Point[];
  length: number;
  /** The sea, as a polygon that reaches well beyond anything drawn. */
  polygon: Point[];
  /** How far a point is from the shore: negative in the sea. */
  gap(point: Point): number;
}

export interface WaterInput {
  brief: SettlementBrief;
  /** Only the river and the coast are read: the village generator passes its own. */
  settings: Pick<StagedSettings, 'river' | 'coast'>;
  seed: number;
  /** The first word of the streams' names: `staged`, unless another generator draws water this way. */
  streams?: string;
  /** The town's radius, and how far out roads and water are drawn. */
  radius: number;
  reach: number;
  /** The least distance from the centre to a river's bank. */
  least: number;
}

/** The river of a brief, or nothing if it has none. */
export function makeRiver({ brief, settings, seed, radius, reach, least, streams = 'staged' }: WaterInput): River | undefined {
  if (!brief.river) return undefined;
  const { river } = settings;
  const arrives = brief.river.arrivesFrom?.bearing;
  // A river that ends here runs to the sea if there is one, otherwise on to the edge opposite.
  const leaves = brief.river.leavesToward?.bearing ?? brief.coast.waterBearing ?? (arrives === undefined ? undefined : (arrives + 180) % 360);
  if (leaves === undefined) return undefined;
  const riverPort = brief.flags.port && !brief.coast.isCoastal;
  // This one draw decides whether the town is beside its river or astride it, so it has a stream of its own.
  const off = drawFrom(stepRng(seed, `${streams}-river-distance`), riverPort ? river.portDistance : river.distance) * radius;
  const rng = stepRng(seed, `${streams}-river`);
  const sign = rng.next() < 0.5 ? 1 : -1;
  const bends = [drawFrom(rng, river.bend), drawFrom(rng, river.bend)];
  const turned = (rng.next() < 0.5 ? 1 : -1) * drawFrom(rng, river.sourceTurn);
  const source = drawFrom(rng, river.source) * radius;
  const far = reach * river.beyond;
  // A river that rises here is laid as if it came from nearly opposite, and cut short at its source.
  const from = add([0, 0], bearingVector(arrives ?? leaves + 180 + turned), far);
  const to = add([0, 0], bearingVector(leaves), far);
  let toward: Point = [from[0] + to[0], from[1] + to[1]];
  // Coming and going straight opposite, it passes on a side chosen by chance.
  if (size(toward) < 1e-6 * far) toward = left(unit(from, to));
  const middle = add([0, 0], toward, off / size(toward));
  const pushed = (a: Point, b: Point, by: number) => add(between(a, b), left(unit(a, b)), sign * by * size([b[0] - a[0], b[1] - a[1]]));
  let line = chaikin([from, pushed(from, middle, bends[0] as number), middle, pushed(middle, to, bends[1] as number), to], 5);
  const width = river.width * (riverPort ? river.portWidth : 1);
  // Rounding its bends moves it in or out, and a small town's share of its radius may be less than the river is
  // wide. It is moved bodily until it passes the centre at the distance drawn, or as near as leaves room between
  // the centre and the bank for the plaza and a quay road.
  const passes = Math.max(off, width / 2 + least);
  const found = projectOnPolyline(line, [0, 0]);
  const away = found.distance > 1e-6 ? unit([0, 0], found.point) : unit([0, 0], toward);
  line = line.map((point) => add(point, away, passes - found.distance));
  if (arrives === undefined) {
    // Cut at the last point upstream of the centre that is as far out as the source.
    const nearest = projectOnPolyline(line, [0, 0]).along;
    let start = 0;
    line.forEach((point, at) => {
      if (size(point) >= source && projectOnPolyline(line, point).along < nearest) start = at;
    });
    line = line.slice(start);
  }
  const length = polylineLength(line);
  const nearest = (point: Point) => projectOnPolyline(line, point);
  const at = (along: number) => ({ point: pointAlongPolyline(line, along), direction: tangentAt(line, along, length) });
  return {
    line,
    width,
    length,
    distance: passes,
    nearest,
    at,
    gap: (point) => nearest(point).distance - width / 2,
    side(point) {
      const found = nearest(point);
      const { direction } = at(found.along);
      return dot(left(direction), [point[0] - found.point[0], point[1] - found.point[1]]) <= 0 ? 1 : -1;
    },
    crossed: (a, b) => crossingsOfPolyline(a, b, line) > 0,
  };
}

/** The coast of a brief, or nothing if it has none. */
export function makeCoast({ brief, settings, seed, radius, reach, streams = 'staged' }: WaterInput): Coast | undefined {
  if (brief.coast.waterBearing === undefined) return undefined;
  const { coast } = settings;
  const seaward = bearingVector(brief.coast.waterBearing);
  const alongShore = left(seaward);
  const out = drawFrom(stepRng(seed, `${streams}-coast-distance`), coast.distance) * radius;
  const rng = stepRng(seed, `${streams}-coast`);
  const depth = Math.min(coast.depth, coast.depthShare * out);
  const half = 1.5 * reach;
  const raw = evened(Array.from({ length: coast.knots }, () => normal(rng) * depth), coast.smoothing);
  // The shore where the centre looks out to sea stays where it was drawn, so that the town is never in the water.
  const middle = ((raw[coast.knots / 2 - 1] ?? 0) + (raw[Math.floor(coast.knots / 2)] ?? 0)) / 2;
  // The brief's land routes are facts: where one leaves nearer the water's bearing than a straight shore allows,
  // the shore on that side runs out to sea beside it, and the town stands at the head of a bay.
  const slopes = { [-1]: 0, [1]: 0 } as Record<number, number>;
  for (const route of brief.routes) {
    if (route.kind === 'sea-route') continue;
    const way = bearingVector(route.bearing);
    const along = dot(way, alongShore);
    const off = (Math.atan2(Math.abs(along), dot(way, seaward)) * 180) / Math.PI - coast.clearAngle;
    if (off >= 90) continue;
    const slope = off <= 0 ? coast.steepest : Math.min(coast.steepest, 1 / Math.tan((off * Math.PI) / 180));
    const side = along >= 0 ? 1 : -1;
    slopes[side] = Math.max(slopes[side] as number, slope);
  }
  const knots = raw.map((value, at): Point => {
    const along = -half + (2 * half * at) / (coast.knots - 1);
    return add(add([0, 0], alongShore, along), seaward, out + value - middle + (slopes[along >= 0 ? 1 : -1] as number) * Math.abs(along));
  });
  const shore = chaikin(knots, 4);
  const length = polylineLength(shore);
  const first = shore[0] as Point;
  const last = shore[shore.length - 1] as Point;
  const polygon = [...shore, add(last, seaward, 3 * reach), add(first, seaward, 3 * reach)];
  return {
    seaward,
    alongShore,
    shore,
    length,
    polygon,
    gap(point) {
      const found = projectOnPolyline(shore, point);
      return dot([point[0] - found.point[0], point[1] - found.point[1]], seaward) > 0 ? -found.distance : found.distance;
    },
  };
}
