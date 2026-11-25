/**
 * The village generator's plan written in the one layout format, and checked
 * against its invariants.
 *
 * Every way is cut into segments where another way meets or crosses it, at
 * each end of a bridge, and at the exits. Roads are arterials, a bridge's
 * length is a bridge, everything else is a lane. Each building has one lot:
 * its plot, or its anchor's site, entered from the way it fronts. A green is
 * a place: the plaza, as the lot of its building, where the brief is flagged
 * `plaza`; otherwise a green that belongs to no building. The well on it is
 * a lot of its own at its edge, cut out of it. Districts are not drawn: a
 * district's ground is its lots. A palisade is a wall of open lines with gaps
 * where ways pass, and no gates. Fields, trees, barns and boats are not in
 * the format: they are drawing.
 */
import type { City } from '../../city/records.ts';
import type { SettingPack } from '../../pack/schema.ts';
import type { Point, SettlementBrief } from '../../schema.ts';
import { interiorPoint } from '../cutting.ts';
import { boxOf, pointInPolygon, polygonArea, polygonCentroid, polylineLength, projectOnPolyline, slicePolyline } from '../geometry.ts';
import { checkLayout } from '../invariants.ts';
import { ringShare } from '../measure.ts';
import { type DistrictArea, type Exit, type Junction, LAYOUT_VERSION, type Layout, type Lot, type Segment } from '../records.ts';
import { crossingsAlong } from '../staged/lines.ts';
import { grown, united, without } from '../staged/shapes.ts';
import { VillageLayoutError, planVillage, villageInput } from './plan.ts';

export const VILLAGE_GENERATOR = 'village';

export interface VillageOptions {
  seed?: number;
  /** false returns the layout without checking it against the invariants: for measuring what a village breaks. */
  check?: boolean;
}

/** Two points nearer than this are one junction, in metres. */
const TOUCH = 0.05;
/** A district's ground is its lots, each drawn in by this much so that two districts' lots that touch do not overlap. */
const DRAWN_IN = 0.02;
/** The well is cut out of the green with this much to spare, so that the two do not overlap once rounded. */
const WELL_CLEAR = 0.05;
/** How far past the well's front its cut out of the green runs, to reach the green's edge, in metres. */
const WELL_OUT = 3;
/** A lot's entrance is looked for from this many pieces of its front. */
const FRONT_PROBES = 8;

const pad = (value: number, digits: number) => String(value).padStart(digits, '0');

