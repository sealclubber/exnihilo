/**
 * The staged generator's town as a layout: the plan's ways, lots, wall,
 * places and districts, written in the one layout format and checked
 * against its invariants.
 */
import type { City } from '../../city/records.ts';
import { type SettingPack, footprintCoverageOf, placeFlagsOf } from '../../pack/schema.ts';
import type { Point, SettlementBrief } from '../../schema.ts';
import { interiorPoint } from '../cutting.ts';
import { boxOf, distance, polygonsOverlap, sharedBoundaryLength, distancePolygonToPolyline, distanceToPolygonEdge, piecesCross, pointInPolygon, strictlyInside, polylineLength, slicePolyline, polygonArea, polygonCentroid, projectOnPolyline, SpatialIndex } from '../geometry.ts';
import { checkLayout } from '../invariants.ts';
import { ringShare } from '../measure.ts';
import { type BridgeLink, type Courtyard, type DistrictArea, type Exit, type Gate, type Junction, LAYOUT_VERSION, type Layout, type Lot, type Segment, type Wall as WallRecord } from '../records.ts';
import { builtInChecks } from './checks.ts';
import { type NetEdge, type NetNode, buildNetwork } from './network.ts';
import { StagedLayoutError, type TownPlan, planTown, stagedSettings, townInput } from './plan.ts';
import { cornersOf } from './rects.ts';
import { grown, widened, without } from './shapes.ts';
import { plainly } from './tiles.ts';

export const STAGED_GENERATOR = 'staged';

/** A reservation a person made, for the editor to come: a ward, a block or a slot, given a building or a footprint, at a place. */
export interface Pin {
  reservation: 'ward' | 'block' | 'slot';
  /** Where: a point in the ward or block, or on the row. */
  at: Point;
  buildingType?: string;
  footprint?: Point[];
}

export interface StagedOptions {
  seed?: number;
  /** Reservations people made, applied before the rules: a block pin gives the block at its place to a landmark of its type. An empty list and no list give the same town. */
  pins?: readonly Pin[];
  /** false returns the layout without checking it against the invariants: for measuring which of them a town breaks. */
  check?: boolean;
  /** Wards to draw afresh, by name, as an edit to one ward would. */
  redraw?: ReadonlyMap<string, number>;
}

const pad = (value: number, digits: number) => String(value).padStart(digits, '0');
/** The wall's width, in metres, and the side of a gatehouse: it stands in the clear ground beside its gate. */
const WALL_WIDTH = 3;
const GATEHOUSE = 3.5;
/** A pocket of at least this many junctions is joined to the town, by a lane no longer than this many metres. */
const POCKET = 2;
const JOIN_WITHIN = 400;
/** How near a bridge's head no joining lane begins or ends, in metres. */
const HEAD_CLEAR = 3;
/** A house's way is looked for at its front; if none lies within this many metres, at its other sides. */
const FRONT_WITHIN = 11;

