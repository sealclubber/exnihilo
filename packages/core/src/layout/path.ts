/**
 * Walking paths over a layout's street graph. The graph is the truth for
 * movement: a lot is left and reached through its entrance point on its
 * segment, and nothing here looks at shapes other than the segments' lines.
 */
import type { Point } from '../schema.ts';
import { distance, polylineLength, projectOnPolyline, slicePolyline } from './geometry.ts';
import { Heap } from './heap.ts';
import type { Layout, LayoutPath } from './records.ts';

export class LayoutPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutPathError';
  }
}

export interface PathFinder {
  /** The shortest walking path between two lots, from entrance point to entrance point. */
  path(fromLotId: string, toLotId: string): LayoutPath;
}

/** Prepares a layout for path queries. Use this when asking for more than one path. */
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
  const line = (segment: number) => (layout.segments[segment] as Layout['segments'][number]).points;

  return {
    path(fromLotId, toLotId) {
      const start = entrance(fromLotId);
      const goal = entrance(toLotId);
      const result = (segments: number[], length: number, points: Point[]): LayoutPath => ({
        fromLotId,
        toLotId,
        segmentIds: segments.map((segment) => (layout.segments[segment] as Layout['segments'][number]).id),
        length,
        // Drop points repeated where one segment ends and the next begins.
        points: points.filter((point, index) => index === 0 || distance(point, points[index - 1] as Point) > 0),
      });

      // Along the one segment, when both entrances are on it.
      let bestLength = start.segment === goal.segment ? Math.abs(start.along - goal.along) : Infinity;
      let bestEnd: number | undefined;

      // Or out through either end of the first segment, across the graph, and in through either end of the last.
      const cost = new Float64Array(layout.junctions.length).fill(Infinity);
      const cameBy = new Int32Array(layout.junctions.length).fill(-1);
      const heap = new Heap();
      const [startFrom, startTo] = ends[start.segment] as [number, number];
      const leave = (junction: number, walked: number) => {
        if (walked < (cost[junction] as number)) {
          cost[junction] = walked;
          heap.push(walked, junction);
        }
      };
      leave(startFrom, start.along);
      leave(startTo, (lengths[start.segment] as number) - start.along);
      const [goalFrom, goalTo] = ends[goal.segment] as [number, number];
      const lastLeg = (junction: number) => (junction === goalFrom ? goal.along : (lengths[goal.segment] as number) - goal.along);
      while (heap.size > 0) {
        const [walked, junction] = heap.pop();
        if (walked > (cost[junction] as number)) continue;
        if (walked >= bestLength) break;
        if (junction === goalFrom || junction === goalTo) {
          // A segment that joins a junction to itself has both ends here; take the shorter way in.
          const total = walked + (goalFrom === goalTo ? Math.min(goal.along, (lengths[goal.segment] as number) - goal.along) : lastLeg(junction));
          if (total < bestLength) {
            bestLength = total;
            bestEnd = junction;
          }
        }
        for (const way of ways[junction] as Array<{ to: number; segment: number }>) {
          const next = walked + (lengths[way.segment] as number);
          if (next < (cost[way.to] as number)) {
            cost[way.to] = next;
            cameBy[way.to] = way.segment;
            heap.push(next, way.to);
          }
        }
      }
      if (bestLength === Infinity) {
        throw new LayoutPathError(`no path joins ${fromLotId} and ${toLotId}: the street graph is not connected`);
      }
      if (bestEnd === undefined) {
        return result([start.segment], bestLength, slicePolyline(line(start.segment), start.along, goal.along));
      }

      // Walk back from the last junction to the first, then lay the pieces end to end.
      const crossed: number[] = [];
      let junction = bestEnd;
      while ((cameBy[junction] as number) >= 0) {
        const segment = cameBy[junction] as number;
        crossed.push(segment);
        const [from, to] = ends[segment] as [number, number];
        junction = junction === to ? from : to;
      }
      crossed.reverse();
      const points: Point[] = slicePolyline(line(start.segment), start.along, junction === startFrom ? 0 : (lengths[start.segment] as number));
      for (const segment of crossed) {
        const [from, to] = ends[segment] as [number, number];
        points.push(...(junction === from ? line(segment) : [...line(segment)].reverse()));
        junction = junction === from ? to : from;
      }
      const enterAt = bestEnd === goalFrom && (goalFrom !== goalTo || goal.along <= (lengths[goal.segment] as number) - goal.along) ? 0 : (lengths[goal.segment] as number);
      points.push(...slicePolyline(line(goal.segment), enterAt, goal.along));
      return result([start.segment, ...crossed, goal.segment], bestLength, points);
    },
  };
}

/** The shortest walking path between two lots. For many paths over one layout, use createPathFinder. */
export function shortestPath(layout: Layout, fromLotId: string, toLotId: string): LayoutPath {
  return createPathFinder(layout).path(fromLotId, toLotId);
}
