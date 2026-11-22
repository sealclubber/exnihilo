/**
 * A town's fabric: blocks scattered over the ground, with the gaps between
 * them as candidate streets. Points are scattered so that no two are too
 * close; each gets the ground nearer to it than to any other; and every
 * boundary between two such cells is a candidate street, every corner a
 * candidate junction. Nothing here knows where the centre is, so the streets
 * have no direction to fall into.
 *
 * Some points are fixed before the scatter, in pairs either side of a line
 * that a boundary should follow: a bank, a shore, a wall. The boundary between
 * the two of a pair lies midway, on the line.
 */
import { Delaunay } from 'd3-delaunay';
import type { Rng } from '../city/random.ts';
import type { Point } from '../schema.ts';
import { distance, polygonArea, polygonCentroid } from './geometry.ts';

/** A point a block grows from. */
export interface Seed {
  point: Point;
  /** Placed on purpose, and not moved when the scatter is evened out. */
  fixed?: true;
  /** In the water: its cell is no ground at all. */
  water?: true;
}

export interface FabricCell {
  id: number;
  seed: Seed;
  /** Its corners in order round it, and the edge from each corner to the next. */
  corners: number[];
  edges: number[];
  /** At the edge of the scattered ground, where cells are cut off by its bounds: never built on. */
  rim: boolean;
}

export interface FabricEdge {
  id: number;
  a: number;
  b: number;
  /** The one or two cells it lies between. */
  cells: number[];
}

export interface Fabric {
  corners: Point[];
  cells: FabricCell[];
  edges: FabricEdge[];
  /** The edges that meet at each corner. */
  around: number[][];
}

/** How many places are tried round a point before the scatter gives up on it. */
const TRIES = 18;

/**
 * Scatters points over a disc so that none is nearer another than the spacing at its place allows, starting from
 * the fixed points given. `blocked` says where no point may be.
 */
export function scatter(rng: Rng, radius: number, spacingAt: (point: Point) => number, blocked: (point: Point) => boolean, fixed: readonly Seed[]): Seed[] {
  const seeds: Seed[] = [...fixed];
  let least = Infinity;
  for (let ring = 0; ring <= 8; ring++) least = Math.min(least, spacingAt([(radius * ring) / 8, 0]));
  const square = least / Math.SQRT2;
  const filed = new Map<string, number[]>();
  const file = (index: number) => {
    const [x, y] = (seeds[index] as Seed).point;
    const key = `${Math.floor(x / square)}:${Math.floor(y / square)}`;
    const list = filed.get(key);
    if (list) list.push(index);
    else filed.set(key, [index]);
  };
  seeds.forEach((_, index) => file(index));
  const crowded = (point: Point, spacing: number) => {
    const reach = Math.ceil(spacing / square);
    const cx = Math.floor(point[0] / square);
    const cy = Math.floor(point[1] / square);
    for (let x = cx - reach; x <= cx + reach; x++) {
      for (let y = cy - reach; y <= cy + reach; y++) {
        for (const index of filed.get(`${x}:${y}`) ?? []) if (distance((seeds[index] as Seed).point, point) < spacing) return true;
      }
    }
    return false;
  };
  const active: number[] = seeds.map((_, index) => index);
  if (active.length === 0) {
    seeds.push({ point: [0, 0] });
    file(0);
    active.push(0);
  }
  while (active.length > 0) {
    const pick = Math.floor(rng.next() * active.length);
    const from = (seeds[active[pick] as number] as Seed).point;
    const spacing = spacingAt(from);
    let placed = false;
    for (let attempt = 0; attempt < TRIES; attempt++) {
      const angle = rng.next() * 2 * Math.PI;
      const away = spacing * (1 + rng.next());
      const point: Point = [from[0] + Math.cos(angle) * away, from[1] + Math.sin(angle) * away];
      if (Math.hypot(point[0], point[1]) > radius || blocked(point) || crowded(point, spacingAt(point))) continue;
      seeds.push({ point });
      file(seeds.length - 1);
      active.push(seeds.length - 1);
      placed = true;
      break;
    }
    if (!placed) {
      active[pick] = active[active.length - 1] as number;
      active.pop();
    }
  }
  return seeds;
}

