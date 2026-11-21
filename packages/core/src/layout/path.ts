/**
 * Walking paths over a layout's street graph. The graph is the truth for
 * movement: a lot is left and reached through its entrance point on its
 * segment, and nothing here looks at shapes other than the segments' lines.
 */
import type { Point } from '../schema.ts';
import { distance, polylineLength, projectOnPolyline, slicePolyline } from './geometry.ts';
import { Heap } from './heap.ts';
import type { Layout, LayoutPath, StreetPath, StreetPosition } from './records.ts';

export class LayoutPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutPathError';
  }
}

export interface PathFinder {
  /** The shortest walking path between two lots, from entrance point to entrance point. */
  path(fromLotId: string, toLotId: string): LayoutPath;
  /**
   * The shortest walking path between any two positions on the street graph. Each is a segment and a
   * point, which is taken to the nearest point of that segment's line. Both may lie on the same segment.
   */
  between(from: StreetPosition, to: StreetPosition): StreetPath;
  /** Where a lot is on the graph: its entrance. */
  positionOfLot(lotId: string): StreetPosition;
  /** The nearest point of the nearest segment to any point of the map. */
  nearestPosition(point: Point): StreetPosition;
}

/**
 * Prepares a layout for path queries. Use this when asking for more than one
 * path: it keeps a table of distances for each junction paths leave through,
 * and every path it has found, so repeated and similar queries are cheap.
 */