export function generateStagedLayout(city: City, brief: SettlementBrief, pack: SettingPack, options: StagedOptions = {}): Layout {
  const settings = stagedSettings(pack);
  const seed = options.seed ?? brief.seed;
  const fail = (message: string): never => {
    throw new StagedLayoutError(`${brief.name} (${brief.id}): ${message}`);
  };
  const number = brief.id.split('-')[1] as string;
  const plan = planTown(brief, { ...townInput(city, pack), ...(options.pins && options.pins.length > 0 && { pins: options.pins }), ...(options.redraw && { redraw: options.redraw }) }, pack, seed);
  if (options.check !== false) {
    const faults = builtInChecks(plan);
    const broken = Object.entries(faults).filter(([, count]) => count > 0);
    if (broken.length > 0) fail(`the town breaks its own checks: ${broken.map(([name, count]) => `${name} ${count}`).join(', ')}`);
  }
  const fitting = plan.fitting as NonNullable<TownPlan['fitting']>;
  const buildingById = new Map(city.buildings.map((building) => [building.id, building]));

  // ---- The network ---------------------------------------------------------------------------------------------------
  const builtBlocks = new Set<number>();
  plan.houses.forEach((house, index) => fitting.holder[index] !== undefined && builtBlocks.add(house.block));
  for (const landmark of plan.landmarks) if (landmark.block !== undefined) builtBlocks.add(landmark.block);
  const net = buildNetwork({ plan, settings, routes: brief.routes.map((route) => ({ bearing: route.bearing, sea: route.kind === 'sea-route' })), builtBlocks, wallWidth: WALL_WIDTH });

  // One town: the ways that can be reached from the centre.
  const beside: number[][] = net.nodes.map(() => []);
  net.edges.forEach((edge, index) => {
    (beside[edge.from] as number[]).push(index);
    (beside[edge.to] as number[]).push(index);
  });
  // The largest piece of the network is the town's. A pocket of lanes cut off from it, as houses between the wall
  // and the water may be, is joined to it by the shortest lane that passes no house and no water; where that lane
  // must pass the wall it does so by a plain gate. A stray length that joins nothing is left out.
  const solid = new SpatialIndex<Point[]>(40);
  plan.houses.forEach((house, at) => fitting.holder[at] !== undefined && solid.add(boxOf(house.outline, 3), house.outline));
  for (const landmark of plan.landmarks) {
    const polygon = landmark.block !== undefined ? (plan.blocks[landmark.block] as TownPlan['blocks'][number]).polygon : (plan.wards[landmark.ward] as TownPlan['wards'][number]).polygon;
    solid.add(boxOf(polygon, 3), polygon);
  }
  const ringLines = plan.wall ? plan.wall.parts.map((part) => (part.closed ? [...part.points, part.points[0] as Point] : part.points)) : [];
  const laneWidth = settings.widths.lane - 0.4;
  const pieces = (): { of: Int32Array; sizes: number[] } => {
    const of = new Int32Array(net.nodes.length).fill(-1);
    const sizes: number[] = [];
    net.nodes.forEach((_, from) => {
      if (of[from] !== -1 || (beside[from] as number[]).length === 0) return;
      const queue = [from];
      of[from] = sizes.length;
      for (let head = 0; head < queue.length; head++) {
        for (const index of beside[queue[head] as number] as number[]) {
          const edge = net.edges[index] as NetEdge;
          for (const next of [edge.from, edge.to]) {
            if (of[next] !== -1) continue;
            of[next] = sizes.length;
            queue.push(next);
          }
        }
      }
      sizes.push(queue.length);
    });
    return { of, sizes };
  };
  let found = pieces();
  let largest = found.sizes.indexOf(Math.max(...found.sizes));
  // Each pocket is known by one of its junctions: the pieces are counted again after every join.
  const pockets = found.sizes.map((size, at) => ({ size, at, node: found.of.indexOf(at) })).filter(({ size, at }) => at !== largest && size >= POCKET).sort((a, b) => b.size - a.size || a.at - b.at);
  for (const pocket of pockets) {
    // Never at a bridge's head, where a gate may stand across the road.
    const atHead = (at: number) => [...net.bridgeHeads.values()].some((head) => distance(head, (net.nodes[at] as NetNode).point) < HEAD_CLEAR) || plan.bridges.some((bridge) => distance(bridge.a, (net.nodes[at] as NetNode).point) < HEAD_CLEAR || distance(bridge.b, (net.nodes[at] as NetNode).point) < HEAD_CLEAR);
    const piece = found.of[pocket.node] as number;
    if (piece === largest) continue;
    const own = net.nodes.map((_, at) => at).filter((at) => found.of[at] === piece && !atHead(at));
    const main = net.nodes.map((_, at) => at).filter((at) => found.of[at] === largest && !atHead(at));
    // To the nearest place on any way of the town, not only its junctions: the way is parted there.
    const inMain = new Set(main);
    const pairs = own.flatMap((u) => {
      const from = (net.nodes[u] as NetNode).point;
      let best: { edge: number; along: number; point: Point; away: number } | undefined;
      net.edges.forEach((edge, at) => {
        if (edge.kind === 'bridge' || found.of[edge.from] !== largest) return;
        const hit = projectOnPolyline(edge.points, from);
        if (!best || hit.distance < best.away) best = { edge: at, along: hit.along, point: hit.point, away: hit.distance };
      });
      return best ? [{ u, ...(best as { edge: number; along: number; point: Point; away: number }) }] : [];
    }).sort((a, b) => a.away - b.away || a.u - b.u);
    void inMain;
    const nodeAt = (edge: number, along: number, point: Point): number => {
      const way = net.edges[edge] as NetEdge;
      const length = polylineLength(way.points);
      if (along < 0.3) return way.from;
      if (along > length - 0.3) return way.to;
      const node = net.nodes.length;
      net.nodes.push({ point, kind: 'crossing' });
      beside.push([edge, net.edges.length]);
      const far = way.to;
      net.edges.push({ ...way, from: node, to: far, points: [point, ...slicePolyline(way.points, along, length).slice(1)] });
      (beside[far] as number[]).splice((beside[far] as number[]).indexOf(edge), 1, net.edges.length - 1);
      way.to = node;
      way.points = [...slicePolyline(way.points, 0, along).slice(0, -1), point];
      return node;
    };
    for (const { u, edge, along, point, away } of pairs.slice(0, 40)) {
      if (away > JOIN_WITHIN) break;
      if ([...net.bridgeHeads.values()].some((head) => distance(head, point) < HEAD_CLEAR)) continue;
      const [from, to] = [(net.nodes[u] as NetNode).point, point];
      let clear = true;
      for (let step = 0; step <= Math.ceil(away / 2) && clear; step++) {
        const point: Point = [from[0] + ((to[0] - from[0]) * step) / Math.ceil(away / 2), from[1] + ((to[1] - from[1]) * step) / Math.ceil(away / 2)];
        if ((plan.river && plan.river.gap(point) < laneWidth) || (plan.coast && plan.coast.gap(point) < laneWidth)) clear = false;
      }
      for (const outline of solid.near(boxOf([from, to], laneWidth))) if (distancePolygonToPolyline(outline, [from, to]) < laneWidth / 2 + 0.05) clear = false;
      if (!clear) continue;
      const v = -1;
      const hits = ringLines.flatMap((line) => line.flatMap((point, at) => (at > 0 ? [meetOf(from, to, line[at - 1] as Point, point)] : [])).filter((hit): hit is Point => hit !== undefined));
      if (hits.length > 1) continue;
      const add = (a: number, b: number, points: Point[]) => {
        (beside[a] as number[]).push(net.edges.length);
        (beside[b] as number[]).push(net.edges.length);
        net.edges.push({ from: a, to: b, points, kind: 'lane', width: laneWidth });
      };
      void v;
      const target = nodeAt(edge, along, point);
      if (hits.length === 1) {
        const gate = net.nodes.length;
        net.nodes.push({ point: hits[0] as Point, kind: 'gate', arterial: false });
        beside.push([]);
        add(u, gate, [from, hits[0] as Point]);
        add(gate, target, [hits[0] as Point, to]);
      } else add(u, target, [from, to]);
      break;
    }
    found = pieces();
    largest = found.sizes.indexOf(Math.max(...found.sizes));
  }
  const reached = Uint8Array.from(found.of, (of) => (of === largest ? 1 : 0));
  const alive = net.edges.map((edge) => reached[edge.from] === 1);

  // ---- Lots, each with its entrance on the nearest way ----------------------------------------------------------------
  const index = new SpatialIndex<number>(40);
  net.edges.forEach((edge, at) => alive[at] && edge.kind !== 'bridge' && index.add(boxOf(edge.points, 1), at));
  const fronted = new Uint8Array(net.edges.length);
  /** The way nearest a lot: looked for from a point at its front, or failing one from every corner and side of its outline. */
  const entranceFor = (polygon: readonly Point[], front?: Point): { edge: number; point: Point } => {
    const probes = front ? [front] : polygon.flatMap((corner, at): Point[] => [corner, [(corner[0] + (polygon[(at + 1) % polygon.length] as Point)[0]) / 2, (corner[1] + (polygon[(at + 1) % polygon.length] as Point)[1]) / 2]]);
    for (const reach of [15, 40, 120, 400]) {
      let best: { edge: number; point: Point; away: number } | undefined;
      for (const from of probes) {
        for (const at of index.near({ minX: from[0] - reach, minY: from[1] - reach, maxX: from[0] + reach, maxY: from[1] + reach })) {
          const found = projectOnPolyline((net.edges[at] as NetEdge).points, from);
          if (!best || found.distance < best.away - 1e-9 || (Math.abs(found.distance - best.away) <= 1e-9 && at < best.edge)) best = { edge: at, point: found.point, away: found.distance };
        }
      }
      if (best && best.away <= reach) {
        fronted[best.edge] = 1;
        return best;
      }
    }
    return fail('a lot has no way within 400 m to open onto');
  };
  interface Draft {
    building: string;
    polygon: Point[];
    footprints: Point[][];
    front?: [Point, Point];
    entrance: { edge: number; point: Point };
  }
  const drafts = new Map<string, Draft>();
  const slotOpen = (type: string) => settings.landmarks.types[type]?.open;
  /** The block each kept house stands in, by the building it holds. */
  const blockOfBuilding = new Map<string, number>();
  plan.houses.forEach((house, at) => {
    const held = fitting.holder[at];
    if (held === undefined) return;
    blockOfBuilding.set(held, house.block);
    const middle: Point = [(house.front[0][0] + house.front[1][0]) / 2, (house.front[0][1] + house.front[1][1]) / 2];
    const type = (buildingById.get(held) as City['buildings'][number]).type;
    const open = slotOpen(type);
    let footprints = [house.outline];
    const body = house.parts[0] as TownPlan['houses'][number]['parts'][number];
    if (open !== undefined) {
      // A small footprint in the middle of the front, the rest of the place open ground: a well by the street.
      const side = Math.min(open, body.width, body.depth);
      footprints = [cornersOf({ corner: [body.corner[0] + (body.along[0] * (body.width - side)) / 2 + body.inward[0] * 0.5, body.corner[1] + (body.along[1] * (body.width - side)) / 2 + body.inward[1] * 0.5], along: body.along, inward: body.inward, width: side, depth: Math.min(side, body.depth - 0.5) })];
    } else if (placeFlagsOf(type, pack).openAir) {
      // An open-air place keeps the whole house as its lot, and is built over only as far back from the street as
      // the pack's coverage for its type says: a shed or a stable at the front, the rest a yard. None, by default.
      const coverage = footprintCoverageOf(type, pack);
      footprints = coverage > 0 ? [cornersOf({ ...body, depth: body.depth * Math.min(coverage, 1) })] : [];
    }
    // By its front; but a house whose front faces open ground with no way across it opens onto the way nearest
    // any of its sides.
    let entrance = entranceFor(house.outline, middle);
    if (distance(entrance.point, middle) > FRONT_WITHIN) {
      const other = entranceFor(house.outline);
      if (distancePolygonToPolyline(house.outline, [other.point, other.point]) < distancePolygonToPolyline(house.outline, [entrance.point, entrance.point])) entrance = other;
    }
    drafts.set(held, { building: held, polygon: house.outline, footprints, front: house.front, entrance });
  });
  for (const landmark of plan.landmarks) {
    const polygon = landmark.block !== undefined ? (plan.blocks[landmark.block] as TownPlan['blocks'][number]).polygon : (plan.wards[landmark.ward] as TownPlan['wards'][number]).polygon;
    drafts.set(landmark.building, { building: landmark.building, polygon, footprints: landmark.outline.length > 0 ? [landmark.outline] : [], entrance: entranceFor(polygon) });
  }

  // ---- The wall, its gates and their gatehouses -----------------------------------------------------------------------
  const wallLines: Point[][] = plan.wall ? plan.wall.parts.map((part) => part.points) : [];
  const closed = plan.wall !== undefined && plan.wall.parts.length === 1 && (plan.wall.parts[0] as { closed: boolean }).closed;
  const gates: Array<{ node: number; arterial: boolean; along: Point; inward: Point; clear: number; rank: number; bank?: boolean }> = [];
  if (plan.wall) {
    const lines = plan.wall.parts.map((part) => (part.closed ? [...part.points, part.points[0] as Point] : part.points));
    net.nodes.forEach((node, at) => {
      if (node.kind !== 'gate' || !reached[at]) return;
      // The wall's direction at the gate, and the way into the town.
      let best: { line: Point[]; found: ReturnType<typeof projectOnPolyline> } | undefined;
      for (const line of lines) {
        const found = projectOnPolyline(line, node.point);
        if (!best || found.distance < best.found.distance) best = { line, found };
      }
      const { line, found } = best as NonNullable<typeof best>;
      const a = pointAt(line, Math.max(found.along - 1, 0));
      const b = pointAt(line, found.along + 1);
      const length = distance(a, b) || 1;
      const along: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
      let inward: Point = [-along[1], along[0]];
      if (inward[0] * node.point[0] + inward[1] * node.point[1] > 0) inward = [-inward[0], -inward[1]];
      const widest = Math.max(...(beside[at] as number[]).map((edge) => (net.edges[edge] as NetEdge).width));
      gates.push({ node: at, arterial: node.arterial ?? false, along, inward, clear: widest / 2, rank: node.arterial ? 0 : 2 });
    });
    // A bridge into a bank the river closes has its gate at the bridge's end: a short length of wall stands across it.
    if (plan.wall.farDropped) {
      for (const gate of plan.wall.gates) {
        if (gate.bridge === undefined) continue;
        const bridge = plan.bridges[gate.bridge] as TownPlan['bridges'][number];
        const head = net.bridgeHeads.get(gate.bridge) ?? bridge.a;
        const at = net.nodes.findIndex((node) => distance(node.point, head) < 0.05);
        if (at < 0 || !reached[at] || gates.some((other) => other.node === at)) continue;
        // The way into the town is the way from the water.
        const here0 = (net.nodes[at] as NetNode).point;
        const bank = (plan.river as NonNullable<TownPlan['river']>).nearest(here0).point;
        const span = distance(bank, here0) || 1;
        const inward: Point = [(here0[0] - bank[0]) / span, (here0[1] - bank[1]) / span];
        const along: Point = [-inward[1], inward[0]];
        (net.nodes[at] as NetNode).kind = 'gate';
        const here = (net.nodes[at] as NetNode).point;
        // No longer than the gate itself: other ways meet the road close by the bridge's head.
        const half = 0.3;
        wallLines.push([[here[0] - along[0] * half, here[1] - along[1] * half], here, [here[0] + along[0] * half, here[1] + along[1] * half]]);
        gates.push({ node: at, arterial: true, along, inward, clear: settings.widths.highway / 2, rank: 1, bank: true });
      }
    }
  }
  gates.sort((a, b) => a.rank - b.rank || a.node - b.node);
  const keptBy = new Map<number, string>();
  const allEdges = net.edges.map((edge, at) => ({ edge, at })).filter(({ at }) => alive[at]);
  const freeAt = (square: Point[]) =>
    allEdges.every(({ edge }) => distancePolygonToPolyline(square, edge.points) >= edge.width / 2 + 0.05) &&
    wallLines.every((line) => distancePolygonToPolyline(square, line) >= WALL_WIDTH / 2 + 0.05) &&
    square.every((corner) => (!plan.river || plan.river.gap(corner) > 0.3) && (!plan.coast || plan.coast.gap(corner) > 0.3)) &&
    [...drafts.values()].every((draft) => !boxesMeet(boxOf(draft.polygon), boxOf(square)) || (distancePolygonToPolyline(square, [...draft.polygon, draft.polygon[0] as Point]) > 0.3 && !pointInPolygon(square[0] as Point, draft.polygon)));
  const spare = [...plan.gatehouses];
  /** A clear square beside a gate, or nothing. */
  const beside1 = (gate: (typeof gates)[number]): Point[] | undefined => {
    const at = (net.nodes[gate.node] as NetNode).point;
    // Beside the gate, just inside the wall or just outside it, on either hand. At a bridge the gatehouse stands
    // on the bank, beside the bridge's head, where no house stands.
    for (const inside of gate.bank ? [-1, 1] : [1, -1]) {
      for (const hand of [1, -1]) {
        for (const further of [0, 2, 4, 7, 11, 16, 22]) {
          const corner: Point = [
            at[0] + gate.along[0] * hand * (gate.clear + 0.4 + further + (hand < 0 ? GATEHOUSE : 0)) + gate.inward[0] * inside * (WALL_WIDTH / 2 + 0.4 + (inside < 0 ? GATEHOUSE : 0)),
            at[1] + gate.along[1] * hand * (gate.clear + 0.4 + further + (hand < 0 ? GATEHOUSE : 0)) + gate.inward[1] * inside * (WALL_WIDTH / 2 + 0.4 + (inside < 0 ? GATEHOUSE : 0)),
          ];
          const square = cornersOf({ corner, along: gate.along, inward: gate.inward, width: GATEHOUSE, depth: GATEHOUSE });
          if (freeAt(square)) return square;
        }
      }
    }
    return undefined;
  };
  const homeless: string[] = [];
  for (const gate of gates) {
    const building = spare.shift();
    if (building === undefined) break;
    const square = beside1(gate);
    if (!square) {
      homeless.push(building);
      continue;
    }
    drafts.set(building, { building, polygon: square, footprints: [square], entrance: entranceFor(square) });
    keptBy.set(gate.node, building);
  }
  // A gatehouse whose gate has no clear ground beside it, or for which the network has no gate left, stands
  // beside whichever gate has room, and keeps none.
  for (const building of [...homeless, ...spare]) {
    let square: Point[] | undefined;
    for (const gate of gates) if ((square = beside1(gate))) break;
    if (!square) return fail(`no clear ground beside any gate for the gatehouse ${building}`);
    drafts.set(building, { building, polygon: square, footprints: [square], entrance: entranceFor(square) });
  }

  // ---- Ways no building fronts and nothing needs are left out -----------------------------------------------------------
  const degree = net.nodes.map((_, at) => (beside[at] as number[]).filter((edge) => alive[edge]).length);
  const loose = net.nodes.map((_, at) => at).filter((at) => degree[at] === 1);
  for (let head = 0; head < loose.length; head++) {
    const at = loose[head] as number;
    const node = net.nodes[at] as NetNode;
    if (degree[at] !== 1 || node.kind === 'exit' || node.kind === 'gate') continue;
    const edge = (beside[at] as number[]).find((candidate) => alive[candidate]) as number;
    if (fronted[edge]) continue;
    alive[edge] = false;
    const other = (net.edges[edge] as NetEdge).from === at ? (net.edges[edge] as NetEdge).to : (net.edges[edge] as NetEdge).from;
    degree[at] = 0;
    degree[other] = (degree[other] as number) - 1;
    if (degree[other] === 1) loose.push(other);
  }

  // ---- Records ------------------------------------------------------------------------------------------------------------
  const junctionId = new Map<number, string>();
  const junctions: Junction[] = [];
  net.nodes.forEach((node, at) => {
    if ((degree[at] as number) === 0) return;
    const id = `junction-${number}-${pad(junctions.length + 1, 6)}`;
    junctionId.set(at, id);
    junctions.push({ id, position: node.point, kind: node.kind === 'crossing' && degree[at] === 1 ? 'dead-end' : node.kind });
  });
  // No roadway reaches into the plaza: a way that passes nearer than its half-width is only as wide as the ground.
  if (plan.plaza) {
    const edge = [...plan.plaza.polygon, plan.plaza.polygon[0] as Point];
    net.edges.forEach((way, at) => {
      if (!alive[at]) return;
      const gap = distancePolygonToPolyline(plan.plaza?.polygon as Point[], way.points);
      void edge;
      if (gap > 0.5 && gap < way.width / 2 + 0.05) way.width = 2 * gap - 0.1;
    });
  }
  const segmentId = new Map<number, string>();
  const segments: Segment[] = [];
  net.edges.forEach((edge, at) => {
    if (!alive[at]) return;
    const id = `segment-${number}-${pad(segments.length + 1, 6)}`;
    segmentId.set(at, id);
    const route = edge.route === undefined ? undefined : brief.routes[edge.route];
    segments.push({ id, fromJunctionId: junctionId.get(edge.from) as string, toJunctionId: junctionId.get(edge.to) as string, points: edge.points, kind: edge.kind, width: edge.width, ...(route && { routeId: route.routeId }) });
  });
  const exits: Exit[] = [];
  brief.routes.forEach((route, position) => {
    const at = net.nodes.findIndex((node, index) => node.kind === 'exit' && node.route === position && junctionId.has(index));
    if (at < 0) fail(`route ${position} (${route.routeId}) has no exit on the network: ${net.notes.join('; ')}`);
    exits.push({ id: `exit-${number}-${pad(position + 1, 3)}`, junctionId: junctionId.get(at) as string, routeId: route.routeId, ...(route.name !== undefined && { name: route.name }), kind: route.kind, bearing: route.bearing, ...((net.nodes[at] as NetNode).atQuay && { atQuay: true }) });
  });
  const lots: Lot[] = [];
  city.buildings.forEach((building, at) => {
    const draft = drafts.get(building.id);
    if (!draft) return fail(`${building.id}, a ${building.type}, was given no place`);
    lots.push({ id: `lot-${number}-${pad(at + 1, 6)}`, buildingId: building.id, polygon: draft.polygon, districtId: building.districtId, entrance: { segmentId: segmentId.get(draft.entrance.edge) as string, point: draft.entrance.point }, footprints: draft.footprints, ...(draft.front && { front: draft.front }) });
  });
  const walls: WallRecord[] = [];
  if (plan.wall && wallLines.length > 0) {
    const records: Gate[] = gates.filter((gate) => junctionId.has(gate.node)).map((gate) => ({ junctionId: junctionId.get(gate.node) as string, ...(keptBy.has(gate.node) && { buildingId: keptBy.get(gate.node) as string }), arterial: gate.arterial }));
    records.sort((a, b) => (a.junctionId < b.junctionId ? -1 : 1));
    walls.push({ id: `wall-${number}-001`, lines: wallLines, closed: closed && wallLines.length === 1, width: WALL_WIDTH, gates: records });
  }
  const square = plan.landmarks.find((landmark) => landmark.reservation === 'ward' && plan.wards[landmark.ward]?.kind === 'plaza');
  const places: Layout['places'] = plan.plaza && square ? [{ id: `place-${number}-001`, kind: 'plaza', polygon: plan.plaza.polygon, buildingId: square.building }] : [];
  const courtyards = courtyardsOf(plan, settings.rows, lots, blockOfBuilding, segments, builtBlocks, number);

  // ---- Districts: the ground about each one's blocks ----------------------------------------------------------------------
  const { areas: districtAreas, joins } = districtGround(plan, city, lots);
  // Each join is written with the bridge's segment, and the district at each of the segment's ends.
  const bridgeLinks: BridgeLink[] = [];
  for (const join of joins) {
    const bridge = plan.bridges[join.bridge] as TownPlan['bridges'][number];
    const middle: Point = [(bridge.a[0] + bridge.b[0]) / 2, (bridge.a[1] + bridge.b[1]) / 2];
    let over: Segment | undefined;
    let least = Infinity;
    for (const segment of segments) {
      if (segment.kind !== 'bridge') continue;
      const away = projectOnPolyline(segment.points, middle).distance;
      if (away < least) {
        least = away;
        over = segment;
      }
    }
    if (!over) continue;
    const forward = distance(over.points[0] as Point, bridge.a) <= distance(over.points[0] as Point, bridge.b);
    const link: BridgeLink = { segmentId: over.id, from: forward ? join.a : join.b, to: forward ? join.b : join.a };
    if (!bridgeLinks.some((other) => other.segmentId === link.segmentId && other.from === link.from && other.to === link.to)) bridgeLinks.push(link);
  }
  bridgeLinks.sort((a, b) => (a.segmentId < b.segmentId ? -1 : a.segmentId > b.segmentId ? 1 : a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1));

  const waters: Layout['waters'] = [];
  if (plan.river) waters.push({ id: `water-${number}-${pad(waters.length + 1, 3)}`, kind: 'river', centreLine: plan.river.line, width: plan.river.width });
  if (plan.coast) waters.push({ id: `water-${number}-${pad(waters.length + 1, 3)}`, kind: 'sea', polygon: plan.coast.polygon });
  const builtArea = lots.reduce((sum, lot) => sum + polygonArea(lot.polygon), 0);
  const most = Math.max(...plan.wards.map((ward) => ward.growthRank), 1);
  const districtIdOf = (of: number | undefined) => (of === undefined ? undefined : plan.districts[of]?.id);
  const layout: Layout = {
    junctions,
    segments,
    exits,
    waters,
    lots,
    districtAreas,
    ...(bridgeLinks.length > 0 && { bridgeLinks }),
    ...(courtyards.length > 0 && { courtyards }),
    walls,
    places,
    blocks: plan.blocks.flatMap((block, at) => (builtBlocks.has(at) ? [{ id: `block-${number}-${pad(at + 1, 6)}`, polygon: block.polygon, ...(districtIdOf(plan.drawn.blockDistrict[at]) !== undefined && { districtId: districtIdOf(plan.drawn.blockDistrict[at]) as string }), growthRank: Math.min((plan.wards[block.ward] as TownPlan['wards'][number]).growthRank / most, 1) }] : [])),
    wards: plan.wards.map((ward, at) => ({ id: `ward-${number}-${pad(at + 1, 4)}`, polygon: ward.polygon, kind: ward.kind, ...(districtIdOf(plan.forecast.of[at]) !== undefined && { districtId: districtIdOf(plan.forecast.of[at]) as string }), growthRank: Math.min(ward.growthRank / most, 1) })),
    summary: {
      settlementId: brief.id,
      counts: { junctions: junctions.length, segments: segments.length, exits: exits.length, waters: waters.length, lots: lots.length, districtAreas: districtAreas.length, walls: walls.length, gates: walls.reduce((sum, wall) => sum + wall.gates.length, 0), places: places.length },
      outlineArea: plan.blocks.reduce((sum, block, at) => sum + (builtBlocks.has(at) ? block.area : 0), 0),
      bounds: boxOf([...lots.flatMap((lot) => lot.polygon), ...segments.flatMap((segment) => segment.points)]),
      builtArea,
      residentsPerHectare: builtArea === 0 ? 0 : city.people.length / (builtArea / 10_000),
      ringShare: ringShare(segments),
      roadsOut: exits.length,
      layoutVersion: LAYOUT_VERSION,
      generator: STAGED_GENERATOR,
      pack: { name: pack.pack.name, version: pack.pack.version },
      seed,
    },
  };
  if (options.check === false) return layout;
  const broken = checkLayout(layout, city, brief, pack);
  if (broken.length > 0) fail(`the layout breaks ${broken.length === 1 ? 'an invariant' : 'invariants'}:\n  ${broken.join('\n  ')}`);
  return layout;
}

