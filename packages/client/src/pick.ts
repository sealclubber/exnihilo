import type { Point } from '@worldsim/core';
import { type View, toScreen } from './view.ts';

/**
 * The item nearest to a screen position, if one lies within `radius` screen
 * pixels of it.
 */
export function pickNearest<T extends { position: Point }>(
  items: readonly T[],
  view: View,
  screenX: number,
  screenY: number,
  radius = 10,
): T | undefined {
  let best: T | undefined;
  let bestDistance = radius * radius;
  for (const item of items) {
    const [x, y] = toScreen(view, item.position);
    const distance = (x - screenX) ** 2 + (y - screenY) ** 2;
    if (distance <= bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}
