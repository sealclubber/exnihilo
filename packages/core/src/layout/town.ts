/**
 * The fabric of a grown town: water, roads, the order its ground was built on,
 * its blocks and the streets between them. Steps 1 to 10 of the road-first
 * method (phase 6D.2); `grown.ts` puts districts, lots, the wall and exits on
 * what this makes.
 *
 * 1. Water, as phase 6D.1 made it.
 * 2. Highways and 3. arterials, as lines (`roads.ts`).
 * 4. A line along each bank of the river.
 * 5. The cost of ground: near a highway, near the centre along it, near an
 *    arterial, and a little by chance. The town takes the cheapest first.
 * 6. Patches, each with a grain from its nearest road.
 * 7. Block seeds as brickwork in each patch's grain, none on a road or in
 *    the water, and pairs either side of every road so that each road falls
 *    between blocks.
 * 8. One Voronoi diagram of every seed, not evened out.
 * 9. Each road found again as an unbroken chain of cell boundaries; streets
 *    paired through each junction, and the junctions pulled straight.
 * 10. Blocks: each cell drawn in from its streets.
 *
 * Every number comes from the pack's `grown` block; randomness from streams
 * named `grown-…`.
 */
import { type Rng, stepRng } from '../city/random.ts';
import type { GrownSettings, SettingPack } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import { type BlockSide, clip, makeBlock } from './blocks.ts';
import { type Fabric, type FabricCell, type Seed, scatter, weave } from './fabric.ts';
import { distance, pointInPolygon, polygonArea, polygonCentroid } from './geometry.ts';
import { Heap } from './heap.ts';
import { LineIndex, alongOf, chaikin, normal } from './lines.ts';
import { type RoadLine, type RoadPlan, planRoads } from './roads.ts';
import { type Coast, type River, makeCoast, makeRiver } from './water.ts';

const TAU = 2 * Math.PI;
/** Brickwork is laid on ground costing up to this many times the cost at which the town ends; beyond, a patch is one seed. */
const BRICKS_OUT = 3.5;

/** Thrown when the ground laid out proved too small; the town is laid out again on more. */
export class TooSmall extends Error {
  /** Which step found it too small. */
  readonly where: string;

  constructor(where: string) {
    super(`too small at ${where}`);
    this.where = where;
  }
}

/** What a boundary between two cells is. */
export type EdgeKind = 'highway' | 'arterial' | 'street' | 'lane' | 'wall' | 'none';

export interface Edge {
  id: number;
  a: number;
  b: number;
  cells: number[];
  kind: EdgeKind;
  /** A bridge: not a boundary between cells at all. */
  bridge?: true;
  /** The plan's road it carries, and for a highway the brief's route. */
  road?: number;
  route?: number;
  /** Kept as a street. */
  street: boolean;
  /** For a street that runs up to the wall: the corner on the wall, which it stops short of. */
  wallEnd?: number;
}

export interface Cell extends FabricCell {
  water: boolean;
  /** Inside the wall's line. */
  inside: boolean;
  centre: Point;
  /** The cells it shares a boundary with. */
  touching: number[];
  /** What its ground costs: the lower, the sooner it was built on. */
  cost: number;
}

export type Way = { to: number; edge: number };

/** What the town's size and flags ask of the fabric. */
export interface TownNeeds {
  /** The lot area of every building but the plaza, in square metres. */
  lotArea: number;
  /** The plaza's area, or 0 for none. */
  plazaArea: number;
  /** How many gatehouses there are, or 0 for no wall. */
  gatehouses: number;
  /** The wall encloses every block. */
  enclosesAll: boolean;
  /** How many times the usual ground to lay out: more each time a layout proves too small. */
  room: number;
  /** The lot area of the central districts, for how far out a coast stands. */
  centralLotArea: number;
}

export interface Town {
  river?: River;
  coast?: Coast;
  dryBy: (point: Point) => number;
  plan: RoadPlan;
  corners: Point[];
  cells: Cell[];
  /** Every boundary, and every possible bridge after them. */
  edges: Edge[];
  ways: Way[][];
  around: number[][];
  /** The cells of the town, in the order their ground was taken. */
  ground: number[];
  /** Each town cell's growth rank, from 0 for the first taken to 1 for the last. */
  rank: Map<number, number>;
  /** Each road's chain of edges, by the plan's road index; for a highway from the centre outward. */
  chains: Map<number, number[]>;
  /** The corners where a road passes the wall, in the order they were opened. */
  gates: number[];
  wallCorners: Set<number>;
  wallLine?: Point[];
  plazaCell?: number;
  /** The width of the roadway along an edge. */
  widthOf: (edge: Edge) => number;
  /** The block drawn in from a town cell's streets: empty if nothing is left of it. */
  blockOf: (cell: number) => Point[];
  /** Takes a cell into the town after the rest: a street along each side of it that has none and could. Returns the cells whose blocks that changed. */
  addGround: (cell: number) => number[];
  /** Whether a boundary could carry a street: not the wall, dry, with ground on one side. */
  passable: (edge: Edge) => boolean;
  /** Whether a boundary lies between ground and water. */
  atWater: (edge: Edge) => boolean;
  /** How far a point's ground costs, and the cost at which the town ends. */
  cost: (point: Point) => number;
  townCost: number;
  bankside: number;
}

