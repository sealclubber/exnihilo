/**
 * Measurements of a layout that say something about how it looks, for the summary and the tests.
 */
import type { Point } from '../schema.ts';
import type { Segment, Water } from './records.ts';

/** Streets within this many degrees of running round a point, or straight to it, count as a ring or a spoke. */
const RING_TOLERANCE = 20;
/** The middle of the town is left out: every street there runs round the centre or to it. */
const RING_CORE = 30;

/**
 * The share of street and lane length that runs round a point or straight to it, within 20 degrees, leaving out
 * everything within 30 metres of the point. Main roads and bridges are not counted: they are meant to lead to the centre.
 */
export function ringShare(segments: readonly Pick<Segment, 'kind' | 'points'>[], about: Point = [0, 0]): number {
  let counted = 0;
  let total = 0;
  for (const segment of segments) {
    if (segment.kind !== 'street' && segment.kind !== 'lane') continue;
    for (let at = 1; at < segment.points.length; at++) {
      const a = segment.points[at - 1] as Point;
      const b = segment.points[at] as Point;
      const middle: Point = [(a[0] + b[0]) / 2 - about[0], (a[1] + b[1]) / 2 - about[1]];
      const away = Math.hypot(middle[0], middle[1]);
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (away < RING_CORE || length === 0) continue;
      // The angle between the piece and the line out from the point: 0 is a spoke, 90 a ring.
      const cosine = Math.abs(((b[0] - a[0]) * middle[0] + (b[1] - a[1]) * middle[1]) / (length * away));
      const angle = (Math.acos(Math.min(1, cosine)) * 180) / Math.PI;
      total += length;
      if (angle <= RING_TOLERANCE || angle >= 90 - RING_TOLERANCE) counted += length;
    }
  }
  return total === 0 ? 0 : counted / total;
}

/** The width of a river at a point of its centre line. */
export function riverWidthAt(river: Extract<Water, { kind: 'river' }>, index: number): number {
  return river.widths?.[index] ?? river.width;
}

/** A river's two banks as one outline, for drawing it and for telling what is in it. */
export function riverOutline(river: Extract<Water, { kind: 'river' }>): Point[] {
  const { centreLine } = river;
  const left: Point[] = [];
  const right: Point[] = [];
  centreLine.forEach((point, index) => {
    const before = centreLine[Math.max(0, index - 1)] as Point;
    const after = centreLine[Math.min(centreLine.length - 1, index + 1)] as Point;
    const length = Math.hypot(after[0] - before[0], after[1] - before[1]) || 1;
    const nx = -(after[1] - before[1]) / length;
    const ny = (after[0] - before[0]) / length;
    const half = riverWidthAt(river, index) / 2;
    left.push([point[0] + nx * half, point[1] + ny * half]);
    right.push([point[0] - nx * half, point[1] - ny * half]);
  });
  return [...left, ...right.reverse()];
}
