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

type River = Extract<Layout['waters'][number], { kind: 'river' }>;

/**
 * A river's two banks as one outline, for filling. Each point of the centre line is pushed out to either side by
 * half the width there: the river's own width at that point where it has one, otherwise its one width throughout.
 */
export function riverOutline(river: River): Point[] {
  const { centreLine } = river;
  const left: Point[] = [];
  const right: Point[] = [];
  centreLine.forEach((point, index) => {
    const before = centreLine[Math.max(0, index - 1)] as Point;
    const after = centreLine[Math.min(centreLine.length - 1, index + 1)] as Point;
    const length = Math.hypot(after[0] - before[0], after[1] - before[1]) || 1;
    const nx = -(after[1] - before[1]) / length;
    const ny = (after[0] - before[0]) / length;
    const half = (river.widths?.[index] ?? river.width) / 2;
    left.push([point[0] + nx * half, point[1] + ny * half]);
    right.push([point[0] - nx * half, point[1] - ny * half]);
  });
  return [...left, ...right.reverse()];
}

/** The area of a polygon of any shape, in the square of its units. */
export function polygonArea(polygon: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

/**
 * A wall's line with its gates left open: the stretches of the line that stand, in order. Each gap is centred on
 * the point of the line nearest its gate and is as long as that gate's `gap`. A closed wall's line is taken to
 * return to its first point.
 */
export function wallRuns(line: readonly Point[], closed: boolean, gates: ReadonlyArray<{ position: Point; gap: number }>): Point[][] {
  const points = closed ? [...line, line[0] as Point] : [...line];
  // How far along the line each of its points is.
  const along = [0];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1] as Point, points[i] as Point];
    along.push((along[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = along[along.length - 1] as number;
  const pointAt = (distance: number): Point => {
    let i = 1;
    while (i < points.length - 1 && (along[i] as number) < distance) i++;
    const [a, b] = [points[i - 1] as Point, points[i] as Point];
    const span = (along[i] as number) - (along[i - 1] as number);
    const t = span === 0 ? 0 : (distance - (along[i - 1] as number)) / span;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  // The stretches taken out, each as distances along the line. On a closed wall one may run past the end and round to the start.
  const gaps: Array<[number, number]> = [];
  for (const gate of gates) {
    let nearest = 0;
    let least = Infinity;
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1] as Point, points[i] as Point];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const square = dx * dx + dy * dy;
      const t = square === 0 ? 0 : Math.min(1, Math.max(0, ((gate.position[0] - a[0]) * dx + (gate.position[1] - a[1]) * dy) / square));
      const away = Math.hypot(gate.position[0] - (a[0] + dx * t), gate.position[1] - (a[1] + dy * t));
      if (away < least) {
        least = away;
        nearest = (along[i - 1] as number) + Math.sqrt(square) * t;
      }
    }
    const [from, to] = [nearest - gate.gap / 2, nearest + gate.gap / 2];
    if (!closed) gaps.push([Math.max(0, from), Math.min(total, to)]);
    else if (from < 0) gaps.push([0, to], [from + total, total]);
    else if (to > total) gaps.push([from, total], [0, to - total]);
    else gaps.push([from, to]);
  }
  gaps.sort((a, b) => a[0] - b[0]);
  const runs: Point[][] = [];
  const run = (from: number, to: number) => {
    if (to - from <= 1e-9) return;
    const inner = points.filter((_, index) => (along[index] as number) > from && (along[index] as number) < to);
    runs.push([pointAt(from), ...inner, pointAt(to)]);
  };
  let at = 0;
  for (const [from, to] of gaps) {
    run(at, from);
    at = Math.max(at, to);
  }
  run(at, total);
  // A closed wall with no gate at its first point runs on through it: the last stretch and the first are one.
  if (closed && runs.length > 1 && gaps.every(([from, to]) => from > 0 && to < total)) {
    const last = runs.pop() as Point[];
    runs[0] = [...last, ...(runs[0] as Point[]).slice(1)];
  }
  return runs;
}

/** What the town pane says of a layout: who made it, and its wall and plaza where it has them. */
export function layoutFacts(layout: Layout): Array<{ key: 'generator' | 'gates' | 'plaza'; label: string; value: string }> {
  const plazas = layout.places.filter((place) => place.kind === 'plaza');
  const area = plazas.reduce((sum, place) => sum + polygonArea(place.polygon), 0);
  return [
    { key: 'generator', label: 'Layout generator', value: layout.summary.generator },
    ...(layout.walls.length > 0 ? [{ key: 'gates' as const, label: 'Gates in the wall', value: layout.walls.reduce((sum, wall) => sum + wall.gates.length, 0).toLocaleString('en-US') }] : []),
    ...(plazas.length > 0 ? [{ key: 'plaza' as const, label: 'Plaza', value: `${Math.round(area).toLocaleString('en-US')} m²` }] : []),
  ];
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
