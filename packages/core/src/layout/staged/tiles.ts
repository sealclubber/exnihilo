/**
 * The ground about each block: a tile for every block, cut from one
 * partition of the town, so that no two tiles share ground and neighbours
 * meet along a common edge. A district's ground is the tiles of its blocks,
 * and two blocks are neighbours where their tiles touch.
 *
 * Ground is taken a little at a time, every block reaching a step further
 * in each round, so that the ground between two neighbours goes to them and
 * not to a third block further off.
 */
import type { Point } from '../../schema.ts';
import { SpatialIndex, boxOf, crossingsOfPolyline, distance, pointInPolygon, polygonArea } from '../geometry.ts';
import { grown, without } from './shapes.ts';

export interface Tiles {
  /** For each block, the pieces of its tile: plain outlines, the first holding the block. */
  rings: Point[][][];
  /** For each block, the blocks whose tiles touch its own. */
  beside: number[][];
}

/** Shapes with holes made plain outlines: each hole is joined to the outline round it by a slit that does not cross what must lie whole inside. */
export function plainly(rings: Point[][], holes: Point[][], keep: readonly Point[] = []): Point[][] {
  const out = rings.map((ring) => [...ring]);
  const crosses = (a: Point, b: Point, ring: readonly Point[]) => ring.some((point, at) => crossingsOfPolyline(a, b, [ring[(at + ring.length - 1) % ring.length] as Point, point]) > 0);
  for (const hole of holes) {
    const within = out.findIndex((ring) => pointInPolygon(hole[0] as Point, ring));
    if (within < 0) continue;
    const ring = out[within] as Point[];
    let best: { h: number; o: number; length: number } | undefined;
    hole.forEach((from, h) => ring.forEach((to, o) => {
      const length = distance(from, to);
      if (best && length >= best.length) return;
      if (keep.length > 0 && (crosses(from, to, keep) || pointInPolygon([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2], keep as Point[]))) return;
      best = { h, o, length };
    }));
    if (!best) continue;
    const { h, o } = best as { h: number; o: number; length: number };
    out[within] = [...ring.slice(0, o + 1), ...hole.slice(h), ...hole.slice(0, h + 1), ...ring.slice(o)];
  }
  return out;
}

/** Whether two outlines run along each other for more than a length, within a finger's breadth. */
export function touching(a: readonly Point[], b: readonly Point[], least = TOUCH, slack = 0.02): boolean {
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    const [p, q] = [a[j] as Point, a[i] as Point];
    const length = distance(p, q);
    if (length < least) continue;
    const [ux, uy] = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
    for (let k = 0, l = b.length - 1; k < b.length; l = k++) {
      const [r, t] = [b[l] as Point, b[k] as Point];
      if (Math.abs((r[0] - p[0]) * uy - (r[1] - p[1]) * ux) > slack || Math.abs((t[0] - p[0]) * uy - (t[1] - p[1]) * ux) > slack) continue;
      const [one, two] = [(r[0] - p[0]) * ux + (r[1] - p[1]) * uy, (t[0] - p[0]) * ux + (t[1] - p[1]) * uy];
      if (Math.min(length, Math.max(one, two)) - Math.max(0, Math.min(one, two)) > least) return true;
    }
  }
  return false;
}

export function tileBlocks(polygons: ReadonlyArray<readonly Point[]>, steps: readonly number[]): Tiles {
  const reach = Math.max(...steps, 0);
  const boxes = polygons.map((polygon) => boxOf(polygon, reach + 2));
  const index = new SpatialIndex<number>(Math.max(4 * reach, 20));
  boxes.forEach((box, at) => index.add(box, at));
  const near = polygons.map((_, at) => [...index.near(boxes[at] as ReturnType<typeof boxOf>)].filter((other) => other !== at).sort((a, b) => a - b));
  const rings: Point[][][] = polygons.map(() => []);
  // A block's own ground, and a hair beyond it, is never another's.
  const own = polygons.map((polygon) => grown([polygon], 0.5).rings);
  for (const step of steps) {
    polygons.forEach((polygon, at) => {
      const taken = (near[at] as number[]).flatMap((other) => [...(own[other] as Point[][]), ...(rings[other] as Point[][])]);
      const cut = without(grown([polygon], step).rings, [...taken, ...(rings[at] as Point[][])]);
      const more = plainly(cut.rings, cut.holes, polygon).filter((ring) => polygonArea(ring) > 0.5);
      // The first round's piece holds the block itself; later rounds add the ground beyond it, where it joins on.
      const had = rings[at] as Point[][];
      rings[at] = [...had, ...more.filter((ring) => had.length === 0 || had.some((piece) => touching(piece, ring) || touching(ring, piece)))];
    });
  }
  const beside: number[][] = polygons.map(() => []);
  polygons.forEach((_, at) => {
    for (const other of near[at] as number[]) {
      if (other < at) continue;
      const touch = (rings[at] as Point[][]).some((one) => (rings[other] as Point[][]).some((two) => touching(one, two) || touching(two, one)));
      if (!touch) continue;
      (beside[at] as number[]).push(other);
      (beside[other] as number[]).push(at);
    }
  });
  return { rings, beside };
}

/** How long a common edge two tiles must have to be neighbours, in metres. */
const TOUCH = 0.5;
