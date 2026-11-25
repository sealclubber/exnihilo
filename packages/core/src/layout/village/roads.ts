/**
 * Step 2 of the village generator: the road.
 *
 * Each land route of the brief is a road from the centre to its exit, a road's
 * width wide, straying aside as a highway does. Two exits more than `through`
 * degrees apart, the farthest apart first, are one through road; any other is
 * an arm from the centre. A village of two exits that are not opposite has
 * one road all the same, bending at the centre. Where a road crosses the stream it has a small
 * bridge; where it would run into the sea it stops at the shore.
 */
import type { Rng } from '../../city/random.ts';
import type { VillageSettings } from '../../pack/schema.ts';
import type { Point, SettlementBrief } from '../../schema.ts';
import { bearingDifference, bearingVector, pointAlongPolyline, polylineLength, projectOnPolyline } from '../geometry.ts';
import { add, crossingsAlong, dot, resmooth, stray, tangentAt, unit } from '../staged/lines.ts';
import type { Coast, River } from '../staged/water.ts';

export interface Way {
  /** `road`: one of the brief's routes, or the village's own road where it has none. `lane`: everything else. */
  kind: 'road' | 'lane';
  points: Point[];
  width: number;
  /** The brief's routes it carries, by their place in the brief. */
  routes: number[];
}

export interface Bridge {
  /** The way it carries, by its place in the plan, and where along the way the stream's centre line is. */
  way: number;
  along: number;
  /** Its two ends on the way, and where it crosses the stream's centre line. */
  a: Point;
  b: Point;
  centre: Point;
}

export interface RoadInput {
  brief: SettlementBrief;
  settings: VillageSettings;
  rng: Rng;
  river?: River;
  coast?: Coast;
}

const CENTRE: Point = [0, 0];
/** How finely a road is walked when its meeting with the shore is looked for, in metres. */
const SHORE_STEP = 4;
/** The most a bridge reaches either way from the stream's centre line, in metres. */
const BRIDGE_MOST = 200;

