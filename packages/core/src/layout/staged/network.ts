/**
 * The walking network of the staged generator, built from the same geometry
 * as the town and not traced from a drawing.
 *
 * Every way has a centre line: a highway's own line, a main street's chain
 * of mesh edges, a ward border's mesh edge, the line of the cut that parted
 * two blocks, a courtyard passage's axis, a ring round the plaza and the
 * castle, the quay. The lines are trimmed where they would enter water or
 * cross the wall away from a gate, joined where they meet, and kept where a
 * building fronts them or they hold the network together.
 */
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { offsetLine } from '../cutting.ts';
import { SpatialIndex, bearingDifference, boxOf, distance, distancePolygonToPolyline, distanceToPolygonEdge, distanceToPolyline, exactBearing, pointAlongPolyline, pointInPolygon, polylineLength, projectOnPolyline, slicePolyline } from '../geometry.ts';
import { cellPolygon } from './mesh.ts';
import type { TownPlan } from './plan.ts';
import { grown } from './shapes.ts';

export type WayKind = 'arterial' | 'street' | 'lane' | 'bridge';

export interface Way {
  points: Point[];
  kind: WayKind;
  width: number;
  /** The brief's route it carries, by its place in the brief. */
  route?: number;
  /** Whether it may pass through the wall: a highway always, a main street or lane only where it was given a gate. */
  through: boolean;
}

export interface NetNode {
  point: Point;
  kind: 'crossing' | 'dead-end' | 'bridge-end' | 'exit' | 'gate';
  /** The brief's route that leaves here, for an exit, and whether it is a sea route's exit at the quay. */
  route?: number;
  atQuay?: boolean;
  /** Whether a highway passes through this gate. */
  arterial?: boolean;
}

export interface NetEdge {
  from: number;
  to: number;
  points: Point[];
  kind: WayKind;
  width: number;
  route?: number;
}

export interface Network {
  nodes: NetNode[];
  edges: NetEdge[];
  /** For each bridge, the end of its way on the centre's bank. */
  bridgeHeads: Map<number, Point>;
  /** What could not be done, for the report. */
  notes: string[];
}

export interface NetworkInput {
  plan: TownPlan;
  settings: StagedSettings;
  /** The brief's routes: their bearings and which are sea routes. */
  routes: ReadonlyArray<{ bearing: number; sea: boolean }>;
  /** Which blocks and wards have a building: ways are laid only where the town is built. */
  builtBlocks: ReadonlySet<number>;
  wallWidth: number;
}

/** How finely a line is walked when it is trimmed, in metres, and the least length of way worth keeping. */
const STEP = 2;
const LEAST = 3;
/** How far a lane's end is carried on to meet the next way, in metres. */
const REACH = 13;
/** Points nearer than this are one junction, in metres. */
const SNAP = 0.05;
const HAIR = 0.2;
/** How far a bridge's way runs on past each end of the bridge, in metres. */
const APPROACH = 3;
/** How near a block a lane along the wall or the water must pass to be laid, in metres. */
const BESIDE = 8;
const BRIDGEHEAD = 19;
/** How far a way that was cut short is carried on to meet the way it stopped at, in metres. */
const LAST_STEP = 5;

const key = (point: Point) => `${Math.round(point[0] / SNAP)}:${Math.round(point[1] / SNAP)}`;

/** The stretches of a line whose points pass a test, walked in steps. */
function stretches(points: readonly Point[], ok: (point: Point) => boolean): Point[][] {
  const length = polylineLength(points);
  if (length === 0) return [];
  const count = Math.max(1, Math.ceil(length / STEP));
  const out: Point[][] = [];
  let from: number | undefined;
  for (let at = 0; at <= count; at++) {
    const along = (length * at) / count;
    const good = ok(pointAlongPolyline(points, along));
    if (good && from === undefined) from = along;
    if ((!good || at === count) && from !== undefined) {
      const to = good ? along : (length * (at - 1)) / count;
      // A way that passes whole is kept however short: it may be the last step of a road to the quay.
      if (from === 0 && to === length) out.push([...points]);
      else if (to - from >= LEAST) out.push(slicePolyline(points, from, to));
      from = undefined;
    }
  }
  return out;
}