export function generateVillageLayout(city: City, brief: SettlementBrief, pack: SettingPack, options: VillageOptions = {}): Layout {
  const seed = options.seed ?? brief.seed;
  const plan = planVillage(brief, villageInput(city), pack, seed);
  const fail = (message: string): never => {
    throw new VillageLayoutError(`${brief.name} (${brief.id}): ${message}`);
  };
  const number = brief.id.split('-')[1] as string;
  const ways = plan.ways;

  // ---- Where each way is cut: its ends, where others meet or cross it, its bridges ---------------------------------------
  const cuts = ways.map((way) => [0, polylineLength(way.points)]);
  ways.forEach((way, i) => {
    ways.forEach((other, j) => {
      if (i === j) return;
      for (const end of [other.points[0] as Point, other.points[other.points.length - 1] as Point]) {
        const found = projectOnPolyline(way.points, end);
        if (found.distance < TOUCH) (cuts[i] as number[]).push(found.along);
      }
      (cuts[i] as number[]).push(...crossingsAlong(way.points, other.points));
    });
  });
  const spans = new Map<number, Array<[number, number]>>();
  for (const bridge of plan.bridges) {
    const way = ways[bridge.way] as (typeof ways)[number];
    const [a, b] = [projectOnPolyline(way.points, bridge.a).along, projectOnPolyline(way.points, bridge.b).along];
    (cuts[bridge.way] as number[]).push(a, b);
    spans.set(bridge.way, [...(spans.get(bridge.way) ?? []), [Math.min(a, b), Math.max(a, b)]]);
  }

  // ---- Junctions and segments -------------------------------------------------------------------------------------------------
  const junctions: Junction[] = [];
  const junctionAt = (point: Point): Junction => {
    for (const junction of junctions) if (Math.hypot(junction.position[0] - point[0], junction.position[1] - point[1]) < TOUCH) return junction;
    const junction: Junction = { id: `junction-${number}-${pad(junctions.length + 1, 6)}`, position: [point[0], point[1]], kind: 'crossing' };
    junctions.push(junction);
    return junction;
  };
  const segments: Segment[] = [];
  /** For each way, its segments and where along the way each runs. */
  const pieces = ways.map((): Array<{ from: number; to: number; segment: Segment }> => []);
  const bridgeEnds = new Set<Junction>();
  ways.forEach((way, index) => {
    const length = polylineLength(way.points);
    const along = [...new Set((cuts[index] as number[]).map((value) => Math.min(Math.max(value, 0), length)))].sort((a, b) => a - b).filter((value, at, all) => at === 0 || value - (all[at - 1] as number) >= TOUCH);
    const centre = projectOnPolyline(way.points, [0, 0]).along;
    for (let k = 1; k < along.length; k++) {
      const [from, to] = [along[k - 1] as number, along[k] as number];
      const points = slicePolyline(way.points, from, to);
      const start = junctionAt(points[0] as Point);
      const end = junctionAt(points[points.length - 1] as Point);
      if (start === end) continue;
      points[0] = start.position;
      points[points.length - 1] = end.position;
      const middle = (from + to) / 2;
      const onBridge = (spans.get(index) ?? []).some(([a, b]) => middle > a && middle < b);
      if (onBridge) {
        bridgeEnds.add(start);
        bridgeEnds.add(end);
      }
      // A through road carries its first route on the near side of the centre, its second beyond.
      const route = way.routes.length === 0 ? undefined : way.routes.length === 1 || middle < centre ? way.routes[0] : way.routes[1];
      const segment: Segment = {
        id: `segment-${number}-${pad(segments.length + 1, 6)}`,
        fromJunctionId: start.id,
        toJunctionId: end.id,
        points,
        kind: onBridge ? 'bridge' : way.kind === 'road' ? 'arterial' : 'lane',
        width: way.width,
        ...(route !== undefined && brief.routes[route] && { routeId: brief.routes[route].routeId }),
        ...(way.kind === 'road' && route !== undefined && brief.routes[route]?.name !== undefined && { name: brief.routes[route].name as string }),
      };
      segments.push(segment);
      (pieces[index] as Array<{ from: number; to: number; segment: Segment }>).push({ from, to, segment });
    }
  });
  /** The segment of a way nearest a lot's front, or a point, and the point on it. */
  const entranceOn = (wayIndex: number, front: readonly Point[]): Lot['entrance'] => {
    const way = ways[wayIndex] ?? fail(`a lot fronts way ${wayIndex}, which the plan does not have`);
    // Looked for from points along the front: on a bend the way comes nearest the front away from its middle.
    const probes = front.length === 2 ? Array.from({ length: FRONT_PROBES + 1 }, (_, k): Point => [(front[0] as Point)[0] + (((front[1] as Point)[0] - (front[0] as Point)[0]) * k) / FRONT_PROBES, (front[0] as Point)[1] + (((front[1] as Point)[1] - (front[0] as Point)[1]) * k) / FRONT_PROBES]) : [...front];
    const found = probes.map((probe) => projectOnPolyline(way.points, probe)).reduce((best, one) => (one.distance < best.distance ? one : best));
    const near = found.point;
    const piece = (pieces[wayIndex] ?? []).find((one) => found.along >= one.from - TOUCH && found.along <= one.to + TOUCH) ?? fail(`no segment of way ${wayIndex} is at ${found.along.toFixed(1)} m along it`);
    return { segmentId: piece.segment.id, point: projectOnPolyline(piece.segment.points, near).point };
  };

  // ---- Exits: each road's ends, and the quays for sea routes ------------------------------------------------------------------
  const exitAt = new Map<number, { junction: Junction; atQuay: boolean }>();
  ways.forEach((way) => {
    if (way.kind !== 'road') return;
    const ends = [way.points[0] as Point, way.points[way.points.length - 1] as Point];
    // An arm runs from the centre to its exit; a through road from its first exit to its second.
    if (way.routes.length === 1) exitAt.set(way.routes[0] as number, { junction: junctionAt(ends[1] as Point), atQuay: false });
    if (way.routes.length === 2) {
      exitAt.set(way.routes[0] as number, { junction: junctionAt(ends[0] as Point), atQuay: false });
      exitAt.set(way.routes[1] as number, { junction: junctionAt(ends[1] as Point), atQuay: false });
    }
  });
  const quays = [...plan.anchors.quays];
  brief.routes.forEach((route, at) => {
    if (route.kind !== 'sea-route') return;
    const quay = quays.shift() ?? fail(`route ${at} (${route.routeId}) is a sea route, but the village has no landing to leave from`);
    exitAt.set(at, { junction: junctionAt(quay), atQuay: true });
  });
  const exits: Exit[] = brief.routes.map((route, at) => {
    const found = exitAt.get(at) ?? fail(`route ${at} (${route.routeId}) has no road and no landing`);
    return { id: `exit-${number}-${pad(at + 1, 3)}`, junctionId: found.junction.id, routeId: route.routeId, ...(route.name !== undefined && { name: route.name }), kind: route.kind, bearing: route.bearing, ...(found.atQuay && { atQuay: true }) };
  });

  // ---- Junction kinds ------------------------------------------------------------------------------------------------------------
  const degree = new Map<string, number>();
  for (const segment of segments) for (const id of [segment.fromJunctionId, segment.toJunctionId]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const exitJunctions = new Set(exits.map((exit) => exit.junctionId));
  for (const junction of junctions) {
    junction.kind = exitJunctions.has(junction.id) ? 'exit' : bridgeEnds.has(junction) ? 'bridge-end' : (degree.get(junction.id) ?? 0) <= 1 ? 'dead-end' : 'crossing';
  }

  // ---- Lots ------------------------------------------------------------------------------------------------------------------------
  const buildingById = new Map(city.buildings.map((building) => [building.id, building]));
  const drafts = new Map<string, Omit<Lot, 'id' | 'districtId'>>();
  for (const plot of plan.plots) drafts.set(plot.building, { buildingId: plot.building, polygon: plot.outline, entrance: entranceOn(plot.way, plot.front), footprints: plot.footprints, front: plot.front });
  const { green } = plan.anchors;
  const wellOnGreen = green ? plan.anchors.sites.find((site) => site.role === 'well' && site.outline.every((corner) => pointInPolygon(corner, green.outline) || projectOnPolyline([...green.outline, green.outline[0] as Point], corner).distance < TOUCH)) : undefined;
  // The green less the well cut out of its edge.
  // The well's site and the way from it to the green's edge are cut out together, so the green keeps one outline.
  const wellCut = (well: NonNullable<typeof wellOnGreen>): Point[][] => {
    const front = well.front ?? [well.outline[0] as Point, well.outline[1] as Point];
    const centre = polygonCentroid(well.outline);
    const middle: Point = [(front[0][0] + front[1][0]) / 2, (front[0][1] + front[1][1]) / 2];
    const length = Math.hypot(middle[0] - centre[0], middle[1] - centre[1]) || 1;
    const out: Point = [(middle[0] - centre[0]) / length, (middle[1] - centre[1]) / length];
    const reach = (step: number): Point[] => [front[0], front[1], [front[1][0] + out[0] * step, front[1][1] + out[1] * step], [front[0][0] + out[0] * step, front[0][1] + out[1] * step]];
    return grown([...united([well.outline, reach(WELL_OUT)]).rings], WELL_CLEAR).rings;
  };
  const greenGround = green ? ((wellOnGreen ? without([green.outline], wellCut(wellOnGreen)).rings : [green.outline]).sort((a, b) => polygonArea(b) - polygonArea(a))[0] as Point[]) : undefined;
  for (const site of plan.anchors.sites) {
    if (site.building === undefined) continue;
    const polygon = site.role === 'green' ? (greenGround as Point[]) : site.outline;
    const wayIndex = site.way ?? fail(`the ${site.role} has no way to open onto`);
    drafts.set(site.building, { buildingId: site.building, polygon, entrance: entranceOn(wayIndex, site.front ?? polygon), footprints: site.footprints, ...(site.front && { front: site.front }) });
  }
  const lots: Lot[] = [];
  city.buildings.forEach((building, at) => {
    const draft = drafts.get(building.id) ?? fail(`${building.id}, a ${building.type}, was given no place`);
    lots.push({ id: `lot-${number}-${pad(at + 1, 6)}`, ...draft, districtId: building.districtId });
  });

  // ---- Places, the wall, water, districts ---------------------------------------------------------------------------------------
  const places: Layout['places'] = [];
  if (green && greenGround) {
    const holder = plan.anchors.sites.find((site) => site.role === 'green')?.building;
    places.push(holder !== undefined && buildingById.has(holder) ? { id: `place-${number}-001`, kind: 'plaza', polygon: greenGround, buildingId: holder } : { id: `place-${number}-001`, kind: 'green', polygon: greenGround });
  }
  const walls: Layout['walls'] = plan.palisade && plan.palisade.lines.length > 0 ? [{ id: `wall-${number}-001`, lines: plan.palisade.lines, closed: false, width: plan.palisade.width, gates: [] }] : [];
  const waters: Layout['waters'] = [];
  if (plan.river) waters.push({ id: `water-${number}-${pad(waters.length + 1, 3)}`, kind: 'river', centreLine: plan.river.line, width: plan.river.width });
  if (plan.coast) waters.push({ id: `water-${number}-${pad(waters.length + 1, 3)}`, kind: 'sea', polygon: plan.coast.polygon });
  // A district's ground is its lots, made one where they touch.
  const districtAreas: DistrictArea[] = [];
  for (const district of city.districts) {
    const own = lots.filter((lot) => lot.districtId === district.id);
    if (own.length === 0) continue;
    const drawnIn = own.flatMap((lot) => grown([lot.polygon], -DRAWN_IN).rings);
    const polygons = united(drawnIn).rings.filter((ring) => polygonArea(ring) > 0.01);
    if (polygons.length === 0) continue;
    const largest = polygons.reduce((best, ring) => (polygonArea(ring) > polygonArea(best) ? ring : best));
    const middle = polygonCentroid(largest);
    districtAreas.push({ districtId: district.id, polygons, labelPoint: pointInPolygon(middle, largest) ? middle : interiorPoint(largest) });
  }

  // ---- The summary -------------------------------------------------------------------------------------------------------------------
  const builtArea = lots.reduce((sum, lot) => sum + polygonArea(lot.polygon), 0);
  const layout: Layout = {
    junctions,
    segments,
    exits,
    waters,
    lots,
    districtAreas,
    walls,
    places,
    summary: {
      settlementId: brief.id,
      counts: { junctions: junctions.length, segments: segments.length, exits: exits.length, waters: waters.length, lots: lots.length, districtAreas: districtAreas.length, walls: walls.length, gates: 0, places: places.length },
      outlineArea: polygonArea(plan.countryside.envelope),
      bounds: boxOf([...lots.flatMap((lot) => lot.polygon), ...segments.flatMap((segment) => segment.points)]),
      builtArea,
      residentsPerHectare: builtArea === 0 ? 0 : city.people.length / (builtArea / 10_000),
      ringShare: ringShare(segments),
      roadsOut: exits.length,
      layoutVersion: LAYOUT_VERSION,
      generator: VILLAGE_GENERATOR,
      pack: { name: pack.pack.name, version: pack.pack.version },
      seed,
    },
  };
  if (options.check === false) return layout;
  const broken = checkLayout(layout, city, brief, pack);
  if (broken.length > 0) fail(`the layout breaks ${broken.length === 1 ? 'an invariant' : 'invariants'}:\n  ${broken.join('\n  ')}`);
  return layout;
}

