/**
 * The pan and zoom state of the map, and the arithmetic on it.
 * A map position p is drawn at screen position p * scale + (x, y).
 */
import type { Point } from '@worldsim/core';

export interface View {
  scale: number;
  x: number;
  y: number;
}

/** The view that shows the whole map, centred, with a margin around it. */
export function fitView(mapWidth: number, mapHeight: number, viewWidth: number, viewHeight: number, margin = 16): View {
  const scale = Math.max(
    Math.min((viewWidth - 2 * margin) / mapWidth, (viewHeight - 2 * margin) / mapHeight),
    0.01,
  );
  return {
    scale,
    x: (viewWidth - mapWidth * scale) / 2,
    y: (viewHeight - mapHeight * scale) / 2,
  };
}

export function toScreen(view: View, point: Point): Point {
  return [point[0] * view.scale + view.x, point[1] * view.scale + view.y];
}

export function toMap(view: View, screenX: number, screenY: number): Point {
  return [(screenX - view.x) / view.scale, (screenY - view.y) / view.scale];
}

export function panBy(view: View, dx: number, dy: number): View {
  return { scale: view.scale, x: view.x + dx, y: view.y + dy };
}

/**
 * Zooms by `factor`, keeping the map position under the given screen point
 * where it is. The scale is held between the two limits.
 */
export function zoomAt(
  view: View,
  screenX: number,
  screenY: number,
  factor: number,
  limits: { min: number; max: number },
): View {
  const scale = Math.min(Math.max(view.scale * factor, limits.min), limits.max);
  const applied = scale / view.scale;
  return {
    scale,
    x: screenX - (screenX - view.x) * applied,
    y: screenY - (screenY - view.y) * applied,
  };
}