export function layRoads({ brief, settings, rng, river, coast }: RoadInput): { ways: Way[]; bridges: Bridge[]; through: number; landExits: number; notes: string[] } {
  const notes: string[] = [];
  const width = settings.widths.road;
  const amplitude = settings.road.wander * settings.reach;
  const land = brief.routes.flatMap((route, at) => (route.kind === 'sea-route' ? [] : [{ at, bearing: route.bearing }]));

  // Pairs of exits far enough apart, the farthest apart first, are through roads.
  const pairs: Array<[number, number]> = [];
  const paired = new Set<number>();
  const candidates = land.flatMap((one, i) => land.slice(i + 1).map((other) => ({ a: one.at, b: other.at, apart: bearingDifference(one.bearing, other.bearing) })));
  candidates.sort((x, y) => y.apart - x.apart || x.a - y.a || x.b - y.b);
  for (const { a, b, apart } of candidates) {
    if (apart <= settings.road.through || paired.has(a) || paired.has(b)) continue;
    pairs.push([a, b]);
    paired.add(a);
    paired.add(b);
  }
  const through = pairs.length;
  // Two exits that are not opposite are still one road: a street with a bend at the centre.
  if (land.length === 2 && pairs.length === 0) {
    pairs.push([(land[0] as { at: number }).at, (land[1] as { at: number }).at]);
    for (const exit of land) paired.add(exit.at);
  }
  const arms = land.filter((exit) => !paired.has(exit.at)).map((exit) => exit.at);

  /** The half of a road from the centre to an exit on a bearing, stopped at the shore. */
  const half = (bearing: number, route: number | undefined): Point[] => {
    let points = stray(rng, CENTRE, add(CENTRE, bearingVector(bearing), settings.reach), amplitude);
    if (coast) {
      const length = polylineLength(points);
      for (let along = 0; along <= length; along += SHORE_STEP) {
        if (coast.gap(pointAlongPolyline(points, along)) >= width / 2 + SHORE_STEP) continue;
        points = cut(points, Math.max(along - SHORE_STEP, SHORE_STEP));
        notes.push(`${route === undefined ? 'the village road' : `route ${route} (${brief.routes[route]?.routeId})`} runs into the sea, and stops at the shore`);
        break;
      }
    }
    return points;
  };

  const ways: Way[] = [];
  for (const [a, b] of pairs) {
    const from = half((brief.routes[a] as { bearing: number }).bearing, a).reverse();
    const to = half((brief.routes[b] as { bearing: number }).bearing, b);
    ways.push({ kind: 'road', points: resmooth([...from, ...to.slice(1)], settings.road.step), width, routes: [a, b] });
  }
  // An arm leaves the first through road where it passes the centre: evened, that road may miss the centre by a little.
  const through0 = ways[0];
  for (const at of arms) {
    const points = half((brief.routes[at] as { bearing: number }).bearing, at);
    const meet = through0 ? projectOnPolyline(through0.points, CENTRE).point : undefined;
    ways.push({ kind: 'road', points: meet && Math.hypot(...meet) > 1e-6 ? [meet, ...points] : points, width, routes: [at] });
  }
  if (ways.length === 0) {
    // No land route: the village has a road of its own through the centre, along the shore where there is one.
    const bearing = brief.coast.waterBearing === undefined ? 0 : (brief.coast.waterBearing + 90) % 360;
    const from = half(bearing, undefined).reverse();
    const to = half((bearing + 180) % 360, undefined);
    ways.push({ kind: 'road', points: resmooth([...from, ...to.slice(1)], settings.road.step), width, routes: [] });
    notes.push('the brief has no land route, so the village has a road of its own through the centre');
  }

  // A small bridge wherever a road crosses the stream, as long as the stream is wide where it is crossed.
  const bridges: Bridge[] = [];
  if (river) {
    // A road whose far end lies in the stream, where the drawing ends, stops on dry land short of it.
    for (const way of ways) {
      for (const end of [0, 1]) {
        const line = end === 0 ? [...way.points].reverse() : way.points;
        const length = polylineLength(line);
        let along = length;
        while (along > length / 2 && river.gap(pointAlongPolyline(line, along)) < settings.bridge.beyond + width / 2) along -= SHORE_STEP;
        if (along === length) continue;
        const kept = cut(line, along);
        way.points = end === 0 ? kept.reverse() : kept;
        notes.push(`${way.routes.length > 0 ? `the road of route ${way.routes.map((at) => brief.routes[at]?.routeId).join(' and ')}` : 'the village road'} ends in the stream where the drawing ends, and stops short of it`);
      }
    }
    ways.forEach((way, index) => {
      const length = polylineLength(way.points);
      for (const along of crossingsAlong(way.points, river.line)) {
        const centre = pointAlongPolyline(way.points, along);
        const flow = river.at(river.nearest(centre).along).direction;
        const square = Math.max(Math.abs(dot(tangentAt(way.points, along, length), [-flow[1], flow[0]])), 0.3);
        // Out onto dry ground at each end, however slantwise the road crosses.
        let back = river.width / 2 / square + settings.bridge.beyond;
        let on = back;
        while (back < BRIDGE_MOST && river.gap(pointAlongPolyline(way.points, along - back)) < settings.bridge.beyond) back += SHORE_STEP;
        while (on < BRIDGE_MOST && river.gap(pointAlongPolyline(way.points, along + on)) < settings.bridge.beyond) on += SHORE_STEP;
        bridges.push({ way: index, along, a: pointAlongPolyline(way.points, Math.max(along - back, 0)), b: pointAlongPolyline(way.points, Math.min(along + on, length)), centre });
      }
    });
    if (bridges.length > 1) notes.push(`the roads cross the stream ${bridges.length} times, each with a bridge`);
  }
  return { ways, bridges, through, landExits: land.length, notes };
}

/** A line cut short at a distance along it. */
function cut(points: readonly Point[], along: number): Point[] {
  const out: Point[] = [points[0] as Point];
  let walked = 0;
  for (let at = 1; at < points.length; at++) {
    const step = Math.hypot((points[at] as Point)[0] - (points[at - 1] as Point)[0], (points[at] as Point)[1] - (points[at - 1] as Point)[1]);
    if (walked + step >= along) {
      out.push(add(points[at - 1] as Point, unit(points[at - 1] as Point, points[at] as Point), along - walked));
      return out;
    }
    walked += step;
    out.push(points[at] as Point);
  }
  return out;
}
