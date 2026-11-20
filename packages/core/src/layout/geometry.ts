/**
 * Plane geometry for layouts. Pure arithmetic on points, polylines and
 * polygons; nothing here assumes a grid or right angles.
 */
import type { Point } from '../schema.ts';

/** Lengths closer than this, in metres, count as equal. */
export const EPSILON = 1e-6;

export function distance(a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** The unit vector for a bearing in degrees clockwise from north, with y pointing south. */
export function bearingVector(bearing: number): Point {
  const radians = (bearing * Math.PI) / 180;
  return [Math.sin(radians), -Math.cos(radians)];
}

/** The smallest angle between two bearings, from 0 to 180 degrees. */
export function bearingDifference(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
}

/** The bearing from one point to another as a decimal number of degrees, from 0 up to 360. */
export function exactBearing(from: Point, to: Point): number {
  const degrees = (Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** The area enclosed by a polygon, whichever way round its points run. */
export function polygonArea(polygon: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

export function polygonCentroid(polygon: readonly Point[]): Point {
  let twice = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    const cross = a[0] * b[1] - b[0] * a[1];
    twice += cross;
    x += (a[0] + b[0]) * cross;
    y += (a[1] + b[1]) * cross;
  }
  if (Math.abs(twice) < EPSILON) return polygon[0] as Point;
  return [x / (3 * twice), y / (3 * twice)];
}

export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1] as Point, points[i] as Point);
  return total;
}

/** The point at a distance along a polyline from its start, held within its ends. */
export function pointAlongPolyline(points: readonly Point[], along: number): Point {
  let left = Math.max(along, 0);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const length = distance(a, b);
    if (left <= length && length > 0) return [a[0] + ((b[0] - a[0]) * left) / length, a[1] + ((b[1] - a[1]) * left) / length];
    left -= length;
  }
  return points[points.length - 1] as Point;
}

/** The part of a polyline between two distances along it, in the order given. */
export function slicePolyline(points: readonly Point[], from: number, to: number): Point[] {
  if (from > to) return slicePolyline(points, to, from).reverse();
  const result: Point[] = [pointAlongPolyline(points, from)];
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    walked += distance(points[i - 1] as Point, points[i] as Point);
    if (walked > from + EPSILON && walked < to - EPSILON) result.push(points[i] as Point);
  }
  result.push(pointAlongPolyline(points, to));
  return result;
}

/** The nearest point of a straight piece to a point. */
function nearestOnPiece(point: Point, a: Point, b: Point): { point: Point; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return { point: [a[0] + dx * t, a[1] + dy * t], t };
}

export function distanceToPiece(point: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  const x = a[0] + dx * t - point[0];
  const y = a[1] + dy * t - point[1];
  return Math.sqrt(x * x + y * y);
}

/** Where a point falls on a polyline: the nearest point of it, how far along that is, and how far away. */
export function projectOnPolyline(points: readonly Point[], point: Point): { point: Point; along: number; distance: number } {
  let best = { point: points[0] as Point, along: 0, distance: Infinity };
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const length = distance(a, b);
    const nearest = nearestOnPiece(point, a, b);
    const away = distance(point, nearest.point);
    if (away < best.distance) best = { point: nearest.point, along: walked + nearest.t * length, distance: away };
    walked += length;
  }
  return best;
}

export function distanceToPolyline(point: Point, points: readonly Point[]): number {
  return projectOnPolyline(points, point).distance;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Whether two straight pieces meet, including by touching at an end. */
export function piecesMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  return distanceBetweenPieces(a, b, c, d) <= EPSILON;
}

/** Whether two straight pieces cross at a point inside both, not merely touch or overlap along their length. */
export function piecesCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const scale = Math.max(distance(a, b) * distance(c, d), EPSILON);
  const tolerance = EPSILON * scale;
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > tolerance && d2 < -tolerance) || (d1 < -tolerance && d2 > tolerance)) && ((d3 > tolerance && d4 < -tolerance) || (d3 < -tolerance && d4 > tolerance));
}

export function distanceBetweenPieces(a: Point, b: Point, c: Point, d: Point): number {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distanceToPiece(a, c, d), distanceToPiece(b, c, d), distanceToPiece(c, a, b), distanceToPiece(d, a, b));
}

/** The pieces of an open polyline, or of a closed polygon. */
function* pieces(points: readonly Point[], closed: boolean): Generator<[Point, Point]> {
  for (let i = 1; i < points.length; i++) yield [points[i - 1] as Point, points[i] as Point];
  if (closed && points.length > 2) yield [points[points.length - 1] as Point, points[0] as Point];
}

export function distanceBetweenPolylines(a: readonly Point[], b: readonly Point[]): number {
  let best = Infinity;
  for (const [p, q] of pieces(a, false)) {
    for (const [r, s] of pieces(b, false)) best = Math.min(best, distanceBetweenPieces(p, q, r, s));
  }
  return best;
}

/** How many times a straight piece crosses a polyline. */
export function crossingsOfPolyline(a: Point, b: Point, points: readonly Point[]): number {
  let crossings = 0;
  for (const [p, q] of pieces(points, false)) if (piecesCross(a, b, p, q)) crossings++;
  return crossings;
}

