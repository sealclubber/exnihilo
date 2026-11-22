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
  sharedBoundaryLength,
  strictlyInside,
} from './geometry.ts';
import { type Layout, type Lot, type Segment, type Water, LAYOUT_VERSION } from './records.ts';

/** An exit, or a river's end, must lie within this many degrees of the brief's bearing, seen from the centre. */
export const BEARING_TOLERANCE = 20;

const MOST_PROBLEMS_LISTED = 20;
/** The clear ground a layout may leave between a roadway and the lots along it, in metres. */
const VERGE = 1;
/** A segment that ends at a gate is on the wall's line there; it is looked at from this far along, in metres. */
const GATE_REACH = 0.01;
const ORIGIN: Point = [0, 0];

/** The distance from a polygon to a body of water. Zero when they meet. */
export function distanceToWater(polygon: readonly Point[], water: Water): number {
  if (water.kind === 'sea') return distanceBetweenPolygons(polygon, water.polygon);
  return Math.max(0, distancePolygonToPolyline(polygon, water.centreLine) - water.width / 2);
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
    if (bearingDifference(seen, exit.bearing) > BEARING_TOLERANCE) {
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
      const wet = water.kind === 'sea' ? polygonsOverlap(lot.polygon, water.polygon) : distancePolygonToPolyline(lot.polygon, water.centreLine) < water.width / 2 - EPSILON;
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
    const line = wall.closed ? [...wall.line, wall.line[0] as Point] : wall.line;
    for (const gate of wall.gates) {
      const junction = junctionById.get(gate.junctionId);
      if (!junction) problem(`${wall.id} has a gate at ${gate.junctionId}, which does not exist`);
      else {
        if (junction.kind !== 'gate') problem(`${wall.id} has a gate at ${junction.id}, which is not marked as a gate`);
        if (distanceToPolyline(junction.position, line) > EPSILON) problem(`${wall.id} has a gate at ${junction.id}, which is not on the wall's line`);
      }
      if (gateJunctions.has(gate.junctionId)) problem(`${gate.junctionId} is a gate more than once`);
      gateJunctions.add(gate.junctionId);
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
      if (points.some((point, at) => at > 0 && crossingsOfPolyline(points[at - 1] as Point, point, line) > 0)) problem(`${segment.id} crosses ${wall.id} where there is no gate`);
    }
    for (const lot of lots) {
      if (distancePolygonToPolyline(lot.polygon, line) < wall.width / 2 - EPSILON) problem(`${lot.id} overlaps ${wall.id}`);
    }
  }
  for (const junction of junctions) {
    if (junction.kind === 'gate' && !gateJunctions.has(junction.id)) problem(`${junction.id} is marked as a gate but no wall has it`);
  }
  for (const place of places) {
    if (!buildingById.has(place.buildingId)) problem(`${place.id} belongs to ${place.buildingId}, which does not exist`);
    for (const lot of lots) {
      if (lot.buildingId !== place.buildingId && polygonsOverlap(lot.polygon, place.polygon)) problem(`${lot.id} overlaps ${place.id}`);
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
          ? distanceBetweenPolylines(segment.points, water.centreLine) < water.width / 2 + segment.width / 2 - EPSILON
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

  // District areas: they enclose their lots, hold together, and keep apart from each other.
  const lotsByDistrict = new Map<string, Lot[]>();
  for (const lot of lots) {
    const list = lotsByDistrict.get(lot.districtId);
    if (list) list.push(lot);
    else lotsByDistrict.set(lot.districtId, [lot]);
  }
  for (const [districtId, districtLots] of lotsByDistrict) {
    const area = areaByDistrict.get(districtId);
    if (!area) {
      problem(`${districtId} has lots but no district area`);
      continue;
    }
    for (const lot of districtLots) {
      // A gatehouse stands at its gate, wherever its district lies.
      if (gatehouses.has(lot.buildingId)) continue;
      if (!area.polygons.some((polygon) => polygonWithin(lot.polygon, polygon))) problem(`${lot.id} lies outside the area of ${districtId}`);
    }
  }
  for (const area of districtAreas) {
    if (!districtById.has(area.districtId)) problem(`a district area names ${area.districtId}, which does not exist`);
    // One connected area: every polygon can be reached from the first through shared boundaries.
    const joined = new Set([0]);
    const queue = [0];
    for (let at = 0; at < queue.length; at++) {
      area.polygons.forEach((polygon, other) => {
        if (joined.has(other)) return;
        const current = area.polygons[queue[at] as number] as Point[];
        if (sharedBoundaryLength(current, polygon) > EPSILON || polygonsOverlap(current, polygon)) {
          joined.add(other);
          queue.push(other);
        }
      });
    }
    if (joined.size !== area.polygons.length) {
      problem(`the area of ${area.districtId} is in ${area.polygons.length - joined.size + 1} or more separate pieces`);
    }
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
  if (places.length > 0 && !brief.flags.plaza) problem('the layout has a plaza but the brief is not flagged for one');
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
  if (summary.settlementId !== brief.id) problem(`the summary names ${summary.settlementId}, not ${brief.id}`);
  if (summary.layoutVersion !== LAYOUT_VERSION) problem(`the summary gives layout version ${summary.layoutVersion}, not ${LAYOUT_VERSION}`);

  return problems;
}
