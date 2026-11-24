/**
 * The rules every layout must satisfy, whichever generator made it. Returns
 * one line per broken rule; an empty list means the layout is sound.
 *
 * Everything here reads the format alone: polylines and polygons, never a
 * grid.
 */
import type { City } from '../city/records.ts';
import type { SettingPack } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import {
  type Box,
  EPSILON,
  SpatialIndex,
  bearingDifference,
  bearingVector,
  boxOf,
  crossingsOfPolyline,
  distance,
  distanceBetweenPolygons,
  distanceBetweenPolylines,
  distancePolygonToPolyline,
  distanceToPolygonEdge,
  distanceToPolyline,
  exactBearing,
  pointInPolygon,
  polygonArea,
  polygonWithin,
  polylineLength,
  slicePolyline,
  polygonsOverlap,
  strictlyInside,
} from './geometry.ts';
import { riverWidthAt } from './measure.ts';
import { type Layout, type Lot, type Segment, type Water, LAYOUT_VERSION } from './records.ts';

/** An exit, or a river's end, must lie within this many degrees of the brief's bearing, seen from the centre. */
export const BEARING_TOLERANCE = 20;

const MOST_PROBLEMS_LISTED = 20;
/** The clear ground a layout may leave between a roadway and the lots along it, in metres. */
const VERGE = 3;
/** A segment that ends at a gate is on the wall's line there; it is looked at from this far along, in metres. */
const GATE_REACH = 0.01;
const ORIGIN: Point = [0, 0];

/**
 * How far a shape is from a river's water: negative by as much as it reaches into it. The river's width may vary
 * along its length, so each piece of its line is taken at the wider of its two ends. `closed` says the points are
 * a polygon's and not a line's. Where only gaps up to `within` matter, pieces of the river further off than that
 * are passed over, and the answer for a shape with none nearer is infinite.
 */
export function gapToRiver(points: readonly Point[], river: Extract<Water, { kind: 'river' }>, closed: boolean, within = Infinity): number {
  const shape = closed ? [...points, points[0] as Point] : points;
  const box = boxOf(shape);
  let nearest = Infinity;
  const widest = river.widths ? river.widths.reduce((most, width) => Math.max(most, width), 0) : river.width;
  for (let at = 1; at < river.centreLine.length; at++) {
    const a = river.centreLine[at - 1] as Point;
    const b = river.centreLine[at] as Point;
    // A piece too far from the shape's box to matter is passed over.
    const reach = Math.min(Math.max(nearest, 0), within) + widest / 2;
    if (Math.max(a[0], b[0]) < box.minX - reach || Math.min(a[0], b[0]) > box.maxX + reach || Math.max(a[1], b[1]) < box.minY - reach || Math.min(a[1], b[1]) > box.maxY + reach) {
      if (nearest !== Infinity || within !== Infinity) continue;
    }
    const half = Math.max(riverWidthAt(river, at - 1), riverWidthAt(river, at)) / 2;
    const away = (closed ? distancePolygonToPolyline(points, [a, b]) : distanceBetweenPolylines(shape, [a, b])) - half;
    if (away < nearest) nearest = away;
  }
  return nearest;
}

/** The sides of each sea asked about, with the box of each, kept so that a shore of many pieces is looked through once. */
const seaSides = new WeakMap<readonly Point[], Array<{ a: Point; b: Point; minX: number; maxX: number; minY: number; maxY: number }>>();

/**
 * Whether a polygon overlaps a sea. A shore has many pieces and a town many lots, so only the pieces of shore
 * whose boxes meet the polygon's box are compared with it; a polygon with none near is wholly in the sea or
 * wholly out of it, which one of its corners settles.
 */
function overlapsSea(polygon: readonly Point[], box: Box, sea: readonly Point[]): boolean {
  let sides = seaSides.get(sea);
  if (!sides) {
    sides = sea.map((a, at) => {
      const b = sea[(at + 1) % sea.length] as Point;
      return { a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) };
    });
    seaSides.set(sea, sides);
  }
  const near = sides.some((side) => side.minX <= box.maxX && side.maxX >= box.minX && side.minY <= box.maxY && side.maxY >= box.minY);
  return near ? polygonsOverlap(polygon, sea) : strictlyInside(polygon[0] as Point, sea);
}

/** The distance from a polygon to a body of water. Zero when they meet. */
export function distanceToWater(polygon: readonly Point[], water: Water): number {
  if (water.kind === 'sea') return distanceBetweenPolygons(polygon, water.polygon);
  return Math.max(0, gapToRiver(polygon, water, true));
}