/**
 * Each block's courtyards: the ground inside it that no lot, way or gap between houses takes, in as many pieces as
 * it falls into, each written with the lots that back onto it. A piece no lot backs onto is not a courtyard.
 */
function courtyardsOf(
  plan: TownPlan,
  rows: { inset: number; gap: number },
  lots: readonly Lot[],
  blockOfBuilding: ReadonlyMap<string, number>,
  segments: readonly Segment[],
  builtBlocks: ReadonlySet<number>,
  number: string,
): Courtyard[] {
  // Houses closer than this to a courtyard back onto it: the gap between two houses, closed from both sides.
  const closing = rows.gap / 2 + 0.05;
  const lotsOfBlock = new Map<number, Lot[]>();
  for (const lot of lots) {
    const block = blockOfBuilding.get(lot.buildingId);
    if (block !== undefined) lotsOfBlock.set(block, [...(lotsOfBlock.get(block) ?? []), lot]);
  }
  const lotIndex = new SpatialIndex<Lot>(40);
  for (const lot of lots) lotIndex.add(boxOf(lot.polygon, closing), lot);
  const wayIndex = new SpatialIndex<Segment>(40);
  for (const segment of segments) wayIndex.add(boxOf(segment.points, segment.width), segment);
  const courtyards: Courtyard[] = [];
  plan.blocks.forEach((block, at) => {
    const own = lotsOfBlock.get(at);
    if (!own || !builtBlocks.has(at)) return;
    const box = boxOf(block.polygon, 1);
    // Off the block's edge by the houses' inset, so that the gaps between houses do not lead the ground out to the street.
    const inner = grown([block.polygon], -(rows.inset + 0.05));
    // The lots made one and grown, with the holes the union leaves inside a ring of houses: those wind the other
    // way round, so taking the holes with the rings leaves the ground they enclose.
    const near = [...lotIndex.near(box)];
    const houses = grown(near.map((lot) => lot.polygon), closing);
    const taken = [...houses.rings, ...houses.holes];
    const ways = [...wayIndex.near(box)];
    taken.push(...ways.flatMap((way) => widened([way.points], way.width + 2 * closing)));
    const cut = without(inner.rings, taken);
    // A lot standing free in a courtyard leaves a hole in it, joined to the ground round it by a slit that crosses no
    // outline. A courtyard whose hole cannot be so joined is left out, as it would otherwise cover the lot.
    const pieces = cut.rings.flatMap((ring) => {
      const inside = cut.holes.filter((hole) => hole.some((corner) => pointInPolygon(corner, ring) && distanceToPolygonEdge(corner, ring) > 0.01));
      const joined = joinHoles(ring, inside);
      return joined && polygonArea(joined) > 1 ? [joined] : [];
    });
    if (pieces.length === 0) return;
    // Each lot backs onto the largest piece it is beside.
    const backing = pieces.map((): string[] => []);
    for (const lot of own) {
      let best = -1;
      pieces.forEach((piece, index) => {
        if (distancePolygonToPolyline(lot.polygon, [...piece, piece[0] as Point]) > closing + 0.1) return;
        if (best < 0 || polygonArea(piece) > polygonArea(pieces[best] as Point[])) best = index;
      });
      if (best >= 0) (backing[best] as string[]).push(lot.id);
    }
    // A passage's lane ends at its courtyard.
    const passages = plan.passages.filter((passage) => passage.block === at);
    pieces.forEach((piece, index) => {
      const lotIds = (backing[index] as string[]).sort();
      if (lotIds.length === 0) return;
      const ring = [...piece, piece[0] as Point];
      let passage: string | undefined;
      for (const { axis, rect } of passages) {
        const reach = rect.width + closing + 0.1;
        for (const way of ways) {
          if (way.kind !== 'lane') continue;
          const ends = [way.points[0] as Point, way.points[way.points.length - 1] as Point];
          if (ends.some((end) => distance(end, axis[1]) <= reach && distancePolygonToPolyline(ring, [end, end]) <= reach) && (passage === undefined || way.id < passage)) passage = way.id;
        }
      }
      courtyards.push({ id: `courtyard-${number}-${String(courtyards.length + 1).padStart(6, '0')}`, blockId: `block-${number}-${String(at + 1).padStart(6, '0')}`, polygon: piece, lotIds, ...(passage !== undefined && { passage }) });
    });
  });
  return courtyards;
}