export function distanceToPolygonEdge(point: Point, polygon: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const away = distanceToPiece(point, polygon[i] as Point, polygon[(i + 1) % polygon.length] as Point);
    if (away < best) best = away;
  }
  return best;
}

/** Whether a point is inside a polygon. A point on the edge counts as inside. */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  if (distanceToPolygonEdge(point, polygon) <= EPSILON) return true;
  return strictlyInside(point, polygon);
}

/** Whether a point is inside a polygon and not on its edge. */
export function strictlyInside(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  // A point on the edge may count either way above; it is not strictly inside.
  return inside && distanceToPolygonEdge(point, polygon) > EPSILON;
}

/** The distance from a polygon, edge and interior, to a polyline. Zero when they meet. */
export function distancePolygonToPolyline(polygon: readonly Point[], points: readonly Point[]): number {
  if (strictlyInside(points[0] as Point, polygon)) return 0;
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    for (let j = 1; j < points.length; j++) {
      const away = distanceBetweenPieces(a, b, points[j - 1] as Point, points[j] as Point);
      if (away < best) best = away;
    }
  }
  return best;
}

export function distanceBetweenPolygons(a: readonly Point[], b: readonly Point[]): number {
  if (strictlyInside(a[0] as Point, b) || strictlyInside(b[0] as Point, a)) return 0;
  let best = Infinity;
  for (const [p, q] of pieces(a, true)) {
    for (const [r, s] of pieces(b, true)) best = Math.min(best, distanceBetweenPieces(p, q, r, s));
  }
  return best;
}

/**
 * Whether two polygons share any area. Polygons that only touch, along an
 * edge or at a corner, do not overlap.
 */
export function polygonsOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  // Shapes whose boxes share no area cannot overlap; this settles most neighbours at once.
  const boxA = boxOf(a);
  const boxB = boxOf(b);
  if (
    Math.min(boxA.maxX, boxB.maxX) - Math.max(boxA.minX, boxB.minX) <= EPSILON ||
    Math.min(boxA.maxY, boxB.maxY) - Math.max(boxA.minY, boxB.minY) <= EPSILON
  ) {
    return false;
  }
  for (const [p, q] of pieces(a, true)) {
    for (const [r, s] of pieces(b, true)) if (piecesCross(p, q, r, s)) return true;
  }
  // With no edges crossing, one lies inside the other or they are apart. Corners and
  // edge midpoints are tried as well as the centre, for shapes that share part of an outline.
  const probes = (polygon: readonly Point[]): Point[] => [
    // The centroid of a shape that is not convex can lie outside it, and then says nothing.
    ...[polygonCentroid(polygon)].filter((centre) => strictlyInside(centre, polygon)),
    ...polygon,
    ...[...pieces(polygon, true)].map(([p, q]): Point => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]),
  ];
  return probes(a).some((point) => strictlyInside(point, b)) || probes(b).some((point) => strictlyInside(point, a));
}

/** Whether a polygon lies within another, edges touching allowed. */
export function polygonWithin(inner: readonly Point[], outer: readonly Point[]): boolean {
  if (!inner.every((point) => pointInPolygon(point, outer))) return false;
  for (const [p, q] of pieces(inner, true)) {
    for (const [r, s] of pieces(outer, true)) if (piecesCross(p, q, r, s)) return false;
  }
  return true;
}

/** The length of outline that two polygons have in common. Zero when they are apart or meet only at corners. */
export function sharedBoundaryLength(a: readonly Point[], b: readonly Point[]): number {
  let shared = 0;
  for (const [p, q] of pieces(a, true)) {
    const length = distance(p, q);
    if (length <= EPSILON) continue;
    const ux = (q[0] - p[0]) / length;
    const uy = (q[1] - p[1]) / length;
    for (const [r, s] of pieces(b, true)) {
      // The two pieces must lie on one line.
      if (Math.abs(cross(p, q, r)) > EPSILON * length || Math.abs(cross(p, q, s)) > EPSILON * length) continue;
      const t1 = (r[0] - p[0]) * ux + (r[1] - p[1]) * uy;
      const t2 = (s[0] - p[0]) * ux + (s[1] - p[1]) * uy;
      shared += Math.max(0, Math.min(length, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)));
    }
  }
  return shared;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boxOf(points: readonly Point[], margin = 0): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
}

/**
 * Finds things near other things without comparing every pair: items are
 * filed under the squares their box covers.
 */
export class SpatialIndex<T> {
  private readonly cell: number;
  private readonly squares = new Map<string, T[]>();

  constructor(cell: number) {
    this.cell = cell;
  }

  private *keys(box: Box): Generator<string> {
    for (let x = Math.floor(box.minX / this.cell); x <= Math.floor(box.maxX / this.cell); x++) {
      for (let y = Math.floor(box.minY / this.cell); y <= Math.floor(box.maxY / this.cell); y++) yield `${x}:${y}`;
    }
  }

  add(box: Box, item: T): void {
    for (const key of this.keys(box)) {
      const list = this.squares.get(key);
      if (list) list.push(item);
      else this.squares.set(key, [item]);
    }
  }

  /** Every item whose box may meet the given box, each once. */
  near(box: Box): Set<T> {
    const found = new Set<T>();
    for (const key of this.keys(box)) for (const item of this.squares.get(key) ?? []) found.add(item);
    return found;
  }
}