export function createPathFinder(layout: Layout): PathFinder {
  const junctionIndex = new Map(layout.junctions.map((junction, index) => [junction.id, index]));
  const segmentIndex = new Map(layout.segments.map((segment, index) => [segment.id, index]));
  const lengths = layout.segments.map((segment) => polylineLength(segment.points));
  const ends = layout.segments.map((segment): [number, number] => {
    const from = junctionIndex.get(segment.fromJunctionId);
    const to = junctionIndex.get(segment.toJunctionId);
    if (from === undefined || to === undefined) throw new LayoutPathError(`${segment.id} names a junction that does not exist`);
    return [from, to];
  });
  /** For each junction, the segments that leave it and where they lead. */
  const ways: Array<Array<{ to: number; segment: number }>> = layout.junctions.map(() => []);
  ends.forEach(([from, to], segment) => {
    (ways[from] as Array<{ to: number; segment: number }>).push({ to, segment });
    (ways[to] as Array<{ to: number; segment: number }>).push({ to: from, segment });
  });
  interface Place {
    segment: number;
    along: number;
  }
  const lots = new Map(layout.lots.map((lot) => [lot.id, lot]));
  /** Where a lot's entrance is: its segment, and how far along it from the segment's first junction. */
  const entrance = (lotId: string) => {
    const lot = lots.get(lotId);
    if (!lot) throw new LayoutPathError(`there is no lot with the ID "${lotId}"`);
    const segment = segmentIndex.get(lot.entrance.segmentId);
    if (segment === undefined) throw new LayoutPathError(`${lot.id} opens onto ${lot.entrance.segmentId}, which does not exist`);
    const along = projectOnPolyline((layout.segments[segment] as Layout['segments'][number]).points, lot.entrance.point).along;
    return { segment, along, point: lot.entrance.point };
  };
  /** Where a street position is: its segment, and how far along it the nearest point of the line is. */
  const place = (position: StreetPosition): Place => {
    const segment = segmentIndex.get(position.segmentId);
    if (segment === undefined) throw new LayoutPathError(`there is no segment with the ID "${position.segmentId}"`);
    return { segment, along: projectOnPolyline((layout.segments[segment] as Layout['segments'][number]).points, position.point).along };
  };
  const line = (segment: number) => (layout.segments[segment] as Layout['segments'][number]).points;

  /**
   * Lookup tables, made once per junction the first time a path leaves through it: the
   * distance from that junction to every other, and the segment by which each is reached.
   */
  const trees = new Map<number, { cost: Float64Array; cameBy: Int32Array }>();
  const treeFrom = (source: number) => {
    let tree = trees.get(source);
    if (tree) return tree;
    const cost = new Float64Array(layout.junctions.length).fill(Infinity);
    const cameBy = new Int32Array(layout.junctions.length).fill(-1);
    const heap = new Heap();
    cost[source] = 0;
    heap.push(0, source);
    while (heap.size > 0) {
      const [walked, junction] = heap.pop();
      if (walked > (cost[junction] as number)) continue;
      for (const way of ways[junction] as Array<{ to: number; segment: number }>) {
        const next = walked + (lengths[way.segment] as number);
        if (next < (cost[way.to] as number)) {
          cost[way.to] = next;
          cameBy[way.to] = way.segment;
          heap.push(next, way.to);
        }
      }
    }
    tree = { cost, cameBy };
    trees.set(source, tree);
    return tree;
  };
  /** The shortest way from one place on the graph to another. `what` names the two ends, for the error. */
  const route = (start: Place, goal: Place, what: () => string): StreetPath => {
    const startLength = lengths[start.segment] as number;
    const goalLength = lengths[goal.segment] as number;
    const result = (segments: number[], walked: number[], length: number, points: Point[]): StreetPath => ({
      segmentIds: segments.map((segment) => (layout.segments[segment] as Layout['segments'][number]).id),
      walked,
      length,
      // Drop points repeated where one segment ends and the next begins.
      points: points.filter((point, index) => index === 0 || distance(point, points[index - 1] as Point) > 0),
    });

    // Along the one segment, when both ends are on it.
    let bestLength = start.segment === goal.segment ? Math.abs(start.along - goal.along) : Infinity;
    let best: { leave: number; enter: number } | undefined;
    // Or out through either end of the first segment, across the graph, and in through either end of the last.
    const [startFrom, startTo] = ends[start.segment] as [number, number];
    const [goalFrom, goalTo] = ends[goal.segment] as [number, number];
    for (const [leave, out] of [[startFrom, start.along], [startTo, startLength - start.along]] as const) {
      const tree = treeFrom(leave);
      for (const [enter, into] of [[goalFrom, goal.along], [goalTo, goalLength - goal.along]] as const) {
        const total = out + (tree.cost[enter] as number) + into;
        if (total < bestLength) {
          bestLength = total;
          best = { leave, enter };
        }
      }
    }
    if (bestLength === Infinity) {
      throw new LayoutPathError(`no path joins ${what()}: the street graph is not connected`);
    }
    if (!best) {
      return result([start.segment], [bestLength], bestLength, slicePolyline(line(start.segment), start.along, goal.along));
    }

    // Walk back from the junction entered to the junction left by, then lay the pieces end to end.
    const { cameBy } = treeFrom(best.leave);
    const crossed: number[] = [];
    let junction = best.enter;
    while (junction !== best.leave) {
      const segment = cameBy[junction] as number;
      crossed.push(segment);
      const [from, to] = ends[segment] as [number, number];
      junction = junction === to ? from : to;
    }
    crossed.reverse();
    const outBy = best.leave === startFrom && (startFrom !== startTo || start.along <= startLength - start.along) ? 0 : startLength;
    const points: Point[] = slicePolyline(line(start.segment), start.along, outBy);
    for (const segment of crossed) {
      const [from, to] = ends[segment] as [number, number];
      points.push(...(junction === from ? line(segment) : [...line(segment)].reverse()));
      junction = junction === from ? to : from;
    }
    const inBy = best.enter === goalFrom && (goalFrom !== goalTo || goal.along <= goalLength - goal.along) ? 0 : goalLength;
    points.push(...slicePolyline(line(goal.segment), inBy, goal.along));
    return result(
      [start.segment, ...crossed, goal.segment],
      [Math.abs(start.along - outBy), ...crossed.map((segment) => lengths[segment] as number), Math.abs(goal.along - inBy)],
      bestLength,
      points,
    );
  };
  const found = new Map<string, LayoutPath>();

  return {
    path(fromLotId, toLotId) {
      const key = `${fromLotId}>${toLotId}`;
      const known = found.get(key);
      if (known) return known;
      const walk = route(entrance(fromLotId), entrance(toLotId), () => `${fromLotId} and ${toLotId}`);
      const path: LayoutPath = { fromLotId, toLotId, ...walk };
      found.set(key, path);
      return path;
    },

    between(from, to) {
      return route(place(from), place(to), () => `${from.segmentId} and ${to.segmentId}`);
    },

    positionOfLot(lotId) {
      const { segment, point } = entrance(lotId);
      return { segmentId: (layout.segments[segment] as Layout['segments'][number]).id, point };
    },

    nearestPosition(point) {
      let best: StreetPosition | undefined;
      let nearest = Infinity;
      for (const segment of layout.segments) {
        const found = projectOnPolyline(segment.points, point);
        if (found.distance < nearest) {
          nearest = found.distance;
          best = { segmentId: segment.id, point: found.point };
        }
      }
      if (!best) throw new LayoutPathError('the layout has no segments to stand on');
      return best;
    },
  };
}

/** The shortest walking path between two lots. For many paths over one layout, use createPathFinder. */
export function shortestPath(layout: Layout, fromLotId: string, toLotId: string): LayoutPath {
  return createPathFinder(layout).path(fromLotId, toLotId);
}
