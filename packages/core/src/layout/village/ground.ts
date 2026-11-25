/**
 * What is already on a village's ground, and whether a new plot, site or lane
 * would be clear of it: the water, every way's roadway, and every plot and
 * site placed so far. Shared by the steps that place things one at a time.
 */
import type { Point } from '../../schema.ts';
import { type Box, SpatialIndex, boxOf, distancePolygonToPolyline, pointAlongPolyline, polygonsOverlap, polylineLength, projectOnPolyline } from '../geometry.ts';
import { add, left, tangentAt, unit } from '../staged/lines.ts';
import type { Coast, River } from '../staged/water.ts';
import type { Way } from './roads.ts';

/** How far a plot or site keeps from the water's edge, in metres. */
export const DRY = 0.5;
/** The points an outline is tested at for water: its corners and the points between, this many to a side. */
const PER_SIDE = 4;
/** Ways and outlines are indexed in squares of this many metres. */
const CELL = 40;

/** A rectangle from a corner, `width` along `u` and `depth` along `v`. */
export const rectAt = (corner: Point, u: Point, v: Point, width: number, depth: number): Point[] => [corner, add(corner, u, width), add(add(corner, u, width), v, depth), add(corner, v, depth)];

export interface Fronted {
  outline: Point[];
  front: [Point, Point];
  /** Along the front, and into the plot. */
  u: Point;
  v: Point;
}

export class Ground {
  readonly ways: Way[];
  private readonly lengths = new Map<Way, number>();
  private readonly wayBoxes = new Map<Way, Box>();
  private outlines = new SpatialIndex<Point[]>(CELL);
  /** Which outlines are plots, which a lane may take away to be laid again; the rest are anchors. */
  private readonly plots = new Set<Point[]>();
  private readonly all: Point[][] = [];
  private readonly river: River | undefined;
  private readonly coast: Coast | undefined;

  constructor(ways: readonly Way[], river?: River, coast?: Coast) {
    this.ways = [...ways];
    this.river = river;
    this.coast = coast;
  }

  lengthOf(way: Way): number {
    let length = this.lengths.get(way);
    if (length === undefined) this.lengths.set(way, (length = polylineLength(way.points)));
    return length;
  }

  private boxOfWay(way: Way): Box {
    let box = this.wayBoxes.get(way);
    if (!box) this.wayBoxes.set(way, (box = boxOf(way.points, way.width)));
    return box;
  }

  addWay(way: Way): number {
    this.ways.push(way);
    return this.ways.length - 1;
  }

  occupy(outline: Point[], plot = false): void {
    this.outlines.add(boxOf(outline), outline);
    this.all.push(outline);
    if (plot) this.plots.add(outline);
  }

  /** Takes plots away, so that their ground is free again. */
  release(outlines: ReadonlySet<Point[]>): void {
    if (outlines.size === 0) return;
    this.outlines = new SpatialIndex<Point[]>(CELL);
    const kept = this.all.filter((outline) => !outlines.has(outline));
    this.all.length = 0;
    for (const outline of kept) {
      this.outlines.add(boxOf(outline), outline);
      this.all.push(outline);
    }
    for (const outline of outlines) this.plots.delete(outline);
  }

  /** What a way of a width keeping `gap` from things would run into: plots, and whether it meets an anchor. */
  blockers(points: readonly Point[], width: number, gap: number): { plots: Point[][]; anchor: boolean } {
    const plots: Point[][] = [];
    let anchor = false;
    for (const other of this.outlines.near(boxOf(points, width / 2 + gap))) {
      if (distancePolygonToPolyline(other, points) >= width / 2 + gap) continue;
      if (this.plots.has(other)) plots.push(other);
      else anchor = true;
    }
    return { plots, anchor };
  }

  /** Whether points are all more than `margin` from the water. */
  dry(points: readonly Point[], margin: number): boolean {
    return points.every((point) => (!this.river || this.river.gap(point) > margin) && (!this.coast || this.coast.gap(point) > margin));
  }

  /** Whether an outline is clear of the water, every way's roadway and everything placed. */
  free(outline: readonly Point[], margin = DRY): boolean {
    if (!this.dry(probes(outline), margin)) return false;
    const box = boxOf(outline);
    for (const way of this.ways) {
      const reach = this.boxOfWay(way);
      if (reach.minX > box.maxX || reach.maxX < box.minX || reach.minY > box.maxY || reach.maxY < box.minY) continue;
      if (distancePolygonToPolyline(outline, way.points) < way.width / 2 - 0.05) return false;
    }
    for (const other of this.outlines.near(box)) if (polygonsOverlap(outline, other)) return false;
    return true;
  }

  /** Whether a way of a width would be clear of the water and of everything placed, keeping `gap` from it. */
  clearLine(points: readonly Point[], width: number, gap: number): boolean {
    if (!this.dry(points, width / 2 + DRY)) return false;
    for (const other of this.outlines.near(boxOf(points, width / 2 + gap))) if (distancePolygonToPolyline(other, points) < width / 2 + gap) return false;
    return true;
  }

  /** The nearest point of any way, and which way. */
  nearestWay(point: Point, among: readonly Way[] = this.ways): { way: Way; point: Point; along: number; distance: number } | undefined {
    let best: { way: Way; point: Point; along: number; distance: number } | undefined;
    for (const way of among) {
      const found = projectOnPolyline(way.points, point);
      if (!best || found.distance < best.distance) best = { way, point: found.point, along: found.along, distance: found.distance };
    }
    return best;
  }
}

/** Points along an outline, for testing against water. */
function probes(outline: readonly Point[]): Point[] {
  return outline.flatMap((corner, at) => {
    const next = outline[(at + 1) % outline.length] as Point;
    const length = Math.hypot(next[0] - corner[0], next[1] - corner[1]);
    return Array.from({ length: PER_SIDE }, (_, k) => add(corner, unit(corner, next), (k / PER_SIDE) * length));
  });
}

/** A plot fronting a way: from `along` for `width` metres along it, on one side, `depth` deep, `gap` back from the way's edge. */
export function plotAt(way: Way, length: number, along: number, side: 1 | -1, width: number, depth: number, gap: number): Fronted | undefined {
  const end = along + width;
  if (along < 0 || end > length) return undefined;
  const [a, b] = [pointAlongPolyline(way.points, along), pointAlongPolyline(way.points, end)];
  const across = (at: number): Point => {
    const normal = left(tangentAt(way.points, at, length));
    return [normal[0] * side, normal[1] * side];
  };
  const [na, nb] = [across(along), across(end)];
  const off = way.width / 2 + gap;
  const front: [Point, Point] = [add(a, na, off), add(b, nb, off)];
  const outline = [front[0], front[1], add(b, nb, off + depth), add(a, na, off + depth)];
  const u = unit(front[0], front[1]);
  const v = unit([0, 0], [na[0] + nb[0], na[1] + nb[1]]);
  return { outline, front, u, v };
}
