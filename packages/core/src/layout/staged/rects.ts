/**
 * Rectangles against blocks, tested directly: a house is a rectangle on a
 * block's edge, and whether it lies inside the block and clear of its
 * neighbours is plain arithmetic, with no polygon library called per house.
 */
import type { Point } from '../../schema.ts';

/** A rectangle by its front left corner, the unit vectors along its front and back from it, and its width and depth. */
export interface Rect {
  corner: Point;
  along: Point;
  inward: Point;
  width: number;
  depth: number;
}

/** Its corners: the two at the front, then the two at the back. */
export function cornersOf(rect: Rect): [Point, Point, Point, Point] {
  const { corner: [x, y], along: [tx, ty], inward: [nx, ny], width, depth } = rect;
  return [[x, y], [x + tx * width, y + ty * width], [x + tx * width + nx * depth, y + ty * width + ny * depth], [x + nx * depth, y + ny * depth]];
}

/** The same rectangle with every side moved out by so many metres. */
export function widenedRect(rect: Rect, by: number): Rect {
  return { ...rect, corner: [rect.corner[0] - (rect.along[0] + rect.inward[0]) * by, rect.corner[1] - (rect.along[1] + rect.inward[1]) * by], width: rect.width + 2 * by, depth: rect.depth + 2 * by };
}

/** A polygon made ready for many tests: its edges, with the box about it. */
export interface Outline {
  ring: Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function outlineOf(ring: Point[]): Outline {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { ring, minX, minY, maxX, maxY };
}

function within(point: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[i] as Point, ring[j] as Point];
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

const turn = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function cross(a: Point, b: Point, c: Point, d: Point): boolean {
  const [d1, d2, d3, d4] = [turn(c, d, a), turn(c, d, b), turn(a, b, c), turn(a, b, d)];
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Whether a rectangle lies wholly inside a polygon: every corner inside, and no side of the polygon through it. */
export function rectInside(rect: Rect, outline: Outline): boolean {
  const corners = cornersOf(rect);
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const corner of corners) {
    if (corner[0] < outline.minX || corner[0] > outline.maxX || corner[1] < outline.minY || corner[1] > outline.maxY) return false;
    minX = Math.min(minX, corner[0]);
    maxX = Math.max(maxX, corner[0]);
    minY = Math.min(minY, corner[1]);
    maxY = Math.max(maxY, corner[1]);
  }
  for (const corner of corners) if (!within(corner, outline.ring)) return false;
  const { ring } = outline;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[j] as Point, ring[i] as Point];
    if (Math.max(a[0], b[0]) < minX || Math.min(a[0], b[0]) > maxX || Math.max(a[1], b[1]) < minY || Math.min(a[1], b[1]) > maxY) continue;
    for (let k = 0; k < 4; k++) if (cross(a, b, corners[k] as Point, corners[(k + 1) % 4] as Point)) return false;
    // A corner of the polygon inside the rectangle: the polygon turns within it.
    const [dx, dy] = [b[0] - rect.corner[0], b[1] - rect.corner[1]];
    const [u, v] = [dx * rect.along[0] + dy * rect.along[1], dx * rect.inward[0] + dy * rect.inward[1]];
    if (u > 0 && u < rect.width && v > 0 && v < rect.depth) return false;
  }
  return true;
}

/** A rectangle made ready for many tests against others: its middle, how far its corners lie from it, and its extent along its own two directions. */
export interface Standing {
  rect: Rect;
  x: number;
  y: number;
  reach: number;
}

export function standingOf(rect: Rect): Standing {
  return {
    rect,
    x: rect.corner[0] + (rect.along[0] * rect.width + rect.inward[0] * rect.depth) / 2,
    y: rect.corner[1] + (rect.along[1] * rect.width + rect.inward[1] * rect.depth) / 2,
    reach: Math.hypot(rect.width, rect.depth) / 2,
  };
}

/** Whether two rectangles overlap, by looking for a line that parts them. */
export function standingOverlap(a: Standing, b: Standing): boolean {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const apart = a.reach + b.reach;
  if (dx * dx + dy * dy >= apart * apart) return false;
  // Along each of the four directions, the middles must be nearer than the two half-extents together.
  for (const [one, other] of [[a.rect, b.rect], [b.rect, a.rect]] as const) {
    for (const [axis, half] of [[one.along, one.width / 2], [one.inward, one.depth / 2]] as const) {
      const between = Math.abs(dx * axis[0] + dy * axis[1]);
      const reach = half + (Math.abs(other.along[0] * axis[0] + other.along[1] * axis[1]) * other.width + Math.abs(other.inward[0] * axis[0] + other.inward[1] * axis[1]) * other.depth) / 2;
      if (between >= reach) return false;
    }
  }
  return true;
}

export const rectsOverlap = (a: Rect, b: Rect) => standingOverlap(standingOf(a), standingOf(b));

/** How far a ray from a point goes before it meets the polygon's edge: infinite if it never does. */
export function rayDepth(from: Point, way: Point, outline: Outline): number {
  let least = Infinity;
  const { ring } = outline;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[j] as Point, ring[i] as Point];
    const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
    const denominator = way[0] * ey - way[1] * ex;
    if (Math.abs(denominator) < 1e-12) continue;
    const t = ((a[0] - from[0]) * ey - (a[1] - from[1]) * ex) / denominator;
    const s = ((a[0] - from[0]) * way[1] - (a[1] - from[1]) * way[0]) / denominator;
    if (t > 1e-6 && s >= 0 && s <= 1 && t < least) least = t;
  }
  return least;
}

/** Whether a point is inside a polygon. */
export const pointInside = (point: Point, outline: Outline) => within(point, outline.ring);