/** A line parted wherever a test changes its answer along it: the lengths in order, each with the answer, meeting end to end. */
function parted(points: readonly Point[], test: (point: Point) => boolean): Array<{ points: Point[]; pass: boolean }> {
  const length = polylineLength(points);
  const count = Math.max(1, Math.ceil(length / STEP));
  const marks: number[] = [0];
  const answers: boolean[] = [test(pointAlongPolyline(points, 0))];
  for (let at = 1; at <= count; at++) {
    const along = (length * at) / count;
    const answer = test(pointAlongPolyline(points, along));
    if (answer === answers[answers.length - 1]) continue;
    let [low, high] = [(length * (at - 1)) / count, along];
    while (high - low > SNAP) {
      const middle = (low + high) / 2;
      if (test(pointAlongPolyline(points, middle)) === answer) high = middle;
      else low = middle;
    }
    marks.push(high);
    answers.push(answer);
  }
  marks.push(length);
  return answers.map((pass, at) => ({ points: slicePolyline(points, marks[at] as number, marks[at + 1] as number), pass })).filter((part) => polylineLength(part.points) > SNAP);
}

/** Where two straight pieces cross: how far along each, as shares, or nothing. */
function crossing(a: Point, b: Point, c: Point, d: Point): [number, number] | undefined {
  const denominator = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(denominator) < 1e-12) return undefined;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denominator;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : undefined;
}

/**
 * The ward borders let through the wall besides the highways, each to be a gate: those that cross the wall
 * nearest the end of a main street, apart from each other. Each is a pair of mesh corners.
 */
export function gateLanes(plan: Pick<TownPlan, 'mesh' | 'streets' | 'wall'>, wanted: number): Array<[number, number]> {
  if (!plan.wall || wanted <= 0) return [];
  const walls = plan.wall.parts.map((part) => (part.closed ? [...part.points, part.points[0] as Point] : part.points));
  const special = new Set(plan.mesh.cells.filter((cell) => cell.special).map((cell) => cell.seed));
  const ends = plan.streets.map((street) => street.points[street.points.length - 1] as Point);
  const crossers: Array<{ pair: [number, number]; line: [Point, Point]; away: number }> = [];
  plan.mesh.edges.forEach((edge) => {
    if (plan.mesh.onEdge[edge.a] || plan.mesh.onEdge[edge.b] || edge.cells.some((cell) => special.has(cell))) return;
    const line: [Point, Point] = [plan.mesh.corners[edge.a] as Point, plan.mesh.corners[edge.b] as Point];
    // Once, and squarely enough that the lane does not run along the wall.
    const hits = walls.reduce((sum, wall) => sum + wall.filter((point, at) => at > 0 && crossing(line[0], line[1], wall[at - 1] as Point, point)).length, 0);
    if (hits !== 1) return;
    crossers.push({ pair: [edge.a, edge.b], line, away: Math.min(...ends.map((end) => distanceToPolyline(end, line)), 1e9) });
  });
  crossers.sort((a, b) => a.away - b.away || a.pair[0] - b.pair[0] || a.pair[1] - b.pair[1]);
  const chosen: typeof crossers = [];
  for (const crosser of crossers) {
    if (chosen.length >= wanted) break;
    if (chosen.some((other) => distance(other.line[0], crosser.line[0]) < 2 * plan.mesh.spacing)) continue;
    chosen.push(crosser);
  }
  return chosen.map((crosser) => crosser.pair);
}

