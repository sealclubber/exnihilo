/**
 * Stage 6 of the staged generator: ground, which says how far the mesh
 * needs to reach.
 *
 * Land is taken cheapest first until there is a multiple of the area the
 * town needs, where cost is distance from the nearest highway and from the
 * centre, with smooth noise. It is held as squares, never as an outline:
 * nothing draws or stores the town's edge. The cost without its noise is
 * kept as the growth rank of whatever stands there.
 */
import type { Rng } from '../../city/random.ts';
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { crossingsOfPolyline, distance } from '../geometry.ts';
import { LineIndex, normal } from '../lines.ts';
import type { RoadPlan } from './highways.ts';
import { armsAt } from './lines.ts';
import type { Coast, River } from './water.ts';

export interface Ground {
  /** The side of a square, the corner the squares start from, and how many there are each way. */
  step: number;
  minX: number;
  minY: number;
  columns: number;
  rows: number;
  /** For each square, how far it is from the ground in metres: nothing for a square of the ground. */
  away: Float32Array;
  /** The ground's area, and the box about it. */
  area: number;
  box: { minX: number; minY: number; maxX: number; maxY: number };
  /** What a metre from the nearest highway and from the centre cost. */
  weights: { highway: number; centre: number };
  /** Whether a point is on the ground, or within `margin` metres of it. */
  has(point: Point, margin?: number): boolean;
  /** How late in the town's growth a point would be built on: its cost, without the noise. */
  rank(point: Point): number;
  /** How far a point is from the nearest highway or bridge road. */
  toRoad(point: Point): number;
}

export interface GroundInput {
  settings: StagedSettings;
  rng: Rng;
  buildings: number;
  radius: number;
  roads: RoadPlan;
  river?: River;
  coast?: Coast;
  /** How many times more ground than the pack's factor: raised when a town turns out to need more. */
  more?: number;
}

const CENTRE: Point = [0, 0];

/** Squared distances to the nearest marked place along one row, by the lower envelope of parabolas. */
function alongRow(values: Float64Array, count: number, out: Float64Array, hull: Int32Array, breaks: Float64Array) {
  let k = 0;
  hull[0] = 0;
  breaks[0] = -Infinity;
  breaks[1] = Infinity;
  for (let q = 1; q < count; q++) {
    let s: number;
    for (;;) {
      const p = hull[k] as number;
      s = ((values[q] as number) + q * q - ((values[p] as number) + p * p)) / (2 * q - 2 * p);
      if (s > (breaks[k] as number)) break;
      k--;
    }
    k++;
    hull[k] = q;
    breaks[k] = s;
    breaks[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < count; q++) {
    while ((breaks[k + 1] as number) < q) k++;
    const p = hull[k] as number;
    out[q] = (q - p) * (q - p) + (values[p] as number);
  }
}

/** For every square, the distance in squares to the nearest marked one. */
function distances(marked: Uint8Array, columns: number, rows: number): Float32Array {
  const FAR = 1e12;
  const most = Math.max(columns, rows);
  const line = new Float64Array(most);
  const found = new Float64Array(most);
  const hull = new Int32Array(most);
  const breaks = new Float64Array(most + 1);
  const squared = new Float64Array(columns * rows);
  for (let x = 0; x < columns; x++) {
    for (let y = 0; y < rows; y++) line[y] = marked[y * columns + x] ? 0 : FAR;
    alongRow(line, rows, found, hull, breaks);
    for (let y = 0; y < rows; y++) squared[y * columns + x] = found[y] as number;
  }
  const out = new Float32Array(columns * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) line[x] = squared[y * columns + x] as number;
    alongRow(line, columns, found, hull, breaks);
    for (let x = 0; x < columns; x++) out[y * columns + x] = Math.sqrt(found[x] as number);
  }
  return out;
}

