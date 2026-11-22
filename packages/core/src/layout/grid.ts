/**
 * The simple layout generator: a regular street grid, trimmed to a compact
 * outline, with lots along the streets. It is deliberately plain, so that
 * when something later looks wrong on the map it is easy to tell whether the
 * layout or the behaviour is at fault.
 *
 * A finished city, its brief, the pack and a seed in; a layout out. The city
 * is read and never changed. Every length comes from the pack's layout
 * settings. Randomness comes from streams of this generator's own.
 *
 * The steps, in order:
 *   1. Give every building a lot size from the pack.
 *   2. Lay a grid of streets and blocks around the centre.
 *   3. Place the river from the brief's bearings, beside the centre.
 *   4. Grow the districts block by block, packing each one's lots as it grows:
 *      centre kinds first, then waterside, middle and edge kinds. A coastal
 *      town's shore is set just beyond its centre and waterside districts.
 *   5. Put an exit on the town's edge at each of the brief's bearings and mark
 *      the streets from the centre to it as an arterial, bridging the river.
 *   6. Keep the streets that border a used block or carry an arterial, and
 *      join up anything left apart, with further bridges if need be.
 *   7. Write the records and check every layout invariant.
 */
import type { Building, City, District } from '../city/records.ts';
import { stepRng } from '../city/random.ts';
import { idNumber } from '../ids.ts';
import { type SettingPack, footprintCoverageOf, lotSizeOf } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import {
  EPSILON,
  bearingVector,
  boxOf,
  crossingsOfPolyline,
  distance,
  distanceBetweenPolylines,
  distancePolygonToPolyline,
  distanceToPolyline,
} from './geometry.ts';
import { Heap } from './heap.ts';
import { BEARING_TOLERANCE, checkLayout } from './invariants.ts';
import { type Exit, type Junction, type Layout, type Lot, type Segment, type SegmentKind, type Water, LAYOUT_VERSION } from './records.ts';

/** The name this generator records in a layout's summary. */
export const GRID_GENERATOR = 'grid';

export class LayoutGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutGenerationError';
  }
}

export interface LayoutOptions {
  /** Replaces the brief's own seed. */
  seed?: number;
  /**
   * false leaves each building on the lot it was first given, as layout version 2 did, instead of gathering
   * trades along streets. The lots themselves are the same either way; this is for comparing the two.
   */
  arrange?: boolean;
}

/** How many blocks a district may grow to find a street that has none of a spread civic type yet. */
const APART_BLOCKS = 3;

/** Thrown inside an attempt when the grid of candidate blocks proved too small; the attempt is repeated on a larger one. */
class GridTooSmall extends Error {}

const pad = (value: number, digits: number) => String(value).padStart(digits, '0');
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];

export function generateLayout(city: City, brief: SettlementBrief, pack: SettingPack, options: LayoutOptions = {}): Layout {
  const seed = options.seed ?? brief.seed;
  const settings = pack.layout;
  const totalLotArea = city.buildings.reduce((sum, building) => {
    const size = lotSizeOf(building.type, pack);
    return sum + size.frontage * size.depth;
  }, 0);
  // Start with room for twice the blocks the lots need, and double the grid for as long as it proves too small.
  const needed = totalLotArea / (settings.block.length * settings.block.depth);
  let half = Math.max(4, Math.ceil(Math.sqrt(needed)) + 2);
  for (let attempt = 0; ; attempt++, half *= 2) {
    try {
      return attemptLayout(city, brief, pack, seed, half, options.arrange !== false);
    } catch (error) {
      if (!(error instanceof GridTooSmall) || attempt >= 6) {
        if (error instanceof GridTooSmall) {
          throw new LayoutGenerationError(`${brief.id} (${brief.name}): the town does not fit even a grid of ${2 * half} blocks a side`);
        }
        throw error;
      }
    }
  }
}