export function buildNetwork({ plan, settings, routes, builtBlocks, wallWidth }: NetworkInput): Network {
  // A roadway is a hair narrower than the ground left for it, so that a block that stands exactly at its edge
  // does not count as standing in it.
  const widths = { ...settings.widths, lane: settings.widths.lane - HAIR };
  const notes: string[] = [];
  const corridor = settings.widths.highway + 2 * settings.wards.highwayVerge + settings.widths.wardBorder - HAIR;
  const walls = plan.wall ? plan.wall.parts.map((part) => (part.closed ? [...part.points, part.points[0] as Point] : part.points)) : [];
  const specials = [plan.plaza, plan.castle].filter((ward): ward is NonNullable<TownPlan['plaza']> => ward !== undefined);
  const ringOffset = widths.wardBorder / 2;
  const rings = specials.map((ward) => grown([ward.polygon], ringOffset).rings[0] ?? ward.polygon);
  const dry = (point: Point, margin: number) => (!plan.river || plan.river.gap(point) >= margin) && (!plan.coast || plan.coast.gap(point) >= margin);
  const offWall = (point: Point, margin: number) => walls.every((line) => distanceToPolyline(point, line) >= margin);
  const offSpecials = (point: Point, margin: number) => specials.every((ward) => !pointInPolygon(point, ward.polygon) && distanceToPolygonEdge(point, ward.polygon) >= margin);

  // ---- How far out the town is built, and where each route leaves -------------------------------------------------
  let builtRadius = 0;
  plan.houses.forEach((house, index) => {
    if (plan.selection.district[index] !== undefined) for (const corner of house.outline) builtRadius = Math.max(builtRadius, Math.hypot(corner[0], corner[1]));
  });
  for (const landmark of plan.landmarks) for (const corner of landmark.outline) builtRadius = Math.max(builtRadius, Math.hypot(corner[0], corner[1]));
  const edgeOfTown = Math.max(builtRadius * 1.1 + 30, plan.radius);

  const ways: Way[] = [];
  const exits: Array<{ point: Point; route: number; atQuay: boolean }> = [];
  const bridgeEnds: Point[] = [];
  const bridgeHeads = new Map<number, Point>();

  // ---- Highways -----------------------------------------------------------------------------------------------------
  /** A highway from the centre outward is cut where it has left the town and lies on its route's bearing. */
  const leaves = (points: Point[], route: number | undefined): Point[] => {
    const length = polylineLength(points);
    for (let along = 0; along <= length; along += STEP) {
      const point = pointAlongPolyline(points, along);
      if (Math.hypot(point[0], point[1]) < edgeOfTown) continue;
      if (route !== undefined && bearingDifference(exactBearing([0, 0], point), (routes[route] as { bearing: number }).bearing) > 10) continue;
      return slicePolyline(points, 0, along);
    }
    return points;
  };
  plan.highways.forEach((highway) => {
    // In stretches between its bridges, each from the centre's side outward.
    const stretch: Array<{ points: Point[]; bridge: boolean }> = [];
    const spans = highway.bridges.map((index) => plan.bridges[index] as TownPlan['bridges'][number]).map((bridge) => ({ bridge, at: projectOnPolyline(highway.points, bridge.a).along, to: projectOnPolyline(highway.points, bridge.b).along })).sort((a, b) => Math.min(a.at, a.to) - Math.min(b.at, b.to));
    let done = 0;
    const whole = polylineLength(highway.points);
    for (const span of spans) {
      // The bridge's way begins a little before the bank and ends a little after: the road beside it is too wide
      // to come so near the water.
      const [low, high] = [Math.max(Math.min(span.at, span.to) - APPROACH, done), Math.min(Math.max(span.at, span.to) + APPROACH, whole)];
      if (low - done > LEAST) stretch.push({ points: slicePolyline(highway.points, done, low), bridge: false });
      const over = slicePolyline(highway.points, low, high);
      stretch.push({ points: over, bridge: true });
      bridgeEnds.push(over[0] as Point, over[over.length - 1] as Point);
      bridgeHeads.set(plan.bridges.indexOf(span.bridge), span.at <= span.to ? (over[0] as Point) : (over[over.length - 1] as Point));
      done = high;
    }
    if (whole - done > LEAST) stretch.push({ points: slicePolyline(highway.points, done, whole), bridge: false });
    // Which route each end carries: a road through the centre carries one each way.
    const through = highway.kind === 'route' && highway.routes.length === 2;
    const centreAt = through ? projectOnPolyline(highway.points, [0, 0]).along : 0;
    let walked = 0;
    for (const part of stretch) {
      const length = polylineLength(part.points);
      const middle = walked + length / 2;
      walked += length;
      if (part.bridge) {
        ways.push({ points: part.points, kind: 'bridge', width: widths.highway, through: true });
        continue;
      }
      const route = highway.kind === 'quay-road' ? undefined : through ? (middle < centreAt ? highway.routes[0] : highway.routes[1]) : highway.routes[0];
      // A part that holds the centre is two ways out from it.
      const splits = through && walked - length < centreAt && walked > centreAt ? [slicePolyline(part.points, 0, centreAt - (walked - length)).reverse(), slicePolyline(part.points, centreAt - (walked - length), length)] : [part.points];
      splits.forEach((points, side) => {
        const carried = through && splits.length === 2 ? highway.routes[side] : route;
        const last = part === stretch[stretch.length - 1] || (through && part === stretch[0] && side === 0 && splits.length === 2) || (through && part === stretch[0] && splits.length === 1 && middle < centreAt);
        const outward = splits.length === 1 && through && middle < centreAt ? [...points].reverse() : points;
        const cut = last && highway.kind !== 'branch' && highway.kind !== 'bridge-road' && highway.kind !== 'quay-road' ? leaves(outward, carried) : outward;
        if (polylineLength(cut) < LEAST) return;
        // The road down to the quay is a street: it comes nearer the water than a highway's ground may.
        if (highway.kind === 'quay-road') {
          // The road down to the quay: as wide as any highway's ground until it nears the water, then a street.
          for (const part of parted(cut, (point) => dry(point, corridor / 2 + 0.5))) ways.push(part.pass ? { points: part.points, kind: 'arterial', width: corridor, through: true } : { points: part.points, kind: 'street', width: widths.mainStreet, through: true });
        } else ways.push({ points: cut, kind: 'arterial', width: corridor, ...(carried !== undefined && { route: carried }), through: true });
        if (last && carried !== undefined && highway.kind !== 'quay-road' && highway.kind !== 'branch' && highway.kind !== 'bridge-road') exits.push({ point: cut[cut.length - 1] as Point, route: carried, atQuay: false });
      });
    }
  });

  // ---- The quay, and the sea routes' exits along it -----------------------------------------------------------------
  if (plan.harbour) {
    const quay = plan.harbour.quay;
    ways.push({ points: quay, kind: 'street', width: Math.min(plan.harbour.width, 2 * settings.harbour.quay.inset - 1), through: true });
    const length = polylineLength(quay);
    const places = [0, 1, 0.5, 0.25, 0.75, 0.125, 0.875, 0.375, 0.625];
    const sea = plan.exits.filter((exit) => exit.atQuay);
    // The first at the end its route lies toward, the rest spread along the quay, so that each has a place.
    const used = new Set<number>();
    for (const exit of sea) {
      const nearer = distance(exit.point, quay[0] as Point) <= distance(exit.point, quay[quay.length - 1] as Point) ? 0 : 1;
      const share = [nearer, ...places].find((place) => !used.has(place)) ?? nearer;
      used.add(share);
      exits.push({ point: pointAlongPolyline(quay, share * length), route: exit.route, atQuay: true });
    }
  }
  // A route with no road of its own, as a sea route with no water to land at, leaves by a road on its bearing.
  routes.forEach((route, index) => {
    if (exits.some((exit) => exit.route === index)) return;
    const way: Point = [Math.sin((route.bearing * Math.PI) / 180), -Math.cos((route.bearing * Math.PI) / 180)];
    const points: Point[] = [[0, 0], [way[0] * edgeOfTown, way[1] * edgeOfTown]];
    ways.push({ points, kind: 'arterial', width: corridor, route: index, through: true });
    exits.push({ point: points[1] as Point, route: index, atQuay: false });
    notes.push(`route ${index} has no road in the plan and leaves by a straight road on its bearing`);
  });

  // ---- Main streets, ward borders, block lanes, passages, rings -----------------------------------------------------
  // The far leg of a bridge road was laid with the highways, and passes the wall as they do.
  for (const street of plan.streets) ways.push({ points: street.points, kind: 'street', width: widths.mainStreet, through: street.corners.length === 0 });
  const builtWards = new Set([...builtBlocks].map((block) => (plan.blocks[block] as TownPlan['blocks'][number]).ward));
  const builtCells = new Set([...builtWards].map((ward) => (plan.wards[ward] as TownPlan['wards'][number]).cell));
  const special = new Set(plan.mesh.cells.filter((cell) => cell.special).map((cell) => cell.seed));
  const onStreet = new Set(plan.streets.flatMap((street) => street.corners.slice(1).map((corner, at) => `${Math.min(corner, street.corners[at] as number)}:${Math.max(corner, street.corners[at] as number)}`)));
  // A lane is laid only where a block with a building stands beside it.
  const builtBoxes = new SpatialIndex<number>(60);
  for (const block of builtBlocks) builtBoxes.add(boxOf((plan.blocks[block] as TownPlan['blocks'][number]).polygon, BESIDE), block);
  const besideHouses = (point: Point, within = BESIDE) => {
    for (const block of builtBoxes.near({ minX: point[0], minY: point[1], maxX: point[0], maxY: point[1] })) {
      const polygon = (plan.blocks[block] as TownPlan['blocks'][number]).polygon;
      if (pointInPolygon(point, polygon) || distanceToPolygonEdge(point, polygon) <= within) return true;
    }
    return false;
  };
  const fronted = (line: readonly Point[], within: number) => [0, 0.25, 0.5, 0.75, 1].some((share) => besideHouses(pointAlongPolyline(line, share * polylineLength(line)), within));
  const gated = new Set(plan.gateLanes.map(([a, b]) => `${a}:${b}`));
  for (const edge of plan.mesh.edges) {
    if (plan.mesh.onEdge[edge.a] || plan.mesh.onEdge[edge.b] || onStreet.has(`${edge.a}:${edge.b}`)) continue;
    const gate = gated.has(`${edge.a}:${edge.b}`);
    // A border of the plaza's or the castle's cell is laid too: where the cell is larger than the ward in it,
    // the border is a way between houses, and where it is the ward's own edge it is trimmed away below.
    if (!gate && !edge.cells.some((cell) => builtCells.has(cell) || special.has(cell))) continue;
    if (!gate && !fronted([plan.mesh.corners[edge.a] as Point, plan.mesh.corners[edge.b] as Point], settings.widths.wardBorder / 2 + settings.wards.fromWall)) continue;
    // A ward border given a gate is a street through the wall.
    ways.push({ points: [plan.mesh.corners[edge.a] as Point, plan.mesh.corners[edge.b] as Point], kind: gate ? 'street' : 'lane', width: gate ? Math.min(widths.mainStreet, settings.widths.wardBorder - HAIR) : widths.lane, through: gate });
  }
  // Lanes along the wall, inside and out, and along the bank and the shore, wherever houses stand beside them:
  // a house that faces the wall or the water has a way at its door like any other.
  const along: Point[][] = [];
  // As far from the wall as the houses allow, so that a gatehouse has room between the lane and the wall.
  const back = settings.wards.fromWall + settings.widths.wardBorder / 2 - settings.widths.lane / 2 - 0.15;
  for (const part of plan.wall?.parts ?? []) {
    // A wall that runs all the way round has a ring within and a ring without.
    if (part.closed) for (const by of [back, -back]) for (const ring of grown([part.points], by, true).rings) along.push([...ring, ring[0] as Point]);
    else for (const by of [back, -back]) along.push(offsetLine(part.points, by));
  }
  const shoreBack = settings.wards.fromWater;
  if (plan.river) for (const by of [plan.river.width / 2 + shoreBack, -(plan.river.width / 2 + shoreBack)]) along.push(offsetLine(plan.river.line, by));
  if (plan.coast) for (const by of [shoreBack, -shoreBack]) along.push(offsetLine(plan.coast.shore, by));
  // Not at a bridge's head, where a gatehouse may stand.
  const offBridges = (point: Point) => plan.bridges.every((bridge) => distance(point, bridge.a) > BRIDGEHEAD && distance(point, bridge.b) > BRIDGEHEAD);
  for (const line of along) for (const piece of stretches(line, (point) => besideHouses(point) && offBridges(point))) ways.push({ points: piece, kind: 'lane', width: widths.lane, through: false });
  rings.forEach((ring) => ways.push({ points: [...ring, ring[0] as Point], kind: 'lane', width: widths.lane, through: false }));
  const houseBoxes = new SpatialIndex<Point[]>(40);
  plan.houses.forEach((house, index) => plan.selection.district[index] !== undefined && houseBoxes.add(boxOf(house.outline, 3), house.outline));
  for (const landmark of plan.landmarks) if (landmark.block !== undefined) houseBoxes.add(boxOf((plan.blocks[landmark.block] as TownPlan['blocks'][number]).polygon, 3), (plan.blocks[landmark.block] as TownPlan['blocks'][number]).polygon);
  const tooNearHouses = (from: Point, to: Point, half: number) => {
    for (const outline of houseBoxes.near(boxOf([from, to], half))) if (distancePolygonToPolyline(outline, [from, to]) < half + 0.02) return true;
    return false;
  };
  const lanes: Array<Way & { ends?: readonly number[] }> = [];
  for (const lane of plan.lanes) if (builtWards.has(lane.ward) && fronted(lane.line, settings.widths.lane / 2 + 1)) lanes.push({ points: [lane.line[0], lane.line[1]], kind: 'lane', width: widths.lane, through: false });
  for (const passage of plan.passages) {
    if (!builtBlocks.has(passage.block)) continue;
    // Its way stops half its width short of the courtyard end, where a house of another row may stand close by.
    const width = Math.min(widths.lane, settings.rows.passage.width);
    const [front, inner] = passage.axis;
    const depth = distance(front, inner);
    if (depth <= width / 2 + LEAST) continue;
    const share = (depth - width / 2 - 0.05) / depth;
    lanes.push({ points: [[front[0] + (inner[0] - front[0]) * share, front[1] + (inner[1] - front[1]) * share], front], kind: 'lane', width, through: false, ends: [1] });
  }

  // ---- Trimmed: out of the water, off the wall but at a gate, out of the plaza and the castle -----------------------
  const trimmed: Way[] = [];
  for (const way of ways) {
    const half = way.width / 2;
    if (way.kind === 'bridge') {
      trimmed.push(way);
      continue;
    }
    const narrowNear = half > ringOffset - 0.1 && plan.plaza ? plan.plaza.polygon : undefined;
    const clear = (point: Point) => dry(point, Math.min(half, widths.lane) + 0.3) && (way.through || offWall(point, wallWidth / 2 + half + 0.5)) && offSpecials(point, way.kind === 'lane' && rings.some((ring) => way.points[0] === ring[0]) ? 0 : ringOffset - 0.01);
    for (const piece of stretches(way.points, clear)) {
      if (!narrowNear) {
        trimmed.push({ ...way, points: piece });
        continue;
      }
      // Beside the plaza a highway is only as wide as the ground between the plaza and the houses.
      const near = (point: Point) => distanceToPolygonEdge(point, narrowNear) < half + 0.5;
      for (const part of parted(piece, near)) trimmed.push(part.pass ? { ...way, points: part.points, width: 2 * ringOffset - 0.2 } : { ...way, points: part.points });
    }
  }

  // ---- Lanes carried on to meet the next way ------------------------------------------------------------------------
  // A way cut short, as a highway is at the plaza's ring, is carried the last step on to the way it stopped at.
  const sameEnd = new Set(ways.flatMap((way) => [key(way.points[0] as Point), key(way.points[way.points.length - 1] as Point)]));
  // Nor an end where two lengths of one way meet.
  const ends = new Map<string, number>();
  for (const way of trimmed) for (const tip of [way.points[0] as Point, way.points[way.points.length - 1] as Point]) ends.set(key(tip), (ends.get(key(tip)) ?? 0) + 1);
  for (const [name, count] of ends) if (count > 1) sameEnd.add(name);
  const early = trimmed.map((way) => way);
  for (const way of early) {
    if (way.kind === 'bridge') continue;
    for (const end of [0, 1] as const) {
      const [tip, before] = end === 0 ? [way.points[0] as Point, way.points[1] as Point] : [way.points[way.points.length - 1] as Point, way.points[way.points.length - 2] as Point];
      // Nor an end at a bridge's head, where the road gives way to the bridge.
      if (sameEnd.has(key(tip)) || bridgeEnds.some((end) => distance(end, tip) < 0.5)) continue;
      const length = distance(before, tip) || 1;
      const toward: Point = [(tip[0] - before[0]) / length, (tip[1] - before[1]) / length];
      let least: number | undefined;
      for (const other of early) {
        if (other === way || other.kind === 'bridge') continue;
        for (let at = 1; at < other.points.length; at++) {
          const hit = crossing(tip, [tip[0] + toward[0] * LAST_STEP, tip[1] + toward[1] * LAST_STEP], other.points[at - 1] as Point, other.points[at] as Point);
          if (hit && (least === undefined || hit[0] * LAST_STEP < least)) least = hit[0] * LAST_STEP;
        }
      }
      if (least === undefined || least < SNAP) continue;
      const reached: Point = [tip[0] + toward[0] * least, tip[1] + toward[1] * least];
      if (end === 0) way.points = [reached, ...way.points];
      else way.points = [...way.points, reached];
    }
  }
  const boxed = (way: Way) => ({ way, minX: Math.min(...way.points.map((p) => p[0])), maxX: Math.max(...way.points.map((p) => p[0])), minY: Math.min(...way.points.map((p) => p[1])), maxY: Math.max(...way.points.map((p) => p[1])) });
  const known = trimmed.map(boxed);
  /** How far a ray goes before it meets a way, and no further than the reach. */
  const meets = (from: Point, toward: Point, reach: number): number | undefined => {
    const end: Point = [from[0] + toward[0] * reach, from[1] + toward[1] * reach];
    let least: number | undefined;
    for (const { way, minX, maxX, minY, maxY } of known) {
      if (Math.max(from[0], end[0]) < minX || Math.min(from[0], end[0]) > maxX || Math.max(from[1], end[1]) < minY || Math.min(from[1], end[1]) > maxY) continue;
      for (let at = 1; at < way.points.length; at++) {
        const hit = crossing(from, end, way.points[at - 1] as Point, way.points[at] as Point);
        if (hit && (least === undefined || hit[0] * reach < least)) least = hit[0] * reach;
      }
    }
    return least;
  };
  for (const lane of lanes) {
    const half = lane.width / 2;
    const clear = (point: Point) => dry(point, half + 0.3) && offWall(point, wallWidth / 2 + half + 0.5) && offSpecials(point, ringOffset - 0.01);
    for (const piece of stretches(lane.points, clear)) {
      const points = [...piece];
      // A passage is carried on at its street end only: its other end is the courtyard.
      for (const end of lane.ends ?? [0, 1]) {
        const [tip, before] = end === 0 ? [points[0] as Point, points[1] as Point] : [points[points.length - 1] as Point, points[points.length - 2] as Point];
        const length = distance(before, tip) || 1;
        const toward: Point = [(tip[0] - before[0]) / length, (tip[1] - before[1]) / length];
        const far = meets(tip, toward, REACH);
        if (far === undefined) continue;
        const reached: Point = [tip[0] + toward[0] * far, tip[1] + toward[1] * far];
        // Never past a house's wall, nor through water or the wall, to get there.
        if (tooNearHouses(tip, reached, half)) continue;
        if (!stretches([tip, reached], clear).some((run) => polylineLength(run) >= far - STEP) && far > LEAST) continue;
        if (end === 0) points.unshift(reached);
        else points.push(reached);
      }
      // A lane laid may be the way a later lane meets.
      const laid: Way = { points, kind: lane.kind, width: lane.width, through: lane.through };
      trimmed.push(laid);
      known.push(boxed(laid));
    }
  }

  // ---- Joined: every way cut where it meets another, at the wall, and at an exit ------------------------------------
  const cuts: number[][] = trimmed.map(() => []);
  const alongOf = (way: Way, piece: number, share: number) => {
    let along = 0;
    for (let at = 1; at < piece; at++) along += distance(way.points[at - 1] as Point, way.points[at] as Point);
    return along + share * distance(way.points[piece - 1] as Point, way.points[piece] as Point);
  };
  for (let i = 0; i < known.length; i++) {
    const a = known[i] as (typeof known)[number];
    for (let j = i + 1; j < known.length; j++) {
      const b = known[j] as (typeof known)[number];
      if (a.maxX < b.minX - SNAP || b.maxX < a.minX - SNAP || a.maxY < b.minY - SNAP || b.maxY < a.minY - SNAP) continue;
      for (let p = 1; p < a.way.points.length; p++) {
        for (let q = 1; q < b.way.points.length; q++) {
          const hit = crossing(a.way.points[p - 1] as Point, a.way.points[p] as Point, b.way.points[q - 1] as Point, b.way.points[q] as Point);
          if (!hit) continue;
          (cuts[i] as number[]).push(alongOf(a.way, p, hit[0]));
          (cuts[j] as number[]).push(alongOf(b.way, q, hit[1]));
        }
      }
      // An end that rests on the other way, without crossing it.
      for (const [one, other, into] of [[a.way, b.way, j], [b.way, a.way, i]] as const) {
        for (const tip of [one.points[0] as Point, one.points[one.points.length - 1] as Point]) {
          const found = projectOnPolyline(other.points, tip);
          if (found.distance <= SNAP) (cuts[into] as number[]).push(found.along);
        }
      }
    }
  }
  const gateAt = new Map<string, boolean>();
  const gatePoints = new Map<string, Point>();
  trimmed.forEach((way, index) => {
    if (!way.through) return;
    for (const line of walls) {
      for (let p = 1; p < way.points.length; p++) {
        for (let q = 1; q < line.length; q++) {
          const hit = crossing(way.points[p - 1] as Point, way.points[p] as Point, line[q - 1] as Point, line[q] as Point);
          if (!hit) continue;
          const along = alongOf(way, p, hit[0]);
          (cuts[index] as number[]).push(along);
          // The gate stands on the wall's own line.
          const a = line[q - 1] as Point;
          const b = line[q] as Point;
          const point: Point = [a[0] + (b[0] - a[0]) * hit[1], a[1] + (b[1] - a[1]) * hit[1]];
          gateAt.set(`${index}:${along.toFixed(3)}`, way.kind === 'arterial');
          gatePoints.set(`${index}:${along.toFixed(3)}`, point);
        }
      }
    }
  });
  for (const exit of exits) {
    trimmed.forEach((way, index) => {
      const found = projectOnPolyline(way.points, exit.point);
      if (found.distance <= SNAP) (cuts[index] as number[]).push(found.along);
    });
  }

  const nodes: NetNode[] = [];
  const nodeOf = new Map<string, number>();
  const node = (point: Point): number => {
    const name = key(point);
    let index = nodeOf.get(name);
    if (index === undefined) {
      index = nodes.length;
      nodes.push({ point: [point[0], point[1]], kind: 'crossing' });
      nodeOf.set(name, index);
    }
    return index;
  };
  const edges: NetEdge[] = [];
  trimmed.forEach((way, index) => {
    const length = polylineLength(way.points);
    const marks = [...new Set([0, ...(cuts[index] as number[]).filter((along) => along > SNAP && along < length - SNAP).map((along) => Math.round(along * 1000) / 1000), length])].sort((a, b) => a - b);
    const places = marks.filter((along, at) => at === 0 || along - (marks[at - 1] as number) > SNAP);
    for (let at = 1; at < places.length; at++) {
      const [low, high] = [places[at - 1] as number, places[at] as number];
      const points = slicePolyline(way.points, low, high);
      // Ends at a gate stand exactly on the wall.
      for (const [along, end] of [[low, 0], [high, points.length - 1]] as const) {
        const gate = gatePoints.get(`${index}:${along.toFixed(3)}`);
        if (gate) points[end] = gate;
      }
      const from = node(points[0] as Point);
      const to = node(points[points.length - 1] as Point);
      if (from === to) continue;
      points[0] = (nodes[from] as NetNode).point;
      points[points.length - 1] = (nodes[to] as NetNode).point;
      for (const [along, end] of [[low, from], [high, to]] as const) {
        const gate = gateAt.get(`${index}:${along.toFixed(3)}`);
        if (gate === undefined) continue;
        const at = nodes[end] as NetNode;
        at.kind = 'gate';
        at.arterial = (at.arterial ?? false) || gate;
      }
      edges.push({ from, to, points, kind: way.kind, width: way.width, ...(way.route !== undefined && { route: way.route }) });
    }
  });
  for (const end of bridgeEnds) {
    const index = nodeOf.get(key(end));
    if (index !== undefined && (nodes[index] as NetNode).kind === 'crossing') (nodes[index] as NetNode).kind = 'bridge-end';
  }
  for (const exit of exits) {
    const index = nodeOf.get(key(exit.point));
    if (index === undefined) {
      notes.push(`the exit for route ${exit.route} is on no way`);
      continue;
    }
    const at = nodes[index] as NetNode;
    if (at.kind === 'exit') {
      notes.push(`routes ${at.route} and ${exit.route} leave at one place`);
      continue;
    }
    Object.assign(at, { kind: 'exit', route: exit.route, atQuay: exit.atQuay });
  }
  return { nodes, edges, bridgeHeads, notes };
}


/** The cells of the mesh, for a caller that draws the network over them. */
export const cellOutlines = (plan: TownPlan): Point[][] => plan.mesh.cells.filter((cell) => !cell.open).map((cell) => cellPolygon(plan.mesh, cell));
