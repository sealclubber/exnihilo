/**
 * Lines that wander, are smoothed, and are asked how far away they are.
 *
 * The grown generator lays its roads as lines before it lays any block, and
 * then asks of thousands of points which road is nearest and how far along it
 * they are. These are the tools for both. Pure: randomness comes from the
 * stream passed in.
 */
import type { Rng } from '../city/random.ts';
import type { Point } from '../schema.ts';
import { distance } from './geometry.ts';

/** A draw from the standard normal distribution. */
export function normal(rng: Rng): number {
  const u = Math.max(rng.next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

/** Rounds a line's corners off by cutting each a quarter of the way along its pieces, `rounds` times; the ends stay. */
export function chaikin(points: readonly Point[], rounds: number): Point[] {
  let line = points.map((point): Point => [point[0], point[1]]);
  for (let round = 0; round < rounds && line.length > 2; round++) {
    const next: Point[] = [line[0] as Point];
    for (let at = 1; at < line.length; at++) {
      const [a, b] = [line[at - 1] as Point, line[at] as Point];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    next.push(line[line.length - 1] as Point);
    line = next;
  }
  return line;
}

/**
 * A line from one point to another that strays aside by about `amplitude` metres, most in the middle and not at
 * all at the ends: `knots` points between the two are moved aside by chance, evened out, and the whole rounded.
 */
export function wander(rng: Rng, from: Point, to: Point, amplitude: number, knots = 6): Point[] {
  const length = distance(from, to);
  if (length === 0) return [from, to];
  const across: Point = [-(to[1] - from[1]) / length, (to[0] - from[0]) / length];
  const count = knots + 2;
  const raw = Array.from({ length: count }, (_, at) => normal(rng) * amplitude * Math.sin((Math.PI * at) / (count - 1)));
  // Evened out with a narrow bell, the ends held where they were.
  const kernel = [-2, -1, 0, 1, 2].map((offset) => Math.exp(-(offset * offset) / 2));
  const evened = raw.map((_, at) => {
    if (at === 0 || at === count - 1) return 0;
    let sum = 0;
    let weight = 0;
    kernel.forEach((share, index) => {
      const from = at + index - 2;
      if (from < 0 || from >= count) return;
      sum += share * (raw[from] as number);
      weight += share;
    });
    return sum / weight;
  });
  const line = evened.map((aside, at): Point => {
    const t = at / (count - 1);
    return [from[0] + (to[0] - from[0]) * t + across[0] * aside, from[1] + (to[1] - from[1]) * t + across[1] * aside];
  });
  return chaikin(line, 4);
}

/** How far along a line each of its points is. */
export function alongOf(points: readonly Point[]): number[] {
  const along = [0];
  for (let at = 1; at < points.length; at++) along.push((along[at - 1] as number) + distance(points[at - 1] as Point, points[at] as Point));
  return along;
}

/** The first point at which two lines cross, as a distance along the first, or nothing. */
export function firstCrossing(line: readonly Point[], other: readonly Point[], skip = 0): number | undefined {
  const along = alongOf(line);
  for (let at = 1; at < line.length; at++) {
    if ((along[at] as number) < skip) continue;
    const [a, b] = [line[at - 1] as Point, line[at] as Point];
    for (let index = 1; index < other.length; index++) {
      const [c, d] = [other[index - 1] as Point, other[index] as Point];
      const denominator = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
      if (denominator === 0) continue;
      const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denominator;
      const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denominator;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        const crossing = (along[at - 1] as number) + t * distance(a, b);
        if (crossing >= skip) return crossing;
      }
    }
  }
  return undefined;
}

/** What a line index says of the line nearest a point. */
export interface Nearest {
  /** Which line, as given when it was added. */
  line: number;
  distance: number;
  /** How far along that line the nearest point is, and the point. */
  along: number;
  point: Point;
  /** The unit direction of the line there. */
  direction: Point;
}

/** Lines filed by square, so that the one nearest a point is found without looking at them all. */
export class LineIndex {
  private readonly square: number;
  private readonly filed = new Map<number, Array<[number, number]>>();
  private readonly lines: Point[][] = [];
  private readonly alongs: number[][] = [];

  constructor(square = 50) {
    this.square = square;
  }

  private key(x: number, y: number): number {
    return (x + 32768) * 65536 + (y + 32768);
  }

  /** Adds a line; returns the number it is known by. */
  add(points: readonly Point[]): number {
    const id = this.lines.length;
    this.lines.push(points.map((point): Point => [point[0], point[1]]));
    this.alongs.push(alongOf(points));
    for (let at = 1; at < points.length; at++) {
      const [a, b] = [points[at - 1] as Point, points[at] as Point];
      for (let x = Math.floor(Math.min(a[0], b[0]) / this.square); x <= Math.floor(Math.max(a[0], b[0]) / this.square); x++) {
        for (let y = Math.floor(Math.min(a[1], b[1]) / this.square); y <= Math.floor(Math.max(a[1], b[1]) / this.square); y++) {
          const key = this.key(x, y);
          const list = this.filed.get(key);
          if (list) list.push([id, at]);
          else this.filed.set(key, [[id, at]]);
        }
      }
    }
    return id;
  }

  get size(): number {
    return this.lines.length;
  }

  line(id: number): Point[] {
    return this.lines[id] as Point[];
  }

  /**
   * The nearest line to a point, among those `keep` allows, looking no further than `reach` metres; nothing if
   * none is that near.
   */
  nearest(point: Point, reach = Infinity, keep?: (line: number) => boolean): Nearest | undefined {
    const cx = Math.floor(point[0] / this.square);
    const cy = Math.floor(point[1] / this.square);
    let best: { line: number; piece: number; t: number; squared: number } | undefined;
    const rings = Math.min(4096, Math.ceil(reach / this.square) + 1);
    for (let ring = 0; ring <= rings; ring++) {
      if (best && Math.sqrt(best.squared) < (ring - 1) * this.square) break;
      for (let x = cx - ring; x <= cx + ring; x++) {
        for (let y = cy - ring; y <= cy + ring; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
          for (const [line, piece] of this.filed.get(this.key(x, y)) ?? []) {
            if (keep && !keep(line)) continue;
            const points = this.lines[line] as Point[];
            const [a, b] = [points[piece - 1] as Point, points[piece] as Point];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const squaredLength = dx * dx + dy * dy;
            const t = squaredLength === 0 ? 0 : Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / squaredLength));
            const ox = a[0] + dx * t - point[0];
            const oy = a[1] + dy * t - point[1];
            const squared = ox * ox + oy * oy;
            if (!best || squared < best.squared || (squared === best.squared && (line < best.line || (line === best.line && piece < best.piece)))) best = { line, piece, t, squared };
          }
        }
      }
      if (ring > 64 && !best && this.filed.size === 0) break;
    }
    if (!best || Math.sqrt(best.squared) > reach) return undefined;
    const points = this.lines[best.line] as Point[];
    const along = this.alongs[best.line] as number[];
    const [a, b] = [points[best.piece - 1] as Point, points[best.piece] as Point];
    const length = distance(a, b) || 1;
    return {
      line: best.line,
      distance: Math.sqrt(best.squared),
      along: (along[best.piece - 1] as number) + best.t * length,
      point: [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t],
      direction: [(b[0] - a[0]) / length, (b[1] - a[1]) / length],
    };
  }
}