export function layTown(brief: SettlementBrief, pack: SettingPack, grown: GrownSettings, seed: number, needs: TownNeeds): Town {
  const settings = pack.layout;
  const widths = settings.streetWidths;
  const { roadside } = grown;
  const rngOf = (step: string): Rng => stepRng(seed, step);
  const needed = needs.lotArea / grown.lotShare + needs.plazaArea;
  const root = Math.sqrt(needed);
  const plazaRadius = Math.sqrt(needs.plazaArea / Math.PI);
  // How far out roads and seeds reach: well beyond the town, more each time it proved too small.
  const far = Math.max(root * (grown.arterials.span + grown.arterials.reach) * needs.room, 4 * grown.patches.spacing);

  // ---- 1. Water -------------------------------------------------------------------------------------------------
  const river: River | undefined = makeRiver(brief, settings.riverWidth, grown.river, seed, plazaRadius + 1.6 * grown.blocks.depth + settings.riverWidth, far * 1.6);
  if (brief.river && !river) throw new Error(`${brief.id} (${brief.name}): the brief has a river with no bearing to place it by`);
  let coast: Coast | undefined;
  if (brief.coast.waterBearing !== undefined) coast = makeCoast(brief, grown.coast, seed, Math.sqrt((needs.centralLotArea / grown.lotShare + needs.plazaArea) / Math.PI) + 1.5 * grown.blocks.depth, far * 1.3);
  const dryBy = (point: Point) => Math.min(river ? river.gap(point) : Infinity, coast ? coast.gap(point) : Infinity);
  if (dryBy([0, 0]) < grown.blocks.depth / 2) throw new Error(`${brief.id} (${brief.name}): the town centre is under water`);
  // A street along the water stands back far enough for a lot's width between them to bow no more than a lane.
  const bankside = widths.street / 2 + roadside + widths.lane / 2 + 1;

  // ---- 2, 3. Highways and arterials --------------------------------------------------------------------------
  const plan = planRoads({ brief, settings: grown, rng: rngOf, far, root, dryBy, ...(river && { river }), ...(coast && { coast }), bankside });
  const trunkSet = new Set(plan.trunks);
  const trunkIndex = new LineIndex(50);
  const trunkOf: number[] = [];
  const arterialIndex = new LineIndex(50);
  const roadIndex = new LineIndex(50);
  plan.roads.forEach((road, index) => {
    if (trunkSet.has(index)) {
      trunkIndex.add(road.points);
      trunkOf.push(index);
    } else arterialIndex.add(road.points);
    roadIndex.add(road.points);
  });

  // ---- 4. Along the water ------------------------------------------------------------------------------------
  // A line along each bank, where a street will run: it gives the ground there its grain and seeds its blocks.
  const banks: Point[][] = [];
  if (river) {
    for (const sign of [1, -1]) {
      let run: Point[] = [];
      const flush = () => {
        if (run.length > 3) banks.push(chaikin(run, 1));
        run = [];
      };
      for (let along = 0; along < (river.along[river.along.length - 1] as number); along += 6) {
        const { point, direction, width } = river.at(along);
        const out = width / 2 + bankside;
        const on: Point = [point[0] - direction[1] * sign * out, point[1] + direction[0] * sign * out];
        // Not where another stretch of the river comes nearer, at a bend, nor beyond the ground laid out.
        if (Math.hypot(on[0], on[1]) > far || river.gap(on) < out - width / 2 - 1 || (coast && coast.gap(on) < bankside)) flush();
        else run.push(on);
      }
      flush();
    }
  }
  // And along the shore.
  if (coast) {
    let run: Point[] = [];
    const flush = () => {
      if (run.length > 3) banks.push(chaikin(run, 1));
      run = [];
    };
    for (let along = -far; along <= far; along += 6) {
      const out = coast.shoreAt(along) - bankside;
      const on: Point = [coast.seaward[0] * out + coast.alongShore[0] * along, coast.seaward[1] * out + coast.alongShore[1] * along];
      if (Math.hypot(on[0], on[1]) > far || (river && river.gap(on) < bankside)) flush();
      else run.push(on);
    }
    flush();
  }
  for (const bank of banks) roadIndex.add(bank);

  // ---- 5. The cost of ground ---------------------------------------------------------------------------------
  const noiseRng = rngOf('grown-ground');
  const phases = [noiseRng.next() * TAU, noiseRng.next() * TAU];
  const { ground: costs } = grown;
  const cost = (point: Point): number => {
    const highway = trunkIndex.nearest(point) as NonNullable<ReturnType<LineIndex['nearest']>>;
    const arterial = arterialIndex.size > 0 ? arterialIndex.nearest(point, costs.arterialCap) : undefined;
    let value = highway.distance + costs.along * highway.along + costs.arterial * Math.min(arterial ? arterial.distance : costs.arterialCap, costs.arterialCap);
    value += costs.noise.depth * Math.sin(point[0] / costs.noise.length + (phases[0] as number)) * Math.cos(point[1] / (1.3 * costs.noise.length) + (phases[1] as number));
    // Ground across the water from both its nearest highway and its nearest arterial.
    const across = (to: Point) => {
      for (let step = 1; step < 6; step++) {
        const t = step / 6;
        if (dryBy([point[0] + (to[0] - point[0]) * t, point[1] + (to[1] - point[1]) * t]) < 0) return true;
      }
      return false;
    };
    if (across(highway.point) && (!arterial || across(arterial.point))) value += costs.water;
    return value;
  };
  // The cost at which the town ends: where cheaper dry ground than that comes to what the town needs.
  const GRID = 20;
  const sampled: number[] = [];
  for (let x = -far; x <= far; x += GRID) {
    for (let y = -far; y <= far; y += GRID) {
      if (x * x + y * y > far * far || dryBy([x, y]) < 0) continue;
      sampled.push(cost([x, y]));
    }
  }
  sampled.sort((a, b) => a - b);
  const quantile = (area: number) => {
    const index = Math.floor(area / (GRID * GRID));
    if (index >= sampled.length) throw new TooSmall('the cost of ground');
    return sampled[index] as number;
  };
  const townCost = quantile(needed);
  const rankAt = (point: Point) => Math.max(0, cost(point) / townCost);

  // ---- The wall's line --------------------------------------------------------------------------------------
  // The edge of the oldest ground, blurred over `smoothing` metres and traced as a contour: it has the town's shape,
  // arms and all, and is never a circle.
  let wallLine: Point[] | undefined;
  if (needs.gatehouses > 0) {
    const wallCost = needs.enclosesAll ? townCost * 1.6 : quantile(grown.wall.share * needed);
    const size = Math.ceil((2 * far) / GRID) + 1;
    const at = (i: number) => -far + i * GRID;
    // Old ground is 1 and the rest 0, then blurred.
    let field: Float64Array = new Float64Array(size * size);
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const point: Point = [at(i), at(j)];
        if (point[0] * point[0] + point[1] * point[1] > far * far || dryBy(point) < 0) continue;
        if (cost(point) < wallCost) field[i * size + j] = 1;
      }
    }
    const sigma = grown.wall.smoothing / GRID;
    const radius = Math.ceil(3 * sigma);
    const kernel = Array.from({ length: 2 * radius + 1 }, (_, k) => Math.exp(-((k - radius) ** 2) / (2 * sigma * sigma || 1)));
    const total = kernel.reduce((sum, value) => sum + value, 0);
    for (const across of [true, false]) {
      const next = new Float64Array(size * size);
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
          let sum = 0;
          for (let k = -radius; k <= radius; k++) {
            const [ii, jj] = across ? [i + k, j] : [i, j + k];
            if (ii < 0 || jj < 0 || ii >= size || jj >= size) continue;
            sum += (kernel[k + radius] as number) * (field[ii * size + jj] as number);
          }
          next[i * size + j] = sum / total;
        }
      }
      field = next;
    }
    // The contour at a half, by marching squares; of its loops, the longest one round the centre.
    const value = (i: number, j: number) => field[i * size + j] as number;
    const edgePoint = (i1: number, j1: number, i2: number, j2: number): Point => {
      const [v1, v2] = [value(i1, j1), value(i2, j2)];
      const t = v1 === v2 ? 0.5 : (0.5 - v1) / (v2 - v1);
      return [at(i1) + (at(i2) - at(i1)) * t, at(j1) + (at(j2) - at(j1)) * t];
    };
    const ends = new Map<string, Array<{ other: string; from: Point; to: Point }>>();
    const keyOf = (i1: number, j1: number, i2: number, j2: number) => (i1 < i2 || (i1 === i2 && j1 < j2) ? `${i1},${j1},${i2},${j2}` : `${i2},${j2},${i1},${j1}`);
    for (let i = 0; i < size - 1; i++) {
      for (let j = 0; j < size - 1; j++) {
        const corners4: Array<[number, number]> = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
        const inside4 = corners4.map(([ci, cj]) => value(ci, cj) >= 0.5);
        const sides: Array<[number, number, number, number]> = [];
        for (let k = 0; k < 4; k++) {
          const [a1, a2] = [corners4[k] as [number, number], corners4[(k + 1) % 4] as [number, number]];
          if (inside4[k] !== inside4[(k + 1) % 4]) sides.push([a1[0], a1[1], a2[0], a2[1]]);
        }
        // Two crossings make one piece; four (a saddle) make two, paired round the square.
        for (let k = 0; k + 1 < sides.length; k += 2) {
          const [one, two] = [sides[k] as [number, number, number, number], sides[k + 1] as [number, number, number, number]];
          const [ka, kb] = [keyOf(...one), keyOf(...two)];
          const [pa, pb] = [edgePoint(...one), edgePoint(...two)];
          ends.set(ka, [...(ends.get(ka) ?? []), { other: kb, from: pa, to: pb }]);
          ends.set(kb, [...(ends.get(kb) ?? []), { other: ka, from: pb, to: pa }]);
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
        const next = (ends.get(key) ?? []).find((piece) => !used.has(piece.other));
        const any = (ends.get(key) ?? [])[0];
        if (!any) break;
        loop.push((next ?? any).from);
        if (!next) break;
        key = next.other;
      }
      if (loop.length > 8) loops.push(loop);
    }
    const around = loops.filter((loop) => pointInPolygon([0, 0], loop)).sort((a, b) => b.length - a.length);
    const chosen = around[0] ?? loops.sort((a, b) => b.length - a.length)[0];
    if (chosen) wallLine = chaikin([...chosen, chosen[0] as Point], 2).slice(0, -1);
  }
  const insideWall = (point: Point) => (wallLine ? pointInPolygon(point, wallLine) : true);

  // ---- 6. Patches and their grain -----------------------------------------------------------------------------
  const patchRng = rngOf('grown-patches');
  const patches = scatter(patchRng, far, () => grown.patches.spacing, () => false, []).map((patch) => {
    const near = roadIndex.nearest(patch.point);
    const grain = (near ? Math.atan2(near.direction[1], near.direction[0]) : 0) + ((grown.patches.turn * Math.PI) / 180) * normal(patchRng);
    const age = Math.min(1, rankAt(patch.point));
    const scale = grown.blocks.oldScale + (1 - grown.blocks.oldScale) * age;
    const pick = (range: { min: number; max: number }) => range.min + (range.max - range.min) * patchRng.next();
    return { point: patch.point, grain, depth: grown.blocks.depth * pick(grown.blocks.depthSpread) * scale, length: grown.blocks.length * pick(grown.blocks.lengthSpread) * scale };
  });
  const patchSquare = grown.patches.spacing;
  const patchFiled = new Map<string, number[]>();
  patches.forEach((patch, index) => {
    const key = `${Math.floor(patch.point[0] / patchSquare)}:${Math.floor(patch.point[1] / patchSquare)}`;
    patchFiled.set(key, [...(patchFiled.get(key) ?? []), index]);
  });
  const patchAt = (point: Point): number => {
    const cx = Math.floor(point[0] / patchSquare);
    const cy = Math.floor(point[1] / patchSquare);
    let best = -1;
    let nearest = Infinity;
    for (let x = cx - 2; x <= cx + 2; x++) {
      for (let y = cy - 2; y <= cy + 2; y++) {
        for (const index of patchFiled.get(`${x}:${y}`) ?? []) {
          const away = distance((patches[index] as (typeof patches)[number]).point, point);
          if (away < nearest) {
            nearest = away;
            best = index;
          }
        }
      }
    }
    return best;
  };

  // ---- 7. Block seeds ----------------------------------------------------------------------------------------
  const seedRng = rngOf('grown-seeds');
  const { roadSeeds } = grown;
  const fixed: Seed[] = [];
  // The plaza is a block of its own: a seed at the centre and a ring of seeds twice its radius away.
  if (needs.plazaArea > 0) {
    fixed.push({ point: [0, 0], fixed: true });
    const count = Math.max(6, Math.round((TAU * 2 * plazaRadius) / grown.blocks.depth));
    const start = seedRng.next() * TAU;
    for (let index = 0; index < count; index++) {
      const angle = start + (TAU * (index + (seedRng.next() - 0.5) * 0.3)) / count;
      const away = 2 * plazaRadius * (1 + (seedRng.next() - 0.5) * 0.12);
      fixed.push({ point: [Math.sin(angle) * away, -Math.cos(angle) * away], fixed: true });
    }
  }
  /** Pairs of seeds either side of a line. `exact` pairs stand straight across from each other, so the line is a boundary exactly. */
  const pairsAlong = (line: Point[], exact: boolean, waterSide: boolean) => {
    const along = alongOf(line);
    const length = along[along.length - 1] as number;
    let s = seedRng.next() * 40;
    let piece = 1;
    while (s < length) {
      while (piece < line.length - 1 && (along[piece] as number) < s) piece++;
      const [a, b] = [line[piece - 1] as Point, line[piece] as Point];
      const run = distance(a, b) || 1;
      const t = Math.min(1, Math.max(0, (s - (along[piece - 1] as number)) / run));
      const base: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const tangent: Point = [(b[0] - a[0]) / run, (b[1] - a[1]) / run];
      const side: Point = [-tangent[1], tangent[0]];
      const shift = exact ? 0 : (seedRng.next() * 2 - 1) * 8;
      const other = exact ? 0 : shift + (seedRng.next() * 2 - 1) * 18;
      const spacing = roadSeeds.spacing.min + (roadSeeds.spacing.max - roadSeeds.spacing.min) * seedRng.next();
      s += exact ? Math.min(spacing, 0.85 * roadSeeds.spacing.min + 0.15 * spacing) : spacing;
      if (Math.hypot(base[0], base[1]) > far * 0.97) continue;
      // None crowds the plaza's ring.
      if (needs.plazaArea > 0 && Math.hypot(base[0], base[1]) < 2.6 * plazaRadius + roadSeeds.offset) continue;
      for (const [sign, slide] of [[1, shift], [-1, other]] as const) {
        const point: Point = [base[0] + side[0] * roadSeeds.offset * sign + tangent[0] * slide, base[1] + side[1] * roadSeeds.offset * sign + tangent[1] * slide];
        const wet = dryBy(point) < 0;
        if (wet && !waterSide) continue;
        fixed.push({ point, fixed: true, ...(wet && { water: true as const }) });
      }
    }
  };
  if (wallLine) pairsAlong([...wallLine, wallLine[0] as Point], true, false);
  for (const bank of banks) pairsAlong(bank, true, true);
  // A quay's blocks are seeded by the shore's pairs.
  plan.roads.forEach((road) => {
    if (road.kind !== 'quay') pairsAlong(road.points, false, false);
  });
  const nearRoad = (point: Point, reach: number) => roadIndex.nearest(point, reach) !== undefined;
  const wallIndex = new LineIndex(50);
  if (wallLine) wallIndex.add([...wallLine, wallLine[0] as Point]);
  const bricks: Seed[] = [];
  const outer = BRICKS_OUT * townCost;
  patches.forEach((patch, index) => {
    const reach = 1.65 * grown.patches.spacing;
    const [ca, sa] = [Math.cos(patch.grain), Math.sin(patch.grain)];
    // Beyond the town's likely ground a patch is one seed: the land there needs no blocks. Out in the water, the
    // same, marked as water.
    if (dryBy(patch.point) < 0) {
      bricks.push({ point: patch.point, water: true });
      return;
    }
    if (cost(patch.point) > outer) {
      bricks.push({ point: patch.point });
      return;
    }
    let row = 0;
    for (let v = -reach; v < reach; v += patch.depth, row++) {
      const shift = (row % 2) * (patch.length / 2) + (seedRng.next() * 2 - 1) * grown.blocks.rowShift * patch.length;
      for (let u = -reach; u < reach; u += patch.length) {
        const uu = u + shift + normal(seedRng) * patch.length * grown.blocks.jitter.along;
        const vv = v + normal(seedRng) * patch.depth * grown.blocks.jitter.across;
        const point: Point = [patch.point[0] + uu * ca - vv * sa, patch.point[1] + uu * sa + vv * ca];
        if (patchAt(point) !== index || Math.hypot(point[0], point[1]) > far) continue;
        if (cost(point) > outer) continue;
        bricks.push({ point });
      }
    }
  });
  // No block seed on a road, in the water, inside the plaza's ring or on the wall's line.
  const plazaRing = needs.plazaArea > 0 ? 2.6 * plazaRadius : 0;
  const keptBricks = bricks.filter(({ point, water }) => water || !nearRoad(point, roadSeeds.clear) && (water || dryBy(point) >= roadSeeds.waterClear) && Math.hypot(point[0], point[1]) >= plazaRing && wallIndex.nearest(point, roadSeeds.clear) === undefined);
  // Seeds nearer than `nearest` to one kept before them are dropped: the fixed first, then the bricks.
  const seeds: Seed[] = [];
  const seedFiled = new Map<string, number[]>();
  const square = roadSeeds.nearest;
  for (const candidate of [...fixed, ...keptBricks]) {
    const cx = Math.floor(candidate.point[0] / square);
    const cy = Math.floor(candidate.point[1] / square);
    let crowded = false;
    for (let x = cx - 1; x <= cx + 1 && !crowded; x++) {
      for (let y = cy - 1; y <= cy + 1 && !crowded; y++) {
        for (const index of seedFiled.get(`${x}:${y}`) ?? []) if (distance((seeds[index] as Seed).point, candidate.point) < roadSeeds.nearest) crowded = true;
      }
    }
    // The plaza's own seed is kept whatever is near it.
    if (crowded && !(candidate.point[0] === 0 && candidate.point[1] === 0)) continue;
    seeds.push(candidate);
    const key = `${cx}:${cy}`;
    seedFiled.set(key, [...(seedFiled.get(key) ?? []), seeds.length - 1]);
  }

  // ---- 8. Cells ----------------------------------------------------------------------------------------------
  const fabric: Fabric = weave(seeds, far, grown.streets.shortest, () => false, false);
  const corners = fabric.corners;
  const around = fabric.around;
  const outlineOf = (cell: FabricCell): Point[] => cell.corners.map((corner) => corners[corner] as Point);
  const tooWet = (point: Point) => dryBy(point) < widths.street / 2 + roadside / 2;
  const cells: Cell[] = fabric.cells.map((cell) => {
    const outline = outlineOf(cell);
    const centre = polygonCentroid(outline);
    const midway = (point: Point, index: number): Point => [(point[0] + (outline[(index + 1) % outline.length] as Point)[0]) / 2, (point[1] + (outline[(index + 1) % outline.length] as Point)[1]) / 2];
    const water = cell.seed.water === true || dryBy(centre) < 0 || outline.some(tooWet) || outline.some((point, index) => tooWet(midway(point, index))) || outline.some((point) => dryBy([(point[0] + centre[0]) / 2, (point[1] + centre[1]) / 2]) < 0);
    return { ...cell, water, inside: insideWall(cell.seed.point), centre, touching: [], cost: cost(cell.seed.point) };
  });
  const isGround = (id: number) => !(cells[id] as Cell).water && !(cells[id] as Cell).rim;
  const edges: Edge[] = fabric.edges.map((edge) => ({ ...edge, kind: 'street' as EdgeKind, street: false }));
  for (const edge of edges) {
    const [one, other] = edge.cells;
    if (one === undefined || other === undefined) continue;
    if (wallLine && isGround(one) && isGround(other) && (cells[one] as Cell).inside !== (cells[other] as Cell).inside) edge.kind = 'wall';
    if (isGround(one) && isGround(other)) {
      (cells[one] as Cell).touching.push(other);
      (cells[other] as Cell).touching.push(one);
    }
  }
  const drynessBetween = (a: Point, b: Point) => {
    const pieces = Math.max(1, Math.ceil(distance(a, b) / 5));
    let least = Infinity;
    for (let at = 0; at <= pieces; at++) least = Math.min(least, dryBy([a[0] + ((b[0] - a[0]) * at) / pieces, a[1] + ((b[1] - a[1]) * at) / pieces]));
    return least;
  };
  const dryAlong = new Map<number, number>();
  const drynessOf = (edge: Edge) => {
    let dry = dryAlong.get(edge.id);
    if (dry === undefined) {
      dry = drynessBetween(corners[edge.a] as Point, corners[edge.b] as Point);
      dryAlong.set(edge.id, dry);
    }
    return dry;
  };
  const streetDry = widths.street / 2 + roadside / 2;
  const roadDry = widths.arterial / 2 + roadside / 2;
  const passable = (edge: Edge) => edge.bridge === true || (edge.kind !== 'wall' && edge.cells.some(isGround) && edge.cells.every((id) => !(cells[id] as Cell).rim) && drynessOf(edge) >= streetDry);
  const atWater = (edge: Edge) => edge.cells.length === 2 && edge.cells.some(isGround) && edge.cells.some((id) => (cells[id] as Cell).water);
  const wallCorners = new Set(edges.filter((edge) => edge.kind === 'wall').flatMap((edge) => [edge.a, edge.b]));
  const plazaCell = needs.plazaArea > 0 ? cells.find((cell) => cell.seed.fixed && cell.seed.point[0] === 0 && cell.seed.point[1] === 0)?.id : undefined;
  if (needs.plazaArea > 0 && (plazaCell === undefined || (cells[plazaCell] as Cell).water)) throw new Error(`${brief.id} (${brief.name}): the plaza has no dry ground at the centre`);

  // ---- Bridges that could be built -----------------------------------------------------------------------
  // Wherever a corner of one bank has a corner of the other nearly straight across, where the river is no wider than its mean.
  if (river) {
    const banksAt = new Map<number, { side: number; along: number; width: number }>();
    for (const edge of edges) {
      if (!atWater(edge) || !passable(edge)) continue;
      for (const corner of [edge.a, edge.b]) {
        if (banksAt.has(corner)) continue;
        const point = corners[corner] as Point;
        const near = river.nearest(point);
        if (near.away > near.width / 2 + bankside + grown.blocks.depth / 2) continue;
        const { direction } = river.at(near.along);
        banksAt.set(corner, { side: Math.sign(direction[0] * (point[1] - near.point[1]) - direction[1] * (point[0] - near.point[0])), along: near.along, width: near.width });
      }
    }
    for (const [corner, bank] of [...banksAt].sort((a, b) => a[0] - b[0])) {
      if (bank.side <= 0 || bank.width > river.width) continue;
      let best: number | undefined;
      let nearest = Infinity;
      for (const [other, across] of banksAt) {
        if (across.side >= 0) continue;
        const away = distance(corners[corner] as Point, corners[other] as Point);
        // Straight across: no further along the river than a third of the way over.
        if (Math.abs(across.along - bank.along) > away / 3 || away > bank.width + 2 * bankside + grown.blocks.depth / 2) continue;
        if (away < nearest || (away === nearest && other < (best as number))) {
          nearest = away;
          best = other;
        }
      }
      if (best === undefined) continue;
      edges.push({ id: edges.length, a: corner, b: best, cells: [], kind: 'street', bridge: true, street: false });
    }
  }
  const ways: Way[][] = corners.map(() => []);
  for (const edge of edges) {
    if (!passable(edge)) continue;
    (ways[edge.a] as Way[]).push({ to: edge.b, edge: edge.id });
    (ways[edge.b] as Way[]).push({ to: edge.a, edge: edge.id });
  }

  // ---- 9a. The roads as chains of boundaries ---------------------------------------------------------------
  const chains = new Map<number, number[]>();
  const onChain = new Set<number>();
  const gates: number[] = [];
  let gatesLeft = needs.gatehouses;
  const starts = plazaCell !== undefined ? (cells[plazaCell] as Cell).corners.filter((corner) => (ways[corner] as Way[]).length > 0) : (() => {
    let nearest = -1;
    corners.forEach((point, index) => {
      if ((ways[index] as Way[]).length > 0 && (nearest === -1 || Math.hypot(point[0], point[1]) < Math.hypot(...(corners[nearest] as Point)))) nearest = index;
    });
    return nearest === -1 ? [] : [nearest];
  })();
  if (starts.length === 0) throw new TooSmall('the centre');
  /** The cheapest way along the boundaries that keeps to a line, from any of `from` to the corner nearest its end. */
  const follow = (line: Point[], from: number[], crosses: boolean, mayGate: boolean, corridor = 4 * roadSeeds.offset): number[] | undefined => {
    const index = new LineIndex(40);
    index.add(line);
    const end = line[line.length - 1] as Point;
    let goal = -1;
    let goalAway = Infinity;
    for (let corner = 0; corner < corners.length; corner++) {
      if ((ways[corner] as Way[]).length === 0) continue;
      const away = distance(corners[corner] as Point, end);
      if (away < goalAway) {
        goalAway = away;
        goal = corner;
      }
    }
    if (goal < 0) return undefined;
    const reached = new Map<number, number>();
    const cameBy = new Map<number, [number, number]>();
    const heap = new Heap();
    for (const start of from) {
      reached.set(start, 0);
      heap.push(0, start);
    }
    while (heap.size > 0) {
      const [so, corner] = heap.pop();
      if (so > (reached.get(corner) as number)) continue;
      if (corner === goal) break;
      for (const way of ways[corner] as Way[]) {
        const edge = edges[way.edge] as Edge;
        if (edge.bridge && !crosses) continue;
        const [a, b] = [corners[edge.a] as Point, corners[edge.b] as Point];
        const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const near = index.nearest(middle, corridor);
        if (!near && way.to !== goal) continue;
        const off = near ? near.distance / roadSeeds.offset : 4;
        let step = distance(a, b) * (1 + off * off) * (onChain.has(edge.id) ? 4 : 1);
        // A main road keeps its own width clear of the water where it can; where it cannot, it narrows.
        if (!edge.bridge && drynessOf(edge) < roadDry) step *= 6;
        if (wallCorners.has(way.to)) {
          if (!mayGate) continue;
          step += 2 * grown.blocks.length;
        }
        const next = so + step;
        if (next < (reached.get(way.to) ?? Infinity)) {
          reached.set(way.to, next);
          cameBy.set(way.to, [corner, way.edge]);
          heap.push(next, way.to);
        }
      }
    }
    if (!cameBy.has(goal)) return undefined;
    const path: number[] = [];
    for (let back = goal; cameBy.has(back); back = (cameBy.get(back) as [number, number])[0]) path.push((cameBy.get(back) as [number, number])[1]);
    return path.reverse();
  };
  const cornersOf = (chain: number[], from: number[]): number[] => {
    const list: number[] = [];
    let at = from.find((corner) => {
      const first = edges[chain[0] as number] as Edge;
      return first.a === corner || first.b === corner;
    }) as number;
    list.push(at);
    for (const id of chain) {
      const edge = edges[id] as Edge;
      at = edge.a === at ? edge.b : edge.a;
      list.push(at);
    }
    return list;
  };
  const chainCorners = new Map<number, number[]>();
  const take = (road: number, chain: number[], from: number[]) => {
    chains.set(road, chain);
    chainCorners.set(road, cornersOf(chain, from));
    for (const id of chain) onChain.add(id);
    for (const corner of chainCorners.get(road) as number[]) {
      if (wallCorners.has(corner) && !gates.includes(corner)) {
        gates.push(corner);
        gatesLeft--;
      }
    }
  };
  /** The corner with a way out nearest a point. */
  const cornerNear = (point: Point): number => {
    let nearest = -1;
    for (let corner = 0; corner < corners.length; corner++) {
      if ((ways[corner] as Way[]).length === 0) continue;
      if (nearest === -1 || distance(corners[corner] as Point, point) < distance(corners[nearest] as Point, point)) nearest = corner;
    }
    return nearest;
  };
  plan.trunks.forEach((road) => {
    const trunk = plan.roads[road] as RoadLine;
    // A highway leaves from the centre; a quay from the point on the shore nearest it.
    const from = trunk.kind === 'quay' ? [cornerNear(trunk.points[0] as Point)] : starts;
    // A highway keeps to a corridor along its line where it can, and finds its way without one where it cannot. A
    // quay passes the wall only where a gatehouse is left to keep a gate.
    const mayGate = trunk.kind !== 'quay' || gatesLeft > 0;
    const chain = follow(trunk.points, from, true, mayGate) ?? follow(trunk.points, from, true, mayGate, Infinity);
    // A highway that reaches the sea within a block of the centre has no chain at all: it ends there.
    if (!chain || chain.length === 0) {
      if (trunk.kind === 'highway' && distance(trunk.points[trunk.points.length - 1] as Point, [0, 0]) < grown.blocks.length) {
        chains.set(road, []);
        chainCorners.set(road, [from[0] as number]);
        return;
      }
      if (trunk.kind === 'quay') return;
      throw new TooSmall('a highway');
    }
    take(road, chain, from);
  });
  // Arterials, those nearest the centre first: each from the corner of its highway's chain nearest where it leaves.
  const branches = plan.roads.map((road, index) => ({ road, index })).filter(({ road }) => road.kind === 'arterial');
  branches.sort((a, b) => (a.road.from?.along ?? 0) - (b.road.from?.along ?? 0) || a.index - b.index);
  const wallCrossing = (line: Point[]) => (wallLine ? line.findIndex((point) => !insideWall(point)) : -1);
  for (const { road, index } of branches) {
    const parent = chainCorners.get(road.from?.road ?? -1);
    if (!parent) continue;
    let line = road.points;
    // Through the wall only where a gatehouse is left to keep a gate; otherwise it ends inside.
    const leaves = wallCrossing(line);
    const passes = leaves > 0 && insideWall(line[0] as Point);
    if (passes && gatesLeft <= 0) line = line.slice(0, Math.max(2, leaves - Math.ceil(grown.blocks.depth / 6)));
    const base = line[0] as Point;
    let start = parent[0] as number;
    for (const corner of parent) if (distance(corners[corner] as Point, base) < distance(corners[start] as Point, base)) start = corner;
    const chain = follow(line, [start], road.crosses === true, passes && gatesLeft > 0);
    if (!chain || chain.length === 0) continue;
    take(index, chain, [start]);
  }
  for (const [road, chain] of chains) {
    const line = plan.roads[road] as RoadLine;
    for (const id of chain) {
      const edge = edges[id] as Edge;
      if (edge.road !== undefined && (plan.roads[edge.road] as RoadLine).kind !== 'arterial') continue;
      edge.road = road;
      edge.kind = line.kind === 'arterial' ? 'arterial' : 'highway';
      if (line.route !== undefined) edge.route = line.route;
    }
  }

  // ---- 5 again. Taking the ground --------------------------------------------------------------------------
  // Ground on a highway was built on first: a cell beside one costs `frontage` metres less.
  for (const [road, chain] of chains) {
    if (!trunkSet.has(road)) continue;
    for (const id of chain) for (const cell of (edges[id] as Edge).cells) {
      const entry = cells[cell] as Cell & { onHighway?: true };
      if (entry.onHighway) continue;
      entry.onHighway = true;
      entry.cost -= costs.frontage;
    }
  }
  // From the centre outward, cheapest first, each cell beside one already taken or across a bridge a road uses,
  // until the blocks will hold every lot.
  const usedBridges = edges.filter((edge) => edge.bridge && onChain.has(edge.id));
  const groundAt = (corner: number) => (around[corner] as number[]).flatMap((id) => (edges[id] as Edge).cells).filter(isGround);
  const beyondBridge = new Map<number, number[]>();
  for (const bridge of usedBridges) {
    for (const one of groundAt(bridge.a)) for (const other of groundAt(bridge.b)) {
      beyondBridge.set(one, [...(beyondBridge.get(one) ?? []), other]);
      beyondBridge.set(other, [...(beyondBridge.get(other) ?? []), one]);
    }
  }
  const inset = widths.street / 2 + roadside;
  const holds = (id: number) => {
    const outline = outlineOf(cells[id] as Cell);
    let perimeter = 0;
    outline.forEach((point, index) => {
      perimeter += distance(point, outline[(index + 1) % outline.length] as Point);
    });
    return Math.max(0, polygonArea(outline) - perimeter * inset) * 0.9;
  };
  const barred = (id: number) => !isGround(id) || (needs.enclosesAll && !(cells[id] as Cell).inside);
  const taken = new Set<number>();
  const order: number[] = [];
  const frontier = new Heap();
  const queued = new Set<number>();
  const offer = (id: number) => {
    if (queued.has(id) || barred(id)) return;
    queued.add(id);
    frontier.push((cells[id] as Cell).cost, id);
  };
  let room = 0;
  const takeCell = (id: number) => {
    taken.add(id);
    order.push(id);
    room += holds(id);
    for (const next of (cells[id] as Cell).touching) offer(next);
    for (const next of beyondBridge.get(id) ?? []) offer(next);
  };
  if (plazaCell !== undefined) {
    queued.add(plazaCell);
    takeCell(plazaCell);
  }
  for (const corner of starts) for (const id of groundAt(corner)) offer(id);
  while (room < needs.lotArea * 1.04) {
    if (frontier.size === 0) throw new TooSmall('the ground');
    const [, id] = frontier.pop();
    if (taken.has(id)) continue;
    if ((cells[id] as Cell).rim) throw new TooSmall('the rim');
    takeCell(id);
  }
  // Holes: ground no road reaches from outside the town, closed in by it, is town too.
  const outside = new Set<number>();
  {
    const queue = cells.filter((cell) => cell.rim).map((cell) => cell.id);
    for (const id of queue) outside.add(id);
    for (let at = 0; at < queue.length; at++) {
      const cell = cells[queue[at] as number] as Cell;
      const next = [...cell.edges.flatMap((edge) => (edges[edge] as Edge).cells)];
      for (const id of next) {
        if (outside.has(id) || taken.has(id)) continue;
        outside.add(id);
        queue.push(id);
      }
    }
  }
  const holes = cells.filter((cell) => !taken.has(cell.id) && !outside.has(cell.id) && isGround(cell.id)).map((cell) => cell.id).sort((a, b) => (cells[a] as Cell).cost - (cells[b] as Cell).cost || a - b);
  for (const id of holes) takeCell(id);
  // The rank is by cost: the cheapest ground was the first built on.
  const ground = [...order].sort((a, b) => (cells[a] as Cell).cost - (cells[b] as Cell).cost || a - b);
  if (plazaCell !== undefined) ground.splice(ground.indexOf(plazaCell), 1), ground.unshift(plazaCell);
  const rank = new Map(ground.map((id, index) => [id, ground.length === 1 ? 0 : index / (ground.length - 1)]));

  // ---- 9b. Which boundaries are streets -------------------------------------------------------------------
  for (const edge of edges) {
    if (edge.bridge) {
      edge.street = onChain.has(edge.id);
      continue;
    }
    if (edge.kind === 'wall') continue;
    const touchesTown = edge.cells.some((id) => taken.has(id));
    if (edge.kind === 'highway') edge.street = passable(edge);
    else edge.street = touchesTown && passable(edge);
    if (edge.kind === 'arterial' && !touchesTown) edge.street = false;
  }
  // No street touches the wall but at a gate: one that runs up to it stops a clear strip short of it; one that runs
  // along between two of its corners is none at all.
  if (wallLine) {
    for (const edge of edges) {
      if (edge.kind === 'wall' || edge.bridge) continue;
      const ends = [edge.a, edge.b].filter((corner) => wallCorners.has(corner));
      if (ends.length === 0 || (onChain.has(edge.id) && ends.every((corner) => gates.includes(corner)))) continue;
      if (ends.length === 1 && !gates.includes(ends[0] as number)) edge.wallEnd = ends[0] as number;
      else {
        edge.street = false;
        edge.kind = 'none';
      }
    }
  }
  // An arterial ends where the town does: its chain is kept as far as its last boundary beside a town block.
  for (const [road, chain] of chains) {
    if ((plan.roads[road] as RoadLine).kind !== 'arterial') continue;
    let last = -1;
    chain.forEach((id, at) => {
      if ((edges[id] as Edge).street) last = at;
    });
    chain.forEach((id, at) => {
      const edge = edges[id] as Edge;
      if (at > last && edge.kind === 'arterial') edge.street = false;
      // Over open ground between two parts of the town it is still a road.
      if (at <= last && !edge.street && passable(edge) && edge.kind === 'arterial') edge.street = true;
    });
  }

  // ---- 9c. Through streets, and junctions pulled straight -------------------------------------------------
  const isStreetEdge = (edge: Edge) => edge.street;
  const partners = new Map<string, number>();
  const pairKey = (corner: number, edge: number) => `${corner}:${edge}`;
  const angleBetween = (corner: number, one: Edge, other: Edge) => {
    const here = corners[corner] as Point;
    const a = corners[one.a === corner ? one.b : one.a] as Point;
    const b = corners[other.a === corner ? other.b : other.a] as Point;
    const d1: Point = [here[0] - a[0], here[1] - a[1]];
    const d2: Point = [b[0] - here[0], b[1] - here[1]];
    const cosine = (d1[0] * d2[0] + d1[1] * d2[1]) / ((Math.hypot(...d1) * Math.hypot(...d2)) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
  };
  const pairUp = (corner: number, one: number, other: number) => {
    partners.set(pairKey(corner, one), other);
    partners.set(pairKey(corner, other), one);
  };
  // Each road continues through every corner on its chain; the wall through every corner on it.
  for (const [road, chain] of chains) {
    const list = chainCorners.get(road) as number[];
    for (let at = 1; at < chain.length; at++) {
      const corner = list[at] as number;
      const [one, other] = [chain[at - 1] as number, chain[at] as number];
      if (!partners.has(pairKey(corner, one)) && !partners.has(pairKey(corner, other)) && (edges[one] as Edge).street && (edges[other] as Edge).street) pairUp(corner, one, other);
    }
  }
  for (let corner = 0; corner < corners.length; corner++) {
    const list = (around[corner] as number[]).filter((id) => (edges[id] as Edge).kind === 'wall');
    if (list.length === 2) pairUp(corner, list[0] as number, list[1] as number);
  }
  for (let corner = 0; corner < corners.length; corner++) {
    const list = (around[corner] as number[]).filter((id) => isStreetEdge(edges[id] as Edge) && (edges[id] as Edge).wallEnd !== corner && !partners.has(pairKey(corner, id)));
    const candidates: Array<{ deviation: number; one: number; other: number }> = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const deviation = angleBetween(corner, edges[list[i] as number] as Edge, edges[list[j] as number] as Edge);
        if (deviation < grown.streets.through) candidates.push({ deviation, one: list[i] as number, other: list[j] as number });
      }
    }
    candidates.sort((a, b) => a.deviation - b.deviation || a.one - b.one || a.other - b.other);
    for (const { one, other } of candidates) {
      if (partners.has(pairKey(corner, one)) || partners.has(pairKey(corner, other))) continue;
      pairUp(corner, one, other);
    }
  }
  // Pull each corner toward the line of the streets passing through it. Corners at the water, the rim and the plaza stay.
  const held = new Set<number>();
  for (const edge of edges) if (atWater(edge) || edge.bridge || edge.cells.some((id) => (cells[id] as Cell).rim)) (held.add(edge.a), held.add(edge.b));
  if (plazaCell !== undefined) for (const corner of (cells[plazaCell] as Cell).corners) held.add(corner);
  const cellsAt = new Map<number, number[]>();
  cells.forEach((cell) => {
    for (const corner of cell.corners) cellsAt.set(corner, [...(cellsAt.get(corner) ?? []), cell.id]);
  });
  const convex = (id: number) => {
    const outline = outlineOf(cells[id] as Cell);
    let sign = 0;
    for (let index = 0; index < outline.length; index++) {
      const [a, b, c] = [outline[index] as Point, outline[(index + 1) % outline.length] as Point, outline[(index + 2) % outline.length] as Point];
      const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(turn) < 1e-9) continue;
      if (sign === 0) sign = Math.sign(turn);
      else if (Math.sign(turn) !== sign) return false;
    }
    return true;
  };
  for (let round = 0; round < grown.streets.rounds; round++) {
    const targets = new Map<number, Point>();
    for (let corner = 0; corner < corners.length; corner++) {
      if (held.has(corner)) continue;
      let sum: Point = [0, 0];
      let count = 0;
      for (const id of around[corner] as number[]) {
        const other = partners.get(pairKey(corner, id));
        if (other === undefined || other < id) continue;
        const [one, two] = [edges[id] as Edge, edges[other] as Edge];
        const a = corners[one.a === corner ? one.b : one.a] as Point;
        const b = corners[two.a === corner ? two.b : two.a] as Point;
        sum = [sum[0] + (a[0] + b[0]) / 2, sum[1] + (a[1] + b[1]) / 2];
        count++;
      }
      if (count === 0) continue;
      const here = corners[corner] as Point;
      targets.set(corner, [here[0] * (1 - grown.streets.pull) + (sum[0] / count) * grown.streets.pull, here[1] * (1 - grown.streets.pull) + (sum[1] / count) * grown.streets.pull]);
    }
    for (const [corner, target] of [...targets].sort((a, b) => a[0] - b[0])) {
      const was = corners[corner] as Point;
      corners[corner] = target;
      const ok =
        (cellsAt.get(corner) ?? []).every((id) => convex(id)) &&
        (around[corner] as number[]).every((id) => {
          const edge = edges[id] as Edge;
          if (!edge.street) return true;
          const other = corners[edge.a === corner ? edge.b : edge.a] as Point;
          const need = edge.kind === 'highway' ? roadDry : streetDry;
          return distance(target, other) > grown.streets.shortest && drynessBetween(target, other) >= Math.min(need, drynessOf(edge));
        });
      if (!ok) corners[corner] = was;
      else for (const id of around[corner] as number[]) dryAlong.delete(id);
    }
  }
  for (const cell of cells) cell.centre = polygonCentroid(outlineOf(cell));
  // Streets that pass few junctions are lanes.
  {
    const seen = new Set<number>();
    for (const edge of edges) {
      if (!edge.street || edge.bridge || edge.kind !== 'street' || seen.has(edge.id)) continue;
      const chain = [edge.id];
      seen.add(edge.id);
      for (const start of [edge.a, edge.b]) {
        let corner = start;
        let id = edge.id;
        for (;;) {
          const next = partners.get(pairKey(corner, id));
          if (next === undefined || seen.has(next) || !(edges[next] as Edge).street || (edges[next] as Edge).kind !== 'street') break;
          seen.add(next);
          chain.push(next);
          const nextEdge = edges[next] as Edge;
          corner = nextEdge.a === corner ? nextEdge.b : nextEdge.a;
          id = next;
        }
      }
      if (chain.length - 1 < grown.streets.laneBelow) for (const id of chain) (edges[id] as Edge).kind = 'lane';
    }
  }

  // ---- 10. Blocks ---------------------------------------------------------------------------------------------
  // A highway squeezed past the water narrows to a street's width there.
  const widthOf = (edge: Edge): number => (edge.bridge ? widths.bridge : edge.kind === 'highway' ? (drynessOf(edge) >= roadDry ? widths.arterial : widths.street) : edge.kind === 'arterial' ? grown.arterials.width : edge.kind === 'lane' ? widths.lane : widths.street);
  const clearAt = (corner: number) => Math.max(0, ...(ways[corner] as Way[]).map((way) => edges[way.edge] as Edge).filter((edge) => edge.street).map((edge) => widthOf(edge) / 2), wallCorners.has(corner) ? grown.wall.width / 2 : 0) + roadside;
  const blocks = new Map<number, Point[]>();
  const blockOf = (id: number): Point[] => {
    const known = blocks.get(id);
    if (known) return known;
    const cell = cells[id] as Cell;
    const sides: BlockSide[] = cell.corners.map((corner, index) => {
      const edge = edges[cell.edges[index] as number] as Edge;
      const a = corners[corner] as Point;
      const b = corners[cell.corners[(index + 1) % cell.corners.length] as number] as Point;
      if (edge.kind === 'wall') return { a, b, inset: grown.wall.width / 2 + (cell.inside ? grown.wall.clearStrip : roadside) };
      if (edge.street) return { a, b, inset: widthOf(edge) / 2 + roadside };
      if (edge.kind === 'none') return { a, b, inset: 0 };
      // A boundary with no street: toward the water it keeps clear as if one ran there; toward open land, none.
      if (atWater(edge) || !passable(edge)) return { a, b, inset: widths.street / 2 + roadside };
      return { a, b, inset: 0 };
    });
    let polygon = makeBlock(sides).polygon;
    // Each corner is cut back to clear the roadways that meet there, and a little more, so the block reads as rounded.
    for (const corner of cell.corners) {
      if (polygon.length < 3) break;
      const at = corners[corner] as Point;
      const away = distance(at, cell.centre) || 1;
      const direction: Point = [(cell.centre[0] - at[0]) / away, (cell.centre[1] - at[1]) / away];
      const reach = clearAt(corner) + grown.streets.corner;
      polygon = clip(polygon, { at: [at[0] + direction[0] * reach, at[1] + direction[1] * reach], normal: direction });
    }
    const result = polygon.length >= 3 && polygonArea(polygon) > 1 ? polygon : [];
    blocks.set(id, result);
    return result;
  };

  const addGround = (id: number): number[] => {
    taken.add(id);
    const changed = new Set<number>([id]);
    for (const edgeId of (cells[id] as Cell).edges) {
      const edge = edges[edgeId] as Edge;
      if (edge.street || edge.bridge || edge.kind === 'wall' || edge.kind === 'none' || !passable(edge)) continue;
      if ([edge.a, edge.b].some((corner) => wallCorners.has(corner))) continue;
      edge.street = true;
      if (edge.kind === 'highway' || edge.kind === 'arterial') edge.kind = 'street';
      // The block on the other side keeps clear of the new street too.
      for (const cell of edge.cells) changed.add(cell);
    }
    for (const cell of changed) blocks.delete(cell);
    return [...changed];
  };

  return {
    ...(river && { river }),
    ...(coast && { coast }),
    dryBy,
    plan,
    corners,
    cells,
    edges,
    ways,
    around,
    ground,
    rank,
    chains,
    gates,
    wallCorners,
    ...(wallLine && { wallLine }),
    ...(plazaCell !== undefined && { plazaCell }),
    widthOf,
    blockOf,
    addGround,
    passable,
    atWater,
    cost,
    townCost,
    bankside,
  };
}
