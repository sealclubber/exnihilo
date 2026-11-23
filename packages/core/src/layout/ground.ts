/**
 * The ground a grown town stands on: as much as its buildings need, taken
 * cheapest first, where ground near a highway, near the centre along it and
 * near an arterial is cheap. The order it was taken in is the order the town
 * grew in, and is kept.
 *
 * The ground is a grid of cells. Those taken are closed over narrow gaps and
 * opened at narrow necks, the largest piece is kept with its holes filled, and
 * its outline traced as a smooth line.
 */
import type { Rng } from '../city/random.ts';
import type { GrownSettings } from '../pack/schema.ts';
import type { Point } from '../schema.ts';
import { area, inside, signedArea, simplifyRing } from './cutting.ts';
import { LineIndex, chaikin } from './lines.ts';

/** Thrown when the ground laid out proved too small; the town is laid out again on more. */
export class TooSmall extends Error {
  /** Which step found it too small. */
  readonly where: string;

  constructor(where: string) {
    super(`too small at ${where}`);
    this.where = where;
  }
}

export interface Ground {
  /** The town's ground: the outline of each piece of it, largest first, without holes. */
  outlines: Point[][];
  /** What a point's ground costs: the lower, the sooner it was built on. */
  cost: (point: Point) => number;
  /** Where a cost falls among the ground taken: 0 for the first taken, 1 for the last. */
  rank: (cost: number) => number;
  /** The outline of the ground whose cost is below a share of it, smoothed over `smoothing` metres; nothing if there is none. */
  oldest: (share: number, smoothing: number) => Point[] | undefined;
}

export interface GroundInput {
  settings: GrownSettings;
  rng: Rng;
  /** Highways, quays and local roads; arterials. */
  trunks: Point[][];
  arterials: Point[][];
  /** The stretches of roads beyond a bridge: ground near them is not across the water from the town. */
  beyondBridges: Point[][];
  /** How far a point is from water: negative in it. */
  dryBy: (point: Point) => number;
  /** The area wanted, in square metres, and how far out from the centre to look for it. */
  needed: number;
  extent: number;
}

/** A square grid of values, `size` on a side, its first cell centred at (`origin`, `origin`). */
interface Field {
  size: number;
  origin: number;
  cell: number;
  values: Float64Array;
}

/** Blurs a field with a bell `sigma` cells wide, along each axis in turn. */
function blur(field: Field, sigma: number): Field {
  if (sigma <= 0) return field;
  const { size } = field;
  const radius = Math.ceil(3 * sigma);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, k) => Math.exp(-((k - radius) ** 2) / (2 * sigma * sigma)));
  const total = kernel.reduce((sum, value) => sum + value, 0);
  let values = field.values;
  for (const across of [true, false]) {
    const next = new Float64Array(size * size);
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const [ii, jj] = across ? [i + k, j] : [i, j + k];
          if (ii < 0 || jj < 0 || ii >= size || jj >= size) continue;
          sum += (kernel[k + radius] as number) * (values[ii * size + jj] as number);
        }
        next[i * size + j] = sum / total;
      }
    }
    values = next;
  }
  return { ...field, values };
}