/**
 * A ring with holes in it as one outline: each hole joined to the outline round it by the shortest slit, from a
 * corner of the hole to a corner of the outline, that crosses no edge of the outline or of any hole and runs over
 * the ground between them. Undefined if some hole cannot be joined.
 */
function joinHoles(ring: readonly Point[], holes: readonly Point[][]): Point[] | undefined {
  let out = [...ring];
  const edgesOf = (outline: readonly Point[]) => outline.map((corner, at): [Point, Point] => [outline[(at + outline.length - 1) % outline.length] as Point, corner]);
  for (let at = 0; at < holes.length; at++) {
    const hole = holes[at] as Point[];
    const blockers = [...edgesOf(out), ...holes.slice(at).flatMap(edgesOf)];
    const others = holes.slice(at);
    let best: { h: number; o: number; length: number } | undefined;
    hole.forEach((from, h) =>
      out.forEach((to, o) => {
        const length = distance(from, to);
        if (best && length >= best.length) return;
        if (blockers.some(([c, d]) => piecesCross(from, to, c, d))) return;
        const middle: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
        if (!pointInPolygon(middle, out) || others.some((other) => strictlyInside(middle, other))) return;
        best = { h, o, length };
      }),
    );
    if (!best) return undefined;
    const { h, o } = best as { h: number; o: number; length: number };
    out = [...out.slice(0, o + 1), ...hole.slice(h), ...hole.slice(0, h + 1), ...out.slice(o)];
  }
  return out;
}