export function checkLayout(layout: Layout, city: City, brief: SettlementBrief, pack: SettingPack): string[] {
  const problems: string[] = [];
  const problem = (text: string) => {
    if (problems.length < MOST_PROBLEMS_LISTED) problems.push(text);
  };
  const { junctions, segments, exits, waters, lots, districtAreas, walls, places, summary } = layout;

  // IDs are unique and every list is in ID order.
  const index = <T>(what: string, list: T[], idOf: (record: T) => string): Map<string, T> => {
    const map = new Map<string, T>();
    let previous = '';
    for (const record of list) {
      const id = idOf(record);
      if (id <= previous) problem(`${what} ${id} is out of ID order or repeated`);
      previous = id;
      map.set(id, record);
    }
    return map;
  };
  const junctionById = index('junction', junctions, (record) => record.id);
  const segmentById = index('segment', segments, (record) => record.id);
  index('exit', exits, (record) => record.id);
  index('water', waters, (record) => record.id);
  index('lot', lots, (record) => record.id);
  const areaByDistrict = index('district area', districtAreas, (record) => record.districtId);
  const buildingById = new Map(city.buildings.map((building) => [building.id, building]));
  const districtById = new Map(city.districts.map((district) => [district.id, district]));

  // Segments join junctions that exist, and their centre lines run from one to the other.
  const degree = new Map<string, number>();
  for (const segment of segments) {
    const ends = [segment.fromJunctionId, segment.toJunctionId].map((id) => junctionById.get(id));
    const points = [segment.points[0] as Point, segment.points[segment.points.length - 1] as Point];
    ends.forEach((junction, end) => {
      const id = end === 0 ? segment.fromJunctionId : segment.toJunctionId;
      if (!junction) return problem(`${segment.id} names ${id}, which does not exist`);
      degree.set(id, (degree.get(id) ?? 0) + 1);
      if (distance(junction.position, points[end] as Point) > EPSILON) {
        problem(`${segment.id} does not ${end === 0 ? 'start' : 'end'} at the position of ${id}`);
      }
    });
  }

  // The street graph is connected.
  if (junctions.length > 0) {
    const neighbours = new Map<string, string[]>();
    for (const segment of segments) {
      for (const [a, b] of [
        [segment.fromJunctionId, segment.toJunctionId],
        [segment.toJunctionId, segment.fromJunctionId],
      ] as const) {
        const list = neighbours.get(a);
        if (list) list.push(b);
        else neighbours.set(a, [b]);
      }
    }
    const reached = new Set<string>([(junctions[0] as { id: string }).id]);
    const queue = [...reached];
    for (let at = 0; at < queue.length; at++) {
      for (const next of neighbours.get(queue[at] as string) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    if (reached.size !== junctions.length) {
      const stranded = junctions.find((junction) => !reached.has(junction.id));
      problem(`the street graph is not connected: ${junctions.length - reached.size} junctions, such as ${stranded?.id}, cannot be reached from ${junctions[0]?.id}`);
    }
  }

  // One exit per route exit in the brief, each near its bearing as seen from the centre.
  if (exits.length !== brief.routes.length) {
    problem(`there are ${exits.length} exits but the brief has ${brief.routes.length} route exits`);
  }
  const exitJunctions = new Set<string>();
  exits.forEach((exit, position) => {
    const route = brief.routes[position];
    if (route && (exit.routeId !== route.routeId || exit.bearing !== route.bearing || exit.kind !== route.kind || exit.name !== route.name)) {
      problem(`${exit.id} does not match the brief's route exit ${position + 1}: ${route.routeId} at bearing ${route.bearing}`);
    }
    const junction = junctionById.get(exit.junctionId);
    if (!junction) return problem(`${exit.id} names ${exit.junctionId}, which does not exist`);
    if (junction.kind !== 'exit') problem(`${exit.id} is at ${junction.id}, which is not marked as an exit`);
    if (exitJunctions.has(junction.id)) problem(`${junction.id} serves more than one exit`);
    exitJunctions.add(junction.id);
    if (!degree.has(junction.id)) problem(`${exit.id} is at ${junction.id}, which no segment reaches`);
    const seen = exactBearing(ORIGIN, junction.position);
    // A sea route's exit stands at the quay, wherever that is: ships leave by water.
    if (!exit.atQuay && bearingDifference(seen, exit.bearing) > BEARING_TOLERANCE) {
      problem(`${exit.id} lies at bearing ${seen.toFixed(1)} from the centre, more than ${BEARING_TOLERANCE} degrees from the brief's ${exit.bearing}`);
    }
  });
  for (const junction of junctions) {
    if (junction.kind === 'exit' && !exitJunctions.has(junction.id)) problem(`${junction.id} is marked as an exit but no exit uses it`);
  }

  // Lots: one per building, in the building's district, entered from a segment that borders it.
  const widest = Math.max(0, ...segments.map((segment) => segment.width));
  const lotOfBuilding = new Map<string, Lot>();
  let builtArea = 0;
  let townRadius = 0;
  for (const lot of lots) {
    builtArea += polygonArea(lot.polygon);
    for (const point of lot.polygon) townRadius = Math.max(townRadius, distance(ORIGIN, point));
    const building = buildingById.get(lot.buildingId);
    if (!building) problem(`${lot.id} belongs to ${lot.buildingId}, which does not exist`);
    else if (building.districtId !== lot.districtId) {
      problem(`${lot.id} is in ${lot.districtId} but its building ${building.id} is in ${building.districtId}`);
    }
    if (lotOfBuilding.has(lot.buildingId)) problem(`${lot.buildingId} has more than one lot`);
    lotOfBuilding.set(lot.buildingId, lot);
    const segment = segmentById.get(lot.entrance.segmentId);
    if (!segment) {
      problem(`${lot.id} opens onto ${lot.entrance.segmentId}, which does not exist`);
      continue;
    }
    if (distanceToPolyline(lot.entrance.point, segment.points) > EPSILON) {
      problem(`${lot.id} has an entrance point that is not on ${segment.id}`);
    }
    // Bordering: nothing wider than half the widest street, and a verge, lies between the lot and its entrance.
    if (!pointInPolygon(lot.entrance.point, lot.polygon) && distanceToPolygonEdge(lot.entrance.point, lot.polygon) > widest / 2 + VERGE + EPSILON) {
      problem(`${lot.id} does not border ${segment.id}: its entrance is ${distanceToPolygonEdge(lot.entrance.point, lot.polygon).toFixed(2)} m from the lot`);
    }
  }
  // Footprints lie inside their lot and do not overlap each other; the rest of the lot is open ground.
  for (const lot of lots) {
    lot.footprints.forEach((footprint, at) => {
      if (polygonArea(footprint) <= EPSILON) problem(`${lot.id} has a footprint with no area`);
      else if (!polygonWithin(footprint, lot.polygon)) problem(`${lot.id} has a footprint that does not lie inside the lot`);
      for (let other = 0; other < at; other++) {
        if (polygonsOverlap(footprint, lot.footprints[other] as Point[])) problem(`${lot.id} has footprints that overlap each other`);
      }
    });
  }
  for (const building of city.buildings) {
    if (!lotOfBuilding.has(building.id)) problem(`${building.id} has no lot`);
  }

  // No lot overlaps another lot, a roadway or water.
  const cell = Math.max(10, Math.sqrt(builtArea / Math.max(lots.length, 1)) * 2);
  const lotBoxes = new Map<Lot, Box>(lots.map((lot) => [lot, boxOf(lot.polygon)]));
  const lotIndex = new SpatialIndex<Lot>(cell);
  for (const [lot, box] of lotBoxes) lotIndex.add(box, lot);
  const segmentIndex = new SpatialIndex<Segment>(cell);
  for (const segment of segments) segmentIndex.add(boxOf(segment.points, segment.width / 2), segment);
  for (const [lot, box] of lotBoxes) {
    for (const other of lotIndex.near(box)) {
      if (other.id > lot.id && polygonsOverlap(lot.polygon, other.polygon)) problem(`${lot.id} overlaps ${other.id}`);
    }
    for (const segment of segmentIndex.near(box)) {
      const reach = boxOf(segment.points, segment.width / 2);
      if (reach.minX >= box.maxX || reach.maxX <= box.minX || reach.minY >= box.maxY || reach.maxY <= box.minY) continue;
      if (distancePolygonToPolyline(lot.polygon, segment.points) < segment.width / 2 - EPSILON) {
        problem(`${lot.id} overlaps the roadway of ${segment.id}`);
      }
    }
    for (const water of waters) {
      const wet = water.kind === 'sea' ? overlapsSea(lot.polygon, box, water.polygon) : gapToRiver(lot.polygon, water, true, 0) < -EPSILON;
      if (wet) problem(`${lot.id} overlaps ${water.id}, the ${water.kind}`);
    }
  }

  // Walls and places. A lot overlaps neither, but for the lot of a place's own building, which is the place; and a
  // gatehouse may stand apart from its district, at its gate.
  index('wall', walls, (record) => record.id);
  index('place', places, (record) => record.id);
  const gateJunctions = new Set<string>();
  const gatehouses = new Set<string>();
  for (const wall of walls) {
    if (wall.closed && wall.lines.length !== 1) problem(`${wall.id} is closed but has ${wall.lines.length} lines`);
    const lines = wall.closed ? [[...(wall.lines[0] as Point[]), (wall.lines[0] as Point[])[0] as Point]] : wall.lines;
    const onWall = (point: Point) => Math.min(...lines.map((line) => distanceToPolyline(point, line)));
    for (const gate of wall.gates) {
      const junction = junctionById.get(gate.junctionId);
      if (!junction) problem(`${wall.id} has a gate at ${gate.junctionId}, which does not exist`);
      else {
        if (junction.kind !== 'gate') problem(`${wall.id} has a gate at ${junction.id}, which is not marked as a gate`);
        if (onWall(junction.position) > EPSILON) problem(`${wall.id} has a gate at ${junction.id}, which is not on the wall's line`);
      }
      if (gateJunctions.has(gate.junctionId)) problem(`${gate.junctionId} is a gate more than once`);
      gateJunctions.add(gate.junctionId);
      // A plain gate is kept by no building.
      if (gate.buildingId === undefined) continue;
      if (!buildingById.has(gate.buildingId)) problem(`${wall.id} has a gate kept by ${gate.buildingId}, which does not exist`);
      if (gatehouses.has(gate.buildingId)) problem(`${gate.buildingId} keeps more than one gate`);
      gatehouses.add(gate.buildingId);
    }
    // Streets cross a wall only at its gates: a segment may meet the line at an end that is one of its gates, and nowhere else.
    const ownGates = new Set(wall.gates.map((gate) => gate.junctionId));
    for (const segment of segments) {
      const length = polylineLength(segment.points);
      const from = ownGates.has(segment.fromJunctionId) ? Math.min(GATE_REACH, length / 2) : 0;
      const to = length - (ownGates.has(segment.toJunctionId) ? Math.min(GATE_REACH, length / 2) : 0);
      const points = from === 0 && to === length ? segment.points : slicePolyline(segment.points, from, to);
      if (points.some((point, at) => at > 0 && lines.some((line) => crossingsOfPolyline(points[at - 1] as Point, point, line) > 0))) problem(`${segment.id} crosses ${wall.id} where there is no gate`);
    }
    for (const lot of lots) {
      if (lines.some((line) => distancePolygonToPolyline(lot.polygon, line) < wall.width / 2 - EPSILON)) problem(`${lot.id} overlaps ${wall.id}`);
    }
  }
  for (const junction of junctions) {
    if (junction.kind === 'gate' && !gateJunctions.has(junction.id)) problem(`${junction.id} is marked as a gate but no wall has it`);
  }
  for (const place of places) {
    const owner = place.kind === 'plaza' ? place.buildingId : undefined;
    if (owner !== undefined && !buildingById.has(owner)) problem(`${place.id} belongs to ${owner}, which does not exist`);
    for (const lot of lots) {
      if (lot.buildingId !== owner && polygonsOverlap(lot.polygon, place.polygon)) problem(`${lot.id} overlaps ${place.id}`);
    }
    for (const segment of segments) {
      if (distancePolygonToPolyline(place.polygon, segment.points) < segment.width / 2 - EPSILON) problem(`${place.id} overlaps the roadway of ${segment.id}`);
    }
  }

  // Only bridge segments cross water.
  for (const segment of segments) {
    if (segment.kind === 'bridge') continue;
    for (const water of waters) {
      const wet =
        water.kind === 'river'
          ? gapToRiver(segment.points, water, false, segment.width / 2) < segment.width / 2 - EPSILON
          : segment.points.some((point) => strictlyInside(point, water.polygon)) ||
            segment.points.some((point, at) => at > 0 && crossingsOfPolyline(segment.points[at - 1] as Point, point, [...water.polygon, water.polygon[0] as Point]) > 0);
      if (wet) problem(`${segment.id}, which is not a bridge, enters ${water.id}, the ${water.kind}`);
    }
  }

  // Water follows the brief: a river where the brief has one, reaching the town's edge near each bearing it gives.
  const rivers = waters.filter((water) => water.kind === 'river');
  const seas = waters.filter((water) => water.kind === 'sea');
  if (rivers.length !== (brief.river ? 1 : 0)) {
    problem(`there are ${rivers.length} rivers but the brief has ${brief.river ? 'one' : 'none'}`);
  }
  const river = rivers[0];
  if (river && brief.river) {
    const ends: Array<[string, number | undefined, Point]> = [
      ['arrives', brief.river.arrivesFrom?.bearing, river.centreLine[0] as Point],
      ['leaves', brief.river.leavesToward?.bearing, river.centreLine[river.centreLine.length - 1] as Point],
    ];
    for (const [verb, wanted, end] of ends) {
      if (wanted === undefined) continue;
      if (distance(ORIGIN, end) < townRadius - EPSILON) {
        problem(`${river.id} ${verb} ${distance(ORIGIN, end).toFixed(0)} m from the centre, short of the town's edge at ${townRadius.toFixed(0)} m`);
      }
      const seen = exactBearing(ORIGIN, end);
      if (bearingDifference(seen, wanted) > BEARING_TOLERANCE) {
        problem(`${river.id} ${verb} at bearing ${seen.toFixed(1)}, more than ${BEARING_TOLERANCE} degrees from the brief's ${wanted}`);
      }
    }
  }
  // A coastal settlement has sea toward its water bearing and none the opposite way.
  if (seas.length !== (brief.coast.isCoastal ? 1 : 0)) {
    problem(`there are ${seas.length} seas but the brief says the settlement is ${brief.coast.isCoastal ? '' : 'not '}coastal`);
  }
  const sea = seas[0];
  if (sea && brief.coast.waterBearing !== undefined) {
    const reach = Math.max(...sea.polygon.map((point) => distance(ORIGIN, point)));
    const meetsSea = (bearing: number) => {
      const [x, y] = bearingVector(bearing);
      const far: Point = [x * reach, y * reach];
      return strictlyInside(far, sea.polygon) || crossingsOfPolyline(ORIGIN, far, [...sea.polygon, sea.polygon[0] as Point]) > 0;
    };
    if (!meetsSea(brief.coast.waterBearing)) problem(`${sea.id} is not in the direction of the brief's water bearing, ${brief.coast.waterBearing}`);
    if (meetsSea(brief.coast.waterBearing + 180)) problem(`${sea.id} also lies opposite the brief's water bearing`);
    if (strictlyInside(ORIGIN, sea.polygon)) problem(`${sea.id} covers the town centre`);
  }

  // Bridge links: each names a bridge, and the districts whose ground it reaches at its two ends.
  const bridgeLinks = layout.bridgeLinks ?? [];
  const groundAway = (districtId: string, point: Point) => Math.min(...(areaByDistrict.get(districtId)?.polygons ?? []).map((polygon) => (pointInPolygon(point, polygon) ? 0 : distanceToPolygonEdge(point, polygon))));
  for (const link of bridgeLinks) {
    const bridge = segmentById.get(link.segmentId);
    if (!bridge || bridge.kind !== 'bridge') {
      problem(`a bridge link names ${link.segmentId}, which is not a bridge`);
      continue;
    }
    if (!areaByDistrict.has(link.from) || !areaByDistrict.has(link.to)) {
      problem(`the bridge link of ${link.segmentId} names a district without ground`);
      continue;
    }
    const [start, end] = [bridge.points[0] as Point, bridge.points[bridge.points.length - 1] as Point];
    // The ground it reaches at each end is nearer that end than the other.
    if (groundAway(link.from, start) > groundAway(link.from, end) && groundAway(link.to, end) > groundAway(link.to, start)) {
      problem(`the bridge link of ${link.segmentId} names ${link.from} and ${link.to} at the wrong ends`);
    }
  }

  // District areas: every district with lots has one, and no two overlap. Whether a district's ground is in one
  // piece, and how many of its lots lie in it, is measured (`measureDistrictGround`), not required.
  const withLots = new Set(lots.map((lot) => lot.districtId));
  for (const districtId of [...withLots].sort()) if (!areaByDistrict.has(districtId)) problem(`${districtId} has lots but no district area`);
  for (const area of districtAreas) {
    if (!districtById.has(area.districtId)) problem(`a district area names ${area.districtId}, which does not exist`);
    if (!area.polygons.some((polygon) => pointInPolygon(area.labelPoint, polygon))) {
      problem(`the label point of ${area.districtId} is outside its area`);
    }
  }
  const areaIndex = new SpatialIndex<{ districtId: string; polygon: Point[] }>(cell * 4);
  const pieces = districtAreas.flatMap((area) => area.polygons.map((polygon) => ({ districtId: area.districtId, polygon })));
  for (const piece of pieces) areaIndex.add(boxOf(piece.polygon), piece);
  for (const piece of pieces) {
    for (const other of areaIndex.near(boxOf(piece.polygon))) {
      if (other.districtId > piece.districtId && polygonsOverlap(piece.polygon, other.polygon)) {
        problem(`the areas of ${piece.districtId} and ${other.districtId} overlap`);
      }
    }
  }

  // A waterside district, such as a port's harbour, touches the water where there is any.
  const placements = new Map(pack.districts.kinds.map((kind) => [kind.id, kind.placement]));
  if (waters.length > 0) {
    for (const district of city.districts) {
      if (placements.get(district.kind) !== 'waterside') continue;
      const area = areaByDistrict.get(district.id);
      if (!area) continue;
      const nearest = Math.min(...area.polygons.flatMap((polygon) => waters.map((water) => distanceToWater(polygon, water))));
      if (nearest > pack.layout.watersideReach + EPSILON) {
        problem(`${district.id} is a waterside district but lies ${nearest.toFixed(1)} m from the water, beyond the pack's reach of ${pack.layout.watersideReach} m`);
      }
    }
  }
  if (brief.flags.port && !city.districts.some((district) => placements.get(district.kind) === 'waterside' && areaByDistrict.has(district.id))) {
    problem('the settlement is a port but has no waterside district');
  }

  // The summary agrees with the records, and the density is plausible.
  const counts = { junctions, segments, exits, waters, lots, districtAreas, walls, places };
  for (const [name, list] of Object.entries(counts)) {
    if (summary.counts[name as keyof typeof counts] !== list.length) {
      problem(`the summary counts ${summary.counts[name as keyof typeof counts]} ${name} but there are ${list.length}`);
    }
  }
  if (summary.counts.gates !== gateJunctions.size) problem(`the summary counts ${summary.counts.gates} gates but there are ${gateJunctions.size}`);
  // A wall and a plaza exactly where the brief flags them, when the generator makes them at all.
  if (walls.length > 0 && !brief.flags.walls) problem('the layout has a wall but the brief is not flagged for walls');
  if (places.some((place) => place.kind === 'plaza') && !brief.flags.plaza) problem('the layout has a plaza but the brief is not flagged for one');
  if (Math.abs(summary.builtArea - builtArea) > EPSILON * Math.max(builtArea, 1)) {
    problem(`the summary gives a built area of ${summary.builtArea} but the lots cover ${builtArea}`);
  }
  const { bounds } = summary;
  const outside = ([x, y]: Point) => x < bounds.minX - EPSILON || x > bounds.maxX + EPSILON || y < bounds.minY - EPSILON || y > bounds.maxY + EPSILON;
  if (lots.some((lot) => lot.polygon.some(outside)) || segments.some((segment) => segment.points.some(outside))) {
    problem('the summary\'s bounds do not contain every lot and segment');
  }
  const density = builtArea === 0 ? 0 : city.people.length / (builtArea / 10_000);
  if (Math.abs(summary.residentsPerHectare - density) > EPSILON * Math.max(density, 1)) {
    problem(`the summary gives ${summary.residentsPerHectare} residents per hectare but the figure is ${density}`);
  }
  if (density < pack.layout.density.min || density > pack.layout.density.max) {
    problem(`there are ${density.toFixed(0)} residents per hectare of built area, outside the pack's limits of ${pack.layout.density.min} to ${pack.layout.density.max}`);
  }
  for (const water of waters) {
    if (water.kind === 'river' && water.widths && water.widths.length !== water.centreLine.length) problem(`${water.id} has ${water.widths.length} widths for the ${water.centreLine.length} points of its line`);
  }
  if (summary.settlementId !== brief.id) problem(`the summary names ${summary.settlementId}, not ${brief.id}`);
  if (summary.layoutVersion !== LAYOUT_VERSION) problem(`the summary gives layout version ${summary.layoutVersion}, not ${LAYOUT_VERSION}`);

  return problems;
}
