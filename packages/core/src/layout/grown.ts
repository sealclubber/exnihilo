/**
 * The grown layout generator: road first (phase 6D.2).
 *
 * A finished city, its brief, the pack and a seed in; a layout out, in the
 * same format the grid makes. The city is read and never changed. The road
 * came first and the town grew along it: `town.ts` lays the water, the
 * highways and their arterials, the order the ground was built on, and the
 * blocks with the streets between them. This file puts the town on them:
 *
 * 11. Districts: pieces of town grown each from one block, the nearest block
 *     joining each, where crossing a highway, an arterial or the water counts
 *     for more, so that the roads and the river become their edges.
 * 12. Lots: each block cut along its length into two rows back to back and
 *     each row across into strips, one building to a strip, biggest first.
 *     Old blocks are built wall to wall; newer ones leave gaps.
 * 13. What is left: blocks at the edge with no lots are given back to the
 *     land; one inside the town with none is a green.
 * 14. Exits at the end of each highway, the wall on the edge of the oldest
 *     ground, and the records, with every invariant checked.
 */
import type { Building, City, District } from '../city/records.ts';
import { stepRng } from '../city/random.ts';
import { idNumber } from '../ids.ts';
import { type GrownSettings, type SettingPack, footprintCoverageOf, lotSizeOf } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import { clip } from './blocks.ts';
import { bearingVector, boxOf, distance, distancePolygonToPolyline, distanceToPolygonEdge, piecesCross, polygonArea, polygonCentroid, projectOnPolyline } from './geometry.ts';
import { type LayoutOptions, LayoutGenerationError } from './grid.ts';
import { Heap } from './heap.ts';
import { checkLayout } from './invariants.ts';
import { chaikin, normal } from './lines.ts';
import { ringShare } from './measure.ts';
import { type Block, type Exit, type Junction, type JunctionKind, type Layout, type Lot, type Place, type Segment, type SegmentKind, type Wall, type Water, LAYOUT_VERSION } from './records.ts';
import type { RoadLine } from './roads.ts';
import { arrangeTrades, placementOrder, spreadCivicTypes } from './shared.ts';
import { type Row, type StripBlock, fitStrip, strip, stripBlock, uvOf } from './strips.ts';
import { type Cell, type Edge, type Town, type Way, TooSmall, layTown } from './town.ts';

/** The name this generator records in a layout's summary. */
export const GROWN_GENERATOR = 'grown';
/** A building that finds room in none of this many rows takes a whole block. */
const FAILED_ROWS = 8;
/** An exit lies within this many degrees of the brief's bearing. */
const EXIT_TOLERANCE = 5;

const pad = (value: number, digits: number) => String(value).padStart(digits, '0');

export function generateGrownLayout(city: City, brief: SettlementBrief, pack: SettingPack, options: LayoutOptions = {}): Layout {
  const seed = options.seed ?? brief.seed;
  const grown = pack.layout.grown;
  if (!grown) throw new LayoutGenerationError(`${brief.id} (${brief.name}): the pack's layout file has no \`grown\` block, which the grown generator needs`);
  // Start with room for the town and its roads, and lay out more ground for as long as it proves too small.
  let room = 1;
  for (let attempt = 0; ; attempt++, room *= 1.3) {
    try {
      return attemptLayout(city, brief, pack, grown, seed, room);
    } catch (error) {
      if ((globalThis as any).DBG && error instanceof TooSmall) (globalThis as any).console.log('TOO SMALL', room.toFixed(2), error.where);
      if (error instanceof TooSmall && attempt < 6) continue;
      if (error instanceof TooSmall) throw new LayoutGenerationError(`${brief.id} (${brief.name}): the town does not fit even ${room.toFixed(1)} times the usual ground (it stopped at ${error.where})`);
      if (error instanceof LayoutGenerationError) throw error;
      throw new LayoutGenerationError(`${brief.id} (${brief.name}): ${(error as Error).message}`);
    }
  }
}

/** A lot as it is cut: its building, its ground, the block and street it stands on. */
interface Placed {
  building: Building;
  cell: number;
  polygon: Point[];
  /** The block's layout and the row it was cut from, for arranging trades and for footprints. */
  block?: StripBlock;
  row?: number;
  /** Where along the block it begins, for ordering lots along a row. */
  from: number;
  /** The street it opens onto. */
  edge: number;
  gatehouse?: true;
  /** It has a block to itself. */
  whole?: true;
}

