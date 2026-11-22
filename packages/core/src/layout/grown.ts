/**
 * The grown layout generator: a town of blocks scattered over its ground,
 * with the streets the gaps between them.
 *
 * A finished city, its brief, the pack and a seed in; a layout out, in the
 * same format the grid makes. The city is read and never changed. Every
 * length comes from the pack's layout settings; randomness comes from streams
 * of this generator's own (`grown-…`).
 *
 * Nothing here takes a street's direction from the centre. Points are
 * scattered, each gets the ground nearest it as a block, and the boundaries
 * between blocks are the candidate streets (`fabric.ts`). Main roads find
 * their way along those boundaries; some boundaries are closed so that two
 * blocks become one, some are lanes, some keep a dead-end court.
 *
 * The steps, in order:
 *   1. Water: the river and the coast, neither with a straight edge.
 *   2. The fabric: seeds, fixed in pairs along banks, shore and wall so that
 *      a boundary follows each, then scattered; cells, corners and edges.
 *   3. Roads: a main road from the centre toward each exit, local streets
 *      where the brief's exits are few, bridges, and gates in the wall.
 *   4. What each remaining boundary is: a street, a lane, a court, or none.
 *   5. Districts, grown block by block from the centre outward along the
 *      roads and the water, cutting each one's lots as it grows.
 *   6. Exits, the second bridge, and the streets that are kept.
 *   7. The records, and every layout invariant checked.
 */
import type { Building, City, District } from '../city/records.ts';
import { stepRng } from '../city/random.ts';
import { idNumber } from '../ids.ts';
import { type GrownSettings, type SettingPack, footprintCoverageOf, lotSizeOf } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import { type Block, type BlockSide, type Cut, type Track, clip, cutLot, frontOf, frontage, makeBlock } from './blocks.ts';
import { type Fabric, type FabricCell, type Seed, scatter, weave } from './fabric.ts';
import { bearingVector, boxOf, distance, distancePolygonToPolyline, distanceToPolyline, piecesCross, polygonArea, polygonCentroid, projectOnPolyline } from './geometry.ts';
import { type LayoutOptions, LayoutGenerationError } from './grid.ts';
import { Heap } from './heap.ts';
import { checkLayout } from './invariants.ts';
import { ringShare } from './measure.ts';
import { type Exit, type Junction, type JunctionKind, type Layout, type Lot, type Place, type Segment, type SegmentKind, type Wall, type Water, LAYOUT_VERSION } from './records.ts';
import { arrangeTrades, placementOrder, spreadCivicTypes } from './shared.ts';
import { type Coast, type River, makeCoast, makeRiver } from './water.ts';

/** The name this generator records in a layout's summary. */
export const GROWN_GENERATOR = 'grown';

/** How many blocks a district may grow to find room for a spread civic building far enough from the others of its type. */
const APART_BLOCKS = 3;
/** How many blocks a district may grow looking for one a building can stand in. */
const BLOCK_TRIES = 16;
/** A pair of seeds either side of a line stand this share of the spacing from it. */
const PAIR_REACH = 0.42;
/** An exit lies within this many degrees of the brief's bearing. */
const EXIT_TOLERANCE = 5;
const TAU = 2 * Math.PI;

/** Thrown inside an attempt when the scattered ground proved too small; the attempt is repeated on more. */
class TooSmall extends Error {
  /** Which step found the ground too small, for saying so if it never proves enough. */
  readonly where: number;

  constructor(where: number) {
    super(`too small (${where})`);
    this.where = where;
  }
}

const pad = (value: number, digits: number) => String(value).padStart(digits, '0');
const turn = (angle: number) => ((angle % TAU) + TAU) % TAU;
const apart = (a: number, b: number) => Math.min(turn(a - b), turn(b - a));
const bearingOf = (point: Point) => turn(Math.atan2(point[0], -point[1]));

export function generateGrownLayout(city: City, brief: SettlementBrief, pack: SettingPack, options: LayoutOptions = {}): Layout {
  const seed = options.seed ?? brief.seed;
  if (!pack.layout.grown) throw new LayoutGenerationError(`${brief.id} (${brief.name}): the pack's layout file has no \`grown\` block, which the grown generator needs`);
  // Start with room for the town a few times over, and scatter more ground for as long as it proves too small.
  let reach = 1.7;
  for (let attempt = 0; ; attempt++, reach *= 1.45) {
    try {
      return attemptLayout(city, brief, pack, pack.layout.grown, seed, reach);
    } catch (error) {
      if (!(error instanceof TooSmall) || attempt >= 6) {
        if (error instanceof TooSmall) throw new LayoutGenerationError(`${brief.id} (${brief.name}): the town does not fit even ground ${reach.toFixed(1)} times its size (stopped at step ${error.where})`);
        throw error;
      }
    }
  }
}

/** What a boundary between two blocks is. */
type EdgeKind = 'arterial' | 'street' | 'lane' | 'court' | 'none' | 'wall';
interface Edge {
  id: number;
  a: number;
  b: number;
  cells: number[];
  kind: EdgeKind;
  /** Settled, and not to be closed or demoted: a road, a riverside street, the street round the plaza, a gate's street. */
  fixed: boolean;
  /** The exit whose main road it carries. */
  exit?: number;
  /** For a court: the corner it is entered from. */
  from?: number;
  /** For a bridge: not a boundary between blocks at all. */
  bridge?: true;
}
interface Cell extends FabricCell {
  water: boolean;
  /** Inside the wall. */
  inside: boolean;
  /** Not to be built on. */
  barred: boolean;
  /** The blocks it shares a boundary with, and those besides that a road's bridge leads to. */
  touching: number[];
  neighbours: number[];
  centre: Point;
  block?: Block;
  /** Taken whole by one building. */
  whole?: true;
}
interface Placed {
  building: Building;
  cell: Cell;
  polygon: Point[];
  /** The track it was cut from, and the cut; nothing for a building that has a block to itself. */
  track?: Track;
  cut?: Cut;
  /** The street it opens onto, and where its frontage is. */
  street: number;
  door: Point;
  gatehouse?: true;
}
interface Road {
  /** The exit it leads to, or nothing for a local street. */
  exit?: number;
  corners: number[];
  edges: number[];
}
type Way = { to: number; edge: number };