const boxesMeet = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) => a.minX <= b.maxX + 1 && b.minX <= a.maxX + 1 && a.minY <= b.maxY + 1 && b.minY <= a.maxY + 1;

/** Where two straight pieces cross, or nothing. */
function meetOf(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  const denominator = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(denominator) < 1e-12) return undefined;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denominator;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denominator;
  return t > 0 && t < 1 && u >= 0 && u <= 1 ? [c[0] + (d[0] - c[0]) * u, c[1] + (d[1] - c[1]) * u] : undefined;
}

function pointAt(line: readonly Point[], along: number): Point {
  let walked = 0;
  for (let at = 1; at < line.length; at++) {
    const [a, b] = [line[at - 1] as Point, line[at] as Point];
    const length = distance(a, b);
    if (along <= walked + length || at === line.length - 1) {
      const share = length === 0 ? 0 : Math.min(Math.max((along - walked) / length, 0), 1);
      return [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share];
    }
    walked += length;
  }
  return line[0] as Point;
}

/**
 * Each district's ground: the tiles of the blocks it was drawn over (`districting.ts`), and the plaza's and the
 * castle's for the district holding most of the blocks beside each. A block that lends houses to a neighbour stays its owner's
 * ground, so those lots stand in a neighbour's ground, as does a landmark whose block ended in another district's;
 * the census counts them. The tiles of one district are let overlap a
 * little, which joins them; those of different districts keep a finger's breadth apart, so that no ground is
 * counted twice. Where a bridge has one district's ground at each end, the two are joined by a bridge link; nothing
 * is drawn across it.
 */
