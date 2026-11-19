import type { Point } from './schema.ts';

/**
 * The bearing from one map position to another, in whole degrees clockwise
 * from north. The map's y axis points down, so north is negative y.
 */
export function bearing(from: Point, to: Point): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const degrees = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
  return ((degrees % 360) + 360) % 360;
}