function attemptLayout(city: City, brief: SettlementBrief, pack: SettingPack, grown: GrownSettings, seed: number, reachFactor: number): Layout {
  const settings = pack.layout;
  const number = idNumber(brief.id);
  const fail = (message: string): never => {
    throw new LayoutGenerationError(`${brief.id} (${brief.name}): ${message}`);
  };
  const widths = settings.streetWidths;
  const { roadside } = grown;
  const widthOf = (edge: Edge): number => (edge.bridge ? widths.bridge : edge.kind === 'arterial' ? widths.arterial : edge.kind === 'street' ? widths.street : widths.lane);

  // ---- How much ground ------------------------------------------------------------------
  const lotArea = (building: Building) => {
    const size = lotSizeOf(building.type, pack);
    return size.frontage * size.depth;
  };
  const plazaBuilding = brief.flags.plaza ? city.buildings.find((building) => building.type === grown.plaza.building) : undefined;
  const plazaArea = plazaBuilding ? Math.min(Math.max(brief.population * grown.plaza.perResident, grown.plaza.min), grown.plaza.max) : 0;
  const plazaRadius = Math.sqrt(plazaArea / Math.PI);
  const totalLotArea = city.buildings.reduce((sum, building) => sum + (building === plazaBuilding ? 0 : lotArea(building)), 0);
  const needed = totalLotArea / grown.lotShare + plazaArea;
  const townRadius = Math.sqrt(needed / Math.PI);
  const radius = townRadius * reachFactor + 4 * grown.spacing.edge;
  const spacingAt = (point: Point) => grown.spacing.centre + (grown.spacing.edge - grown.spacing.centre) * Math.min(1, Math.hypot(point[0], point[1]) / townRadius);

  // ---- Water ------------------------------------------------------------------------------
  const placements = new Map(pack.districts.kinds.map((kind) => [kind.id, kind.placement]));
  const placementOf = (district: District) => placements.get(district.kind);
  const river: River | undefined = makeRiver(brief, settings.riverWidth, grown.river, seed, plazaRadius + 1.6 * grown.spacing.centre + settings.riverWidth, radius * 1.6);
  if (brief.river && !river) fail('the brief has a river with no bearing to place it by');
  let coast: Coast | undefined;
  if (brief.coast.waterBearing !== undefined) {
    // The shore stands far enough out for the centre of the town, near enough for the harbour to be at the water.
    const kindOf = new Map(city.districts.map((district) => [district.id, placementOf(district)]));
    const central = city.buildings.reduce((sum, building) => sum + (kindOf.get(building.districtId) === 'centre' && building !== plazaBuilding ? lotArea(building) : 0), 0);
    coast = makeCoast(brief, grown.coast, seed, Math.sqrt((central / grown.lotShare + plazaArea) / Math.PI) + 1.5 * grown.spacing.centre, radius * 1.3);
  }
  /** How far a point is from any water: negative in it. */
  const dryBy = (point: Point) => Math.min(river ? river.gap(point) : Infinity, coast ? coast.gap(point) : Infinity);
  if (dryBy([0, 0]) < grown.spacing.centre / 2) fail('the town centre is under water');

  // ---- The wall's line ----------------------------------------------------------------------
  const gatehouses = brief.flags.walls ? city.buildings.filter((building) => building.type === grown.wall.gatehouse) : [];
  const walled = gatehouses.length > 0;
  const enclosesAll = walled && brief.population < grown.wall.enclosesAllBelow;
  const wallRadius = (() => {
    if (!walled) return () => Infinity;
    const rng = stepRng(seed, 'grown-wall');
    const mean = Math.max(Math.sqrt(((enclosesAll ? 1.3 * reachFactor : grown.wall.share) * needed) / Math.PI), plazaRadius * 2 + 2.5 * grown.spacing.centre);
    const waves = [2, 3, 5].map((count) => ({ count, phase: rng.next() * TAU }));
    return (bearing: number) => mean * (1 + grown.wall.wobble * waves.reduce((sum, wave, index) => sum + ([0.5, 0.3, 0.2][index] as number) * Math.sin(wave.count * bearing + wave.phase), 0));
  })();
  const insideWall = (point: Point) => Math.hypot(point[0], point[1]) < wallRadius(bearingOf(point));

  // ---- Seeds ----------------------------------------------------------------------------------
  const fixed: Seed[] = [];
  const crowds = (point: Point, room: number) => fixed.some((other) => distance(other.point, point) < room);
  /** A pair either side of a line, so that the boundary between the two follows it; `step` is how far apart pairs stand along the line. */
  const pair = (on: Point, normal: Point, reach: number, water: boolean, step: number) => {
    const land: Point = [on[0] + normal[0] * reach, on[1] + normal[1] * reach];
    const other: Point = [on[0] - normal[0] * reach, on[1] - normal[1] * reach];
    if (Math.hypot(land[0], land[1]) > radius || crowds(land, 0.65 * step) || crowds(other, 0.5 * step)) return;
    fixed.push({ point: land, fixed: true }, { point: other, fixed: true, ...(water && { water: true as const }) });
  };
  if (plazaBuilding) {
    // The plaza is a block of its own: a seed at the centre and a ring of seeds twice its radius away.
    fixed.push({ point: [0, 0], fixed: true });
    const count = Math.max(6, Math.round((TAU * 2 * plazaRadius) / grown.spacing.centre));
    const rng = stepRng(seed, 'grown-plaza');
    const start = rng.next() * TAU;
    for (let index = 0; index < count; index++) {
      const bearing = start + (TAU * (index + (rng.next() - 0.5) * 0.3)) / count;
      const away = 2 * plazaRadius * (1 + (rng.next() - 0.5) * 0.12);
      fixed.push({ point: [Math.sin(bearing) * away, -Math.cos(bearing) * away], fixed: true });
    }
  }
  // Along each bank, so that a street can follow the water.
  // The street along a bank is a street's width and no main road takes it, so that what fronts it stands near the
  // water. A street between two corners is straight and the bank is not, so it stands half a lane's width further
  // back, and corners along the water are near enough together that the bank bows no further than that between them.
  const bankside = widths.street / 2 + roadside + widths.lane / 2 + 1;
  const chordOn = (bendRadius: number) => Math.sqrt(4 * bendRadius * widths.lane);
  const riverStep = chordOn((grown.river.meanderLength * settings.riverWidth) / (4 * Math.PI * Math.PI * grown.river.meanderSwing));
  const shoreStep = chordOn(grown.coast.wobble.length ** 2 / (4 * Math.PI * Math.PI * grown.coast.wobble.depth));
  if (river) {
    for (let along = 0; along < (river.along[river.along.length - 1] as number); ) {
      const { point, direction, width } = river.at(along);
      const spacing = spacingAt(point);
      const step = Math.min(spacing * 0.85, riverStep);
      along += step;
      if (Math.hypot(point[0], point[1]) > radius) continue;
      for (const sign of [1, -1]) {
        const normal: Point = [-direction[1] * sign, direction[0] * sign];
        const offset = width / 2 + bankside;
        const on: Point = [point[0] + normal[0] * offset, point[1] + normal[1] * offset];
        const land: Point = [on[0] + normal[0] * spacing * PAIR_REACH, on[1] + normal[1] * spacing * PAIR_REACH];
        // On the inside of a bend the bank doubles back on itself: no pair where another stretch of river is nearer.
        if (river.nearest(land).away < (offset + spacing * PAIR_REACH) * 0.9 || (coast && coast.gap(land) < spacing)) continue;
        pair(on, normal, spacing * PAIR_REACH, true, step);
      }
    }
  }
  // Along the shore, so that a quay can.
  const quayside = bankside;
  if (coast) {
    let since = Infinity;
    for (let index = 1; index < coast.shore.length - 1; index++) {
      const point = coast.shore[index] as Point;
      since += distance(coast.shore[index - 1] as Point, point);
      const spacing = spacingAt(point);
      const step = Math.min(spacing * 0.85, shoreStep);
      if (since < step || Math.hypot(point[0], point[1]) > radius) continue;
      since = 0;
      const before = coast.shore[index - 1] as Point;
      const after = coast.shore[index + 1] as Point;
      const length = distance(before, after) || 1;
      // Inland is the side away from the open water.
      let normal: Point = [-(after[1] - before[1]) / length, (after[0] - before[0]) / length];
      if (normal[0] * coast.seaward[0] + normal[1] * coast.seaward[1] > 0) normal = [-normal[0], -normal[1]];
      const on: Point = [point[0] + normal[0] * quayside, point[1] + normal[1] * quayside];
      if (river && river.gap(on) < spacing) continue;
      pair(on, normal, spacing * PAIR_REACH, true, step);
    }
  }
  // Along the wall.
  if (walled) {
    for (let bearing = 0; bearing < TAU; ) {
      const away = wallRadius(bearing);
      const on: Point = [Math.sin(bearing) * away, -Math.cos(bearing) * away];
      const spacing = spacingAt(on);
      const inward: Point = [-Math.sin(bearing), Math.cos(bearing)];
      bearing += (spacing * 0.9) / away;
      if (dryBy(on) < spacing * 1.2) continue;
      pair(on, inward, spacing * PAIR_REACH, false, spacing * 0.85);
    }
  }
  const blocked = (point: Point) => dryBy(point) < 0 || (plazaBuilding !== undefined && Math.hypot(point[0], point[1]) < 2.2 * plazaRadius);
  const seeds = scatter(stepRng(seed, 'grown-seeds'), radius, spacingAt, blocked, fixed);
  const fabric: Fabric = weave(seeds, radius, grown.shortestStreet, blocked);
  const corners = fabric.corners;
  const around = fabric.around;

  // ---- Cells and edges ---------------------------------------------------------------------------
  const outlineOf = (cell: FabricCell): Point[] => cell.corners.map((corner) => corners[corner] as Point);
  /** Water comes too near a point for a street to pass there. */
  const tooWet = (point: Point) => dryBy(point) < widths.street / 2 + roadside / 2;
  const cells: Cell[] = fabric.cells.map((cell) => {
    const outline = outlineOf(cell);
    const centre = polygonCentroid(outline);
    const midway = (point: Point, index: number): Point => [(point[0] + (outline[(index + 1) % outline.length] as Point)[0]) / 2, (point[1] + (outline[(index + 1) % outline.length] as Point)[1]) / 2];
    const water = cell.seed.water === true || dryBy(centre) < 0 || outline.some(tooWet) || outline.some((point, index) => tooWet(midway(point, index))) || outline.some((point) => dryBy([(point[0] + centre[0]) / 2, (point[1] + centre[1]) / 2]) < 0);
    const inside = !walled || insideWall(cell.seed.point);
    return { ...cell, water, inside, barred: cell.rim || (enclosesAll && !inside), touching: [], neighbours: [], centre };
  });
  const edges: Edge[] = fabric.edges.map((edge) => ({ ...edge, kind: 'street' as EdgeKind, fixed: false }));
  const isGround = (id: number) => !(cells[id] as Cell).water && !(cells[id] as Cell).rim;
  for (const edge of edges) {
    const [one, other] = edge.cells;
    if (other === undefined || one === undefined) continue;
    if (walled && isGround(one) && isGround(other) && (cells[one] as Cell).inside !== (cells[other] as Cell).inside) {
      edge.kind = 'wall';
      edge.fixed = true;
    }
  }
  const lengthOf = (edge: Edge) => distance(corners[edge.a] as Point, corners[edge.b] as Point);
  /** A boundary a street could run along: not the wall, with ground on at least one side and dry at both ends. */
  /** How near the water comes to the straight line between two points. */
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
  const isDry = (edge: Edge) => drynessOf(edge) >= widths.street / 2 + roadside / 2;
  /** Dry enough for a main road, which is wider. */
  const roadDry = widths.arterial / 2 + roadside / 2;
  const passable = (edge: Edge) => edge.kind !== 'wall' && edge.cells.some(isGround) && edge.cells.every((id) => !(cells[id] as Cell).rim) && isDry(edge);
  const atWater = (edge: Edge) => edge.cells.length === 2 && edge.cells.some(isGround) && edge.cells.some((id) => (cells[id] as Cell).water);
  const wallCorners = new Set(edges.filter((edge) => edge.kind === 'wall').flatMap((edge) => [edge.a, edge.b]));
  const plazaCell = plazaBuilding ? cells.find((cell) => cell.seed.fixed && cell.seed.point[0] === 0 && cell.seed.point[1] === 0) : undefined;
  if (plazaBuilding && (!plazaCell || plazaCell.water)) fail('the plaza has no dry ground at the centre');

  // ---- Bridges that could be built ---------------------------------------------------------------
  // Wherever a corner of one bank's street has a corner of the other's nearly straight across, where the river is no wider than usual.
  const bridges: Edge[] = [];
  if (river) {
    const banks = new Map<number, { side: number; along: number; width: number }>();
    for (const edge of edges) {
      if (!atWater(edge) || !passable(edge)) continue;
      for (const corner of [edge.a, edge.b]) {
        if (banks.has(corner)) continue;
        const point = corners[corner] as Point;
        const near = river.nearest(point);
        if (near.away > near.width / 2 + bankside + grown.spacing.edge / 2) continue;
        const { direction } = river.at(near.along);
        banks.set(corner, { side: Math.sign(direction[0] * (point[1] - near.point[1]) - direction[1] * (point[0] - near.point[0])), along: near.along, width: near.width });
      }
    }
    for (const [corner, bank] of banks) {
      if (bank.side <= 0 || bank.width > river.width) continue;
      let best: number | undefined;
      let nearest = Infinity;
      for (const [other, across] of banks) {
        if (across.side >= 0) continue;
        const away = distance(corners[corner] as Point, corners[other] as Point);
        // Straight across: no further along the river than a third of the way over.
        if (Math.abs(across.along - bank.along) > away / 3 || away > bank.width + 2 * bankside + grown.spacing.centre / 2) continue;
        if (away < nearest) {
          nearest = away;
          best = other;
        }
      }
      if (best === undefined) continue;
      bridges.push({ id: edges.length + bridges.length, a: corner, b: best, cells: [], kind: 'street', fixed: true, bridge: true });
    }
  }
  const edgeById = (id: number): Edge => (id < edges.length ? (edges[id] as Edge) : (bridges[id - edges.length] as Edge));
  /** The ways out of each corner. */
  const ways: Way[][] = corners.map(() => []);
  for (const edge of [...edges, ...bridges]) {
    if (!edge.bridge && !passable(edge)) continue;
    (ways[edge.a] as Way[]).push({ to: edge.b, edge: edge.id });
    (ways[edge.b] as Way[]).push({ to: edge.a, edge: edge.id });
  }

  // ---- Roads ---------------------------------------------------------------------------------------
  // A road is the cheapest way along the boundaries from the centre toward a far point. A stretch that leads aside
  // from where the road is going counts for more, so it wanders with the fabric without doubling back.
  let starts: number[];
  if (plazaCell) starts = plazaCell.corners.filter((corner) => (ways[corner] as Way[]).length > 0);
  else {
    let nearest = -1;
    corners.forEach((point, index) => {
      if ((ways[index] as Way[]).length > 0 && (nearest === -1 || Math.hypot(point[0], point[1]) < Math.hypot(...(corners[nearest] as Point)))) nearest = index;
    });
    starts = nearest === -1 ? [] : [nearest];
  }
  if (starts.length === 0) throw new TooSmall(1);
  /** Corners where a road has been let through the wall, and the gatehouse that keeps each. */
  const gates = new Map<number, Building>();
  const spare = [...gatehouses];
  const usedByRoad = new Set<number>();
  const roadTo = (target: Point, mayOpenGate: boolean): Road | undefined => {
    const reached = new Map<number, number>();
    const cameBy = new Map<number, [number, number]>();
    const heap = new Heap();
    for (const start of starts) {
      reached.set(start, 0);
      heap.push(0, start);
    }
    while (heap.size > 0) {
      const [so, corner] = heap.pop();
      if (so > (reached.get(corner) as number)) continue;
      const here = corners[corner] as Point;
      const toward: Point = [target[0] - here[0], target[1] - here[1]];
      const far = Math.hypot(toward[0], toward[1]) || 1;
      for (const way of ways[corner] as Way[]) {
        const edge = edgeById(way.edge);
        // The street along the water is left to the water: a main road keeps a block back from it.
        if (!edge.bridge && (atWater(edge) || drynessOf(edge) < roadDry)) continue;
        const there = corners[way.to] as Point;
        const length = distance(here, there);
        const cosine = ((there[0] - here[0]) * toward[0] + (there[1] - here[1]) * toward[1]) / (length * far || 1);
        // A road already there is cheap to follow; a bridge is dear; and the wall is passed only at a gate, or where one may be opened.
        let cost = length * (1 + grown.wander.aside * (1 - cosine)) * (usedByRoad.has(edge.id) ? 0.6 : 1) * (edge.bridge ? 4 : 1);
        if (wallCorners.has(way.to) && !gates.has(way.to)) {
          if (!mayOpenGate) continue;
          cost += 2 * grown.spacing.edge;
        }
        const next = so + cost;
        if (next < (reached.get(way.to) ?? Infinity)) {
          reached.set(way.to, next);
          cameBy.set(way.to, [corner, way.edge]);
          heap.push(next, way.to);
        }
      }
    }
    // The road ends at the corner it reached that is nearest where it was going.
    let end: number | undefined;
    let nearest = Infinity;
    for (const corner of reached.keys()) {
      const away = distance(corners[corner] as Point, target);
      if (away < nearest) {
        nearest = away;
        end = corner;
      }
    }
    if (end === undefined || !cameBy.has(end)) return undefined;
    const road: Road = { corners: [end], edges: [] };
    for (let back = end; cameBy.has(back); back = (cameBy.get(back) as [number, number])[0]) {
      road.corners.push((cameBy.get(back) as [number, number])[0]);
      road.edges.push((cameBy.get(back) as [number, number])[1]);
    }
    road.corners.reverse();
    road.edges.reverse();
    return road;
  };
  const roads: Road[] = [];
  const takeRoad = (road: Road, kind: 'arterial' | 'street', exit?: number) => {
    for (const id of road.edges) {
      const edge = edgeById(id);
      usedByRoad.add(id);
      if (kind === 'arterial' || edge.kind !== 'arterial') edge.kind = kind;
      edge.fixed = true;
      if (exit !== undefined && edge.exit === undefined) edge.exit = exit;
    }
    // A road through the wall has a gate there, kept by a gatehouse.
    for (const corner of road.corners) if (wallCorners.has(corner) && !gates.has(corner) && spare.length > 0) gates.set(corner, spare.shift() as Building);
    roads.push({ ...road, ...(exit !== undefined && { exit }) });
  };
  const farPoint = (bearing: number): Point => {
    const [x, y] = bearingVector(bearing);
    return [x * radius * 0.92, y * radius * 0.92];
  };
  brief.routes.forEach((route, index) => {
    const road = roadTo(farPoint(route.bearing), spare.length > 0);
    if (!road) throw new TooSmall(2);
    takeRoad(road, 'arterial', index);
  });
  // More ways out: local streets in the widest gaps between the roads there are, until the town has the pack's number.
  {
    const bearings = brief.routes.map((route) => (route.bearing * Math.PI) / 180);
    // A town with a river in reach and no road over it has a street that crosses: the first of its local ones.
    if (river && bridges.length > 0 && !roads.some((road) => road.edges.some((id) => edgeById(id).bridge === true))) {
      const near = river.nearest([0, 0]);
      const away = Math.hypot(near.point[0], near.point[1]);
      if (away > 0 && near.away < townRadius) {
        const beyond = (away + near.width + 0.5 * townRadius) / away;
        const road = roadTo([near.point[0] * beyond, near.point[1] * beyond], spare.length > 0);
        if (road && road.edges.some((id) => edgeById(id).bridge === true)) {
          takeRoad(road, 'street');
          bearings.push(bearingOf(near.point));
        }
      }
    }
    for (let tries = 0; roads.length < grown.roadsOut && tries < 2 * grown.roadsOut; tries++) {
      const sorted = [...bearings].sort((a, b) => a - b);
      let widest = sorted.length === 0 ? TAU : 0;
      let from = 0;
      sorted.forEach((bearing, index) => {
        const gap = index + 1 < sorted.length ? (sorted[index + 1] as number) - bearing : (sorted[0] as number) + TAU - bearing;
        if (gap > widest) {
          widest = gap;
          from = bearing;
        }
      });
      const bearing = turn(from + widest / 2);
      bearings.push(bearing);
      const road = roadTo(farPoint((bearing * 180) / Math.PI), spare.length > 0);
      // A local street that could go nowhere of its own is left out.
      if (!road || road.edges.every((id) => usedByRoad.has(id)) || Math.hypot(...(corners[road.corners[road.corners.length - 1] as number] as Point)) < townRadius * 0.6) continue;
      takeRoad(road, 'street');
    }
  }
  // Lesser gates: the gatehouses left over, where they split the longest stretches of wall without a gate.
  if (walled) {
    const through = (corner: number) => {
      const sides = (ways[corner] as Way[]).map((way) => edgeById(way.edge)).filter((edge) => !edge.bridge && edge.cells.length === 2 && edge.cells.every(isGround));
      return { inward: sides.find((edge) => edge.cells.every((id) => (cells[id] as Cell).inside)), outward: sides.find((edge) => edge.cells.every((id) => !(cells[id] as Cell).inside)) };
    };
    // A lesser gate needs a street on each side that leads on somewhere: one whose far end is not on the wall
    // itself, and has another boundary there that the wall does not close.
    const leadsOn = (edge: Edge | undefined, corner: number) => {
      if (!edge) return false;
      const far = edge.a === corner ? edge.b : edge.a;
      return !wallCorners.has(far) && (ways[far] as Way[]).some((way) => way.edge !== edge.id && !wallCorners.has(way.to) && edgeById(way.edge).kind !== 'none');
    };
    // And it must be on the centre's side of any water: where the streets inside the wall can be walked to.
    const within = new Set<number>(starts);
    {
      const queue = [...starts];
      for (let at = 0; at < queue.length; at++) {
        for (const way of ways[queue[at] as number] as Way[]) {
          const edge = edgeById(way.edge);
          if (within.has(way.to) || (edge.bridge && !usedByRoad.has(edge.id)) || (wallCorners.has(way.to) && !gates.has(way.to))) continue;
          within.add(way.to);
          queue.push(way.to);
        }
      }
    }
    const farEnd = (edge: Edge | undefined, corner: number) => (edge === undefined ? -1 : edge.a === corner ? edge.b : edge.a);
    // Where the wall has too few such places for all its gatehouses, the rest go where a street passes at all.
    const sound = (corner: number) => leadsOn(through(corner).inward, corner) && leadsOn(through(corner).outward, corner);
    const reached = (corner: number) => within.has(farEnd(through(corner).inward, corner));
    for (const fits of [(corner: number) => sound(corner) && reached(corner), reached, () => true]) {
      const candidates = [...wallCorners].filter((corner) => !gates.has(corner) && through(corner).inward && through(corner).outward && fits(corner)).sort((a, b) => a - b);
      while (spare.length > 0 && candidates.length > 0) {
        let chosen = 0;
        let furthest = -1;
        candidates.forEach((corner, index) => {
          const away = Math.min(TAU, ...[...gates.keys()].map((gate) => apart(bearingOf(corners[gate] as Point), bearingOf(corners[corner] as Point))));
          if (away > furthest) {
            furthest = away;
            chosen = index;
          }
        });
        const [corner] = candidates.splice(chosen, 1) as [number];
        gates.set(corner, spare.shift() as Building);
        for (const edge of Object.values(through(corner))) {
          if (!edge || edge.fixed) continue;
          edge.kind = 'lane';
          edge.fixed = true;
        }
      }
    }
    if (spare.length > 0) fail(`${spare.length} of its ${gatehouses.length} gatehouses have no place in the wall for a gate`);
    // No street touches the wall but at a gate: every other boundary that runs up to it is closed.
    for (const edge of edges) {
      if (edge.kind === 'wall') continue;
      const ends = [edge.a, edge.b].filter((corner) => wallCorners.has(corner));
      if (ends.length > 0 && !(edge.fixed && ends.every((corner) => gates.has(corner)))) {
        edge.kind = 'none';
        edge.fixed = true;
      }
    }
  }

  // ---- Easing the roads --------------------------------------------------------------------------
  // A road's corners are drawn toward the line between their neighbours on it, so that it bends where the fabric
  // does without a corner at every block. Corners on the water, the wall and the plaza keep their places.
  {
    const kept = new Set<number>([...wallCorners, ...(plazaCell?.corners ?? []), ...bridges.flatMap((bridge) => [bridge.a, bridge.b])]);
    for (const edge of edges) if (atWater(edge) || edge.cells.some((id) => (cells[id] as Cell).rim)) (kept.add(edge.a), kept.add(edge.b));
    for (let pass = 0; pass < 2; pass++) {
      for (const road of roads) {
        for (let at = 1; at + 1 < road.corners.length; at++) {
          const corner = road.corners[at] as number;
          if (kept.has(corner)) continue;
          const before = corners[road.corners[at - 1] as number] as Point;
          const after = corners[road.corners[at + 1] as number] as Point;
          const here = corners[corner] as Point;
          const moved: Point = [here[0] + (((before[0] + after[0]) / 2 - here[0]) * grown.wander.ease) / 2, here[1] + (((before[1] + after[1]) / 2 - here[1]) * grown.wander.ease) / 2];
          // Never so far that a boundary at the corner would be left with no length.
          // Never so far that a boundary at the corner would be left with no length, or brought too near the water.
          const clear = (around[corner] as number[]).every((id) => {
            const edge = edges[id] as Edge;
            const other = corners[edge.a === corner ? edge.b : edge.a] as Point;
            return distance(moved, other) > grown.shortestStreet && (drynessOf(edge) === Infinity || drynessBetween(moved, other) >= Math.min(drynessOf(edge), roadDry));
          });
          if (clear) {
            corners[corner] = moved;
            for (const id of around[corner] as number[]) dryAlong.delete(id);
          }
        }
      }
    }
    for (const cell of cells) cell.centre = polygonCentroid(outlineOf(cell));
    dryAlong.clear();
  }

  // ---- What each boundary is ------------------------------------------------------------------------
  {
    const rng = stepRng(seed, 'grown-fabric');
    const merged = new Set<number>();
    if (plazaCell) for (const id of plazaCell.edges) (edges[id] as Edge).fixed = true;
    // How many boundaries at each corner are still open to a street. One is never closed where that would leave
    // a street at either end of it with nowhere to go on to.
    const open: number[] = corners.map(() => 0);
    const shut = (corner: number) => {
      open[corner] = (open[corner] as number) - 1;
    };
    for (const edge of edges) {
      if (edge.kind === 'none' || !passable(edge)) continue;
      open[edge.a] = (open[edge.a] as number) + 1;
      open[edge.b] = (open[edge.b] as number) + 1;
    }
    const spared = (corner: number) => open[corner] !== 2;
    for (const edge of edges) {
      if (edge.kind === 'wall') continue;
      // A street along the water.
      if (atWater(edge) && edge.kind !== 'none') edge.fixed = true;
      if (edge.fixed) continue;
      const [one, other] = edge.cells;
      const draw = rng.next();
      const both = one !== undefined && other !== undefined && isGround(one) && isGround(other);
      if (both && draw < grown.fabric.merge && !merged.has(one) && !merged.has(other) && passable(edge) && spared(edge.a) && spared(edge.b)) {
        // Two blocks become one; some keep a dead-end court where the street was.
        merged.add(one);
        merged.add(other);
        const from = rng.next() < 0.5 ? edge.a : edge.b;
        if (rng.next() < grown.fabric.court && lengthOf(edge) > 4 * grown.shortestStreet && (open[from] as number) > 1) {
          edge.kind = 'court';
          edge.from = from;
          shut(from === edge.a ? edge.b : edge.a);
        } else {
          edge.kind = 'none';
          shut(edge.a);
          shut(edge.b);
        }
      } else if (both && rng.next() < grown.fabric.lane) edge.kind = 'lane';
    }
  }

  // Only ground that can be walked to from the centre is built on: the far bank only where a road's bridge leads.
  const reachable = new Uint8Array(cells.length);
  /** The corners that can be walked to from the centre along streets, through gates and over the bridges roads use. */
  const walked = new Set<number>(starts);
  {
    const open = (edge: Edge) => (edge.bridge ? usedByRoad.has(edge.id) : edge.kind !== 'none' && edge.kind !== 'court' && edge.kind !== 'wall');
    const queue = [...starts];
    for (let at = 0; at < queue.length; at++) {
      for (const way of ways[queue[at] as number] as Way[]) {
        const edge = edgeById(way.edge);
        if (walked.has(way.to) || !open(edge) || (wallCorners.has(way.to) && !gates.has(way.to))) continue;
        walked.add(way.to);
        queue.push(way.to);
      }
    }
    // A block can be walked to if a street along one of its sides can.
    for (const cell of cells) if (cell.edges.some((id) => open(edges[id] as Edge) && passable(edges[id] as Edge) && walked.has((edges[id] as Edge).a) && walked.has((edges[id] as Edge).b))) reachable[cell.id] = 1;
  }
  /** A street that can be walked to, or that leads to a gate and will be joined to the rest: lots open only onto these. */
  const walkable = (edge: Edge) => (edge.kind === 'court' ? walked.has(edge.from as number) : (walked.has(edge.a) && walked.has(edge.b)) || gates.has(edge.a) || gates.has(edge.b));

  // ---- Blocks ------------------------------------------------------------------------------------------
  const halfOf = (edge: Edge) => (edge.kind === 'court' ? widths.lane : widthOf(edge)) / 2;
  /** The clear ground round a corner: enough for the widest roadway that ends there. */
  const clearAt = (corner: number) =>
    Math.max(
      0,
      ...(ways[corner] as Way[])
        .map((way) => edgeById(way.edge))
        .filter((edge) => edge.bridge || (edge.kind !== 'none' && edge.kind !== 'wall'))
        .map((edge) => (edge.bridge ? widths.bridge : widths.arterial) / 2),
      wallCorners.has(corner) ? grown.wall.width / 2 : 0,
    ) + roadside;
  const blockOf = (cell: Cell): Block => {
    if (cell.block) return cell.block;
    const sides: BlockSide[] = cell.corners.map((corner, index) => {
      const edge = edges[cell.edges[index] as number] as Edge;
      const a = corners[corner] as Point;
      const b = corners[cell.corners[(index + 1) % cell.corners.length] as number] as Point;
      if (edge.kind === 'wall') return { a, b, inset: grown.wall.width / 2 + (cell.inside ? grown.wall.clearStrip : roadside) };
      if (edge.kind === 'none') return { a, b, inset: 0 };
      // A boundary too near the water to pass is no street, but the block keeps clear of it all the same.
      if (!passable(edge) || !walkable(edge)) return { a, b, inset: halfOf(edge) + roadside };
      if (edge.kind === 'court') return { a, b, inset: halfOf(edge) + roadside, street: edge.id, part: edge.from === corner ? [0, 0.5] : [0.5, 1] };
      return { a, b, inset: halfOf(edge) + roadside, street: edge.id };
    });
    let block = makeBlock(sides);
    if (block.polygon.length >= 3) {
      // Each corner is cut back far enough to clear the roadways that meet there.
      const cutBack = (polygon: Point[]) =>
        cell.corners.reduce((left, corner) => {
          if (left.length < 3) return left;
          const at = corners[corner] as Point;
          const away = distance(at, cell.centre) || 1;
          const normal: Point = [(cell.centre[0] - at[0]) / away, (cell.centre[1] - at[1]) / away];
          return clip(left, { at: [at[0] + normal[0] * clearAt(corner), at[1] + normal[1] * clearAt(corner)], normal });
        }, polygon);
      const polygon = cutBack(block.polygon);
      const tracks = block.tracks.flatMap((track): Track[] => {
        const ground = cutBack(track.ground);
        const on = ground.filter((point) => Math.abs((point[0] - track.origin[0]) * track.back[0] + (point[1] - track.origin[1]) * track.back[1]) < 1e-6).map((point) => (point[0] - track.origin[0]) * track.along[0] + (point[1] - track.origin[1]) * track.along[1]);
        if (ground.length < 3 || on.length < 2) return [];
        const from = Math.max(track.from, Math.min(...on));
        const to = Math.min(track.to, Math.max(...on));
        return to - from < 1 ? [] : [{ ...track, ground, from, to, cursor: from }];
      });
      block = { polygon: polygon.length >= 3 ? polygon : [], tracks: polygon.length >= 3 ? tracks : [] };
    }
    cell.block = block;
    return block;
  };

  const groundAt = (corner: number) => (around[corner] as number[]).flatMap((id) => (edges[id] as Edge).cells).filter(isGround);

  // ---- Lots to place -------------------------------------------------------------------------------------
  const placed: Placed[] = [];
  const districtIndex = new Map(city.districts.map((district, index) => [district.id, index]));
  const buildingsOf: Building[][] = city.districts.map(() => []);
  for (const building of city.buildings) (buildingsOf[districtIndex.get(building.districtId) as number] as Building[]).push(building);
  const held = new Set<string>(plazaBuilding ? [plazaBuilding.id] : []);
  const lotRng = stepRng(seed, 'grown-lots');
  const leanMost = (grown.lots.lean * Math.PI) / 180;
  /** Blocks that are used whether or not a district takes them: those with a gatehouse. */
  const reserved = new Set<number>();
  // Each gatehouse stands just inside its gate, at the end of the street that passes through it.
  for (const [corner, gatehouse] of gates) {
    held.add(gatehouse.id);
    const at = corners[corner] as Point;
    const size = lotSizeOf(gatehouse.type, pack);
    // On the gate's own street where a block inside the wall has frontage enough there; otherwise on whatever
    // frontage of a block at the gate comes nearest it, and outside the wall only where there is none within.
    let done = false;
    const gateStreets = new Set((ways[corner] as Way[]).map((way) => way.edge));
    const options = [...new Set(groundAt(corner))]
      .flatMap((id) => blockOf(cells[id] as Cell).tracks.map((track) => ({ cell: cells[id] as Cell, track, away: Math.min(distance(frontage(track, track.from), at), distance(frontage(track, track.to), at)) + (gateStreets.has(track.street) && track.to - track.from >= size.frontage ? 0 : 1000) + ((cells[id] as Cell).inside ? 0 : 5000) })))
      .sort((one, other) => one.away - other.away);
    for (const { cell, track } of options) {
      const width = Math.min(size.frontage, track.to - track.from);
      if (width < grown.lots.leastFrontage) continue;
      // The end of the frontage nearer the gate.
      const atStart = distance(frontage(track, track.from), at) < distance(frontage(track, track.to), at);
      const from = atStart ? track.from : track.to - width;
      const cut = cutLot(track, from, from + width, size.depth, 0, 0);
      if (cut.area < size.frontage * size.depth * 0.3) continue;
      if (atStart) track.cursor = track.from = from + width;
      else track.to = from;
      placed.push({ building: gatehouse, cell, polygon: cut.polygon, track, cut, street: track.street, door: frontage(track, from + width / 2), gatehouse: true });
      reserved.add(cell.id);
      done = true;
      break;
    }
    if (!done) fail(`the gate at bearing ${Math.round((bearingOf(at) * 180) / Math.PI)} has no ground beside it for its gatehouse`);
  }
  const spreadCivic = spreadCivicTypes(pack);
  /** Where the spread civic buildings placed so far stand, by type, for keeping the next apart from them. */
  const civic = new Map<string, Point[]>();

  // ---- Districts ---------------------------------------------------------------------------------------------
  // Blocks are neighbours across any boundary but the water, and across a bridge that a road uses.
  for (const edge of edges) {
    const [one, other] = edge.cells;
    if (one === undefined || other === undefined || !isGround(one) || !isGround(other)) continue;
    (cells[one] as Cell).neighbours.push(other);
    (cells[other] as Cell).neighbours.push(one);
    (cells[one] as Cell).touching.push(other);
    (cells[other] as Cell).touching.push(one);
  }
  for (const bridge of bridges) {
    if (!usedByRoad.has(bridge.id)) continue;
    for (const one of groundAt(bridge.a)) {
      for (const other of groundAt(bridge.b)) {
        if ((cells[one] as Cell).neighbours.includes(other)) continue;
        (cells[one] as Cell).neighbours.push(other);
        (cells[other] as Cell).neighbours.push(one);
      }
    }
  }
  const owner = new Int32Array(cells.length).fill(-1);
  const luck = new Float64Array(cells.length);
  {
    const rng = stepRng(seed, 'grown-districts');
    for (let cell = 0; cell < cells.length; cell++) luck[cell] = rng.next();
  }
  // What ground costs: its distance from the centre, counted for less beside a road and beside the water, and
  // varying a little by chance, which gives the town a ragged edge that reaches out along its roads and its banks.
  const roadLines = roads.map((road) => road.corners.map((corner) => corners[corner] as Point));
  const cost = new Float64Array(cells.length);
  cells.forEach((cell, index) => {
    if (!isGround(index)) return;
    const fromCentre = Math.hypot(cell.centre[0], cell.centre[1]);
    const toRoad = Math.min(Infinity, ...roadLines.filter((line) => line.length > 1).map((line) => distanceToPolyline(cell.centre, line)));
    const pull = Math.max(grown.outline.arterialPull * Math.exp(-toRoad / grown.outline.reach), grown.outline.waterPull * Math.exp(-Math.max(0, dryBy(cell.centre)) / grown.outline.reach));
    cost[index] = fromCentre * (1 - pull) + (luck[index] as number) * grown.outline.ragged;
  });
  const isFree = (cell: number) => owner[cell] === -1 && reachable[cell] === 1 && isGround(cell) && !(cells[cell] as Cell).barred;
  const best = (among: Iterable<number>, score: (cell: number) => number): number | undefined => {
    let found: number | undefined;
    let foundScore = Infinity;
    for (const cell of among) {
      const value = score(cell);
      if (value < foundScore) {
        found = cell;
        foundScore = value;
      }
    }
    return found;
  };
  const cellsOf: number[][] = city.districts.map(() => []);
  if (plazaCell && plazaBuilding) {
    // The plaza is ground of its building's district.
    owner[plazaCell.id] = districtIndex.get(plazaBuilding.districtId) as number;
    (cellsOf[owner[plazaCell.id] as number] as number[]).push(plazaCell.id);
  }
  /** Free blocks beside the town as it stands: where the next district may begin. */
  const besideTown = (): number[] => {
    const found = new Set<number>();
    cells.forEach((cell, index) => {
      if ((owner[index] as number) < 0) return;
      for (const next of cell.neighbours) if (isFree(next)) found.add(next);
    });
    return [...found].sort((a, b) => a - b);
  };

  const groundOf = cells.map((cell) => polygonArea(outlineOf(cell)));
  /** For each free block, how much free ground it is joined to, itself included: a district begun there can have no more. */
  const roomAt = (): Float64Array => {
    const room = new Float64Array(cells.length);
    const seen = new Uint8Array(cells.length);
    for (const cell of cells) {
      if (seen[cell.id] || !isFree(cell.id)) continue;
      const part = [cell.id];
      seen[cell.id] = 1;
      let area = 0;
      for (let at = 0; at < part.length; at++) {
        area += groundOf[part[at] as number] as number;
        for (const next of (cells[part[at] as number] as Cell).touching) {
          if (seen[next] || !isFree(next)) continue;
          seen[next] = 1;
          part.push(next);
        }
      }
      for (const id of part) room[id] = area;
    }
    return room;
  };
  /** Whether a block has room about it for the district being placed. */
  let roomy: (cell: number) => boolean = () => true;

  /** Grows one district outward from a first block, cutting its lots as it goes. */
  const placeDistrict = (district: number, pickFirst: (candidates: number[]) => number | undefined) => {
    const buildings = (buildingsOf[district] as Building[]).filter((building) => !held.has(building.id));
    if (buildings.length === 0) return;
    const kind = (city.districts[district] as District).kind;
    const filled = grown.lots.filled.includes(kind);
    const byWater = placementOf(city.districts[district] as District) === 'waterside' && (river !== undefined || coast !== undefined);
    const gapChance = grown.lots.gaps[kind] ?? 0;
    const blocks: Cell[] = [];
    const frontier = new Map<number, number>();
    const addBlock = (id: number, depth: number): Cell => {
      owner[id] = district;
      (cellsOf[district] as number[]).push(id);
      frontier.delete(id);
      const cell = cells[id] as Cell;
      // A district is one piece of ground: it grows across boundaries, never over a bridge.
      for (const next of cell.touching) if (isFree(next) && !frontier.has(next)) frontier.set(next, depth + 1);
      blocks.push(cell);
      blockOf(cell);
      return cell;
    };
    // The ground of the plaza, where the district has it, is where it begins.
    for (const id of cellsOf[district] as number[]) for (const next of (cells[id] as Cell).touching) if (isFree(next)) frontier.set(next, 1);
    /** Takes one more block: the cheapest beside the district, or the one that scores least by a measure given. */
    const grow = (score?: (cell: number) => number): Cell => {
      const cell = best(frontier.keys(), score ?? ((candidate) => (frontier.get(candidate) as number) * grown.outline.compact + (cost[candidate] as number)));
      if (cell === undefined) throw new TooSmall(3);
      return addBlock(cell, frontier.get(cell) as number);
    };
    type Fit = { track: Track; cut: Cut; lean: number };
    /** Where a building would stand in a block, on the frontage with most room left; nothing if it fits on none. */
    const fit = (cell: Cell, building: Building, spread: number): Fit | undefined => {
      if (cell.whole) return undefined;
      const { frontage: typical, depth } = lotSizeOf(building.type, pack);
      const wanted = typical * depth * spread;
      const deepest = depth * grown.lots.deepest;
      let found: Fit | undefined;
      let emptiest = Infinity;
      for (const track of (cell.block as Block).tracks) {
        const room = track.to - track.cursor;
        if (room < grown.lots.leastFrontage) continue;
        // The frontage with most room left; in a district by the water, the one nearest the water.
        const used = byWater ? dryBy(frontage(track, (track.from + track.to) / 2)) : (track.cursor - track.from) / (track.to - track.from);
        if (used >= emptiest) continue;
        // A first cut at the typical frontage shows how deep the block lets the lot run; the frontage is then set to give the lot its area.
        let width = Math.min(room, Math.max(grown.lots.leastFrontage, typical * spread));
        let cut = cutLot(track, track.cursor, track.cursor + width, deepest, track.lean, 0);
        for (let pass = 0; pass < 3 && cut.area > 0; pass++) {
          const next = Math.min(room, Math.max(grown.lots.leastFrontage, (width * wanted) / cut.area));
          if (Math.abs(next - width) < 0.05) break;
          width = next;
          cut = cutLot(track, track.cursor, track.cursor + width, deepest, track.lean, 0);
        }
        // What is left of the frontage, if too little for another lot, goes to this one where that does not make it much too big.
        const last = room - width < grown.lots.leastFrontage && cutLot(track, track.cursor, track.cursor + room, deepest, track.lean, 0).area <= wanted * grown.lots.area.max;
        const lean = last || room - width < grown.lots.leastFrontage ? 0 : (lotRng.next() * 2 - 1) * leanMost;
        if (last) width = room;
        // Or else it is drawn in to leave room enough for another.
        else if (room - width < grown.lots.leastFrontage && room - grown.lots.leastFrontage >= grown.lots.leastFrontage) width = room - grown.lots.leastFrontage;
        cut = cutLot(track, track.cursor, track.cursor + width, deepest, track.lean, lean);
        if (cut.area < wanted * grown.lots.area.min || cut.area > wanted * grown.lots.area.max || width > typical * grown.lots.widest) continue;
        found = { track, cut, lean };
        emptiest = used;
      }
      return found;
    };
    const take = (cell: Cell, building: Building, lot: Fit) => {
      const { track, cut } = lot;
      track.cursor = cut.to;
      track.lean = lot.lean;
      // In the outer districts a gap is sometimes left before the next lot.
      if (!filled && lotRng.next() < gapChance) {
        // The next lot begins on a line that leans as this one's side does, so that the two never meet behind the gap.
        track.cursor = Math.min(track.to, track.cursor + grown.lots.gapWidth.min + lotRng.next() * (grown.lots.gapWidth.max - grown.lots.gapWidth.min));
      }
      placed.push({ building, cell, polygon: cut.polygon, track, cut, street: track.street, door: frontage(track, (cut.from + cut.to) / 2) });
    };
    /** A building with a block to itself: the first untouched block of about its size, growing the district to find one. */
    const placeWhole = (building: Building) => {
      const wanted = lotArea(building);
      const suits = (cell: Cell, loosely: boolean) => {
        const block = cell.block as Block;
        if (cell.whole || block.polygon.length < 3 || block.tracks.length === 0 || block.tracks.some((track) => track.cursor > track.from) || reserved.has(cell.id)) return false;
        const area = polygonArea(block.polygon);
        return loosely ? area > wanted * 0.25 : area > wanted * 0.6 && area < wanted * 1.6;
      };
      // The block nearest its size; in a district by the water, the one nearest the water.
      const off = (cell: Cell) => (byWater ? dryBy(cell.centre) : Math.abs(Math.log(polygonArea((cell.block as Block).polygon) / wanted)));
      let chosen = blocks.filter((cell) => suits(cell, false)).reduce<Cell | undefined>((nearest, cell) => (nearest === undefined || off(cell) < off(nearest) ? cell : nearest), undefined);
      // By the water it grows along the water, and takes a block there whatever its size: blocks at the bank are small.
      const toWater = (cell: number) => Math.min(...outlineOf(cells[cell] as Cell).map(dryBy));
      if (byWater) chosen = blocks.filter((cell) => suits(cell, true) && toWater(cell.id) < 2 * bankside).reduce<Cell | undefined>((largest, cell) => (largest === undefined || polygonArea((cell.block as Block).polygon) > polygonArea((largest.block as Block).polygon) ? cell : largest), undefined) ?? chosen;
      for (let tries = 0; !chosen && tries < BLOCK_TRIES; tries++) {
        const cell = byWater ? grow(toWater) : grow();
        if (suits(cell, byWater || tries > BLOCK_TRIES / 2)) chosen = cell;
      }
      chosen ??= blocks.filter((cell) => suits(cell, true)).reduce<Cell | undefined>((nearest, cell) => (nearest === undefined || off(cell) < off(nearest) ? cell : nearest), undefined);
      if (!chosen) throw new TooSmall(4);
      chosen.whole = true;
      const block = chosen.block as Block;
      const track = block.tracks.reduce((longest, entry) => (entry.to - entry.from > longest.to - longest.from ? entry : longest));
      placed.push({ building, cell: chosen, polygon: block.polygon, street: track.street, door: frontage(track, (track.from + track.to) / 2) });
    };
    /**
     * A whole side of a block for one building: all the ground of a street side that no lot has been cut from yet.
     * For a building whose lot is too big to be cut from part of a side. The side whose ground is nearest the
     * size wanted, among those of at least `least` times it.
     */
    const fitSide = (among: Cell[], building: Building, least: number): { cell: Cell; lot: Fit } | undefined => {
      const wanted = lotArea(building);
      let found: { cell: Cell; lot: Fit } | undefined;
      let off = Infinity;
      for (const cell of among) {
        if (cell.whole) continue;
        for (const track of (cell.block as Block).tracks) {
          if (track.cursor > track.from + 1e-9 || track.to - track.from < grown.lots.leastFrontage) continue;
          const cut = cutLot(track, track.from, track.to, Infinity, 0, 0);
          if (cut.area < wanted * least || cut.area > wanted * 2.5) continue;
          const miss = Math.abs(Math.log(cut.area / wanted));
          if (miss < off) {
            off = miss;
            found = { cell, lot: { track, cut, lean: 0 } };
          }
        }
      }
      return found;
    };
    const place = (building: Building) => {
      const spread = 1 + (lotRng.next() * 2 - 1) * grown.lots.frontageSpread;
      for (const block of blocks) {
        const lot = fit(block, building, spread);
        if (lot) return take(block, building, lot);
      }
      // What is too big to be cut from the side of a block has a block to itself.
      if (lotArea(building) >= grown.lots.wholeBlock) return placeWhole(building);
      for (let tries = 0; tries < BLOCK_TRIES; tries++) {
        const block = grow();
        const lot = fit(block, building, spread);
        if (lot) return take(block, building, lot);
      }
      // Whatever side of a block is nearest its size, however far off, rather than no place at all.
      const side = fitSide(blocks, building, 0.1);
      if (side) return take(side.cell, building, side.lot);
      throw new TooSmall(5);
    };
    /** A civic building that the pack spreads stands as far as it can from the others of its type, and at least the pack's distance where the district has room. */
    const placeApart = (building: Building) => {
      const others = civic.get(building.type) ?? [];
      const choose = (among: Cell[]) => {
        let chosen: { cell: Cell; lot: Fit; away: number; at: Point } | undefined;
        for (const cell of among) {
          const lot = fit(cell, building, 1);
          if (!lot) continue;
          const here = polygonCentroid(lot.cut.polygon);
          const away = Math.min(Infinity, ...others.map((other) => distance(other, here)));
          if (!chosen || away > chosen.away) chosen = { cell, lot, away, at: here };
        }
        return chosen;
      };
      let chosen = choose(blocks);
      for (let more = 0; more < APART_BLOCKS && (!chosen || chosen.away < grown.civicSpacing); more++) {
        let block: Cell;
        try {
          block = grow();
        } catch (error) {
          if (error instanceof TooSmall && chosen) break;
          throw error;
        }
        const next = choose([block]);
        if (next && (!chosen || next.away > chosen.away)) chosen = next;
      }
      if (!chosen) return place(building);
      take(chosen.cell, building, chosen.lot);
      civic.set(building.type, [...others, chosen.at]);
    };
    if (frontier.size === 0) {
      // It begins where the free ground is enough for all of it, if anywhere is.
      const room = roomAt();
      const wanted = buildings.reduce((sum, building) => sum + lotArea(building), 0) / grown.lotShare;
      const all = owner.some((value) => value >= 0) ? besideTown() : cells.map((cell) => cell.id).filter(isFree);
      const most = Math.max(0, ...all.map((cell) => room[cell] as number));
      roomy = (cell) => (room[cell] as number) >= Math.min(wanted, most);
      const first = pickFirst(all.filter(roomy));
      if (first === undefined) throw new TooSmall(6);
      addBlock(first, 0);
    }
    for (const { building, apart: keptApart } of placementOrder(buildings, pack, lotRng, () => false)) {
      if (keptApart && spreadCivic.has(building.type)) placeApart(building);
      else place(building);
    }
    // Blocks it grew over and put nothing in are given back, unless the district would fall apart without one.
    const built = new Set(placed.map((lot) => lot.cell.id));
    if (plazaCell) built.add(plazaCell.id);
    const own = new Set(cellsOf[district] as number[]);
    const whole = (): boolean => {
      const first = [...own].find((id) => built.has(id));
      if (first === undefined) return true;
      const seen = new Set([first]);
      const queue = [first];
      for (let at = 0; at < queue.length; at++) {
        for (const next of (cells[queue[at] as number] as Cell).touching) {
          if (!own.has(next) || seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      return [...own].every((id) => !built.has(id) || seen.has(id));
    };
    for (const id of [...(cellsOf[district] as number[])].reverse()) {
      if (built.has(id)) continue;
      own.delete(id);
      if (whole()) owner[id] = -1;
      else own.add(id);
    }
    cellsOf[district] = (cellsOf[district] as number[]).filter((id) => own.has(id));
  };

  const districtsPlaced = (placement: string) => city.districts.map((district, index) => ({ district, index })).filter(({ district }) => placementOf(district) === placement);
  const cheapest = (candidates: number[]) => best(candidates, (cell) => cost[cell] as number);
  // The centre: the district with the plaza first, so that its ground lies round it.
  const central = districtsPlaced('centre').sort((a, b) => Number(b.district.id === plazaBuilding?.districtId) - Number(a.district.id === plazaBuilding?.districtId));
  for (const { index } of central) placeDistrict(index, (candidates) => best(candidates, (cell) => Math.hypot(...(cells[cell] as Cell).centre)));
  // Waterside districts: at the shore, or else on the bank.
  for (const { index } of districtsPlaced('waterside')) {
    placeDistrict(index, (candidates) => {
      if (!coast && !river) return cheapest(candidates);
      const gap = (cell: number) => Math.min(...outlineOf(cells[cell] as Cell).map((point) => (coast ? coast.gap(point) : (river as River).gap(point))));
      const within = candidates.filter((cell) => gap(cell) <= settings.watersideReach * 0.6);
      // Beside the town if it has reached the water; otherwise the nearest ground to the town that is at the water.
      if (within.length > 0) return cheapest(within);
      const atWaterside = cells.map((cell) => cell.id).filter((cell) => isFree(cell) && roomy(cell) && gap(cell) <= settings.watersideReach * 0.6);
      return atWaterside.length > 0 ? cheapest(atWaterside) : best(candidates, gap);
    });
  }
  for (const { index } of districtsPlaced('middle')) placeDistrict(index, cheapest);
  for (const { index } of districtsPlaced('edge')) placeDistrict(index, cheapest);
  if (placed.length !== city.buildings.length - (plazaBuilding ? 1 : 0)) fail(`${city.buildings.length - (plazaBuilding ? 1 : 0) - placed.length} buildings are in districts whose kind the pack no longer lists`);

  // ---- Streets of one trade ------------------------------------------------------------------------------
  // Which building holds which lot is settled last, and changes no lot: buildings whose lots are of one size in
  // the pack change places within a district, as on the grid. A gatehouse keeps its gate, and a building with a
  // block to itself its block.
  {
    const trackOrder = new Map<Track, number>();
    for (const lot of placed) if (lot.track && !trackOrder.has(lot.track)) trackOrder.set(lot.track, trackOrder.size);
    arrangeTrades(
      placed.filter((lot) => !lot.gatehouse && lot.track && lot.cut),
      pack,
      (a, b) => a.cell.id - b.cell.id || (trackOrder.get(a.track as Track) as number) - (trackOrder.get(b.track as Track) as number) || (a.cut as Cut).from - (b.cut as Cut).from,
      (a, b) => a.track === b.track && Math.abs((a.cut as Cut).to - (b.cut as Cut).from) < 1e-9,
    );
  }

  // ---- The streets that are kept ----------------------------------------------------------------------------
  const used = cells.filter((cell) => (owner[cell.id] as number) >= 0 || reserved.has(cell.id));
  const usedSet = new Set(used.map((cell) => cell.id));
  const streets = new Set<number>();
  const isStreet = (edge: Edge) => edge.bridge === true || (edge.kind !== 'none' && edge.kind !== 'wall' && passable(edge) && (walkable(edge) || usedByRoad.has(edge.id)));
  for (const cell of used) for (const id of cell.edges) if (isStreet(edges[id] as Edge)) streets.add(id);
  // Each road runs as far as the town does, and a main road on to its exit.
  const exitDrafts: Array<{ point: Point; joins: number } | undefined> = brief.routes.map(() => undefined);
  const outlines = used.map((cell) => outlineOf(cell));
  const lotBoxes = placed.map((lot) => boxOf(lot.polygon, widths.arterial / 2));
  const wallPieces = edges.filter((edge) => edge.kind === 'wall').map((edge): [Point, Point] => [corners[edge.a] as Point, corners[edge.b] as Point]);
  const crossesTown = (from: Point, to: Point) =>
    wallPieces.some(([a, b]) => piecesCross(from, to, a, b)) ||
    outlines.some((outline) => outline.some((point, index) => piecesCross(from, to, point, outline[(index + 1) % outline.length] as Point))) ||
    placed.some((lot, index) => {
      const box = lotBoxes[index] as ReturnType<typeof boxOf>;
      if (Math.max(from[0], to[0]) < box.minX || Math.min(from[0], to[0]) > box.maxX || Math.max(from[1], to[1]) < box.minY || Math.min(from[1], to[1]) > box.maxY) return false;
      return distancePolygonToPolyline(lot.polygon, [from, to]) < widths.arterial / 2;
    });
  let roadsOut = 0;
  for (const road of roads) {
    let last = 0;
    road.corners.forEach((corner, at) => {
      if (groundAt(corner).some((id) => usedSet.has(id))) last = at;
    });
    if (road.exit === undefined) {
      if (last === 0) continue;
      roadsOut++;
      for (const id of road.edges.slice(0, last)) streets.add(id);
      continue;
    }
    roadsOut++;
    const exit = brief.routes[road.exit] as SettlementBrief['routes'][number];
    // The exit lies beyond a junction at the town's edge, at the brief's bearing: first the road's own junctions
    // from where the town ends, then any junction on the town's edge, nearest the bearing first. It moves aside a
    // degree at a time only where no straight road can be laid to it without crossing the town or the water.
    const onEdge = (corner: number) => (around[corner] as number[]).some((id) => (edges[id] as Edge).cells.some((cell) => !usedSet.has(cell))) && (around[corner] as number[]).some((id) => streets.has(id));
    const ray = bearingVector(exit.bearing);
    const aside = (corner: number) => Math.abs((corners[corner] as Point)[0] * ray[1] - (corners[corner] as Point)[1] * ray[0]) - 1e-3 * ((corners[corner] as Point)[0] * ray[0] + (corners[corner] as Point)[1] * ray[1]);
    const others = corners.map((_, corner) => corner).filter((corner) => onEdge(corner) && (corners[corner] as Point)[0] * ray[0] + (corners[corner] as Point)[1] * ray[1] > 0).sort((a, b) => aside(a) - aside(b)).slice(0, 40);
    const onward = road.corners.slice(last).map((joins, index) => ({ joins, upTo: last + index }));
    const candidates: Array<{ joins: number; upTo?: number }> = [...onward.slice(0, 3), ...others.map((joins) => ({ joins })), ...onward.slice(3)];
    let joined = false;
    for (let step = 0; step <= 2 * EXIT_TOLERANCE && !joined; step++) {
      const offset = step % 2 === 1 ? (step + 1) / 2 : -step / 2;
      if (Math.abs(offset) >= EXIT_TOLERANCE) continue;
      const direction = bearingVector(exit.bearing + offset);
      for (const { joins, upTo } of candidates) {
        const from = corners[joins] as Point;
        let reach = Math.hypot(from[0], from[1]) + grown.exitReach;
        let point: Point = [direction[0] * reach, direction[1] * reach];
        // Toward the sea, or across the river, the exit stands at the water's edge.
        for (let back = 0; back < 60 && reach > 0 && dryBy(point) < widths.arterial / 2 + 1; back++) {
          reach -= grown.exitReach / 10;
          point = [direction[0] * reach, direction[1] * reach];
        }
        const steps = Math.max(1, Math.ceil(distance(from, point) / 2));
        const dryWay = Array.from({ length: steps + 1 }, (_, at): Point => [from[0] + ((point[0] - from[0]) * at) / steps, from[1] + ((point[1] - from[1]) * at) / steps]).every((spot) => dryBy(spot) >= widths.arterial / 2 + 1);
        if (reach <= 0 || distance(from, point) < widths.arterial || distance(from, point) > 4 * grown.exitReach || !dryWay || crossesTown(from, point) || exitDrafts.some((other) => other && distance(other.point, point) < widths.arterial)) continue;
        for (const id of road.edges.slice(0, upTo ?? last)) streets.add(id);
        exitDrafts[road.exit] = { point, joins };
        joined = true;
        break;
      }
    }
    if (!joined) throw new TooSmall(7);
  }
  // Every gate is a way through the wall.
  for (const corner of gates.keys()) for (const way of ways[corner] as Way[]) if (isStreet(edgeById(way.edge)) && edgeById(way.edge).fixed) streets.add(way.edge);
  // A town above the pack's size with building on both banks has a second bridge, well away from the first.
  if (river && brief.population >= grown.river.secondBridgeAbove) {
    const built = bridges.filter((bridge) => streets.has(bridge.id));
    const onStreet = new Set([...streets].flatMap((id) => [edgeById(id).a, edgeById(id).b]));
    const candidates = bridges.filter((bridge) => !streets.has(bridge.id) && onStreet.has(bridge.a) && onStreet.has(bridge.b));
    if (built.length === 1 && candidates.length > 0) {
      const first = corners[(built[0] as Edge).a] as Point;
      const second = candidates.reduce((furthest, bridge) => (distance(corners[bridge.a] as Point, first) > distance(corners[furthest.a] as Point, first) ? bridge : furthest));
      if (distance(corners[second.a] as Point, first) > 2 * grown.spacing.centre) streets.add(second.id);
    }
  }
  // Whatever is left apart is joined to the rest.
  for (;;) {
    const touched = new Set<number>();
    const link = new Map<number, number[]>();
    for (const id of streets) {
      const edge = edgeById(id);
      // A court leads nowhere: it is joined at the corner it is entered from, and joins nothing through itself.
      if (edge.kind === 'court' && !edge.bridge) {
        touched.add(edge.from as number);
        continue;
      }
      const { a, b } = edge;
      touched.add(a).add(b);
      link.set(a, [...(link.get(a) ?? []), b]);
      link.set(b, [...(link.get(b) ?? []), a]);
    }
    if (touched.size === 0) fail('the town has no streets');
    const start = Math.min(...touched);
    const main = new Set([start]);
    const queue = [start];
    for (let next = 0; next < queue.length; next++) {
      for (const beside of link.get(queue[next] as number) ?? []) {
        if (!main.has(beside)) {
          main.add(beside);
          queue.push(beside);
        }
      }
    }
    if (main.size === touched.size) break;
    // The shortest way from the main part to anything apart from it, along boundaries a street may take.
    const reached = new Map<number, number>();
    const cameBy = new Map<number, [number, number]>();
    const heap = new Heap();
    for (const corner of main) {
      reached.set(corner, 0);
      heap.push(0, corner);
    }
    let found: number | undefined;
    while (heap.size > 0) {
      const [so, corner] = heap.pop();
      if (so > (reached.get(corner) as number)) continue;
      if (touched.has(corner) && !main.has(corner)) {
        found = corner;
        break;
      }
      for (const way of ways[corner] as Way[]) {
        const edge = edgeById(way.edge);
        // Along streets and bridges; failing those, along a boundary that was closed between two blocks, and one
        // between blocks that were built on only where nothing else will do: the lots there are drawn back from it.
        const closed = edge.kind === 'none' && !edge.fixed;
        if (!isStreet(edge) && !closed) continue;
        if (wallCorners.has(way.to) && !gates.has(way.to)) continue;
        const next = so + distance(corners[corner] as Point, corners[way.to] as Point) * (edge.bridge ? 4 : closed && edge.cells.some((id) => usedSet.has(id)) ? 8 : 1);
        if (next < (reached.get(way.to) ?? Infinity)) {
          reached.set(way.to, next);
          cameBy.set(way.to, [corner, way.edge]);
          heap.push(next, way.to);
        }
      }
    }
    if (found === undefined) {
      // Streets that nothing opens onto, and that lead nowhere, are left out; anything else apart is a fault.
      const fronted = new Set(placed.map((lot) => lot.street));
      const apartStreets = [...streets].filter((id) => !main.has(edgeById(id).kind === 'court' && !edgeById(id).bridge ? (edgeById(id).from as number) : edgeById(id).a));
      if (apartStreets.length === 0 || apartStreets.some((id) => fronted.has(id))) fail('part of the town cannot be joined to the rest by any street or bridge');
      for (const id of apartStreets) streets.delete(id);
      continue;
    }
    for (let back = found as number; cameBy.has(back); back = (cameBy.get(back) as [number, number])[0]) {
      const edge = edgeById((cameBy.get(back) as [number, number])[1]);
      // A boundary that had been closed between two blocks nobody built on is opened again as a lane, and a court
      // that is the only way through runs the whole length of its boundary.
      if (edge.kind === 'none' || (edge.kind === 'court' && !edge.bridge)) edge.kind = 'lane';
      streets.add(edge.id);
    }
  }

  // ---- Records ---------------------------------------------------------------------------------------------------
  const kept = [...streets].sort((a, b) => a - b).map(edgeById);
  /** Where a court ends: half way along its boundary. */
  const courtEnd = (edge: Edge): Point => [((corners[edge.a] as Point)[0] + (corners[edge.b] as Point)[0]) / 2, ((corners[edge.a] as Point)[1] + (corners[edge.b] as Point)[1]) / 2];
  const isCourt = (edge: Edge) => edge.kind === 'court' && !edge.bridge;
  const junctionIds = new Map<string, string>();
  const layoutJunctions: Junction[] = [];
  const degree = new Map<number, number>();
  const atBridge = new Set<number>();
  for (const edge of kept) {
    for (const end of isCourt(edge) ? [edge.from as number] : [edge.a, edge.b]) {
      degree.set(end, (degree.get(end) ?? 0) + 1);
      if (edge.bridge) atBridge.add(end);
    }
  }
  for (const draft of exitDrafts) if (draft) degree.set(draft.joins, (degree.get(draft.joins) ?? 0) + 1);
  const junctionFor = (key: string, position: Point, kind: JunctionKind): string => {
    let id = junctionIds.get(key);
    if (!id) {
      id = `junction-${number}-${pad(layoutJunctions.length + 1, 6)}`;
      junctionIds.set(key, id);
      layoutJunctions.push({ id, position, kind });
    }
    return id;
  };
  const cornerJunction = (corner: number) => junctionFor(`c${corner}`, corners[corner] as Point, gates.has(corner) ? 'gate' : atBridge.has(corner) ? 'bridge-end' : degree.get(corner) === 1 ? 'dead-end' : 'crossing');
  for (const corner of [...degree.keys()].sort((a, b) => a - b)) cornerJunction(corner);
  const segmentIds = new Map<number, string>();
  const segmentPoints = new Map<number, Point[]>();
  const segments: Segment[] = kept.map((edge, index) => {
    const id = `segment-${number}-${pad(index + 1, 6)}`;
    segmentIds.set(edge.id, id);
    const court = isCourt(edge);
    const from = court ? (edge.from as number) : edge.a;
    const points: Point[] = court ? [corners[from] as Point, courtEnd(edge)] : [corners[edge.a] as Point, corners[edge.b] as Point];
    segmentPoints.set(edge.id, points);
    const route = edge.exit === undefined ? undefined : (brief.routes[edge.exit] as SettlementBrief['routes'][number]);
    const kind: SegmentKind = edge.bridge ? 'bridge' : edge.kind === 'arterial' ? 'arterial' : edge.kind === 'street' ? 'street' : 'lane';
    return {
      id,
      fromJunctionId: cornerJunction(from),
      toJunctionId: court ? junctionFor(`court${edge.id}`, courtEnd(edge), 'dead-end') : cornerJunction(edge.b),
      points,
      kind,
      width: widthOf(edge),
      ...(route?.name !== undefined && { name: route.name }),
      ...(route && { routeId: route.routeId }),
    };
  });
  const exits: Exit[] = exitDrafts.map((draft, position) => {
    const exit = brief.routes[position] as SettlementBrief['routes'][number];
    const { point, joins } = draft as { point: Point; joins: number };
    const junctionId = junctionFor(`exit${position}`, point, 'exit');
    segments.push({
      id: `segment-${number}-${pad(segments.length + 1, 6)}`,
      fromJunctionId: cornerJunction(joins),
      toJunctionId: junctionId,
      points: [corners[joins] as Point, point],
      kind: 'arterial',
      width: widths.arterial,
      ...(exit.name !== undefined && { name: exit.name }),
      routeId: exit.routeId,
    });
    return { id: `exit-${number}-${pad(position + 1, 3)}`, junctionId, routeId: exit.routeId, ...(exit.name !== undefined && { name: exit.name }), kind: exit.kind, bearing: exit.bearing };
  });
  const waters: Water[] = [];
  const waterId = () => `water-${number}-${pad(waters.length + 1, 3)}`;
  if (river) waters.push({ id: waterId(), kind: 'river', centreLine: river.line, width: river.width, widths: river.widths });
  if (coast) waters.push({ id: waterId(), kind: 'sea', polygon: coast.polygon });

  // The wall: the boundaries between what is inside and what is outside, joined end to end, with the gates on it.
  const walls: Wall[] = [];
  if (walled) {
    const wallEdges = edges.filter((edge) => edge.kind === 'wall' && !tooWet(corners[edge.a] as Point) && !tooWet(corners[edge.b] as Point));
    const at = new Map<number, Edge[]>();
    for (const edge of wallEdges) for (const corner of [edge.a, edge.b]) at.set(corner, [...(at.get(corner) ?? []), edge]);
    const done = new Set<number>();
    const follow = (start: number): number[] => {
      const line = [start];
      for (let corner = start; ; ) {
        const next = (at.get(corner) ?? []).find((edge) => !done.has(edge.id));
        if (!next) break;
        done.add(next.id);
        corner = next.a === corner ? next.b : next.a;
        line.push(corner);
      }
      return line;
    };
    // Open stretches begin at an end; whatever is left after them is a closed ring.
    const lines: number[][] = [];
    const ends = [...at].filter(([, list]) => list.length === 1).map(([corner]) => corner).sort((a, b) => a - b);
    for (const corner of [...ends, ...[...at.keys()].sort((a, b) => a - b)]) if ((at.get(corner) ?? []).some((edge) => !done.has(edge.id))) lines.push(follow(corner));
    for (const line of lines) {
      if (line.length < 2) continue;
      const closed = line.length > 3 && line[0] === line[line.length - 1];
      const own = closed ? line.slice(0, -1) : line;
      walls.push({
        id: `wall-${number}-${pad(walls.length + 1, 3)}`,
        line: own.map((corner) => corners[corner] as Point),
        closed,
        width: grown.wall.width,
        gates: own
          .filter((corner, index) => gates.has(corner) && degree.has(corner) && own.indexOf(corner) === index)
          .map((corner) => ({ junctionId: cornerJunction(corner), buildingId: (gates.get(corner) as Building).id, arterial: (ways[corner] as Way[]).some((way) => streets.has(way.edge) && edgeById(way.edge).kind === 'arterial') })),
      });
    }
    const made = new Set(walls.flatMap((wall) => wall.gates.map((gate) => gate.buildingId))).size;
    if (made !== gatehouses.length) fail(`${gatehouses.length} gatehouses but ${made} gates in the wall`);
  }

  // Lots are numbered as their buildings are.
  const buildingOrder = new Map(city.buildings.map((building, index) => [building.id, index]));
  placed.sort((a, b) => (buildingOrder.get(a.building.id) as number) - (buildingOrder.get(b.building.id) as number));
  const entranceOn = (street: number, door: Point) => ({ segmentId: segmentIds.get(street) as string, point: projectOnPolyline(segmentPoints.get(street) as Point[], door).point });
  // Last, each lot is drawn back from any roadway, wall or bank that it still stands on: blocks keep clear of
  // what runs along their own sides, but not always of what passes a corner.
  const barriers: Array<{ a: Point; b: Point; half: number }> = [
    ...segments.flatMap((segment) => segment.points.slice(1).map((point, index) => ({ a: segment.points[index] as Point, b: point, half: segment.width / 2 }))),
    ...walls.flatMap((wall) => wall.line.map((point, index) => ({ a: point, b: wall.line[(index + 1) % wall.line.length] as Point, half: wall.width / 2 })).slice(0, wall.closed ? undefined : -1)),
  ];
  const TRIM_SQUARE = 60;
  const filedBarriers = new Map<string, number[]>();
  barriers.forEach((barrier, index) => {
    const box = boxOf([barrier.a, barrier.b], barrier.half);
    for (let x = Math.floor(box.minX / TRIM_SQUARE); x <= Math.floor(box.maxX / TRIM_SQUARE); x++) {
      for (let y = Math.floor(box.minY / TRIM_SQUARE); y <= Math.floor(box.maxY / TRIM_SQUARE); y++) {
        const key = `${x}:${y}`;
        const list = filedBarriers.get(key);
        if (list) list.push(index);
        else filedBarriers.set(key, [index]);
      }
    }
  });
  /** The boundaries a lot must be drawn back to; none for nearly every lot. */
  const trimsOf = (polygon: Point[]): Array<{ at: Point; normal: Point }> => {
    const planes: Array<{ at: Point; normal: Point }> = [];
    let left = polygon;
    const box = boxOf(polygon);
    const near = new Set<number>();
    for (let x = Math.floor(box.minX / TRIM_SQUARE); x <= Math.floor(box.maxX / TRIM_SQUARE); x++) for (let y = Math.floor(box.minY / TRIM_SQUARE); y <= Math.floor(box.maxY / TRIM_SQUARE); y++) for (const index of filedBarriers.get(`${x}:${y}`) ?? []) near.add(index);
    for (const index of [...near].sort((one, other) => one - other)) {
      const { a, b, half } = barriers[index] as { a: Point; b: Point; half: number };
      if (left.length < 3 || distancePolygonToPolyline(left, [a, b]) >= half - 1e-9) continue;
      const length = distance(a, b) || 1;
      const middle = polygonCentroid(left);
      let normal: Point = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
      if ((middle[0] - a[0]) * normal[0] + (middle[1] - a[1]) * normal[1] < 0) normal = [-normal[0], -normal[1]];
      const plane = { at: [a[0] + normal[0] * (half + 0.05), a[1] + normal[1] * (half + 0.05)] as Point, normal };
      planes.push(plane);
      left = clip(left, plane);
    }
    if (river) {
      // Along its sides as well as at its corners: a bend can reach in between two corners.
      const along = polygon.flatMap((point, index) => {
        const next = polygon[(index + 1) % polygon.length] as Point;
        const pieces = Math.max(1, Math.ceil(distance(point, next) / 3));
        return Array.from({ length: pieces }, (_, at): Point => [point[0] + ((next[0] - point[0]) * at) / pieces, point[1] + ((next[1] - point[1]) * at) / pieces]);
      });
      for (const point of along) {
        const found = river.nearest(point);
        if (left.length < 3 || found.away - found.width / 2 > 0.2 || found.away === 0) continue;
        const normal: Point = [(point[0] - found.point[0]) / found.away, (point[1] - found.point[1]) / found.away];
        const plane = { at: [found.point[0] + normal[0] * (found.width / 2 + 0.5), found.point[1] + normal[1] * (found.width / 2 + 0.5)] as Point, normal };
        planes.push(plane);
        left = clip(left, plane);
      }
    }
    return planes;
  };
  const trimmed = (polygon: Point[], planes: Array<{ at: Point; normal: Point }>) => planes.reduce((left, plane) => (left.length < 3 ? left : clip(left, plane)), polygon);
  let builtArea = 0;
  const lots: Lot[] = [];
  const places: Place[] = [];
  const allLots: Array<Placed | 'plaza'> = [...placed];
  if (plazaBuilding) allLots.splice(buildingOrder.get(plazaBuilding.id) as number, 0, 'plaza');
  allLots.forEach((lot, index) => {
    const id = `lot-${number}-${pad(index + 1, 6)}`;
    if (lot === 'plaza') {
      // The plaza is the lot of its building: open ground, with a street all the way round it.
      const building = plazaBuilding as Building;
      const block = blockOf(plazaCell as Cell);
      if (block.tracks.length === 0) fail('the plaza has no street round it');
      const track = block.tracks.reduce((longest, entry) => (entry.to - entry.from > longest.to - longest.from ? entry : longest));
      const open = trimmed(block.polygon, trimsOf(block.polygon));
      builtArea += polygonArea(open);
      lots.push({ id, buildingId: building.id, polygon: open, districtId: building.districtId, entrance: entranceOn(track.street, frontage(track, (track.from + track.to) / 2)), footprints: [] });
      places.push({ id: `place-${number}-001`, kind: 'plaza', polygon: open, buildingId: building.id });
      return;
    }
    const coverage = footprintCoverageOf(lot.building.type, pack);
    let footprint: Point[] = [];
    if (coverage > 0) {
      if (lot.track && lot.cut) footprint = frontOf(lot.track, lot.cut, coverage);
      else {
        // A building with a block to itself stands in the middle of it, covering the pack's share of the ground.
        const middle = polygonCentroid(lot.polygon);
        const scale = Math.sqrt(coverage);
        footprint = lot.polygon.map(([x, y]): Point => [middle[0] + (x - middle[0]) * scale, middle[1] + (y - middle[1]) * scale]);
      }
    }
    const planes = trimsOf(lot.polygon);
    const polygon = trimmed(lot.polygon, planes);
    if (polygon.length < 3) fail(`the lot of ${lot.building.id} stands wholly on a roadway, a wall or the water`);
    if (planes.length > 0 && footprint.length >= 3) footprint = trimmed(footprint, planes);
    builtArea += polygonArea(polygon);
    lots.push({ id, buildingId: lot.building.id, polygon, districtId: lot.building.districtId, entrance: entranceOn(lot.street, lot.door), footprints: footprint.length >= 3 ? [footprint] : [] });
  });

  // A district's area is its blocks.
  let outlineArea = 0;
  const districtAreas = city.districts.flatMap((district: District, index) => {
    const own = [...(cellsOf[index] as number[])].sort((a, b) => a - b).map((id) => cells[id] as Cell);
    if (own.length === 0) return [];
    const polygons = own.map((cell) => outlineOf(cell));
    for (const polygon of polygons) outlineArea += polygonArea(polygon);
    const middle: Point = [own.reduce((sum, cell) => sum + cell.centre[0], 0) / own.length, own.reduce((sum, cell) => sum + cell.centre[1], 0) / own.length];
    const label = own.reduce((nearest, cell) => (distance(cell.centre, middle) < distance(nearest.centre, middle) ? cell : nearest));
    return [{ districtId: district.id, polygons, labelPoint: label.centre }];
  });

  const everyPoint = [...lots.flatMap((lot) => lot.polygon), ...segments.flatMap((segment) => segment.points)];
  const layout: Layout = {
    junctions: layoutJunctions,
    segments,
    exits,
    waters,
    lots,
    districtAreas,
    walls,
    places,
    summary: {
      settlementId: brief.id,
      counts: { junctions: layoutJunctions.length, segments: segments.length, exits: exits.length, waters: waters.length, lots: lots.length, districtAreas: districtAreas.length, walls: walls.length, gates: walls.reduce((sum, wall) => sum + wall.gates.length, 0), places: places.length },
      outlineArea,
      bounds: boxOf(everyPoint),
      builtArea,
      residentsPerHectare: builtArea === 0 ? 0 : city.people.length / (builtArea / 10_000),
      ringShare: ringShare(segments),
      roadsOut,
      layoutVersion: LAYOUT_VERSION,
      generator: GROWN_GENERATOR,
      pack: { name: pack.pack.name, version: pack.pack.version },
      seed,
    },
  };
  const broken = checkLayout(layout, city, brief, pack);
  if (broken.length > 0) fail(`the layout breaks ${broken.length === 1 ? 'an invariant' : 'invariants'}:\n  ${broken.join('\n  ')}`);
  return layout;
}