function districtGround(plan: TownPlan, city: City, lots: readonly Lot[]): { areas: DistrictArea[]; joins: Array<{ bridge: number; a: string; b: string }> } {
  const blocks = plan.blocks.length;
  const specials = plan.wards.map((ward, index) => ({ ward, index })).filter(({ ward }) => ward.kind !== 'ordinary');
  const idOf = (of: number | undefined) => (of === undefined ? undefined : plan.districts[of]?.id);
  // The plaza's and the castle's ground goes to the district holding most of the blocks beside it, whatever district
  // the landmark there belongs to.
  const besideMost = (tile: number) => {
    const counts = new Map<number, number>();
    for (const other of plan.tilesBeside[tile] ?? []) {
      const of = other < blocks ? plan.drawn.blockDistrict[other] : undefined;
      if (of !== undefined) counts.set(of, (counts.get(of) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  };
  const owner: Array<string | undefined> = plan.tiles.map((_, tile) => idOf(tile < blocks ? plan.drawn.blockDistrict[tile] : besideMost(tile)));
  // A block no district holds, open country among them, is nobody's ground and is not drawn.
  /** Each tile with the district it belongs to. */
  const entries: Array<{ tile: number; district: string; rings: Point[][]; holes: Point[][] }> = [];
  plan.tiles.forEach((rings, tile) => {
    const district = owner[tile];
    if (district === undefined || rings.length === 0) return;
    entries.push({ tile, district, rings: rings as Point[][], holes: [] });
  });
  const boxes = entries.map((entry) => boxOf(entry.rings.flat(), 0.2));
  const near = new SpatialIndex<number>(60);
  boxes.forEach((box, at) => near.add(box, at));
  const pieces = new Map<string, Point[][]>();
  entries.forEach(({ tile, district, rings, holes }, at) => {
    const box = boxes[at] as ReturnType<typeof boxOf>;
    // Grown with their holes, which shrink as they grow: a part round another district's houses keeps them out.
    const foreign = [...near.near(box)]
      .filter((other) => other !== at && (entries[other] as (typeof entries)[number]).district !== district)
      .sort((x, y) => x - y)
      .flatMap((other) => {
        const shape = grown((entries[other] as (typeof entries)[number]).rings, 0.05, false, (entries[other] as (typeof entries)[number]).holes);
        return [...shape.rings, ...shape.holes];
      });
    const keep = tile < blocks ? (plan.blocks[tile] as TownPlan['blocks'][number]).polygon : (specials[tile - blocks] as (typeof specials)[number]).ward.polygon;
    const ownGrown = grown(rings, 0.03, false, holes);
    const cut = without([...ownGrown.rings, ...ownGrown.holes], foreign);
    const plain = plainly(cut.rings, cut.holes, keep).filter((ring) => polygonArea(ring) > 0.5);
    if (!pieces.has(district)) pieces.set(district, []);
    pieces.get(district)?.push(...plain);
  });
  // A piece of a district's ground that holds none of its lots is a leftover sliver of a divided tile or an empty
  // block, and is not drawn.
  {
    for (const [district, polygons] of pieces) {
      const middles = lots.filter((lot) => lot.districtId === district).map((lot) => polygonCentroid(lot.polygon));
      const group = polygons.map((_, at) => at);
      const find = (at: number): number => (group[at] === at ? at : (group[at] = find(group[at] as number)));
      polygons.forEach((polygon, at) => {
        for (let other = at + 1; other < polygons.length; other++) if (find(other) !== find(at) && (polygonsOverlap(polygon, polygons[other] as Point[]) || sharedBoundaryLength(polygon, polygons[other] as Point[]) > 1e-6)) group[find(other)] = find(at);
      });
      const holding = new Set(polygons.flatMap((polygon, at) => (middles.some((middle) => pointInPolygon(middle, polygon)) ? [find(at)] : [])));
      pieces.set(district, polygons.filter((_, at) => holding.has(find(at))));
    }
  }
  const areas: DistrictArea[] = [];
  for (const district of city.districts) {
    const polygons = pieces.get(district.id) ?? [];
    if (polygons.length === 0) continue;
    const largest = polygons.reduce((best, polygon) => (polygonArea(polygon) > polygonArea(best) ? polygon : best));
    const middle = polygonCentroid(largest);
    areas.push({ districtId: district.id, polygons, labelPoint: pointInPolygon(middle, largest) ? middle : interiorPoint(largest) });
  }
  const joins = plan.links.flatMap((link) => (owner[link.a] === undefined || owner[link.b] === undefined ? [] : [{ bridge: link.bridge, a: owner[link.a] as string, b: owner[link.b] as string }]));
  return { areas, joins };
}
