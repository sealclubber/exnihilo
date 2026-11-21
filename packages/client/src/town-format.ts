/**
 * The arithmetic behind the town map: fitting, hit-testing, colours and the
 * scale bar. Pure, so it can be tested without a browser.
 *
 * Everything here reads a layout as the format defines it: lots are polygons
 * and segments are polylines, of any shape.
 */
import type { Layout, Lot, Point } from '@worldsim/core';
import type { View } from './view.ts';

/** The view that shows a box of map coordinates whole, centred, with a margin. */
export function fitBox(box: Layout['summary']['bounds'], viewWidth: number, viewHeight: number, margin = 24): View {
  const width = Math.max(box.maxX - box.minX, 1);
  const height = Math.max(box.maxY - box.minY, 1);
  const scale = Math.max(Math.min((viewWidth - 2 * margin) / width, (viewHeight - 2 * margin) / height), 0.001);
  return {
    scale,
    x: viewWidth / 2 - ((box.minX + box.maxX) / 2) * scale,
    y: viewHeight / 2 - ((box.minY + box.maxY) / 2) * scale,
  };
}

/** Whether a point is inside a polygon of any shape. */
export function insidePolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/** The lot under a map position, if any. */
export function lotAt(lots: readonly Lot[], point: Point): Lot | undefined {
  return lots.find((lot) => insidePolygon(point, lot.polygon));
}

const NICE_LENGTHS = [1, 2, 5];

/** A round length in metres for a scale bar at most `maxPixels` long, and how long it is on screen. */
export function scaleBar(scale: number, maxPixels = 140): { metres: number; pixels: number } {
  const most = maxPixels / scale;
  let metres = 1;
  for (let power = -2; power <= 6; power++) {
    for (const nice of NICE_LENGTHS) {
      const candidate = nice * 10 ** power;
      if (candidate <= most) metres = candidate;
    }
  }
  return { metres, pixels: metres * scale };
}

export function formatMetres(metres: number): string {
  if (metres >= 1000) return `${(metres / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} km`;
  return `${metres.toLocaleString('en-US', { maximumFractionDigits: metres < 10 ? 1 : 0 })} m`;
}

const DISTRICT_COLOURS = ['#e6b8af', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#b4a7d6', '#d5a6bd', '#d9d2c5', '#c9daf8', '#d0e0c0', '#ead1dc'];

/** A fill colour for each district, in the order given. Neighbours in the list get different colours. */
export function districtColours(districtIds: readonly string[]): Map<string, string> {
  return new Map(districtIds.map((id, index) => [id, DISTRICT_COLOURS[index % DISTRICT_COLOURS.length] as string]));
}

/** What a path's length and extent are, in words. */
export function describePath(path: { length: number; segmentIds: string[] }): string {
  const count = path.segmentIds.length;
  return `${formatMetres(path.length)} along ${count} ${count === 1 ? 'street segment' : 'street segments'}`;
}

/** How many people can be seen on the map: "31 walking · 1,000 outside", with "in view" when the map shows only part of the town. */
export function describeSeen(walking: number, outside: number, wholeTown: boolean): string {
  const count = (value: number) => value.toLocaleString('en-US');
  return `${count(walking)} walking · ${count(outside)} outside${wholeTown ? '' : ', in view'}`;
}
