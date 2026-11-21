/**
 * Moving about outside: where on a lot's open ground a person is during a
 * stay out of doors.
 *
 * A wander is a sequence of points with the times at which the person is at
 * each, covering the whole stay. Between points the person moves in a
 * straight line; where two times share a point, they pause. So the position
 * at any game time is interpolation, and nothing is stepped. A wander is
 * drawn from a random stream of its own, so it never depends on what else
 * was worked out first.
 *
 * This reads the layout format only: a lot is a polygon, its footprints are
 * polygons, and the open ground is what is left.
 */
import type { Rng } from '../city/random.ts';
import { boxOf, distance, piecesMeet, pointInPolygon, projectOnPolyline, strictlyInside } from '../layout/geometry.ts';
import type { Lot } from '../layout/records.ts';
import type { Point } from '../schema.ts';
import type { Wander } from './records.ts';

/** The open ground is looked for on a grid of this many cells each way over the lot, and a finer one if that finds none. */
const GROUND_GRID = 8;
const FINER_GRID = 24;
/** How many places are tried for the next point of a wander before the person stays put a while longer. */
const PLACE_TRIES = 6;

/** How a person moves about when outside: a pace in metres per second, and how long they pause, in seconds. */
export interface WanderHabit {
  pace: number;
  pause: { min: number; max: number };
}

/** The open ground of a lot: everything in it that is not footprint. */
export interface Ground {
  /** Whether a point is on the open ground: in the lot and in no footprint. */
  holds(point: Point): boolean;
  /** Whether the straight line between two points of the open ground stays on it. */
  clear(a: Point, b: Point): boolean;
  /** A point of the open ground, drawn from the stream given; where there is no open ground, the fixed point at the frontage. */
  place(rng: Rng): Point;
  /** Whether the lot has any open ground to move about on. */
  open: boolean;
}

/** Where a person is on their wander at a game time. Before it begins they are at its first point; after it ends, at its last. */
export function positionOnWander(wander: Wander, time: number): Point {
  const { times, points } = wander;
  const last = times.length - 1;
  if (time <= (times[0] as number)) return points[0] as Point;
  if (time >= (times[last] as number)) return points[last] as Point;
  // The last waypoint reached.
  let low = 0;
  let high = last;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((times[middle] as number) <= time) low = middle;
    else high = middle - 1;
  }
  const [ax, ay] = points[low] as Point;
  const [bx, by] = points[low + 1] as Point;
  if (ax === bx && ay === by) return points[low] as Point;
  const share = (time - (times[low] as number)) / ((times[low + 1] as number) - (times[low] as number));
  return [ax + (bx - ax) * share, ay + (by - ay) * share];
}

/** The part of a wander between two game times, beginning and ending where the person is at those times. */
export function clipWander(wander: Wander, from: number, to: number): Wander {
  const { times, points } = wander;
  const first = times[0] as number;
  const last = times[times.length - 1] as number;
  if (from <= first && to >= last) return wander;
  const start = Math.min(Math.max(from, first), last);
  const end = Math.min(Math.max(to, start), last);
  const clipped: Wander = { times: [start], points: [positionOnWander(wander, start)] };
  for (let at = 0; at < times.length; at++) {
    const time = times[at] as number;
    if (time > start && time < end) {
      clipped.times.push(time);
      clipped.points.push(points[at] as Point);
    }
  }
  clipped.times.push(end);
  clipped.points.push(positionOnWander(wander, end));
  return clipped;
}