/** The cells of a set of seeds, as closed outlines within a square of the given half-width; nothing for a seed that has none. */
function outlines(seeds: readonly Seed[], bound: number): Array<Point[] | undefined> {
  const delaunay = Delaunay.from(seeds.map((seed) => seed.point));
  const voronoi = delaunay.voronoi([-bound, -bound, bound, bound]);
  return seeds.map((_, index) => {
    const polygon = voronoi.cellPolygon(index) as Point[] | null;
    return polygon && polygon.length > 3 ? polygon.slice(0, -1) : undefined;
  });
}

/**
 * Builds the fabric of a set of seeds within a disc: evens the scatter out once, by moving every seed that is not
 * fixed to the middle of its cell, then takes the cells, their corners and the edges between them. Edges shorter
 * than `shortest` are closed up, their two ends becoming one corner. `blocked` says where no seed may be moved to.
 */
export function weave(seeds: readonly Seed[], radius: number, shortest: number, blocked: (point: Point) => boolean): Fabric {
  const bound = radius * 1.25;
  // One pass only: more makes honeycomb.
  const first = outlines(seeds, bound);
  const evened = seeds.map((seed, index): Seed => {
    const polygon = first[index];
    if (seed.fixed || !polygon || polygonArea(polygon) <= 0) return seed;
    const middle = polygonCentroid(polygon);
    return blocked(middle) ? seed : { ...seed, point: middle };
  });
  const polygons = outlines(evened, bound);

  // Corners that two cells give at the same place are one corner.
  const places = new Map<string, number>();
  const corners: Point[] = [];
  const cornerAt = (point: Point): number => {
    const key = `${Math.round(point[0] * 1e4)}:${Math.round(point[1] * 1e4)}`;
    let index = places.get(key);
    if (index === undefined) {
      index = corners.length;
      corners.push(point);
      places.set(key, index);
    }
    return index;
  };
  const rings = polygons.map((polygon) => (polygon ? polygon.map(cornerAt) : []));
  // Close up short edges: their ends become one corner, midway.
  const leader = corners.map((_, index) => index);
  const find = (index: number): number => {
    while (leader[index] !== index) {
      leader[index] = leader[leader[index] as number] as number;
      index = leader[index] as number;
    }
    return index;
  };
  for (const ring of rings) {
    ring.forEach((corner, at) => {
      const next = ring[(at + 1) % ring.length] as number;
      const [a, b] = [find(corner), find(next)];
      if (a !== b && distance(corners[a] as Point, corners[b] as Point) < shortest) {
        leader[b] = a;
        corners[a] = [((corners[a] as Point)[0] + (corners[b] as Point)[0]) / 2, ((corners[a] as Point)[1] + (corners[b] as Point)[1]) / 2];
      }
    });
  }
  const cells: FabricCell[] = [];
  const edges: FabricEdge[] = [];
  const edgeKeys = new Map<string, number>();
  const used = new Map<number, number>();
  const kept: Point[] = [];
  const keep = (corner: number): number => {
    const root = find(corner);
    let index = used.get(root);
    if (index === undefined) {
      index = kept.length;
      kept.push(corners[root] as Point);
      used.set(root, index);
    }
    return index;
  };
  rings.forEach((ring, seedIndex) => {
    const own = ring.map(keep).filter((corner, at, list) => corner !== list[(at + list.length - 1) % list.length]);
    if (own.length < 3) return;
    const id = cells.length;
    const rim = own.some((corner) => Math.max(Math.abs((kept[corner] as Point)[0]), Math.abs((kept[corner] as Point)[1])) > bound - 1e-6) || Math.hypot(...(evened[seedIndex] as Seed).point) > radius;
    const cell: FabricCell = { id, seed: evened[seedIndex] as Seed, corners: own, edges: [], rim };
    own.forEach((corner, at) => {
      const next = own[(at + 1) % own.length] as number;
      const key = corner < next ? `${corner}:${next}` : `${next}:${corner}`;
      let edge = edgeKeys.get(key);
      if (edge === undefined) {
        edge = edges.length;
        edges.push({ id: edge, a: Math.min(corner, next), b: Math.max(corner, next), cells: [] });
        edgeKeys.set(key, edge);
      }
      (edges[edge] as FabricEdge).cells.push(id);
      cell.edges.push(edge);
    });
    cells.push(cell);
  });
  const around: number[][] = kept.map(() => []);
  for (const edge of edges) {
    (around[edge.a] as number[]).push(edge.id);
    (around[edge.b] as number[]).push(edge.id);
  }
  return { corners: kept, cells, edges, around };
}