export function takeGround({ settings, rng, buildings, radius, roads, river, coast, more = 1 }: GroundInput): Ground {
  const rules = settings.ground;
  const reach = rules.extent * radius * Math.sqrt(more);
  const step = Math.max(rules.raster.finest, (2 * reach) / rules.raster.across);
  const columns = Math.ceil((2 * reach) / step);
  const rows = columns;
  const minX = -reach;
  const minY = -reach;
  const count = columns * rows;
  const middle = (index: number): Point => [minX + ((index % columns) + 0.5) * step, minY + (Math.floor(index / columns) + 0.5) * step];

  const lines = new LineIndex(Math.max(50, radius / 4));
  const through = roads.highways.filter((highway) => highway.kind !== 'bridge-road' && highway.kind !== 'branch').map((highway) => highway.points);
  for (const highway of roads.highways) lines.add(highway.points);
  for (const street of roads.mainStreets) lines.add(street);
  const toRoad = (point: Point) => (lines.size === 0 ? Math.hypot(point[0], point[1]) : (lines.nearest(point)?.distance ?? Infinity));
  const weights = armsAt(through, settings.widths.highway, settings.highways.armProbe).length <= 2 ? rules.single : rules.several;
  const rank = (point: Point) => weights.highway * toRoad(point) + weights.centre * Math.hypot(point[0], point[1]);

  // Smooth noise: draws on a coarse lattice, eased between.
  const across = Math.ceil((2 * reach) / rules.noise.scale) + 2;
  const lattice = Float64Array.from({ length: across * across }, () => normal(rng));
  const noiseAt = (point: Point) => {
    const u = (point[0] - minX) / rules.noise.scale;
    const v = (point[1] - minY) / rules.noise.scale;
    const [i, j] = [Math.min(Math.max(Math.floor(u), 0), across - 2), Math.min(Math.max(Math.floor(v), 0), across - 2)];
    const ease = (t: number) => t * t * (3 - 2 * t);
    const [s, t] = [ease(Math.min(Math.max(u - i, 0), 1)), ease(Math.min(Math.max(v - j, 0), 1))];
    const at = (x: number, y: number) => lattice[y * across + x] as number;
    return (at(i, j) * (1 - s) + at(i + 1, j) * s) * (1 - t) + (at(i, j + 1) * (1 - s) + at(i + 1, j + 1) * s) * t;
  };

  // ---- Cost, and the cheapest squares ----------------------------------------------------------------------------
  // Distances are measured on the squares themselves: fine enough for ground, which only says roughly how far the
  // mesh reaches, and far quicker than measuring each square against every line.
  const squareOf = (point: Point): number | undefined => {
    const [x, y] = [Math.floor((point[0] - minX) / step), Math.floor((point[1] - minY) / step)];
    return x < 0 || y < 0 || x >= columns || y >= rows ? undefined : y * columns + x;
  };
  const marked = (drawn: ReadonlyArray<readonly Point[]>): Uint8Array => {
    const marks = new Uint8Array(count);
    for (const line of drawn) {
      for (let at = 1; at < line.length; at++) {
        const [a, b] = [line[at - 1] as Point, line[at] as Point];
        const pieces = Math.max(1, Math.ceil(distance(a, b) / (step / 2)));
        for (let piece = 0; piece <= pieces; piece++) {
          const square = squareOf([a[0] + ((b[0] - a[0]) * piece) / pieces, a[1] + ((b[1] - a[1]) * piece) / pieces]);
          if (square !== undefined) marks[square] = 1;
        }
      }
    }
    return marks;
  };
  /** The squares that can be reached from the centre without stepping on a barred one. */
  const reached = (barred: (index: number) => boolean): Uint8Array => {
    const seen = new Uint8Array(count);
    const start = squareOf(CENTRE);
    const queue: number[] = [];
    if (start !== undefined && !barred(start)) {
      seen[start] = 1;
      queue.push(start);
    }
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head] as number;
      const [x, y] = [index % columns, Math.floor(index / columns)];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const [nx, ny] = [x + dx, y + dy];
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
        const next = ny * columns + nx;
        if (seen[next] || barred(next)) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    return seen;
  };
  const roadAway = distances(marked([...roads.highways.map((highway) => highway.points), ...roads.mainStreets]), columns, rows);
  const gaps = new Float32Array(count).fill(Infinity);
  const far = new Uint8Array(count);
  if (river) {
    const away = distances(marked([river.line]), columns, rows);
    for (let index = 0; index < count; index++) gaps[index] = (away[index] as number) * step - river.width / 2;
    // A town with no bridge takes no ground across its river.
    if (!roads.farBank) {
      const [first, last] = [river.line[0] as Point, river.line[river.line.length - 1] as Point];
      if (squareOf(first) === undefined && squareOf(last) === undefined) {
        // The river runs right across: the far bank is whatever cannot be reached from the centre without wading.
        const home = reached((index) => (gaps[index] as number) < step);
        for (let index = 0; index < count; index++) far[index] = home[index] ? 0 : 1;
      } else for (let index = 0; index < count; index++) far[index] = crossingsOfPolyline(CENTRE, middle(index), river.line) % 2 === 1 ? 1 : 0;
    }
  }
  if (coast) {
    const away = distances(marked([coast.shore]), columns, rows);
    const land = reached((index) => (away[index] as number) <= 1);
    for (let index = 0; index < count; index++) {
      const gap = (land[index] || (away[index] as number) <= 1 ? 1 : -1) * (away[index] as number) * step;
      if (gap < (gaps[index] as number)) gaps[index] = gap;
    }
  }
  const cost = new Float64Array(count);
  let loudest = 0;
  const noise = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    noise[index] = noiseAt(middle(index));
    loudest = Math.max(loudest, Math.abs(noise[index] as number));
  }
  const open: number[] = [];
  for (let index = 0; index < count; index++) {
    if ((gaps[index] as number) < rules.fromWater.cost || far[index]) {
      cost[index] = Infinity;
      continue;
    }
    const point = middle(index);
    cost[index] = weights.highway * (lines.size === 0 ? Math.hypot(point[0], point[1]) : (roadAway[index] as number) * step) + weights.centre * Math.hypot(point[0], point[1]) + ((noise[index] as number) / (loudest || 1)) * rules.noise.size * radius;
    open.push(index);
  }
  const wanted = Math.min(open.length, Math.round((rules.factor * more * buildings * settings.extent.perBuilding) / (step * step)));
  open.sort((a, b) => (cost[a] as number) - (cost[b] as number) || a - b);
  let taken = new Uint8Array(count);
  for (let at = 0; at < wanted; at++) taken[open[at] as number] = 1;

  // ---- Hollows filled --------------------------------------------------------------------------------------------
  const close = weights.close / step;
  if (close >= 1) {
    const out = distances(taken, columns, rows);
    const swollen = new Uint8Array(count);
    const beyond = new Uint8Array(count);
    for (let index = 0; index < count; index++) {
      swollen[index] = (out[index] as number) <= close ? 1 : 0;
      beyond[index] = swollen[index] ? 0 : 1;
    }
    const inward = distances(beyond, columns, rows);
    const closed = new Uint8Array(count);
    for (let index = 0; index < count; index++) closed[index] = swollen[index] && (inward[index] as number) > close ? 1 : 0;
    for (let index = 0; index < count; index++) if (taken[index]) closed[index] = 1;
    taken = closed;
  }
  for (let index = 0; index < count; index++) if ((gaps[index] as number) < rules.fromWater.edge || far[index]) taken[index] = 0;

  // ---- One town: the ground about the centre, and about the far end of each bridge -------------------------------
  const kept = new Uint8Array(count);
  const queue: number[] = [];
  const nearest = (point: Point, within: number): number | undefined => {
    let best: number | undefined;
    let least = within;
    const [cx, cy] = [Math.floor((point[0] - minX) / step), Math.floor((point[1] - minY) / step)];
    const span = Math.ceil(within / step);
    for (let y = Math.max(cy - span, 0); y <= Math.min(cy + span, rows - 1); y++) {
      for (let x = Math.max(cx - span, 0); x <= Math.min(cx + span, columns - 1); x++) {
        const index = y * columns + x;
        if (!taken[index]) continue;
        const away = distance(middle(index), point);
        if (away < least) {
          least = away;
          best = index;
        }
      }
    }
    return best;
  };
  const starts = [nearest(CENTRE, radius), ...roads.bridges.map((bridge) => nearest(bridge.b, settings.bridges.landing + settings.bridges.straight.main + 2 * step))];
  for (const start of starts) {
    if (start === undefined || kept[start]) continue;
    kept[start] = 1;
    queue.push(start);
  }
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head] as number;
    const [x, y] = [index % columns, Math.floor(index / columns)];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const [nx, ny] = [x + dx, y + dy];
      if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
      const next = ny * columns + nx;
      if (!taken[next] || kept[next]) continue;
      kept[next] = 1;
      queue.push(next);
    }
  }
  const away = distances(kept, columns, rows);
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let squares = 0;
  for (let index = 0; index < count; index++) {
    away[index] = kept[index] ? 0 : Math.max((away[index] as number) - 0.5, 0) * step;
    if (!kept[index]) continue;
    squares++;
    const [x, y] = middle(index);
    box.minX = Math.min(box.minX, x - step / 2);
    box.maxX = Math.max(box.maxX, x + step / 2);
    box.minY = Math.min(box.minY, y - step / 2);
    box.maxY = Math.max(box.maxY, y + step / 2);
  }
  return {
    step,
    minX,
    minY,
    columns,
    rows,
    away,
    area: squares * step * step,
    box,
    weights: { highway: weights.highway, centre: weights.centre },
    has(point, margin = 0) {
      const [x, y] = [Math.floor((point[0] - minX) / step), Math.floor((point[1] - minY) / step)];
      if (x < 0 || y < 0 || x >= columns || y >= rows) return false;
      return (away[y * columns + x] as number) <= margin;
    },
    rank,
    toRoad,
  };
}