function attemptLayout(city: City, brief: SettlementBrief, pack: SettingPack, seed: number, half: number, arrange: boolean): Layout {
  const settings = pack.layout;
  const number = idNumber(brief.id);
  const fail = (message: string): never => {
    throw new LayoutGenerationError(`${brief.id} (${brief.name}): ${message}`);
  };

  // ---- The grid ------------------------------------------------------------------
  // Streets run along grid lines; the centre is a crossing. A cell is the square between
  // four lines, and the block inside it is the cell less half the widest roadway all round.
  const widths = settings.streetWidths;
  const widest = Math.max(widths.arterial, widths.street, widths.lane, widths.bridge);
  const inset = widest / 2;
  const pitchX = settings.block.length + widest;
  const pitchY = settings.block.depth + widest;
  const diagonal = Math.hypot(pitchX, pitchY);
  const side = 2 * half;
  const cellCount = side * side;
  const cellAt = (i: number, j: number) => i + half + (j + half) * side;
  const cellI = (cell: number) => (cell % side) - half;
  const cellJ = (cell: number) => Math.floor(cell / side) - half;
  const cellCorners = (cell: number): Point[] => {
    const x = cellI(cell) * pitchX;
    const y = cellJ(cell) * pitchY;
    return [
      [x, y],
      [x + pitchX, y],
      [x + pitchX, y + pitchY],
      [x, y + pitchY],
    ];
  };
  const cellCentre = (cell: number): Point => [(cellI(cell) + 0.5) * pitchX, (cellJ(cell) + 0.5) * pitchY];
  const junctionAt = (i: number, j: number) => i + half + (j + half) * (side + 1);
  const junctionI = (junction: number) => (junction % (side + 1)) - half;
  const junctionJ = (junction: number) => Math.floor(junction / (side + 1)) - half;
  const junctionPoint = (junction: number): Point => [junctionI(junction) * pitchX, junctionJ(junction) * pitchY];
  const junctionCount = (side + 1) * (side + 1);
  // Edges: the horizontal one east of junction (i, j), then the vertical one south of it.
  const horizontalCount = side * (side + 1);
  const horizontalAt = (i: number, j: number) => i + half + (j + half) * side;
  const verticalAt = (i: number, j: number) => horizontalCount + i + half + (j + half) * (side + 1);
  const gridEdgeCount = 2 * horizontalCount;
  const edgeEnds = (edge: number): [number, number] => {
    if (edge < horizontalCount) {
      const i = (edge % side) - half;
      const j = Math.floor(edge / side) - half;
      return [junctionAt(i, j), junctionAt(i + 1, j)];
    }
    const rest = edge - horizontalCount;
    const i = (rest % (side + 1)) - half;
    const j = Math.floor(rest / (side + 1)) - half;
    return [junctionAt(i, j), junctionAt(i, j + 1)];
  };
  const neighbourCells = (cell: number): number[] => {
    const i = cellI(cell);
    const j = cellJ(cell);
    const result: number[] = [];
    if (i > -half) result.push(cellAt(i - 1, j));
    if (i < half - 1) result.push(cellAt(i + 1, j));
    if (j > -half) result.push(cellAt(i, j - 1));
    if (j < half - 1) result.push(cellAt(i, j + 1));
    return result;
  };
  const onBorder = (cell: number) => {
    const i = cellI(cell);
    const j = cellJ(cell);
    return i === -half || i === half - 1 || j === -half || j === half - 1;
  };

  // ---- The river --------------------------------------------------------------------
  // A band from the brief's arrival bearing to its departure bearing, bending beside the
  // centre. Its ends lie beyond the grid, so it always reaches the town's edge.
  const far = (half + 2) * diagonal;
  const riverClearance = settings.riverWidth / 2 + widest / 2;
  let riverLine: Point[] | undefined;
  if (brief.river) {
    const arrives = brief.river.arrivesFrom?.bearing;
    // A river that ends here runs on to the sea, or failing that out of the far side of town.
    const leaves =
      brief.river.leavesToward?.bearing ??
      brief.coast.waterBearing ??
      (arrives === undefined ? fail('the brief has a river with no bearing to place it by') : (arrives + 180) % 360);
    const beside = riverClearance + Math.max(pitchX, pitchY);
    const end = (bearing: number): Point => {
      const [x, y] = bearingVector(bearing);
      return [x * far, y * far];
    };
    if (arrives === undefined) {
      // A river that rises here starts beside the centre and runs out at its departure bearing.
      const [x, y] = bearingVector(leaves + 90);
      riverLine = [[x * beside, y * beside], end(leaves)];
    } else {
      const turn = ((leaves - arrives + 540) % 360) - 180;
      const [x, y] = bearingVector(arrives + (Math.abs(turn) === 180 ? 90 : turn / 2));
      riverLine = [end(arrives), [x * beside, y * beside], end(leaves)];
    }
  }
  const nearRiver = (points: Point[]) => riverLine !== undefined && distanceBetweenPolylines(points, riverLine) < riverClearance - EPSILON;
  const cellWet = new Uint8Array(cellCount);
  const junctionRiverWet = new Uint8Array(junctionCount);
  const edgeRiverWet = new Uint8Array(gridEdgeCount);
  if (riverLine) {
    for (let cell = 0; cell < cellCount; cell++) {
      if (distancePolygonToPolyline(cellCorners(cell), riverLine) < riverClearance - EPSILON) cellWet[cell] = 1;
    }
    for (let junction = 0; junction < junctionCount; junction++) {
      if (distanceToPolyline(junctionPoint(junction), riverLine) < riverClearance - EPSILON) junctionRiverWet[junction] = 1;
    }
    for (let edge = 0; edge < gridEdgeCount; edge++) {
      const [a, b] = edgeEnds(edge);
      if (nearRiver([junctionPoint(a), junctionPoint(b)])) edgeRiverWet[edge] = 1;
    }
  }

  // ---- Lots to place -----------------------------------------------------------------
  interface Placed {
    building: Building;
    cell: number;
    /** Which side of the block the lot fronts: the street to its north, or to its south. */
    north: boolean;
    start: number;
    frontage: number;
    depth: number;
  }
  const placed: Placed[] = [];
  const districtIndex = new Map(city.districts.map((district, index) => [district.id, index]));
  const buildingsOf: Building[][] = city.districts.map(() => []);
  for (const building of city.buildings) (buildingsOf[districtIndex.get(building.districtId) as number] as Building[]).push(building);
  const atExits = new Set(settings.atExits ?? []);
  /** Civic buildings the pack spreads across the districts: within a district they are kept to streets of their own. */
  const spreadCivic = new Set(pack.landmarks.filter((landmark) => landmark.spread).map((landmark) => landmark.id));
  const exitVectors = brief.routes.map((route) => bearingVector(route.bearing));
  /** Buildings that belong toward an exit take the exits in turn. */
  const exitOf = new Map<string, number>();
  if (exitVectors.length > 0) {
    let turn = 0;
    for (const building of city.buildings) if (atExits.has(building.type)) exitOf.set(building.id, turn++ % exitVectors.length);
  }

  // ---- Districts ------------------------------------------------------------------------
  const owner = new Int32Array(cellCount).fill(-1);
  const tieBreak = new Float64Array(cellCount);
  {
    const rng = stepRng(seed, 'layout-districts');
    for (let cell = 0; cell < cellCount; cell++) tieBreak[cell] = rng.next();
  }
  const fromCentre = new Float64Array(cellCount);
  for (let cell = 0; cell < cellCount; cell++) fromCentre[cell] = distance([0, 0], cellCentre(cell));
  const isFree = (cell: number) => owner[cell] === -1 && cellWet[cell] === 0;
  /** Free cells joined to the border of the grid: the land a district can still grow into without being boxed in. */
  const openCells = (): Uint8Array => {
    const open = new Uint8Array(cellCount);
    const queue: number[] = [];
    for (let cell = 0; cell < cellCount; cell++) {
      if (onBorder(cell) && isFree(cell)) {
        open[cell] = 1;
        queue.push(cell);
      }
    }
    for (let at = 0; at < queue.length; at++) {
      for (const next of neighbourCells(queue[at] as number)) {
        if (open[next] === 0 && isFree(next)) {
          open[next] = 1;
          queue.push(next);
        }
      }
    }
    return open;
  };
  const best = (cells: Iterable<number>, score: (cell: number) => number): number | undefined => {
    let found: number | undefined;
    let foundScore = Infinity;
    for (const cell of cells) {
      const value = score(cell);
      if (value < foundScore || (value === foundScore && found !== undefined && (tieBreak[cell] as number) < (tieBreak[found] as number))) {
        found = cell;
        foundScore = value;
      }
    }
    return found;
  };
  const allCells = Array.from({ length: cellCount }, (_, cell) => cell);
  const lotRng = stepRng(seed, 'layout-lots');
  const cellsOf: number[][] = city.districts.map(() => []);

  /** Grows one district outward from a seed block, packing its lots as it goes. */
  const placeDistrict = (district: number, pickSeed: (open: Uint8Array) => number | undefined) => {
    const buildings = buildingsOf[district] as Building[];
    if (buildings.length === 0) return;
    const open = openCells();
    const seedCell = pickSeed(open);
    if (seedCell === undefined) throw new GridTooSmall();

    interface Block {
      cell: number;
      /** How far along each frontage is taken. */
      north: number;
      south: number;
    }
    const blocks: Block[] = [];
    const frontier = new Map<number, number>();
    const addBlock = (cell: number, depth: number): Block => {
      owner[cell] = district;
      (cellsOf[district] as number[]).push(cell);
      frontier.delete(cell);
      for (const next of neighbourCells(cell)) {
        if (isFree(next) && open[next] === 1 && !frontier.has(next)) frontier.set(next, depth + 1);
      }
      const block = { cell, north: 0, south: 0 };
      blocks.push(block);
      return block;
    };
    /** The next block: nearest the seed in steps, then nearest the centre. */
    const grow = (toward?: Point): Block => {
      const cell =
        toward === undefined
          ? best(frontier.keys(), (candidate) => (frontier.get(candidate) as number) * far + (fromCentre[candidate] as number))
          : best(frontier.keys(), (candidate) => -dot(cellCentre(candidate), toward));
      if (cell === undefined) throw new GridTooSmall();
      return addBlock(cell, frontier.get(cell) as number);
    };
    const { length, depth: blockDepth } = settings.block;
    const tryBlock = (block: Block, building: Building, frontage: number, depth: number): boolean => {
      if (depth > blockDepth / 2) {
        // A lot deeper than half the block runs from street to street and takes both frontages.
        const start = Math.max(block.north, block.south);
        if (start + frontage > length + EPSILON) return false;
        placed.push({ building, cell: block.cell, north: true, start, frontage, depth });
        block.north = block.south = start + frontage;
        return true;
      }
      const north = block.north <= block.south;
      const start = north ? block.north : block.south;
      if (start + frontage > length + EPSILON) return false;
      placed.push({ building, cell: block.cell, north, start, frontage, depth });
      if (north) block.north += frontage;
      else block.south += frontage;
      return true;
    };
    const place = (building: Building, first?: Block) => {
      const { frontage, depth } = lotSizeOf(building.type, pack);
      if (first && tryBlock(first, building, frontage, depth)) return;
      for (const block of blocks) if (tryBlock(block, building, frontage, depth)) return;
      // A new block always has room: the pack is checked so that every lot fits in a block.
      tryBlock(grow(), building, frontage, depth);
    };

    /**
     * Places a civic building that the pack spreads, such as a well, apart from the others of its type: on a
     * frontage whose street has none yet, the newest block first, so that they follow the district as it grows.
     * Where every frontage with room has one already, the district grows a block for it.
     */
    const ofTypeOn = new Map<string, number>();
    const streetOf = (block: Block, north: boolean) => `${cellI(block.cell)},${cellJ(block.cell) + (north ? 0 : 1)}`;
    const placeApart = (building: Building) => {
      const { frontage, depth } = lotSizeOf(building.type, pack);
      // A lot that runs from street to street has no frontage of its own to choose.
      if (depth > blockDepth / 2) return place(building);
      const countOn = (block: Block, north: boolean) => ofTypeOn.get(`${building.type}|${streetOf(block, north)}`) ?? 0;
      const fits = (block: Block, north: boolean) => (north ? block.north : block.south) + frontage <= length + EPSILON;
      let chosen: { block: Block; north: boolean; count: number } | undefined;
      const consider = (block: Block) => {
        for (const north of [true, false]) {
          if (!fits(block, north)) continue;
          const count = countOn(block, north);
          if (!chosen || count < chosen.count) chosen = { block, north, count };
        }
      };
      for (let at = blocks.length - 1; at >= 0 && chosen?.count !== 0; at--) consider(blocks[at] as Block);
      for (let grown = 0; grown < APART_BLOCKS && chosen?.count !== 0; grown++) consider(grow());
      const { block, north } = chosen ?? { block: grow(), north: true };
      placed.push({ building, cell: block.cell, north, start: north ? block.north : block.south, frontage, depth });
      if (north) block.north += frontage;
      else block.south += frontage;
      const key = `${building.type}|${streetOf(block, north)}`;
      ofTypeOn.set(key, (ofTypeOn.get(key) ?? 0) + 1);
    };

    // Landmarks take their larger lots first; buildings that belong toward an exit go last, on that side.
    const area = (building: Building) => {
      const size = lotSizeOf(building.type, pack);
      return size.frontage * size.depth;
    };
    const towardExit = buildings.filter((building) => exitOf.has(building.id));
    const apart = buildings.filter((building) => spreadCivic.has(building.type) && !exitOf.has(building.id));
    const landmarks = buildings
      .filter((building) => building.kind === 'landmark' && !exitOf.has(building.id) && !spreadCivic.has(building.type))
      .sort((a, b) => area(b) - area(a) || (a.id < b.id ? -1 : 1));
    const others = buildings.filter((building) => building.kind !== 'landmark' && !exitOf.has(building.id));
    for (let index = others.length - 1; index > 0; index--) {
      const other = lotRng.int(0, index);
      [others[index], others[other]] = [others[other] as Building, others[index] as Building];
    }
    addBlock(seedCell, 0);
    // The civic buildings that are spread take their turns at even steps among the rest, so that the district has
    // grown to a new street by the time the next one of a type is placed.
    const rest = [...landmarks, ...others];
    let next = 0;
    rest.forEach((building, turn) => {
      while (next < apart.length && Math.floor(((next + 0.5) * rest.length) / apart.length) <= turn) placeApart(apart[next++] as Building);
      place(building);
    });
    while (next < apart.length) placeApart(apart[next++] as Building);
    const exitBlocks = new Map<number, Block>();
    for (const building of towardExit) {
      const exit = exitOf.get(building.id) as number;
      if (!exitBlocks.has(exit)) exitBlocks.set(exit, grow(exitVectors[exit] as Point));
      place(building, exitBlocks.get(exit));
    }
  };

  const placements = new Map(pack.districts.kinds.map((kind) => [kind.id, kind.placement]));
  const districtsPlaced = (placement: string) =>
    city.districts.map((district, index) => ({ district, index })).filter(({ district }) => placements.get(district.kind) === placement);
  const nearestCentre = (open: Uint8Array) =>
    best(
      allCells.filter((cell) => open[cell] === 1),
      (cell) => fromCentre[cell] as number,
    );
  const usedCells = () => allCells.filter((cell) => (owner[cell] as number) >= 0);

  for (const { index } of districtsPlaced('centre')) placeDistrict(index, nearestCentre);

  // Waterside districts: on the seaward side of what is built so far, or else beside the river.
  const seaward = brief.coast.waterBearing === undefined ? undefined : bearingVector(brief.coast.waterBearing);
  const seawardReach = (cell: number) => Math.max(...cellCorners(cell).map((corner) => dot(corner, seaward as Point)));
  for (const { index } of districtsPlaced('waterside')) {
    placeDistrict(index, (open) => {
      const candidates = allCells.filter((cell) => open[cell] === 1);
      if (seaward) {
        const beside = candidates.filter((cell) => neighbourCells(cell).some((next) => (owner[next] as number) >= 0));
        return beside.length > 0 ? best(beside, (cell) => -seawardReach(cell)) : nearestCentre(open);
      }
      if (riverLine) {
        const gap = (cell: number) => distancePolygonToPolyline(cellCorners(cell), riverLine as Point[]) - settings.riverWidth / 2;
        const within = candidates.filter((cell) => gap(cell) <= settings.watersideReach);
        return within.length > 0 ? best(within, (cell) => fromCentre[cell] as number) : best(candidates, gap);
      }
      return nearestCentre(open);
    });
  }

  // ---- The sea -------------------------------------------------------------------------
  // The shore lies just beyond what is built so far on the seaward side, with room for a street along it.
  let shore: number | undefined;
  if (seaward) {
    const built = usedCells();
    shore = (built.length > 0 ? Math.max(...built.map(seawardReach)) : 0) + inset;
    for (let cell = 0; cell < cellCount; cell++) {
      if (owner[cell] === -1 && seawardReach(cell) > shore - inset + EPSILON) cellWet[cell] = 1;
    }
  }
  const inSea = (point: Point) => shore !== undefined && dot(point, seaward as Point) > shore - inset + EPSILON;

  for (const { index } of districtsPlaced('middle')) placeDistrict(index, nearestCentre);
  for (const { index } of districtsPlaced('edge')) placeDistrict(index, nearestCentre);
  if (placed.length !== city.buildings.length) fail(`${city.buildings.length - placed.length} buildings are in districts whose kind the pack no longer lists`);

  // ---- The street graph over the whole grid ------------------------------------------------
  const junctionDry = new Uint8Array(junctionCount);
  for (let junction = 0; junction < junctionCount; junction++) {
    if (junctionRiverWet[junction] === 0 && !inSea(junctionPoint(junction))) junctionDry[junction] = 1;
  }
  const edgeDry = new Uint8Array(gridEdgeCount);
  for (let edge = 0; edge < gridEdgeCount; edge++) {
    const [a, b] = edgeEnds(edge);
    if (edgeRiverWet[edge] === 0 && junctionDry[a] === 1 && junctionDry[b] === 1) edgeDry[edge] = 1;
  }
  // A bridge can stand wherever a grid line crosses the river: it spans the run of wet edges
  // between the last dry junction on one bank and the first on the other.
  interface Bridge {
    from: number;
    to: number;
    length: number;
  }
  const bridges: Bridge[] = [];
  const bridgesAt = new Map<number, number[]>();
  if (riverLine) {
    const scan = (edgeOf: (step: number, line: number) => number, lines: number) => {
      for (let line = 0; line < lines; line++) {
        let runStart = -1;
        for (let step = 0; step <= side; step++) {
          const wet = step < side && edgeRiverWet[edgeOf(step, line)] === 1;
          if (wet && runStart === -1) runStart = step;
          if (!wet && runStart !== -1) {
            const from = edgeEnds(edgeOf(runStart, line))[0];
            const to = edgeEnds(edgeOf(step - 1, line))[1];
            runStart = -1;
            if (junctionDry[from] === 0 || junctionDry[to] === 0) continue;
            if (crossingsOfPolyline(junctionPoint(from), junctionPoint(to), riverLine as Point[]) === 0) continue;
            const index = bridges.length;
            bridges.push({ from, to, length: distance(junctionPoint(from), junctionPoint(to)) });
            for (const end of [from, to]) bridgesAt.set(end, [...(bridgesAt.get(end) ?? []), index]);
          }
        }
      }
    };
    scan((step, line) => horizontalAt(step - half, line - half), side + 1);
    scan((step, line) => verticalAt(line - half, step - half), side + 1);
  }
  /** Calls back for every way out of a junction: the next junction, the length, and the edge (bridges follow the grid's edges). */
  const waysFrom = (junction: number, visit: (to: number, length: number, edge: number) => void) => {
    const i = junctionI(junction);
    const j = junctionJ(junction);
    const tryEdge = (edge: number, to: number, length: number) => {
      if (edgeDry[edge] === 1) visit(to, length, edge);
    };
    if (i < half) tryEdge(horizontalAt(i, j), junctionAt(i + 1, j), pitchX);
    if (i > -half) tryEdge(horizontalAt(i - 1, j), junctionAt(i - 1, j), pitchX);
    if (j < half) tryEdge(verticalAt(i, j), junctionAt(i, j + 1), pitchY);
    if (j > -half) tryEdge(verticalAt(i, j - 1), junctionAt(i, j - 1), pitchY);
    for (const index of bridgesAt.get(junction) ?? []) {
      const bridge = bridges[index] as Bridge;
      visit(bridge.from === junction ? bridge.to : bridge.from, bridge.length, gridEdgeCount + index);
    }
  };
  /** The shortest way from any of the start junctions to the first junction that satisfies `done`, as edges. */
  const route = (starts: Iterable<number>, done: (junction: number) => boolean, allowed: (junction: number) => boolean): number[] | undefined => {
    const cost = new Map<number, number>();
    const cameBy = new Map<number, [number, number]>();
    const heap = new Heap();
    for (const start of starts) {
      cost.set(start, 0);
      heap.push(0, start);
    }
    while (heap.size > 0) {
      const [reached, junction] = heap.pop();
      if (reached > (cost.get(junction) as number)) continue;
      if (done(junction)) {
        const edges: number[] = [];
        for (let at = junction; cameBy.has(at); at = (cameBy.get(at) as [number, number])[0]) edges.push((cameBy.get(at) as [number, number])[1]);
        return edges.reverse();
      }
      waysFrom(junction, (to, length, edge) => {
        if (!allowed(to)) return;
        const next = reached + length;
        if (next < (cost.get(to) ?? Infinity)) {
          cost.set(to, next);
          cameBy.set(to, [junction, edge]);
          heap.push(next, to);
        }
      });
    }
    return undefined;
  };

  // ---- Exits and arterials -------------------------------------------------------------------
  const built = usedCells();
  const townRadius = Math.max(0, ...built.flatMap((cell) => cellCorners(cell).map((corner) => distance([0, 0], corner))));
  const blockOf = (cell: number): Point[] => {
    const [a, , c] = cellCorners(cell) as [Point, Point, Point, Point];
    return [
      [a[0] + inset, a[1] + inset],
      [c[0] - inset, a[1] + inset],
      [c[0] - inset, c[1] - inset],
      [a[0] + inset, c[1] - inset],
    ];
  };
  // Exits and the roads to them lie just outside the town, so the grid must reach beyond it on every side.
  if (townRadius + 3 * diagonal > half * Math.min(pitchX, pitchY)) throw new GridTooSmall();
  const centre = junctionAt(0, 0);
  if (junctionDry[centre] === 0) fail('the town centre is under water');
  const streets = new Set<number>();
  const arterial = new Map<number, { routeId: string; name?: string }>();
  interface ExitDraft {
    point: Point;
    /** The grid junction the exit is joined to. */
    joins: number;
  }
  const exitDrafts: ExitDraft[] = [];
  brief.routes.forEach((exit, position) => {
    const carries = { routeId: exit.routeId, ...(exit.name !== undefined && { name: exit.name }) };
    // The exit sits at the brief's bearing. If that spot is in the river, or no road can reach it,
    // it moves aside a degree at a time, staying within the tolerance the layout rules allow.
    for (let step = 0; step <= 2 * BEARING_TOLERANCE; step++) {
      const offset = step % 2 === 1 ? (step + 1) / 2 : -step / 2;
      if (Math.abs(offset) >= BEARING_TOLERANCE) continue;
      const direction = bearingVector(exit.bearing + offset);
      let reach = townRadius + diagonal;
      // Toward the sea the town's edge is the shore.
      if (shore !== undefined && dot(direction, seaward as Point) > EPSILON) {
        reach = Math.min(reach, (shore - inset) / dot(direction, seaward as Point));
      }
      const point: Point = [direction[0] * reach, direction[1] * reach];
      if (riverLine && distanceToPolyline(point, riverLine) < riverClearance) continue;
      if (exitDrafts.some((other) => distance(other.point, point) < widest)) continue;
      // Join it to the nearest dry junction that a straight road can reach without touching water or a block.
      const i = Math.round(point[0] / pitchX);
      const j = Math.round(point[1] / pitchY);
      const candidates: number[] = [];
      for (let di = -2; di <= 2; di++) {
        for (let dj = -2; dj <= 2; dj++) {
          if (Math.abs(i + di) <= half && Math.abs(j + dj) <= half) candidates.push(junctionAt(i + di, j + dj));
        }
      }
      candidates.sort((a, b) => distance(junctionPoint(a), point) - distance(junctionPoint(b), point) || a - b);
      for (const joins of candidates) {
        const link = [junctionPoint(joins), point];
        if (junctionDry[joins] === 0 || distance(link[0] as Point, point) < widest || nearRiver(link)) continue;
        if (built.some((cell) => distancePolygonToPolyline(blockOf(cell), link) < widths.arterial / 2 - EPSILON)) continue;
        // The arterial keeps close to the straight line from the centre, widening the search only if it must.
        let edges: number[] | undefined;
        for (let corridor = diagonal; edges === undefined && corridor <= 2 * far; corridor *= 2) {
          edges = route([centre], (junction) => junction === joins, (junction) => distanceToPolyline(junctionPoint(junction), [[0, 0], point]) <= corridor);
        }
        if (!edges) continue;
        for (const edge of edges) {
          streets.add(edge);
          if (!arterial.has(edge)) arterial.set(edge, carries);
        }
        exitDrafts.push({ point, joins });
        return;
      }
    }
    fail(`no road can reach the exit for ${exit.routeId} within ${BEARING_TOLERANCE} degrees of bearing ${exit.bearing} (exit ${position + 1} of ${brief.routes.length})`);
  });

  // ---- Streets ---------------------------------------------------------------------------------
  // Every used block has a street on all four sides.
  for (const cell of built) {
    const i = cellI(cell);
    const j = cellJ(cell);
    for (const edge of [horizontalAt(i, j), horizontalAt(i, j + 1), verticalAt(i, j), verticalAt(i + 1, j)]) streets.add(edge);
  }
  // Join whatever is still apart, such as blocks across the river from any arterial, adding bridges if need be.
  for (;;) {
    const touched = new Set<number>();
    const linked = new Map<number, number[]>();
    for (const edge of streets) {
      const [a, b] = edge < gridEdgeCount ? edgeEnds(edge) : [(bridges[edge - gridEdgeCount] as Bridge).from, (bridges[edge - gridEdgeCount] as Bridge).to];
      touched.add(a).add(b);
      linked.set(a, [...(linked.get(a) ?? []), b]);
      linked.set(b, [...(linked.get(b) ?? []), a]);
    }
    if (touched.size === 0) break;
    const start = touched.has(centre) ? centre : Math.min(...touched);
    const main = new Set([start]);
    const queue = [start];
    for (let at = 0; at < queue.length; at++) {
      for (const next of linked.get(queue[at] as number) ?? []) {
        if (!main.has(next)) {
          main.add(next);
          queue.push(next);
        }
      }
    }
    if (main.size === touched.size) break;
    const edges = route(main, (junction) => touched.has(junction) && !main.has(junction), () => true);
    if (!edges) fail('part of the town cannot be joined to the rest by any street or bridge');
    for (const edge of edges as number[]) streets.add(edge);
  }

  // ---- Records ------------------------------------------------------------------------------------
  const kindOf = (edge: number): SegmentKind =>
    edge >= gridEdgeCount ? 'bridge' : arterial.has(edge) ? 'arterial' : edge < horizontalCount ? 'street' : 'lane';
  const endsOf = (edge: number): [number, number] =>
    edge < gridEdgeCount ? edgeEnds(edge) : [(bridges[edge - gridEdgeCount] as Bridge).from, (bridges[edge - gridEdgeCount] as Bridge).to];
  const streetEdges = [...streets].sort((a, b) => a - b);
  const gridJunctions = [...new Set(streetEdges.flatMap(endsOf))].sort((a, b) => a - b);
  const junctionIds = new Map(gridJunctions.map((junction, index) => [junction, `junction-${number}-${pad(index + 1, 6)}`]));
  const degree = new Map<number, number>();
  const atBridge = new Set<number>();
  for (const edge of streetEdges) {
    for (const end of endsOf(edge)) {
      degree.set(end, (degree.get(end) ?? 0) + 1);
      if (edge >= gridEdgeCount) atBridge.add(end);
    }
  }
  for (const draft of exitDrafts) degree.set(draft.joins, (degree.get(draft.joins) ?? 0) + 1);
  const junctions: Junction[] = gridJunctions.map((junction) => ({
    id: junctionIds.get(junction) as string,
    position: junctionPoint(junction),
    kind: atBridge.has(junction) ? 'bridge-end' : degree.get(junction) === 1 ? 'dead-end' : 'crossing',
  }));
  const segmentIds = new Map<number, string>();
  const segments: Segment[] = streetEdges.map((edge, index) => {
    const [from, to] = endsOf(edge);
    const kind = kindOf(edge);
    const carries = arterial.get(edge);
    const id = `segment-${number}-${pad(index + 1, 6)}`;
    segmentIds.set(edge, id);
    return {
      id,
      fromJunctionId: junctionIds.get(from) as string,
      toJunctionId: junctionIds.get(to) as string,
      points: [junctionPoint(from), junctionPoint(to)],
      kind,
      width: widths[kind],
      ...(carries?.name !== undefined && { name: carries.name }),
      ...(carries && { routeId: carries.routeId }),
    };
  });
  const exits: Exit[] = exitDrafts.map((draft, position) => {
    const exit = brief.routes[position] as SettlementBrief['routes'][number];
    const junctionId = `junction-${number}-${pad(junctions.length + 1, 6)}`;
    junctions.push({ id: junctionId, position: draft.point, kind: 'exit' });
    segments.push({
      id: `segment-${number}-${pad(segments.length + 1, 6)}`,
      fromJunctionId: junctionIds.get(draft.joins) as string,
      toJunctionId: junctionId,
      points: [junctionPoint(draft.joins), draft.point],
      kind: 'arterial',
      width: widths.arterial,
      ...(exit.name !== undefined && { name: exit.name }),
      routeId: exit.routeId,
    });
    return {
      id: `exit-${number}-${pad(position + 1, 3)}`,
      junctionId,
      routeId: exit.routeId,
      ...(exit.name !== undefined && { name: exit.name }),
      kind: exit.kind,
      bearing: exit.bearing,
    };
  });

  const waters: Water[] = [];
  const waterId = () => `water-${number}-${pad(waters.length + 1, 3)}`;
  if (riverLine) waters.push({ id: waterId(), kind: 'river', centreLine: riverLine, width: settings.riverWidth });
  if (shore !== undefined && seaward) {
    const along: Point = [-seaward[1], seaward[0]];
    const corner = (out: number, sideways: number): Point => [seaward[0] * out + along[0] * sideways, seaward[1] * out + along[1] * sideways];
    const span = 2 * far;
    waters.push({ id: waterId(), kind: 'sea', polygon: [corner(shore, -span), corner(shore, span), corner(shore + span, span), corner(shore + span, -span)] });
  }

  // ---- Streets of one trade ---------------------------------------------------------------
  // Which building holds which lot is settled last, and changes no lot. Within a district, buildings whose lots
  // are alike (the same size, covered by the same share of building) change places, so that buildings of one type
  // stand on neighbouring lots along a street, while types the pack spreads stand apart from each other.
  if (arrange) {
    const spreadTypes = new Set([...pack.workplaces, ...pack.landmarks].filter((type) => type.spread).map((type) => type.id));
    const alike = new Map<string, Placed[]>();
    for (const lot of placed) {
      // Buildings that belong toward an exit keep their place.
      if (exitOf.has(lot.building.id)) continue;
      const key = `${lot.building.districtId}|${lot.frontage}|${lot.depth}|${footprintCoverageOf(lot.building.type, pack)}`;
      const list = alike.get(key);
      if (list) list.push(lot);
      else alike.set(key, [lot]);
    }
    for (const lots of alike.values()) {
      const types = new Map<string, Building[]>();
      for (const { building } of lots) types.set(building.type, [...(types.get(building.type) ?? []), building]);
      if (types.size < 2) continue;
      // The lots in the order they stand: street by street, one side at a time, along the street.
      const street = (lot: Placed) => cellJ(lot.cell) + (lot.north ? 0 : 1);
      const along = (lot: Placed) => cellI(lot.cell) * pitchX + lot.start;
      const slots = [...lots].sort((a, b) => street(a) - street(b) || Number(a.north) - Number(b.north) || along(a) - along(b));
      const byId = (a: Building, b: Building) => (a.id < b.id ? -1 : 1);
      for (const list of types.values()) list.sort(byId);
      // Spread types, the commonest first. They are to stand apart from their own kind.
      const spread = [...types].filter(([type]) => spreadTypes.has(type)).sort(([a, one], [b, other]) => other.length - one.length || (a < b ? -1 : 1));
      const apart = spread.flatMap(([, list]) => list);
      // The rest stand together by type, the commonest first.
      const together = [...types].filter(([type]) => !spreadTypes.has(type)).sort(([a, one], [b, other]) => other.length - one.length || (a < b ? -1 : 1)).flatMap(([, list]) => list);
      // Lots that stand side by side form a run; a lot with no like lot beside it stands alone, and whatever is put
      // there has no neighbour of its own type. So the spread types, which are meant to stand apart, take the lone
      // lots first, and the trades that gather take the runs.
      const beside = (a: Placed, b: Placed) => a.cell === b.cell && a.north === b.north && Math.abs(a.start + a.frontage - b.start) < EPSILON;
      const inRun = slots.map((slot, index) => (index > 0 && beside(slots[index - 1] as Placed, slot)) || (index + 1 < slots.length && beside(slot, slots[index + 1] as Placed)));
      const alone = slots.filter((_, index) => !inRun[index]);
      const runs = slots.filter((_, index) => inRun[index]);
      const given = new Map<Placed, Building>();
      const evenly = (buildings: Building[], among: Placed[]) => buildings.forEach((building, turn) => given.set(among[Math.floor(((turn + 0.5) * among.length) / buildings.length)] as Placed, building));
      // A lone lot has no like lot beside it, so nothing put there is beside its own kind: the commonest spread
      // types, which are the hardest to keep apart, go there first.
      evenly(apart.slice(0, alone.length), alone);
      // The rest go into the runs at even steps, in an order that never has two of a type in a row unless one type
      // is more than half of them: every other place is filled first, commonest type first, then the places between.
      const rest = apart.slice(alone.length);
      const mixed = new Array<Building>(rest.length);
      rest.forEach((building, turn) => (mixed[turn * 2 < rest.length ? turn * 2 : (turn - Math.ceil(rest.length / 2)) * 2 + 1] = building));
      evenly(mixed, runs);
      let next = 0;
      for (const slot of [...runs, ...alone]) slot.building = given.get(slot) ?? (together[next++] as Building);
    }
  }

  // Lots are numbered as their buildings are.
  const buildingOrder = new Map(city.buildings.map((building, index) => [building.id, index]));
  placed.sort((a, b) => (buildingOrder.get(a.building.id) as number) - (buildingOrder.get(b.building.id) as number));
  let builtArea = 0;
  /** One rectangle across the lot's frontage, as deep as the pack's coverage of the lot; none where the coverage is nothing. */
  const footprint = (left: number, right: number, top: number, depth: number, north: boolean, coverage: number): Point[][] => {
    if (coverage <= 0) return [];
    const near = north ? top : top + depth * (1 - coverage);
    const far = north ? top + depth * coverage : top + depth;
    return [[[left, near], [right, near], [right, far], [left, far]]];
  };
  const lots: Lot[] = placed.map((lot, index) => {
    const i = cellI(lot.cell);
    const j = cellJ(lot.cell);
    const left = i * pitchX + inset + lot.start;
    const right = left + lot.frontage;
    const top = lot.north ? j * pitchY + inset : (j + 1) * pitchY - inset - lot.depth;
    const street = lot.north ? j : j + 1;
    builtArea += lot.frontage * lot.depth;
    return {
      id: `lot-${number}-${pad(index + 1, 6)}`,
      buildingId: lot.building.id,
      polygon: [
        [left, top],
        [right, top],
        [right, top + lot.depth],
        [left, top + lot.depth],
      ],
      districtId: lot.building.districtId,
      entrance: { segmentId: segmentIds.get(horizontalAt(i, street)) as string, point: [(left + right) / 2, street * pitchY] },
      footprints: footprint(left, right, top, lot.depth, lot.north, footprintCoverageOf(lot.building.type, pack)),
    };
  });

  // A district's area is its cells, joined along each row into strips that touch the rows above and below.
  const districtAreas = city.districts.flatMap((district: District, index) => {
    const cells = [...(cellsOf[index] as number[])].sort((a, b) => a - b);
    if (cells.length === 0) return [];
    const polygons: Point[][] = [];
    for (let at = 0; at < cells.length; ) {
      let end = at;
      while (end + 1 < cells.length && cells[end + 1] === (cells[end] as number) + 1 && cellJ(cells[end + 1] as number) === cellJ(cells[at] as number)) end++;
      const [topLeft] = cellCorners(cells[at] as number) as [Point];
      const bottomRight = (cellCorners(cells[end] as number) as Point[])[2] as Point;
      polygons.push([topLeft, [bottomRight[0], topLeft[1]], bottomRight, [topLeft[0], bottomRight[1]]]);
      at = end + 1;
    }
    const middle: Point = [
      cells.reduce((sum, cell) => sum + cellCentre(cell)[0], 0) / cells.length,
      cells.reduce((sum, cell) => sum + cellCentre(cell)[1], 0) / cells.length,
    ];
    const labelCell = best(cells, (cell) => distance(cellCentre(cell), middle)) as number;
    return [{ districtId: district.id, polygons, labelPoint: cellCentre(labelCell) }];
  });

  const everyPoint = [...lots.flatMap((lot) => lot.polygon), ...segments.flatMap((segment) => segment.points)];
  const layout: Layout = {
    junctions,
    segments,
    exits,
    waters,
    lots,
    districtAreas,
    summary: {
      settlementId: brief.id,
      counts: {
        junctions: junctions.length,
        segments: segments.length,
        exits: exits.length,
        waters: waters.length,
        lots: lots.length,
        districtAreas: districtAreas.length,
      },
      bounds: boxOf(everyPoint),
      builtArea,
      residentsPerHectare: builtArea === 0 ? 0 : city.people.length / (builtArea / 10_000),
      layoutVersion: LAYOUT_VERSION,
      generator: GRID_GENERATOR,
      pack: { name: pack.pack.name, version: pack.pack.version },
      seed,
    },
  };

  const broken = checkLayout(layout, city, brief, pack);
  if (broken.length > 0) {
    fail(`the layout breaks ${broken.length === 1 ? 'an invariant' : 'invariants'}:\n  ${broken.join('\n  ')}`);
  }
  return layout;
}
