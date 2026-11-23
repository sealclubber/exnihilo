/**
 * Line tools of the staged generator: lines that stray, are evened, and are
 * walked along. Pure; randomness comes from the stream passed in.
 */
import type { Rng } from '../../city/random.ts';
import type { Point } from '../../schema.ts';
import { distance, pointAlongPolyline, polylineLength } from '../geometry.ts';
import { chaikin, normal } from '../lines.ts';

export const add = (a: Point, b: Point, times = 1): Point => [a[0] + b[0] * times, a[1] + b[1] * times];
export const between = (a: Point, b: Point, share = 0.5): Point => [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share];
export const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
export const left = (a: Point): Point => [-a[1], a[0]];
export const size = (a: Point) => Math.hypot(a[0], a[1]);
export function unit(from: Point, to: Point): Point {
  const length = distance(from, to) || 1;
  return [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}
/** A draw between the two ends of a span. */
export const drawFrom = (rng: Rng, span: { min: number; max: number }) => span.min + (span.max - span.min) * rng.next();

/** Values evened with a bell `sigma` places wide, the row mirrored at its ends. */
export function evened(values: readonly number[], sigma: number): number[] {
  if (sigma <= 0) return [...values];
  const reach = Math.max(1, Math.round(4 * sigma));
  const count = values.length;
  const mirrored = (at: number) => {
    let index = at;
    while (index < 0 || index >= count) index = index < 0 ? -index - 1 : 2 * count - index - 1;
    return values[index] as number;
  };
  return values.map((_, at) => {
    let sum = 0;
    let weight = 0;
    for (let offset = -reach; offset <= reach; offset++) {
      const bell = Math.exp(-(offset * offset) / (2 * sigma * sigma));
      sum += bell * mirrored(at + offset);
      weight += bell;
    }
    return sum / weight;
  });
}

/** A line from one point to another that strays aside by about `amplitude` metres, least at its ends. */
export function stray(rng: Rng, from: Point, to: Point, amplitude: number, knots = 4): Point[] {
  const length = distance(from, to);
  if (length === 0) return [from, to];
  const across = left(unit(from, to));
  const count = knots + 2;
  const aside = evened(Array.from({ length: count }, () => normal(rng) * amplitude), 1).map((value, at) => value * Math.sin((Math.PI * at) / (count - 1)));
  return chaikin(aside.map((value, at) => add(between(from, to, at / (count - 1)), across, value)), 4);
}

/** A line walked in equal steps of about `step` metres and its corners rounded. The ends stay where they are. */
export function resmooth(points: readonly Point[], step: number): Point[] {
  const length = polylineLength(points);
  const count = Math.max(Math.floor(length / step), 3);
  return chaikin(Array.from({ length: count + 1 }, (_, at) => (at === count ? (points[points.length - 1] as Point) : pointAlongPolyline(points, (length * at) / count))), 3);
}

/** The direction a line runs at a distance along it, taken over ten metres either side. */
export function tangentAt(points: readonly Point[], along: number, length = polylineLength(points)): Point {
  return unit(pointAlongPolyline(points, Math.max(along - 10, 0)), pointAlongPolyline(points, Math.min(along + 10, length)));
}

/** A line without the points that repeat the one before. */
export function tidy(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || distance(last, point) > 1e-6) out.push([point[0], point[1]]);
  }
  return out;
}

/** Every point at which one line crosses another, as distances along the first. */
export function crossingsAlong(line: readonly Point[], other: readonly Point[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (let k = 1; k < line.length; k++) {
    const [a, b] = [line[k - 1] as Point, line[k] as Point];
    const piece = distance(a, b);
    for (let index = 1; index < other.length; index++) {
      const [c, d] = [other[index - 1] as Point, other[index] as Point];
      const denominator = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
      if (denominator === 0) continue;
      const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denominator;
      const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denominator;
      // Half-open, so that a crossing at a shared corner is counted once.
      if (t >= 0 && t < 1 && u >= 0 && u < 1) out.push(at + t * piece);
    }
    at += piece;
  }
  return out.sort((x, y) => x - y);
}

/** The ways roads leave the centre: for each highway that passes through it, the direction `probe` metres along, each way it runs. */
export function armsAt(roads: ReadonlyArray<readonly Point[]>, within: number, probe: number): Point[] {
  const arms: Point[] = [];
  for (const road of roads) {
    const length = polylineLength(road);
    let along = 0;
    let least = Infinity;
    let walked = 0;
    for (let k = 1; k < road.length; k++) {
      const [a, b] = [road[k - 1] as Point, road[k] as Point];
      const piece = distance(a, b);
      const t = piece === 0 ? 0 : Math.min(Math.max(-(a[0] * (b[0] - a[0]) + a[1] * (b[1] - a[1])) / (piece * piece), 0), 1);
      const away = Math.hypot(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      if (away < least) {
        least = away;
        along = walked + t * piece;
      }
      walked += piece;
    }
    if (least > within) continue;
    for (const sign of [1, -1]) {
      const room = sign > 0 ? length - along : along;
      if (room < probe / 2) continue;
      const point = pointAlongPolyline(road, along + sign * Math.min(probe, room));
      const far = Math.hypot(point[0], point[1]);
      if (far > 0) arms.push([point[0] / far, point[1] / far]);
    }
  }
  return arms;
}

/** A polygon of `sides` corners about a point, each corner up to `jitter` nearer or further, then sized to an area exactly. */
export function cornered(rng: Rng, centre: Point, wanted: number, sides: number, turn: number, jitter: number): Point[] {
  const raw = Array.from({ length: sides }, (_, k): Point => {
    const reach = 1 + (2 * rng.next() - 1) * jitter;
    const angle = turn + (2 * Math.PI * k) / sides;
    return [reach * Math.cos(angle), reach * Math.sin(angle)];
  });
  let twice = 0;
  raw.forEach((point, k) => {
    const next = raw[(k + 1) % sides] as Point;
    twice += point[0] * next[1] - next[0] * point[1];
  });
  const scale = Math.sqrt(wanted / (Math.abs(twice) / 2));
  return raw.map((point) => add(centre, point, scale));
}