function attemptLayout(city: City, brief: SettlementBrief, pack: SettingPack, grown: GrownSettings, seed: number, room: number): Layout {
  const number = idNumber(brief.id);
  const fail = (message: string): never => {
    throw new LayoutGenerationError(`${brief.id} (${brief.name}): ${message}`);
  };
  const widths = pack.layout.streetWidths;

  // ---- What the town needs -------------------------------------------------------------------------------------
  const sizeOf = (building: Building) => lotSizeOf(building.type, pack);
  const lotArea = (building: Building) => sizeOf(building).frontage * sizeOf(building).depth;
  const plazaBuilding = brief.flags.plaza ? city.buildings.find((building) => building.type === grown.plaza.building) : undefined;
  const plazaArea = plazaBuilding ? Math.min(Math.max(brief.population * grown.plaza.perResident, grown.plaza.min), grown.plaza.max) : 0;
  const gatehouses = brief.flags.walls ? city.buildings.filter((building) => building.type === grown.wall.gatehouse) : [];
  const placements = new Map(pack.districts.kinds.map((kind) => [kind.id, kind.placement]));
  const placementOf = (district: District) => placements.get(district.kind);
  const centralIds = new Set(city.districts.filter((district) => placementOf(district) === 'centre').map((district) => district.id));
  const town: Town = layTown(brief, pack, grown, seed, {
    lotArea: city.buildings.reduce((sum, building) => sum + (building === plazaBuilding ? 0 : lotArea(building)), 0),
    plazaArea,
    gatehouses: gatehouses.length,
    enclosesAll: gatehouses.length > 0 && brief.population < grown.wall.enclosesAllBelow,
    room,
    centralLotArea: city.buildings.reduce((sum, building) => sum + (centralIds.has(building.districtId) && building !== plazaBuilding ? lotArea(building) : 0), 0),
  });
  const { cells, edges, corners, around, plan } = town;
  const cellOf = (id: number) => cells[id] as Cell;
  const edgeOf = (id: number) => edges[id] as Edge;
  const outlineOf = (id: number): Point[] => cellOf(id).corners.map((corner) => corners[corner] as Point);
  const ground = new Set(town.ground);
  const rankOf = (id: number) => town.rank.get(id) ?? 1;
  const isGround = (id: number) => !cellOf(id).water && !cellOf(id).rim;

  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', '// ---- Gates ---');
  // ---- Gates ----------------------------------------------------------------------------------------------------
  // The corners where a road passes the wall, each kept by a gatehouse, as many as there are gatehouses.
  if (town.gates.length !== gatehouses.length) {
    // Where more gatehouses stand than roads pass the wall, the rest keep gates where a street does.
    const extra = [...town.wallCorners]
      .filter((corner) => !town.gates.includes(corner))
      .filter((corner) => {
        const sides = (around[corner] as number[]).map(edgeOf).filter((edge) => edge.kind !== 'wall' && edge.cells.every(isGround) && town.passable(edge));
        return sides.some((edge) => edge.cells.every((id) => cellOf(id).inside && ground.has(id))) && sides.some((edge) => edge.cells.every((id) => !cellOf(id).inside));
      })
      .sort((a, b) => a - b);
    while (town.gates.length < gatehouses.length && extra.length > 0) {
      // The one furthest round the wall from every gate there is.
      const bearing = (corner: number) => Math.atan2((corners[corner] as Point)[0], -(corners[corner] as Point)[1]);
      const apart = (a: number, b: number) => Math.abs(((((a - b) * 180) / Math.PI + 540) % 360) - 180);
      let chosen = 0;
      let furthest = -1;
      extra.forEach((corner, index) => {
        const away = Math.min(360, ...town.gates.map((gate) => apart(bearing(gate), bearing(corner))));
        if (away > furthest) {
          furthest = away;
          chosen = index;
        }
      });
      const [corner] = extra.splice(chosen, 1) as [number];
      town.gates.push(corner);
      for (const id of around[corner] as number[]) {
        const edge = edgeOf(id);
        // Streets that ran up to the wall here now pass through the gate.
        if (edge.wallEnd === corner) delete edge.wallEnd;
        if (edge.kind === 'none' && edge.cells.every(isGround) && town.passable(edge) && (edge.cells.every((cell) => cellOf(cell).inside) || edge.cells.every((cell) => !cellOf(cell).inside))) {
          edge.kind = 'lane';
          edge.street = true;
        }
      }
    }
    if (town.gates.length !== gatehouses.length) fail(`${gatehouses.length} gatehouses but ${town.gates.length} places in the wall for a gate`);
  }
  const gateOf = new Map(town.gates.map((corner, index) => [corner, gatehouses[index] as Building]));

  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', '// ---- 11. Districts ---');
  // ---- 11. Districts ---------------------------------------------------------------------------------------------
  const districtIndex = new Map(city.districts.map((district, index) => [district.id, index]));
  const buildingsOf: Building[][] = city.districts.map(() => []);
  const held = new Set<string>([...(plazaBuilding ? [plazaBuilding.id] : []), ...gatehouses.map((building) => building.id)]);
  for (const building of city.buildings) if (!held.has(building.id)) (buildingsOf[districtIndex.get(building.districtId) as number] as Building[]).push(building);
  const demand = buildingsOf.map((list) => list.reduce((sum, building) => sum + lotArea(building), 0));
  const capacity = new Map<number, number>();
  const holds = (id: number) => {
    let known = capacity.get(id);
    if (known === undefined) {
      const polygon = town.blockOf(id);
      known = polygon.length >= 3 ? polygonArea(polygon) * 0.82 : 0;
      capacity.set(id, known);
    }
    return known;
  };
  const owner = new Map<number, number>();
  const cellsOf: number[][] = city.districts.map(() => []);
  const assign = (id: number, district: number) => {
    const before = owner.get(id);
    if (before !== undefined) cellsOf[before] = (cellsOf[before] as number[]).filter((other) => other !== id);
    owner.set(id, district);
    (cellsOf[district] as number[]).push(id);
  };
  /** Two neighbouring cells whose shared boundary reaches the water: going round the water's end. */
  const touchesWaterBetween = (a: number, b: number) => cellOf(a).edges.some((id) => edgeOf(id).cells.includes(b) && (town.dryBy(corners[edgeOf(id).a] as Point) < town.bankside || town.dryBy(corners[edgeOf(id).b] as Point) < town.bankside));
  // What lies between two neighbouring cells: a highway, an arterial, the water, or none of these.
  const between = new Map<string, number>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const penalty = grown.districts.penalty;
  for (const edge of edges) {
    if (edge.bridge || edge.cells.length !== 2) continue;
    const [a, b] = edge.cells as [number, number];
    // The wall counts as a highway does: districts keep to one side of it where they can.
    const cost = (edge.kind === 'highway' && edge.street) || edge.kind === 'wall' ? penalty.highway : edge.kind === 'arterial' && edge.street ? penalty.arterial : 0;
    between.set(pairKey(a, b), Math.max(between.get(pairKey(a, b)) ?? 0, cost));
  }
  // Neighbours: across a boundary. A district is one piece of ground, so it never grows over a bridge; the water's
  // penalty counts where a district would reach round it.
  const neighbours = new Map<number, Array<{ cell: number; cost: number }>>();
  const link = (a: number, b: number, cost: number) => {
    neighbours.set(a, [...(neighbours.get(a) ?? []), { cell: b, cost }]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), { cell: a, cost }]);
  };
  for (const cell of cells) for (const other of cell.touching) if (other > cell.id) link(cell.id, other, (between.get(pairKey(cell.id, other)) ?? 0) + (touchesWaterBetween(cell.id, other) ? penalty.water : 0));
  const groundAt = (corner: number) => (around[corner] as number[]).flatMap((id) => edgeOf(id).cells).filter(isGround);
  // Seeds, kind by kind: the centre's on the oldest block, the rest as far as can be from those before them.
  const seeds = new Map<number, number>();
  const groundList = [...town.ground];
  const touchesWater = (id: number) => cellOf(id).edges.some((edge) => town.atWater(edgeOf(edge)));
  const farthest = (among: number[]) => {
    let best: number | undefined;
    let bestAway = -1;
    for (const id of among) {
      if ([...seeds.values()].includes(id) || id === town.plazaCell) continue;
      const away = Math.min(Infinity, ...[...seeds.values()].map((other) => distance(cellOf(id).centre, cellOf(other).centre)));
      if (away > bestAway) {
        bestAway = away;
        best = id;
      }
    }
    return best;
  };
  const byPlacement = (placement: string) => city.districts.map((district, index) => ({ district, index })).filter(({ district, index }) => placementOf(district) === placement && (demand[index] as number) > 0);
  const plazaDistrict = plazaBuilding ? (districtIndex.get(plazaBuilding.districtId) as number) : undefined;
  if (plazaDistrict !== undefined && town.plazaCell !== undefined) {
    seeds.set(plazaDistrict, town.plazaCell);
    assign(town.plazaCell, plazaDistrict);
  }
  for (const { index } of byPlacement('centre')) {
    if (seeds.has(index)) continue;
    const first = seeds.size === 0 ? groundList.find((id) => id !== town.plazaCell) : farthest(groundList.filter((id) => rankOf(id) <= 0.3));
    if (first !== undefined) seeds.set(index, first);
  }
  // Every piece of ground big enough for a district, such as the far bank of a river, gets one: those not yet
  // seeded take the next district by size, one by the water if the piece touches it.
  {
    const component = new Map<number, number>();
    const pieces: number[][] = [];
    for (const id of groundList) {
      if (component.has(id)) continue;
      const piece = [id];
      component.set(id, pieces.length);
      for (let at = 0; at < piece.length; at++) {
        for (const next of neighbours.get(piece[at] as number) ?? []) {
          if (!ground.has(next.cell) || component.has(next.cell)) continue;
          component.set(next.cell, pieces.length);
          piece.push(next.cell);
        }
      }
      pieces.push(piece);
    }
    const seeded = new Set([...seeds.values()].map((id) => component.get(id)));
    const waiting = city.districts.map((district, index) => ({ district, index })).filter(({ district, index }) => (demand[index] as number) > 0 && !seeds.has(index) && placementOf(district) !== 'centre');
    const smallest = Math.min(Infinity, ...waiting.map(({ index }) => demand[index] as number));
    const open = pieces.map((piece, index) => ({ piece, index, room: piece.reduce((sum, id) => sum + holds(id), 0) })).filter((entry) => !seeded.has(entry.index) && entry.room >= 0.4 * smallest).sort((a, b) => b.room - a.room || a.index - b.index);
    for (const { piece } of open) {
      if (waiting.length === 0) break;
      const wet = piece.some(touchesWater);
      const pick = waiting.findIndex(({ district }) => placementOf(district) === (wet ? 'waterside' : 'edge'));
      const { index } = waiting.splice(pick >= 0 ? pick : 0, 1)[0] as { index: number };
      seeds.set(index, [...piece].sort((a, b) => cellOf(a).cost - cellOf(b).cost || a - b)[0] as number);
    }
  }
  for (const { index } of byPlacement('waterside')) {
    if (seeds.has(index)) continue;
    const wet = groundList.filter((id) => touchesWater(id) && rankOf(id) <= 0.7);
    const chosen = farthest(wet.length > 0 ? wet : groundList.filter((id) => rankOf(id) <= 0.7));
    if (chosen !== undefined) seeds.set(index, chosen);
  }
  for (const { index } of byPlacement('middle')) {
    if (seeds.has(index)) continue;
    const chosen = farthest(groundList.filter((id) => rankOf(id) >= 0.15 && rankOf(id) <= 0.75)) ?? farthest(groundList);
    if (chosen !== undefined) seeds.set(index, chosen);
  }
  for (const { index } of byPlacement('edge')) {
    if (seeds.has(index)) continue;
    const chosen = farthest(groundList.filter((id) => rankOf(id) >= 0.55)) ?? farthest(groundList);
    if (chosen !== undefined) seeds.set(index, chosen);
  }
  for (let index = 0; index < city.districts.length; index++) if ((demand[index] as number) > 0 && !seeds.has(index)) fail(`${(city.districts[index] as District).name} has a kind whose placement the pack does not list`);
  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', '// Each district takes the nea');
  const connectedWithout = (district: number, id: number) => {
    const own = new Set((cellsOf[district] as number[]).filter((other) => other !== id));
    if (own.size === 0) return false;
    const first = own.values().next().value as number;
    const seen = new Set([first]);
    const queue = [first];
    for (let at = 0; at < queue.length; at++) for (const next of neighbours.get(queue[at] as number) ?? []) if (own.has(next.cell) && !seen.has(next.cell)) (seen.add(next.cell), queue.push(next.cell));
    return seen.size === own.size;
  };
  const placed: Placed[] = [];
  // ---- 12. Lots ---------------------------------------------------------------------------------------------------
  const lotRng = stepRng(seed, 'grown-lots');
  const { lots: lotRules } = grown;
  /** A cut's skew: drawn by chance, and never so far from the last cut's that a narrow strip's sides would meet. */
  const skewOf = (last = 0) => Math.max(last - 0.4 * lotRules.leastFrontage, Math.min(last + 0.4 * lotRules.leastFrontage, normal(lotRng) * lotRules.skew));
  const between2 = (range: { min: number; max: number }) => range.min + (range.max - range.min) * lotRng.next();
  /** The streets along a cell's sides: each edge that carries one, with its line. */
  const streetsOf = (id: number) => cellOf(id).edges.map(edgeOf).filter((edge) => edge.street && !edge.bridge);
  const lineOf = (edge: Edge): [Point, Point] => [corners[edge.a] as Point, corners[edge.b] as Point];
  /** The street a lot opens onto: of its cell's streets, the one nearest it, the outer side preferred. */
  const doorOf = (id: number, polygon: Point[], outward?: Point): number | undefined => {
    let best: number | undefined;
    let bestScore = Infinity;
    const middle = polygonCentroid(polygon);
    for (const edge of streetsOf(id)) {
      const gap = distancePolygonToPolyline(polygon, lineOf(edge)) - town.widthOf(edge) / 2;
      if (gap > grown.roadside + 1.5) continue;
      const near = projectOnPolyline(lineOf(edge), middle).point;
      const toward = outward ? -((near[0] - middle[0]) * outward[0] + (near[1] - middle[1]) * outward[1]) / (distance(near, middle) || 1) : 0;
      const score = gap + toward * 2;
      if (score < bestScore) {
        bestScore = score;
        best = edge.id;
      }
    }
    return best;
  };
  /** The blocks laid out in rows, as they are cut: one per town cell with ground left in it. */
  const laid = new Map<number, StripBlock>();
  const layoutOf = (id: number): StripBlock | undefined => {
    if (laid.has(id)) return laid.get(id);
    const polygon = town.blockOf(id);
    if (polygon.length < 3) return undefined;
    // Which long side has streets: a side with none has no row of its own, and the block is one row deep.
    const probe = stripBlock(polygon, Infinity, 0.5);
    let low = 0;
    let high = 0;
    for (const edge of streetsOf(id)) {
      const [a, b] = lineOf(edge);
      const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const [, v] = uvOf(probe, middle);
      const length = distance(a, b);
      const share = Math.abs(((b[0] - a[0]) * probe.across[0] + (b[1] - a[1]) * probe.across[1]) / (length || 1));
      if (share > 0.7) continue;
      if (v < (probe.minV + probe.maxV) / 2) low += length;
      else high += length;
    }
    const only = low === 0 && high > 0 ? 'high' : high === 0 && low > 0 ? 'low' : undefined;
    const block = stripBlock(polygon, lotRules.rows, between2(lotRules.split), only);
    laid.set(id, block);
    return block;
  };
  // Gatehouses first: each just inside its gate, at the end of the row nearest it.
  for (const [corner, gatehouse] of [...gateOf].sort((a, b) => a[0] - b[0])) {
    const at = corners[corner] as Point;
    // Where the town does not reach the gate, the block just inside it is taken in for the gatehouse.
    if (!groundAt(corner).some((id) => ground.has(id))) {
      const inside = groundAt(corner).filter((id) => cellOf(id).inside && town.blockOf(id).length >= 0).sort((a, b) => cellOf(a).cost - cellOf(b).cost || a - b)[0];
      if (inside !== undefined) {
        ground.add(inside);
        town.rank.set(inside, 1);
        town.addGround(inside);
      }
    }
    const options = groundAt(corner).filter((id) => ground.has(id) && cellOf(id).inside).sort((a, b) => a - b);
    const outside = groundAt(corner).filter((id) => ground.has(id) && !cellOf(id).inside).sort((a, b) => a - b);
    let done = false;
    for (const id of [...options, ...outside]) {
      const block = layoutOf(id);
      if (!block || done) continue;
      const [u] = uvOf(block, at);
      const fromHigh = u > (block.minU + block.maxU) / 2;
      const rowIndex = block.rows.reduce((bestRow, row, index) => {
        const [, v] = uvOf(block, at);
        const near = Math.abs(v - (row.outer === 'low' ? row.low : row.high));
        const other = block.rows[bestRow] as Row;
        return near < Math.abs(v - (other.outer === 'low' ? other.low : other.high)) ? index : bestRow;
      }, 0);
      const row = block.rows[rowIndex] as Row;
      const wanted = lotArea(gatehouse);
      const cut = fromHigh ? fitStrip(block, row.low, row.high, row.outer, row.hi, 0, -1, wanted, sizeOf(gatehouse).frontage * lotRules.widest, row.lo, 0) : fitStrip(block, row.low, row.high, row.outer, row.lo, 0, 1, wanted, sizeOf(gatehouse).frontage * lotRules.widest, row.hi, 0);
      if (cut.polygon.length < 3 || cut.area < wanted * 0.3) continue;
      const door = doorOf(id, cut.polygon);
      if (door === undefined) continue;
      if (fromHigh) row.hi = cut.end;
      else row.lo = cut.end;
      placed.push({ building: gatehouse, cell: id, polygon: cut.polygon, block, row: rowIndex, from: fromHigh ? cut.end : row.lo, edge: door, gatehouse: true });
      done = true;
    }
    if (!done) fail(`the gate at (${Math.round(at[0])}, ${Math.round(at[1])}) has no ground beside it for its gatehouse`);
  }
  const spreadCivic = spreadCivicTypes(pack);
  const civic = new Map<string, Point[]>();
  const kindOf = (district: number) => (city.districts[district] as District).kind;
  const typicalRow = grown.blocks.depth / 2;
  type Entry = { building: Building; apart: boolean };
  /**
   * What a district has still to place, and where it has got to. Its buildings are cut into lots block by block as
   * it takes the blocks: those big enough take a whole block, those as deep as a block run through both rows from
   * the start of one, and the rest are strips along the rows, oldest blocks first.
   */
  interface Builder {
    district: number;
    whole: Entry[];
    deep: Entry[];
    queue: Entry[];
    waiting: Entry[];
    failures: Map<string, number>;
    rows: Array<{ id: number; index: number }>;
    rowAt: number;
    last?: Placed & { skewFrom?: number };
    lastTarget: number;
    filled: boolean;
    gapChance: number;
  }
  const builders: Array<Builder | undefined> = city.districts.map((_, index) => {
    const buildings = buildingsOf[index] as Building[];
    if (buildings.length === 0) return undefined;
    const order = placementOrder(buildings, pack, lotRng, () => false);
    return {
      district: index,
      whole: order.filter(({ building }) => lotArea(building) >= lotRules.wholeBlock),
      deep: order.filter(({ building }) => lotArea(building) < lotRules.wholeBlock && sizeOf(building).depth >= 1.5 * typicalRow),
      queue: order.filter(({ building }) => lotArea(building) < lotRules.wholeBlock && sizeOf(building).depth < 1.5 * typicalRow),
      waiting: [],
      failures: new Map(),
      rows: [],
      rowAt: 0,
      lastTarget: 0,
      filled: lotRules.filled.includes(kindOf(index)),
      gapChance: lotRules.gaps[kindOf(index)] ?? 0,
    };
  });
  const finished = (builder: Builder) => builder.whole.length + builder.deep.length + builder.queue.length + builder.waiting.length === 0;
  const oldCell = (builder: Builder, id: number) => rankOf(id) < lotRules.oldBelow || builder.filled;
  /** The end of a row: what is left goes to the last lot, in an old block, where that does not make it much too big. */
  const closeRow = (builder: Builder) => {
    const entry = builder.rows[builder.rowAt];
    const last = builder.last;
    if (entry && last && oldCell(builder, entry.id)) {
      const block = layoutOf(entry.id) as StripBlock;
      const row = block.rows[entry.index] as Row;
      if (row.hi - row.lo > 0.05) {
        const extended = strip(block, row.low, row.high, row.outer, last.from, last.skewFrom ?? 0, row.hi, row.skewHi);
        if (extended.length >= 3 && polygonArea(extended) <= builder.lastTarget * lotRules.area.max * 1.25) {
          last.polygon = extended;
          row.lo = row.hi;
        }
      }
    }
    builder.last = undefined;
    builder.rowAt++;
  };
  /** Takes a block whole for a building, if it is untouched. */
  const takeWhole = (id: number, building: Building): boolean => {
    const block = layoutOf(id);
    if (!block || block.rows.some((row) => row.lo !== block.minU || row.hi !== block.maxU)) return false;
    const polygon = town.blockOf(id);
    const door = doorOf(id, polygon);
    if (door === undefined) return false;
    for (const row of block.rows) row.lo = row.hi;
    placed.push({ building, cell: id, polygon, from: block.minU, edge: door, whole: true });
    return true;
  };
  /** Places as much of a district's buildings as a newly taken block holds. */
  const fill = (builder: Builder, id: number) => {
    const block = layoutOf(id);
    if (!block) return;
    // A building that takes a block whole takes this one if it is near its size.
    if (builder.whole.length > 0) {
      const area = polygonArea(town.blockOf(id));
      const index = builder.whole.findIndex(({ building }) => area >= lotArea(building) * 0.45 && area <= lotArea(building) * 2.2);
      if (index >= 0 && takeWhole(id, (builder.whole[index] as Entry).building)) {
        builder.whole.splice(index, 1);
        return;
      }
    }
    // Buildings as deep as a block run through both rows from its start, straight across.
    while (builder.deep.length > 0) {
      const { building } = builder.deep[0] as Entry;
      const start = Math.max(...block.rows.map((row) => row.lo));
      const cut = fitStrip(block, block.minV, block.maxV, 'low', start, 0, 1, lotArea(building) * (1 + (lotRng.next() * 2 - 1) * lotRules.frontageSpread), sizeOf(building).frontage * lotRules.widest, block.maxU, 0, lotRules.leastFrontage);
      const door = cut.polygon.length >= 3 ? doorOf(id, cut.polygon) : undefined;
      if (cut.polygon.length < 3 || cut.area < lotArea(building) * lotRules.area.min || door === undefined) break;
      for (const row of block.rows) {
        row.lo = cut.end;
        row.skewLo = 0;
      }
      placed.push({ building, cell: id, polygon: cut.polygon, block, from: start, edge: door });
      builder.deep.shift();
    }
    block.rows.forEach((_, index) => builder.rows.push({ id, index }));
    // The rest in strips, row by row. A well or an oven waits while one of its type stands too near.
    while (builder.rowAt < builder.rows.length && (builder.queue.length > 0 || builder.waiting.length > 0 || builder.deep.length > 0)) {
      const entry = builder.rows[builder.rowAt] as { id: number; index: number };
      const rowBlock = layoutOf(entry.id) as StripBlock;
      const row = rowBlock.rows[entry.index] as Row;
      if (row.hi - row.lo < lotRules.leastFrontage) {
        closeRow(builder);
        continue;
      }
      const outerV = row.outer === 'low' ? row.low : row.high;
      const at: Point = [rowBlock.origin[0] + rowBlock.axis[0] * row.lo + rowBlock.across[0] * outerV, rowBlock.origin[1] + rowBlock.axis[1] * row.lo + rowBlock.across[1] * outerV];
      const tooNear = (candidate: Building) => spreadCivic.has(candidate.type) && (civic.get(candidate.type) ?? []).some((other) => distance(other, at) < grown.civicSpacing);
      let next: Entry | undefined;
      const ready = builder.waiting.findIndex(({ building }) => !tooNear(building));
      if (ready >= 0) next = builder.waiting.splice(ready, 1)[0];
      while (!next && builder.queue.length > 0) {
        const candidate = builder.queue.shift() as Entry;
        if (tooNear(candidate.building) && builder.queue.length > 0) builder.waiting.push(candidate);
        else next = candidate;
      }
      // Deep buildings that found no block to start: as strips in a row, after the rest.
      if (!next && builder.deep.length > 0) next = builder.deep.shift();
      if (!next) next = builder.waiting.shift();
      if (!next) break;
      const { building } = next;
      const size = sizeOf(building);
      const target = lotArea(building) * (1 + (lotRng.next() * 2 - 1) * lotRules.frontageSpread);
      let skew = skewOf(row.skewLo);
      let cut = fitStrip(rowBlock, row.low, row.high, row.outer, row.lo, row.skewLo, 1, target, Math.max(lotRules.leastFrontage, size.frontage * lotRules.widest), row.hi, skew, lotRules.leastFrontage);
      // A strip that reaches the end of its row ends on the cut already made there.
      if (Math.abs(cut.end - row.hi) < 1e-6 && skew !== row.skewHi) {
        skew = row.skewHi;
        const polygon = strip(rowBlock, row.low, row.high, row.outer, row.lo, row.skewLo, row.hi, skew);
        cut = { polygon, end: row.hi, area: polygon.length >= 3 ? polygonArea(polygon) : 0 };
      }
      const door = cut.polygon.length >= 3 ? doorOf(entry.id, cut.polygon, row.outer === 'low' ? [-rowBlock.across[0], -rowBlock.across[1]] : rowBlock.across) : undefined;
      if (cut.polygon.length < 3 || cut.area < target * lotRules.area.min || door === undefined) {
        // No room in this row: it waits for the next. One that has found room in none of several rows takes a whole block.
        const tries = (builder.failures.get(building.id) ?? 0) + 1;
        builder.failures.set(building.id, tries);
        if (tries > FAILED_ROWS) builder.whole.push(next);
        else if (spreadCivic.has(building.type)) builder.waiting.unshift(next);
        else builder.queue.unshift(next);
        closeRow(builder);
        continue;
      }
      const lot: Placed & { skewFrom?: number } = { building, cell: entry.id, polygon: cut.polygon, block: rowBlock, row: entry.index, from: row.lo, edge: door, skewFrom: row.skewLo };
      placed.push(lot);
      if (spreadCivic.has(building.type)) civic.set(building.type, [...(civic.get(building.type) ?? []), polygonCentroid(cut.polygon)]);
      row.lo = cut.end;
      row.skewLo = skew;
      builder.last = lot;
      builder.lastTarget = target;
      if (!oldCell(builder, entry.id) && lotRng.next() < builder.gapChance) {
        row.lo = Math.min(row.hi, row.lo + between2(lotRules.gapWidth));
        builder.last = undefined;
      }
    }
    if (finished(builder) && builder.rowAt < builder.rows.length) closeRow(builder);
  };

  // ---- Districts grow, block by block ------------------------------------------------------------------------
  // All at once, each from its seed: the block nearest any district that still has buildings goes to it and is cut
  // into lots, until every building has one. Larger districts reach further for the same distance. Ground the town
  // was laid out on is taken first; ground beyond it only when a district can reach nothing else.
  const meanDemand = demand.reduce((sum, value) => sum + value, 0) / Math.max(1, demand.filter((value) => value > 0).length);
  const reachOf = (district: number) => Math.sqrt(Math.max(demand[district] as number, 1) / meanDemand);
  const BEYOND = 40 * grown.blocks.length;
  const heap = new Heap();
  const order: Array<[number, number]> = [];
  const best = new Map<string, number>();
  const push = (cost: number, district: number, id: number) => {
    const key = `${district}:${id}`;
    if (cost >= (best.get(key) ?? Infinity)) return;
    best.set(key, cost);
    order.push([district, id]);
    heap.push(cost / reachOf(district), order.length - 1);
  };
  const barredCell = (id: number) => !isGround(id) || cellOf(id).rim || (gatehouses.length > 0 && brief.population < grown.wall.enclosesAllBelow && !cellOf(id).inside);
  const spread = new Map<number, number>();
  const take = (district: number, id: number, cost: number) => {
    if (!ground.has(id)) {
      ground.add(id);
      town.rank.set(id, 1);
      town.addGround(id);
    }
    assign(id, district);
    spread.set(id, cost);
    const builder = builders[district];
    // The plaza is open ground: no lots are cut from it.
    if (builder && id !== town.plazaCell) fill(builder, id);
    if (!builder || finished(builder)) return;
    for (const next of neighbours.get(id) ?? []) {
      if (owner.has(next.cell) || barredCell(next.cell)) continue;
      push(cost + distance(cellOf(id).centre, cellOf(next.cell).centre) + next.cost + (ground.has(next.cell) ? 0 : BEYOND), district, next.cell);
    }
  };
  for (const [district, id] of [...seeds].sort((a, b) => a[0] - b[0])) {
    if (owner.has(id) && owner.get(id) !== district) continue;
    take(district, id, 0);
  }
  for (let round = 0; ; round++) {
    while (heap.size > 0) {
      const [, at] = heap.pop();
      const [district, id] = order[at] as [number, number];
      const builder = builders[district];
      if (owner.has(id) || barredCell(id) || !builder || finished(builder)) continue;
      take(district, id, best.get(`${district}:${id}`) as number);
    }
    const stuck = builders.findIndex((builder) => builder !== undefined && !finished(builder));
    if (stuck < 0) break;
    if (round > 400) throw new TooSmall(`the lots of ${(city.districts[stuck] as District).name}`);
    // A district boxed in by others takes a block from a neighbour, which takes back what stood on it and grows on.
    const builder = builders[stuck] as Builder;
    const own = cellsOf[stuck] as number[];
    if (own.length === 0) throw new TooSmall(`the lots of ${(city.districts[stuck] as District).name}`);
    const beside = [...new Set(own.flatMap((id) => (neighbours.get(id) ?? []).map((next) => next.cell)))]
      .filter((id) => owner.has(id) && owner.get(id) !== stuck && id !== town.plazaCell && id !== seeds.get(owner.get(id) as number) && !placed.some((lot) => lot.cell === id && lot.gatehouse) && connectedWithout(owner.get(id) as number, id))
      .sort((a, b) => (spread.get(b) ?? 0) - (spread.get(a) ?? 0) || a - b);
    const chosen = beside[0];
    if (chosen === undefined) throw new TooSmall(`the lots of ${(city.districts[stuck] as District).name}`);
    const other = owner.get(chosen) as number;
    const giving = builders[other] as Builder;
    // The neighbour's lots there go back to it, to be placed again as it grows on.
    const back = placed.filter((lot) => lot.cell === chosen);
    for (const lot of back) {
      placed.splice(placed.indexOf(lot), 1);
      const entry = { building: lot.building, apart: spreadCivic.has(lot.building.type) };
      if (lot.whole) giving.whole.push(entry);
      else if (lot.row === undefined) giving.deep.push(entry);
      else giving.queue.push(entry);
      if (spreadCivic.has(lot.building.type)) civic.set(lot.building.type, (civic.get(lot.building.type) ?? []).filter((point) => distance(point, polygonCentroid(lot.polygon)) > 1e-6));
    }
    giving.rows = giving.rows.filter((row) => row.id !== chosen || giving.rows.indexOf(row) < giving.rowAt);
    giving.rowAt = Math.min(giving.rowAt, giving.rows.length);
    giving.rows = giving.rows.filter((row) => row.id !== chosen);
    giving.rowAt = Math.min(giving.rowAt, giving.rows.length);
    laid.delete(chosen);
    const cost = Math.min(...own.map((id) => spread.get(id) ?? 0));
    take(stuck, chosen, cost);
    // The neighbour grows on from its blocks to make up what it gave.
    for (const id of cellsOf[other] as number[]) for (const next of neighbours.get(id) ?? []) if (!owner.has(next.cell) && !barredCell(next.cell)) push((spread.get(id) ?? 0) + distance(cellOf(id).centre, cellOf(next.cell).centre) + next.cost + (ground.has(next.cell) ? 0 : BEYOND), other, next.cell);
    void builder;
  }
  // Ground no district took goes back to the land.
  for (const id of [...ground]) if (!owner.has(id) && !placed.some((lot) => lot.cell === id)) ground.delete(id);

  // ---- Streets of one trade ---------------------------------------------------------------------------------
  // Buildings whose lots are alike change places within a district, as on the grid; no lot changes.
  {
    const rowKey = (lot: Placed) => `${lot.cell}:${lot.row ?? -1}`;
    const rowOrder = new Map<string, number>();
    for (const lot of placed) if (!rowOrder.has(rowKey(lot))) rowOrder.set(rowKey(lot), rowOrder.size);
    const swappable = placed.filter((lot) => !lot.gatehouse && !lot.whole && lot.row !== undefined);
    const sorted = [...swappable].sort((a, b) => (rowOrder.get(rowKey(a)) as number) - (rowOrder.get(rowKey(b)) as number) || a.from - b.from);
    const position = new Map(sorted.map((lot, index) => [lot, index]));
    arrangeTrades(
      swappable,
      pack,
      (a, b) => (position.get(a) as number) - (position.get(b) as number),
      (a, b) => rowKey(a) === rowKey(b) && Math.abs((position.get(a) as number) - (position.get(b) as number)) === 1,
    );
  }

  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', '// ---- 13. What is left ---');
  // ---- 13. What is left ------------------------------------------------------------------------------------------
  // A block with no lots at the edge of the town goes back to the land, as long as its district stays in one piece.
  const built = new Set(placed.map((lot) => lot.cell));
  if (town.plazaCell !== undefined) built.add(town.plazaCell);
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...ground].sort((a, b) => rankOf(b) - rankOf(a) || a - b)) {
      if (built.has(id)) continue;
      const open = (neighbours.get(id) ?? []).some((next) => !ground.has(next.cell)) || cellOf(id).edges.some((edge) => edgeOf(edge).cells.some((other) => !ground.has(other)));
      if (!open) continue;
      const district = owner.get(id);
      if (district !== undefined && !connectedWithout(district, id)) continue;
      ground.delete(id);
      if (district !== undefined) {
        cellsOf[district] = (cellsOf[district] as number[]).filter((other) => other !== id);
        owner.delete(id);
      }
      changed = true;
    }
  }
  // What is left with no lots inside the town is a green.
  const greens = [...ground].filter((id) => !built.has(id) && town.blockOf(id).length >= 3).sort((a, b) => a - b);

  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', '// ---- The streets that are k');
  // ---- The streets that are kept -----------------------------------------------------------------------------
  const kept = new Set<number>();
  for (const edge of edges) {
    if (!edge.street) continue;
    if (edge.bridge) {
      kept.add(edge.id);
      continue;
    }
    if (edge.kind === 'highway' || edge.cells.some((id) => ground.has(id))) kept.add(edge.id);
  }
  // A street that runs up to the wall ends a clear strip short of it, at a dead end of its own: its end there is a
  // node of its own, numbered below zero, so that nothing joins the two sides of the wall through a corner on it.
  const cutShort = grown.wall.width / 2 + grown.wall.clearStrip;
  const endsOf = (edge: Edge): [number, number] => [edge.wallEnd === edge.a ? -(edge.id + 1) : edge.a, edge.wallEnd === edge.b ? -(edge.id + 1) : edge.b];
  const nodePoint = (node: number): Point => {
    if (node >= 0) return corners[node] as Point;
    const edge = edgeOf(-node - 1);
    const wall = corners[edge.wallEnd as number] as Point;
    const other = corners[edge.a === edge.wallEnd ? edge.b : edge.a] as Point;
    const t = Math.min(0.45, cutShort / (distance(wall, other) || 1));
    return [wall[0] + (other[0] - wall[0]) * t, wall[1] + (other[1] - wall[1]) * t];
  };
  // Every lot's street is kept, whatever else was given back.
  for (const lot of placed) kept.add(lot.edge);
  // A gate keeps the streets that pass through it.
  for (const corner of gateOf.keys()) for (const id of around[corner] as number[]) if (edgeOf(id).street && edgeOf(id).kind !== 'none' && edgeOf(id).wallEnd !== corner) kept.add(id);
  const degreeOf = (corner: number) => (around[corner] as number[]).filter((id) => kept.has(id) && edgeOf(id).wallEnd !== corner).length + (town.ways[corner] as Way[]).filter((way) => edgeOf(way.edge).bridge && kept.has(way.edge)).length;
  // An arterial ends where it meets another street: one left hanging is cut back to the last junction it reaches.
  for (const [road, chain] of town.chains) {
    if ((plan.roads[road] as RoadLine).kind !== 'arterial') continue;
    for (let at = chain.length - 1; at >= 0; at--) {
      const edge = edgeOf(chain[at] as number);
      if (!kept.has(edge.id)) continue;
      const ends = endsOf(edge).filter((node) => node < 0 || degreeOf(node) === 1);
      if (ends.length === 0 || placed.some((lot) => lot.edge === edge.id) || gateOf.has(edge.a) || gateOf.has(edge.b)) break;
      kept.delete(edge.id);
    }
  }
  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', '// Highways: from the centre');
  // Highways: from the centre to where the town ends, then on as far again as the pack's distance, and no further.
  const exitDrafts: Array<{ point: Point; joins: number } | undefined> = brief.routes.map(() => undefined);
  const lotBoxes = placed.map((lot) => boxOf(lot.polygon, widths.arterial / 2));
  const crossesTown = (from: Point, to: Point) =>
    placed.some((lot, index) => {
      const box = lotBoxes[index] as ReturnType<typeof boxOf>;
      if (Math.max(from[0], to[0]) < box.minX || Math.min(from[0], to[0]) > box.maxX || Math.max(from[1], to[1]) < box.minY || Math.min(from[1], to[1]) > box.maxY) return false;
      return distancePolygonToPolyline(lot.polygon, [from, to]) < widths.arterial / 2;
    }) || [...ground].some((id) => outlineOf(id).some((point, index, outline) => piecesCross(from, to, point, outline[(index + 1) % outline.length] as Point)));
  for (const [road, chain] of town.chains) {
    const line = plan.roads[road] as RoadLine;
    if (line.kind !== 'highway' || line.route === undefined) continue;
    const route = brief.routes[line.route] as SettlementBrief['routes'][number];
    const list: number[] = [];
    // The chain's corners from the centre outward.
    let at = chain.length > 0 ? ([edgeOf(chain[0] as number).a, edgeOf(chain[0] as number).b].find((corner) => degreeOf(corner) > 0 && (town.plazaCell === undefined || cellOf(town.plazaCell).corners.includes(corner) || chain.length === 1)) ?? edgeOf(chain[0] as number).a) : -1;
    // A highway that reached the sea at the centre has no chain: its exit joins the street corner nearest where it ends.
    if (chain.length === 0) {
      const end = line.points[line.points.length - 1] as Point;
      const near = [...new Set([...kept].flatMap((id) => endsOf(edgeOf(id))))].filter((node) => node >= 0).sort((a, b) => distance(corners[a] as Point, end) - distance(corners[b] as Point, end) || a - b)[0];
      if (near !== undefined) list.push(near);
    }
    if (chain.length > 0) {
      const first = edgeOf(chain[0] as number);
      const second = chain.length > 1 ? edgeOf(chain[1] as number) : undefined;
      at = second ? (first.a === second.a || first.a === second.b ? first.b : first.a) : at;
      list.push(at);
      for (const id of chain) {
        const edge = edgeOf(id);
        at = edge.a === at ? edge.b : edge.a;
        list.push(at);
      }
    }
    let townEnd = 0;
    list.forEach((corner, index) => {
      if (groundAt(corner).some((id) => ground.has(id))) townEnd = index;
    });
    let reach = 0;
    let stop = townEnd;
    while (stop < list.length - 1 && reach < grown.highways.beyond) {
      reach += distance(corners[list[stop] as number] as Point, corners[list[stop + 1] as number] as Point);
      stop++;
    }
    // Beyond the stop the highway is no street; the exit stands at the brief's bearing past its last corner.
    chain.forEach((id, index) => {
      if (index >= stop) kept.delete(id);
    });
    const direction = bearingVector(route.bearing);
    let joined = false;
    for (let back = stop; back >= townEnd && back >= 0 && !joined; back--) {
      const joins = list[back] as number;
      if (joins === undefined) break;
      const from = corners[joins] as Point;
      for (let offset = 0; offset <= 2 * EXIT_TOLERANCE && !joined; offset++) {
        const turn = offset % 2 === 1 ? (offset + 1) / 2 : -offset / 2;
        if (Math.abs(turn) >= EXIT_TOLERANCE) continue;
        const ray = bearingVector(route.bearing + turn);
        let out = Math.hypot(from[0], from[1]) + grown.exitReach;
        let point: Point = [ray[0] * out, ray[1] * out];
        for (let step = 0; step < 60 && out > 0 && town.dryBy(point) < widths.arterial / 2 + 1; step++) {
          out -= grown.exitReach / 10;
          point = [ray[0] * out, ray[1] * out];
        }
        const steps = Math.max(1, Math.ceil(distance(from, point) / 2));
        const dry = Array.from({ length: steps + 1 }, (_, index): Point => [from[0] + ((point[0] - from[0]) * index) / steps, from[1] + ((point[1] - from[1]) * index) / steps]).every((spot) => town.dryBy(spot) >= widths.arterial / 2 + 1);
        if (out <= 0 || distance(from, point) < widths.arterial || distance(from, point) > 4 * grown.exitReach || !dry || crossesTown(from, point) || exitDrafts.some((other) => other && distance(other.point, point) < widths.arterial)) continue;
        chain.forEach((id, index) => {
          if (index >= back) kept.delete(id);
        });
        exitDrafts[line.route] = { point, joins };
        joined = true;
      }
    }
    void direction;
    if (!joined) throw new TooSmall(`the exit to ${route.routeId}`);
  }
  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', '// Whatever is left apart is j');
  // Whatever is left apart is joined to the rest by the shortest way along boundaries a street may take.
  let joins = 0;
  for (;;) {
    const touched = new Set<number>();
    const links = new Map<number, number[]>();
    for (const id of kept) {
      const [a, b] = endsOf(edgeOf(id));
      touched.add(a).add(b);
      links.set(a, [...(links.get(a) ?? []), b]);
      links.set(b, [...(links.get(b) ?? []), a]);
    }
    if (touched.size === 0) fail('the town has no streets');
    const start = Math.min(...touched);
    const main = new Set([start]);
    const queue = [start];
    for (let at = 0; at < queue.length; at++) for (const next of links.get(queue[at] as number) ?? []) if (!main.has(next)) (main.add(next), queue.push(next));
    if (main.size === touched.size) break;
    joins++;
    if (joins > 2000) fail('the streets cannot be joined into one');
    const reached = new Map<number, number>();
    const cameBy = new Map<number, [number, number]>();
    const heap = new Heap();
    for (const corner of main) {
      if (corner < 0) continue;
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
      for (const way of town.ways[corner] as Way[]) {
        const edge = edgeOf(way.edge);
        if (edge.kind === 'wall' || edge.wallEnd === way.to || edge.wallEnd === corner || (town.wallCorners.has(way.to) && !gateOf.has(way.to))) continue;
        const next = so + distance(corners[corner] as Point, corners[way.to] as Point) * (edge.bridge ? 4 : 1);
        if (next < (reached.get(way.to) ?? Infinity)) {
          reached.set(way.to, next);
          cameBy.set(way.to, [corner, way.edge]);
          heap.push(next, way.to);
        }
      }
    }
    if (found === undefined) fail('part of the town cannot be joined to the rest by any street or bridge');
    for (let back = found as number; cameBy.has(back); back = (cameBy.get(back) as [number, number])[0]) {
      const edge = edgeOf((cameBy.get(back) as [number, number])[1]);
      if (edge.kind === 'none') edge.kind = 'lane';
      kept.add(edge.id);
    }
  }

  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', '// ---- 14. Records ---');
  // ---- 14. Records ---------------------------------------------------------------------------------------------
  const keptEdges = [...kept].sort((a, b) => a - b).map(edgeOf);
  const degree = new Map<number, number>();
  const atBridge = new Set<number>();
  for (const edge of keptEdges) {
    for (const end of endsOf(edge)) {
      degree.set(end, (degree.get(end) ?? 0) + 1);
      if (edge.bridge) atBridge.add(end);
    }
  }
  for (const draft of exitDrafts) if (draft) degree.set(draft.joins, (degree.get(draft.joins) ?? 0) + 1);
  const kindOfEdge = (edge: Edge): SegmentKind => (edge.bridge ? 'bridge' : edge.kind === 'highway' ? 'arterial' : edge.kind === 'lane' ? 'lane' : 'street');
  const routeOfEdge = (edge: Edge) => (edge.kind === 'highway' && edge.route !== undefined ? edge.route : undefined);
  // A junction is a corner where streets meet, end, change kind, or pass a gate or a bridge. Between two junctions the
  // corners a street passes are points along one segment.
  const same = (one: Edge, other: Edge) => kindOfEdge(one) === kindOfEdge(other) && town.widthOf(one) === town.widthOf(other) && routeOfEdge(one) === routeOfEdge(other);
  const isJunction = (corner: number) => {
    if ((degree.get(corner) ?? 0) !== 2 || gateOf.has(corner) || atBridge.has(corner) || exitDrafts.some((draft) => draft?.joins === corner)) return true;
    const [one, other] = keptEdges.filter((edge) => endsOf(edge).includes(corner)) as [Edge, Edge];
    return !same(one, other);
  };
  const junctionIds = new Map<string, string>();
  const layoutJunctions: Junction[] = [];
  const junctionFor = (key: string, position: Point, kind: JunctionKind): string => {
    let id = junctionIds.get(key);
    if (!id) {
      id = `junction-${number}-${pad(layoutJunctions.length + 1, 6)}`;
      junctionIds.set(key, id);
      layoutJunctions.push({ id, position, kind });
    }
    return id;
  };
  const cornerJunction = (corner: number) => junctionFor(`c${corner}`, nodePoint(corner), gateOf.has(corner) ? 'gate' : atBridge.has(corner) ? 'bridge-end' : degree.get(corner) === 1 ? 'dead-end' : 'crossing');
  for (const corner of [...degree.keys()].sort((a, b) => a - b)) if (isJunction(corner)) cornerJunction(corner);
  const edgesAt = new Map<number, Edge[]>();
  for (const edge of keptEdges) for (const end of endsOf(edge)) edgesAt.set(end, [...(edgesAt.get(end) ?? []), edge]);
  const segmentOfEdge = new Map<number, number>();
  const segments: Segment[] = [];
  const walk = (start: number, first: Edge) => {
    const run: Edge[] = [first];
    const points: Point[] = [nodePoint(start)];
    const firstEnds = endsOf(first);
    let corner = firstEnds[0] === start ? firstEnds[1] : firstEnds[0];
    points.push(nodePoint(corner));
    let edge = first;
    while (!isJunction(corner)) {
      const next = (edgesAt.get(corner) as Edge[]).find((other) => other.id !== edge.id) as Edge;
      run.push(next);
      const nextEnds = endsOf(next);
      corner = nextEnds[0] === corner ? nextEnds[1] : nextEnds[0];
      points.push(nodePoint(corner));
      edge = next;
    }
    return { run, points, end: corner };
  };
  // Closed loops with no junction on them get one at their lowest corner.
  for (const edge of keptEdges) {
    if (segmentOfEdge.has(edge.id)) continue;
    let start = endsOf(edge).find((corner) => junctionIds.has(`c${corner}`));
    if (start === undefined) {
      // Walk round to find a junction; a loop with none has its lowest corner made one.
      const loop: number[] = [];
      let corner = endsOf(edge)[0];
      let current = edge;
      for (let steps = 0; steps < 10000; steps++) {
        loop.push(corner);
        const currentEnds = endsOf(current);
        corner = currentEnds[0] === corner ? currentEnds[1] : currentEnds[0];
        if (junctionIds.has(`c${corner}`)) break;
        if (corner === endsOf(edge)[0]) break;
        current = (edgesAt.get(corner) as Edge[]).find((other) => other.id !== current.id) as Edge;
      }
      start = junctionIds.has(`c${corner}`) ? corner : Math.min(...loop);
      junctionFor(`c${start}`, nodePoint(start), 'crossing');
      if (!endsOf(edge).includes(start)) continue;
    }
    const first = edge;
    const { run, points, end } = walk(start, first);
    const index = segments.length;
    for (const piece of run) segmentOfEdge.set(piece.id, index);
    const route = routeOfEdge(first) === undefined ? undefined : (brief.routes[routeOfEdge(first) as number] as SettlementBrief['routes'][number]);
    segments.push({
      id: `segment-${number}-${pad(index + 1, 6)}`,
      fromJunctionId: cornerJunction(start),
      toJunctionId: junctionIds.get(`c${end}`) ?? cornerJunction(end),
      points,
      kind: kindOfEdge(first),
      width: town.widthOf(first),
      ...(route?.name !== undefined && { name: route.name }),
      ...(route && { routeId: route.routeId }),
    });
  }
  // Loops skipped above, now that one of their corners is a junction.
  for (const edge of keptEdges) {
    if (segmentOfEdge.has(edge.id)) continue;
    const start = endsOf(edge).find((corner) => junctionIds.has(`c${corner}`)) as number;
    const { run, points, end } = walk(start, edge);
    const index = segments.length;
    for (const piece of run) segmentOfEdge.set(piece.id, index);
    segments.push({ id: `segment-${number}-${pad(index + 1, 6)}`, fromJunctionId: cornerJunction(start), toJunctionId: cornerJunction(end), points, kind: kindOfEdge(edge), width: town.widthOf(edge) });
  }
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
  if (town.river) waters.push({ id: waterId(), kind: 'river', centreLine: town.river.line, width: town.river.width, widths: town.river.widths });
  if (town.coast) waters.push({ id: waterId(), kind: 'sea', polygon: town.coast.polygon });

  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', '// The wall: the boundaries be');
  // The wall: the boundaries between the oldest ground and the rest, where the town is, smoothed between its gates.
  const walls: Wall[] = [];
  if (gatehouses.length > 0) {
    const tooWet = (point: Point) => town.dryBy(point) < widths.street / 2 + grown.roadside;
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
    const lines: number[][] = [];
    const ends = [...at].filter(([, list]) => list.length === 1).map(([corner]) => corner).sort((a, b) => a - b);
    for (const corner of [...ends, ...[...at.keys()].sort((a, b) => a - b)]) if ((at.get(corner) ?? []).some((edge) => !done.has(edge.id))) lines.push(follow(corner));
    for (const line of lines) {
      if (line.length < 2) continue;
      const closed = line.length > 3 && line[0] === line[line.length - 1];
      const own = closed ? line.slice(0, -1) : line;
      // Smoothed between gates: each stretch from gate to gate is rounded, its ends held where they are.
      const gateAt = own.map((corner, index) => (gateOf.has(corner) && degree.has(corner) ? index : -1)).filter((index) => index >= 0);
      let points: Point[];
      if (gateAt.length === 0) points = closed ? chaikin([...own, own[0] as number].map((corner) => corners[corner] as Point), 2).slice(0, -1) : chaikin(own.map((corner) => corners[corner] as Point), 2);
      else {
        const turned = closed ? [...own.slice(gateAt[0] as number), ...own.slice(0, gateAt[0] as number)] : own;
        const stops = turned.map((corner, index) => (gateOf.has(corner) && degree.has(corner) ? index : -1)).filter((index) => index >= 0);
        if (closed) stops.push(turned.length);
        const ring = closed ? [...turned, turned[0] as number] : turned;
        points = [];
        let from = closed ? 0 : 0;
        for (const stop of [...stops, ring.length - 1]) {
          if (stop <= from) continue;
          const piece = chaikin(ring.slice(from, stop + 1).map((corner) => corners[corner] as Point), 2);
          points.push(...(points.length > 0 ? piece.slice(1) : piece));
          from = stop;
        }
        if (closed) points.pop();
      }
      walls.push({
        id: `wall-${number}-${pad(walls.length + 1, 3)}`,
        line: points,
        closed,
        width: grown.wall.width,
        gates: own
          .filter((corner, index) => gateOf.has(corner) && degree.has(corner) && own.indexOf(corner) === index)
          .map((corner) => ({ junctionId: cornerJunction(corner), buildingId: (gateOf.get(corner) as Building).id, arterial: keptEdges.some((edge) => (edge.a === corner || edge.b === corner) && edge.kind === 'highway') })),
      });
    }
    const made = new Set(walls.flatMap((wall) => wall.gates.map((gate) => gate.buildingId))).size;
    if (made !== gatehouses.length) fail(`${gatehouses.length} gatehouses but ${made} gates in the wall`);
  }

  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', '// Lots, numbered as their bui');
  // Lots, numbered as their buildings are.
  const buildingOrder = new Map(city.buildings.map((building, index) => [building.id, index]));
  placed.sort((a, b) => (buildingOrder.get(a.building.id) as number) - (buildingOrder.get(b.building.id) as number));
  const segmentIdOf = (edge: number) => (segments[segmentOfEdge.get(edge) as number] as Segment).id;
  /** The entrance: the middle of the lot's front, on the street's line. */
  const entranceOn = (edge: number, polygon: Point[]) => {
    const segment = segments[segmentOfEdge.get(edge) as number] as Segment;
    const line = lineOf(edgeOf(edge));
    const near = polygon.map((point) => projectOnPolyline(line, point));
    const least = Math.min(...near.map((entry) => entry.distance));
    const front = near.filter((entry) => entry.distance <= least + 1);
    const middle: Point = [front.reduce((sum, entry) => sum + entry.point[0], 0) / front.length, front.reduce((sum, entry) => sum + entry.point[1], 0) / front.length];
    const point = projectOnPolyline(segment.points, middle).point;
    if (distanceToPolygonEdge(point, polygon) <= segment.width / 2 + grown.roadside + 1.5) return { segmentId: segment.id, point };
    // Near a corner of its block the middle of a lot's front can stand off the street: the nearest point of the street to the lot, then.
    const nearest = polygon.map((corner) => projectOnPolyline(segment.points, corner)).reduce((best, entry) => (entry.distance < best.distance ? entry : best));
    return { segmentId: segment.id, point: nearest.point };
  };
  void segmentIdOf;
  // Last, each lot is drawn back from any roadway, wall or bank that it still stands on: blocks keep clear of what
  // runs along their own sides, but not always of what passes a corner.
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
  type Plane = { at: Point; normal: Point };
  const trimsOf = (polygon: Point[]): Plane[] => {
    const planes: Plane[] = [];
    let left = polygon;
    const box = boxOf(polygon);
    const near = new Set<number>();
    for (let x = Math.floor(box.minX / TRIM_SQUARE); x <= Math.floor(box.maxX / TRIM_SQUARE); x++) for (let y = Math.floor(box.minY / TRIM_SQUARE); y <= Math.floor(box.maxY / TRIM_SQUARE); y++) for (const index of filedBarriers.get(`${x}:${y}`) ?? []) near.add(index);
    for (const index of [...near].sort((one, other) => one - other)) {
      const { a, b, half } = barriers[index] as { a: Point; b: Point; half: number };
      if (left.length < 3 || distancePolygonToPolyline(left, [a, b]) >= half - 1e-9) continue;
      const length = distance(a, b) || 1;
      const middle = polygonCentroid(left);
      let inward: Point = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
      if ((middle[0] - a[0]) * inward[0] + (middle[1] - a[1]) * inward[1] < 0) inward = [-inward[0], -inward[1]];
      const plane = { at: [a[0] + inward[0] * (half + 0.05), a[1] + inward[1] * (half + 0.05)] as Point, normal: inward };
      planes.push(plane);
      left = clip(left, plane);
    }
    if (town.river) {
      const river = town.river;
      const along = polygon.flatMap((point, index) => {
        const next = polygon[(index + 1) % polygon.length] as Point;
        const pieces = Math.max(1, Math.ceil(distance(point, next) / 3));
        return Array.from({ length: pieces }, (_, at): Point => [point[0] + ((next[0] - point[0]) * at) / pieces, point[1] + ((next[1] - point[1]) * at) / pieces]);
      });
      for (const point of along) {
        const found = river.nearest(point);
        if (left.length < 3 || found.away - found.width / 2 > 0.2 || found.away === 0) continue;
        const outward: Point = [(point[0] - found.point[0]) / found.away, (point[1] - found.point[1]) / found.away];
        const plane = { at: [found.point[0] + outward[0] * (found.width / 2 + 0.5), found.point[1] + outward[1] * (found.width / 2 + 0.5)] as Point, normal: outward };
        planes.push(plane);
        left = clip(left, plane);
      }
    }
    return planes;
  };
  const trimmed = (polygon: Point[], planes: Plane[]) => planes.reduce((left, plane) => (left.length < 3 ? left : clip(left, plane)), polygon);
  for (const lot of placed) {
    const planes = trimsOf(lot.polygon);
    if (planes.length === 0) continue;
    lot.polygon = trimmed(lot.polygon, planes);
    if (lot.polygon.length < 3) fail(`the lot of ${lot.building.id} stands wholly on a roadway, a wall or the water`);
  }

  let builtArea = 0;
  const lots: Lot[] = [];
  const places: Place[] = [];
  const allLots: Array<Placed | 'plaza'> = [...placed];
  if (plazaBuilding) allLots.splice(buildingOrder.get(plazaBuilding.id) as number, 0, 'plaza');
  for (const lot of placed) if (!segmentOfEdge.has(lot.edge)) fail(`the lot of ${lot.building.id} opens onto a street that was not kept`);
  allLots.forEach((lot, index) => {
    const id = `lot-${number}-${pad(index + 1, 6)}`;
    if (lot === 'plaza') {
      const building = plazaBuilding as Building;
      const polygon = town.blockOf(town.plazaCell as number);
      const edge = streetsOf(town.plazaCell as number).find((street) => kept.has(street.id) && segmentOfEdge.has(street.id));
      if (polygon.length < 3 || !edge) fail('the plaza has no street round it');
      builtArea += polygonArea(polygon);
      lots.push({ id, buildingId: building.id, polygon, districtId: building.districtId, entrance: entranceOn((edge as Edge).id, polygon), footprints: [] });
      places.push({ id: `place-${number}-${pad(places.length + 1, 3)}`, kind: 'plaza', polygon, buildingId: building.id });
      return;
    }
    // The building stands across the front of its lot, as deep as the pack's share of the lot.
    const coverage = footprintCoverageOf(lot.building.type, pack);
    let footprint: Point[] = [];
    if (coverage > 0) {
      const [a, b] = lineOf(edgeOf(lot.edge));
      const length = distance(a, b) || 1;
      let inward: Point = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
      const middle = polygonCentroid(lot.polygon);
      if ((middle[0] - a[0]) * inward[0] + (middle[1] - a[1]) * inward[1] < 0) inward = [-inward[0], -inward[1]];
      const depths = lot.polygon.map((point) => (point[0] - a[0]) * inward[0] + (point[1] - a[1]) * inward[1]);
      const [near, far] = [Math.min(...depths), Math.max(...depths)];
      const reach = near + (far - near) * coverage;
      footprint = coverage >= 1 ? lot.polygon : clip(lot.polygon, { at: [a[0] + inward[0] * reach, a[1] + inward[1] * reach], normal: [-inward[0], -inward[1]] });
      if (footprint.length < 3 || polygonArea(footprint) < 0.5) footprint = [];
    }
    builtArea += polygonArea(lot.polygon);
    lots.push({ id, buildingId: lot.building.id, polygon: lot.polygon, districtId: lot.building.districtId, entrance: entranceOn(lot.edge, lot.polygon), footprints: footprint.length >= 3 ? [footprint] : [] });
  });
  for (const id of greens) places.push({ id: `place-${number}-${pad(places.length + 1, 3)}`, kind: 'green', polygon: town.blockOf(id) });

  // A district's area is its blocks; every block records its growth rank.
  let outlineArea = 0;
  const districtAreas = city.districts.flatMap((district: District, index) => {
    const own = [...(cellsOf[index] as number[])].filter((id) => ground.has(id) || built.has(id)).sort((a, b) => a - b);
    if (own.length === 0) return [];
    const polygons = own.map(outlineOf);
    for (const polygon of polygons) outlineArea += polygonArea(polygon);
    const middle: Point = [own.reduce((sum, id) => sum + cellOf(id).centre[0], 0) / own.length, own.reduce((sum, id) => sum + cellOf(id).centre[1], 0) / own.length];
    const label = own.reduce((nearest, id) => (distance(cellOf(id).centre, middle) < distance(cellOf(nearest).centre, middle) ? id : nearest));
    return [{ districtId: district.id, polygons, labelPoint: cellOf(label).centre }];
  });
  const blockIds = [...new Set([...ground, ...built])].sort((a, b) => rankOf(a) - rankOf(b) || a - b);
  const records: Block[] = blockIds.map((id, index) => {
    const district = owner.get(id);
    return {
      id: `block-${number}-${pad(index + 1, 6)}`,
      polygon: outlineOf(id),
      ...(district !== undefined && !greens.includes(id) && { districtId: (city.districts[district] as District).id }),
      growthRank: blockIds.length === 1 ? 0 : index / (blockIds.length - 1),
    };
  });

  // Roads out of the centre: the highways that leave it, and the arterials that branch within the oldest ground.
  const roadsOut = plan.trunks.filter((road) => (plan.roads[road] as RoadLine).kind !== 'quay').length + plan.roads.filter((road, index) => road.kind === 'arterial' && town.chains.has(index) && town.cost((road.points[0] as Point)) < 0.25 * town.townCost).length;
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
    blocks: records,
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
  (globalThis as any).__debug?.(layout, { placed, town });
  (globalThis as any).DBG && (globalThis as any).MARK('STAGE', 'const broken = checkLayout(');
  const broken = checkLayout(layout, city, brief, pack);
  if (broken.length > 0) fail(`the layout breaks ${broken.length === 1 ? 'an invariant' : 'invariants'}:\n  ${broken.join('\n  ')}`);
  return layout;
}