/** The loops where a field crosses a level, by marching squares. */
export function contours(field: Field, level: number): Point[][] {
  const { size, origin, cell, values } = field;
  const at = (i: number) => origin + i * cell;
  const value = (i: number, j: number) => values[i * size + j] as number;
  const edgePoint = (i1: number, j1: number, i2: number, j2: number): Point => {
    const [v1, v2] = [value(i1, j1), value(i2, j2)];
    const t = v1 === v2 ? 0.5 : (level - v1) / (v2 - v1);
    return [at(i1) + (at(i2) - at(i1)) * t, at(j1) + (at(j2) - at(j1)) * t];
  };
  const ends = new Map<string, Array<{ other: string; from: Point }>>();
  const keyOf = (i1: number, j1: number, i2: number, j2: number) => (i1 < i2 || (i1 === i2 && j1 < j2) ? `${i1},${j1},${i2},${j2}` : `${i2},${j2},${i1},${j1}`);
  for (let i = 0; i < size - 1; i++) {
    for (let j = 0; j < size - 1; j++) {
      const corners: Array<[number, number]> = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      const over = corners.map(([ci, cj]) => value(ci, cj) >= level);
      const sides: Array<[number, number, number, number]> = [];
      for (let k = 0; k < 4; k++) {
        const [a, b] = [corners[k] as [number, number], corners[(k + 1) % 4] as [number, number]];
        if (over[k] !== over[(k + 1) % 4]) sides.push([a[0], a[1], b[0], b[1]]);
      }
      for (let k = 0; k + 1 < sides.length; k += 2) {
        const [one, two] = [sides[k] as [number, number, number, number], sides[k + 1] as [number, number, number, number]];
        const [ka, kb] = [keyOf(...one), keyOf(...two)];
        const [pa, pb] = [edgePoint(...one), edgePoint(...two)];
        ends.set(ka, [...(ends.get(ka) ?? []), { other: kb, from: pa }]);
        ends.set(kb, [...(ends.get(kb) ?? []), { other: ka, from: pb }]);
      }
    }
  }
  const used = new Set<string>();
  const loops: Point[][] = [];
  for (const start of [...ends.keys()].sort()) {
    if (used.has(start)) continue;
    const loop: Point[] = [];
    let key = start;
    for (let steps = 0; steps < size * size; steps++) {
      used.add(key);
      const list = ends.get(key) ?? [];
      const next = list.find((piece) => !used.has(piece.other));
      const any = list[0];
      if (!any) break;
      loop.push((next ?? any).from);
      if (!next) break;
      key = next.other;
    }
    if (loop.length > 8) loops.push(loop);
  }
  return loops;
}

/** The largest loop round the centre, or the largest of all; smoothed and thinned. */
function mainLoop(loops: Point[][]): Point[] | undefined {
  const around = loops.filter((loop) => inside([0, 0], loop)).sort((a, b) => area(b) - area(a));
  const chosen = around[0] ?? [...loops].sort((a, b) => area(b) - area(a))[0];
  if (!chosen) return undefined;
  return simplifyRing(chaikin([...chosen, chosen[0] as Point], 2).slice(0, -1), 0.2);
}