/** Works out a lot's open ground. */
export function groundOf(lot: Lot): Ground {
  const { polygon, footprints } = lot;
  const holds = (point: Point): boolean => strictlyInside(point, polygon) && !footprints.some((footprint) => pointInPolygon(point, footprint));
  const outlines = [polygon, ...footprints];
  const clear = (a: Point, b: Point): boolean => {
    for (const outline of outlines) {
      for (let i = 0; i < outline.length; i++) {
        if (piecesMeet(a, b, outline[i] as Point, outline[(i + 1) % outline.length] as Point)) return false;
      }
    }
    return true;
  };
  // The cells of a grid over the lot whose centres are on open ground.
  const box = boxOf(polygon);
  const cellsOf = (count: number) => {
    const width = (box.maxX - box.minX) / count;
    const height = (box.maxY - box.minY) / count;
    const centres: Point[] = [];
    for (let row = 0; row < count; row++) {
      for (let column = 0; column < count; column++) {
        const centre: Point = [box.minX + (column + 0.5) * width, box.minY + (row + 0.5) * height];
        if (holds(centre)) centres.push(centre);
      }
    }
    return { centres, width, height };
  };
  let cells = cellsOf(GROUND_GRID);
  if (cells.centres.length === 0) cells = cellsOf(FINER_GRID);
  // With no open ground, a person outside is at the lot's frontage: the point of its outline nearest its entrance.
  const frontage = projectOnPolyline([...polygon, polygon[0] as Point], lot.entrance.point).point;
  return {
    holds,
    clear,
    open: cells.centres.length > 0,
    place(rng) {
      if (cells.centres.length === 0) return frontage;
      const centre = cells.centres[rng.int(0, cells.centres.length - 1)] as Point;
      // Somewhere in the cell, if that is still on open ground; otherwise its centre, which is.
      const point: Point = [centre[0] + (rng.next() - 0.5) * cells.width, centre[1] + (rng.next() - 0.5) * cells.height];
      return holds(point) ? point : centre;
    },
  };
}

/**
 * A wander over a lot's open ground for a stay from `start` to `end`: pause, move to another point at the pace
 * given, pause again, until the stay ends. With a pace of zero, or no open ground, the person stays at one point.
 */
export function makeWander(ground: Ground, rng: Rng, start: number, end: number, habit: WanderHabit | undefined, from?: Point): Wander {
  // Someone who walked here begins where their walk ended; anyone else, somewhere on the ground.
  let here = from ?? ground.place(rng);
  const wander: Wander = { times: [start], points: [here] };
  const reach = (time: number, point: Point) => {
    wander.times.push(time);
    wander.points.push(point);
  };
  if (!habit || habit.pace <= 0 || !ground.open) {
    reach(end, here);
    return wander;
  }
  let now = start;
  while (now < end) {
    // Pause here.
    const until = Math.min(end, now + Math.max(1, Math.round(habit.pause.min + rng.next() * (habit.pause.max - habit.pause.min))));
    reach(until, here);
    now = until;
    if (now >= end) break;
    // Then somewhere else on the open ground that can be walked to in a straight line.
    let next: Point | undefined;
    for (let attempt = 0; attempt < PLACE_TRIES && !next; attempt++) {
      const candidate = ground.place(rng);
      if (ground.clear(here, candidate)) next = candidate;
    }
    if (!next) continue;
    // Whole seconds, rounded up, so the pace is never exceeded.
    const taken = Math.ceil(distance(here, next) / habit.pace);
    if (taken === 0) continue;
    if (now + taken > end) {
      // The stay ends on the way: as far as there is time for.
      const share = (end - now) / taken;
      reach(end, [here[0] + (next[0] - here[0]) * share, here[1] + (next[1] - here[1]) * share]);
      break;
    }
    reach(now + taken, next);
    here = next;
    now += taken;
  }
  return wander;
}

/**
 * A stretch of street as ground to move about on: the straight piece of a
 * segment's line that holds a point, as far as `reach` either way along it.
 * Keeping to one straight piece means that every position between two points
 * of a wander is on the segment too.
 */
export function streetGround(line: readonly Point[], centre: Point, reach: number): Ground & { centre: Point } {
  // The piece of the line nearest the point.
  let best = { piece: 0, distance: Infinity, point: line[0] as Point, share: 0 };
  for (let at = 1; at < line.length; at++) {
    const a = line[at - 1] as Point;
    const b = line[at] as Point;
    const found = projectOnPolyline([a, b], centre);
    if (found.distance < best.distance) best = { piece: at, distance: found.distance, point: found.point, share: found.along };
  }
  const a = line[Math.max(0, best.piece - 1)] as Point;
  const b = line[best.piece] as Point;
  const length = line.length > 1 ? distance(a, b) : 0;
  const from = Math.max(0, best.share - reach);
  const to = Math.min(length, best.share + reach);
  const at = (along: number): Point => (length === 0 ? a : [a[0] + ((b[0] - a[0]) * along) / length, a[1] + ((b[1] - a[1]) * along) / length]);
  return {
    centre: best.point,
    holds: (point) => projectOnPolyline([a, b], point).distance <= 1e-6,
    clear: () => true,
    open: to > from,
    place: (rng) => at(from + rng.next() * (to - from)),
  };
}