export function layGround(input: GroundInput): Ground {
  const { settings, rng, dryBy, needed, extent } = input;
  const costs = settings.ground;
  const cell = costs.cell;
  const size = Math.ceil((2 * extent) / cell) + 1;
  const origin = -extent;
  const at = (i: number) => origin + i * cell;
  const trunkIndex = new LineIndex(50);
  for (const line of input.trunks) trunkIndex.add(line);
  const arterialIndex = new LineIndex(50);
  for (const line of input.arterials) arterialIndex.add(line);
  const beyondIndex = new LineIndex(50);
  for (const line of input.beyondBridges) beyondIndex.add(line);

  // Smooth noise: a random value per cell, blurred and scaled to the noise's depth.
  const raw: Field = { size, origin, cell, values: new Float64Array(size * size) };
  for (let index = 0; index < size * size; index++) {
    const u = Math.max(rng.next(), 1e-12);
    raw.values[index] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
  }
  const noise = blur(raw, costs.noise.length / cell);
  let loudest = 0;
  for (const value of noise.values) loudest = Math.max(loudest, Math.abs(value));
  const noiseAt = (point: Point) => {
    const i = Math.max(0, Math.min(size - 1, Math.round((point[0] - origin) / cell)));
    const j = Math.max(0, Math.min(size - 1, Math.round((point[1] - origin) / cell)));
    return loudest === 0 ? 0 : ((noise.values[i * size + j] as number) / loudest) * costs.noise.depth;
  };
  const cost = (point: Point): number => {
    if (dryBy(point) < costs.wet) return Infinity;
    const highway = trunkIndex.nearest(point);
    if (!highway) return Infinity;
    const arterial = arterialIndex.size > 0 ? arterialIndex.nearest(point, costs.arterialCap) : undefined;
    let value = highway.distance + costs.along * highway.along + costs.arterial * Math.min(arterial ? arterial.distance : costs.arterialCap, costs.arterialCap) + noiseAt(point);
    // Ground across the water from its highway, unless an arterial on its own side, such as one over a bridge, is near.
    const across = (to: Point) => {
      for (let step = 1; step < 8; step++) {
        const t = step / 8;
        if (dryBy([point[0] + (to[0] - point[0]) * t, point[1] + (to[1] - point[1]) * t]) < 0) return true;
      }
      return false;
    };
    const over = beyondIndex.size > 0 ? beyondIndex.nearest(point, costs.arterialCap) : undefined;
    if (across(highway.point) && (!arterial || across(arterial.point)) && (!over || across(over.point))) value += costs.water;
    return value;
  };

  // The cells of the grid, cheapest first, as many as the town needs.
  const value = new Float64Array(size * size);
  const order: number[] = [];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const point: Point = [at(i), at(j)];
      const here = point[0] * point[0] + point[1] * point[1] > extent * extent ? Infinity : cost(point);
      value[i * size + j] = here;
      if (Number.isFinite(here)) order.push(i * size + j);
    }
  }
  order.sort((a, b) => (value[a] as number) - (value[b] as number) || a - b);
  const wanted = Math.ceil((needed * costs.margin) / (cell * cell));
  if (wanted > order.length * 0.6) throw new TooSmall('the ground');
  let taken: Uint8Array = new Uint8Array(size * size);
  for (let k = 0; k < wanted; k++) taken[order[k] as number] = 1;
  // The cells no water touches, which closing may not fill.
  const dry = (index: number) => Number.isFinite(value[index] as number) || dryBy([at(Math.floor(index / size)), at(index % size)]) >= 0;

  // Closed over narrow gaps, then opened at narrow necks.
  const grow = (from: Uint8Array, radius: number, keep: 0 | 1): Uint8Array => {
    const reach = Math.ceil(radius / cell);
    const offsets: Array<[number, number]> = [];
    for (let di = -reach; di <= reach; di++) for (let dj = -reach; dj <= reach; dj++) if ((di * di + dj * dj) * cell * cell <= radius * radius) offsets.push([di, dj]);
    const out = new Uint8Array(size * size);
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        let hit = false;
        for (const [di, dj] of offsets) {
          const [ii, jj] = [i + di, j + dj];
          const there = ii < 0 || jj < 0 || ii >= size || jj >= size ? 0 : (from[ii * size + jj] as number);
          if (there === keep) {
            hit = true;
            break;
          }
        }
        out[i * size + j] = hit === (keep === 1) ? 1 : 0;
      }
    }
    return out;
  };
  taken = grow(grow(taken, costs.close, 1), costs.close, 0);
  taken = grow(grow(taken, costs.open, 0), costs.open, 1);
  for (let index = 0; index < size * size; index++) if (taken[index] && !dry(index)) taken[index] = 0;
  // The pieces a road reaches, each with its holes filled: water may part the town, but every piece is on a road.
  const piece = new Int32Array(size * size).fill(-1);
  const sizes: number[] = [];
  for (let start = 0; start < size * size; start++) {
    if (!taken[start] || piece[start] !== -1) continue;
    const queue = [start];
    piece[start] = sizes.length;
    for (let k = 0; k < queue.length; k++) {
      const index = queue[k] as number;
      const [i, j] = [Math.floor(index / size), index % size];
      for (const [ii, jj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]] as Array<[number, number]>) {
        if (ii < 0 || jj < 0 || ii >= size || jj >= size) continue;
        const next = ii * size + jj;
        if (taken[next] && piece[next] === -1) {
          piece[next] = sizes.length;
          queue.push(next);
        }
      }
    }
    sizes.push(queue.length);
  }
  const reached = new Set<number>();
  for (const line of [...input.trunks, ...input.arterials]) {
    for (let k = 1; k < line.length; k++) {
      const [a, b] = [line[k - 1] as Point, line[k] as Point];
      const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (cell / 2));
      for (let step = 0; step <= steps; step++) {
        const i = Math.round((a[0] + ((b[0] - a[0]) * step) / steps - origin) / cell);
        const j = Math.round((a[1] + ((b[1] - a[1]) * step) / steps - origin) / cell);
        if (i >= 0 && j >= 0 && i < size && j < size && (piece[i * size + j] as number) >= 0) reached.add(piece[i * size + j] as number);
      }
    }
  }
  const largestSize = Math.max(0, ...sizes);
  // A piece of a few cells is no part of the town.
  const kept = new Set([...reached].filter((id) => (sizes[id] as number) >= 0.02 * largestSize));
  if (kept.size === 0) throw new TooSmall('the ground');
  const outside = new Uint8Array(size * size);
  const queue: number[] = [];
  for (let i = 0; i < size; i++) for (const j of [0, size - 1]) for (const index of [i * size + j, j * size + i]) if (!kept.has(piece[index] as number) && !outside[index]) (outside[index] = 1, queue.push(index));
  for (let k = 0; k < queue.length; k++) {
    const index = queue[k] as number;
    const [i, j] = [Math.floor(index / size), index % size];
    for (const [ii, jj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]] as Array<[number, number]>) {
      if (ii < 0 || jj < 0 || ii >= size || jj >= size) continue;
      const next = ii * size + jj;
      if (!kept.has(piece[next] as number) && !outside[next]) {
        outside[next] = 1;
        queue.push(next);
      }
    }
  }
  const mask: Field = { size, origin, cell, values: new Float64Array(size * size) };
  // Holes are filled, but not where they are water.
  for (let index = 0; index < size * size; index++) mask.values[index] = outside[index] || !dry(index) ? 0 : 1;
  // A cell at the edge of the grid is ground only if it is cheap: one that reaches the edge means too little room.
  for (let i = 0; i < size; i++) for (const index of [i * size, i * size + size - 1, i, (size - 1) * size + i]) if (mask.values[index]) throw new TooSmall('the ground');
  const outlines = contours(blur(mask, 0.8), 0.5)
    .filter((loop) => signedArea(loop) !== 0)
    .map((loop) => simplifyRing(chaikin([...loop, loop[0] as Point], 2).slice(0, -1), 0.2))
    .filter((loop) => area(loop) >= 0.02 * largestSize * cell * cell)
    // Outer loops only: one inside another is a hole round water, which the water's own strip takes out.
    .filter((loop, index, all) => !all.some((other, at) => at !== index && area(other) > area(loop) && inside(loop[0] as Point, other)))
    .sort((a, b) => area(b) - area(a));
  if (outlines.length === 0) throw new TooSmall('the ground');

  // Ranks: where a cost falls among the costs of the ground taken.
  const groundCosts: number[] = [];
  for (let index = 0; index < size * size; index++) if (mask.values[index] && Number.isFinite(value[index] as number)) groundCosts.push(value[index] as number);
  groundCosts.sort((a, b) => a - b);
  const rank = (of: number) => {
    let low = 0;
    let high = groundCosts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((groundCosts[middle] as number) <= of) low = middle + 1;
      else high = middle;
    }
    return groundCosts.length === 0 ? 0 : low / groundCosts.length;
  };
  const oldest = (share: number, smoothing: number) => {
    const limit = groundCosts[Math.min(groundCosts.length - 1, Math.floor(share * groundCosts.length))] as number;
    const old: Field = { size, origin, cell, values: new Float64Array(size * size) };
    for (let index = 0; index < size * size; index++) old.values[index] = mask.values[index] && (value[index] as number) <= limit ? 1 : 0;
    return mainLoop(contours(blur(old, smoothing / cell), 0.5));
  };
  return { outlines, cost, rank, oldest };
}
