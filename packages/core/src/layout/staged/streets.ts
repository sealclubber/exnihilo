/**
 * Stage 8 of the staged generator: main streets.
 *
 * From corners of the mesh that lie on a highway, a main street follows cell
 * borders outward, always taking the straightest way on and stopping where
 * the turn would be too sharp. Starts are kept apart. Each street is then
 * evened by moving the corners it passes through, so that the wards beside
 * it bend with it. A main street never crosses water or the wall.
 */
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { distance, distanceToPolyline, pointInPolygon, projectOnPolyline } from '../geometry.ts';
import type { Ground } from './ground.ts';
import type { RoadPlan } from './highways.ts';
import { between, crossingsAlong } from './lines.ts';
import type { Mesh } from './mesh.ts';
import type { SpecialWard } from './special.ts';
import type { Wall } from './wall.ts';
import type { Coast, River } from './water.ts';

export interface MainStreet {
  /** From the highway it leaves, outward. */
  points: Point[];
  /** The mesh corners it passes through, in order: its points after the first. Empty for a bridge road's far leg. */
  corners: number[];
}

export interface StreetInput {
  settings: StagedSettings;
  buildings: number;
  mesh: Mesh;
  ground: Ground;
  roads: RoadPlan;
  river?: River;
  coast?: Coast;
  wall?: Wall;
  plaza?: SpecialWard;
  castle?: SpecialWard;
}

/** How finely a street is walked when it is checked against water, in metres. */
const PROBE = 4;

/** Lays the main streets, moving the mesh's corners as it evens them. The far legs of bridge roads come first, as stage 2 laid them. */
export function layMainStreets({ settings, buildings, mesh, ground, roads, river, coast, wall, plaza, castle }: StreetInput): MainStreet[] {
  const rules = settings.mainStreets;
  const streets: MainStreet[] = roads.mainStreets.map((points) => ({ points, corners: [] }));
  if (buildings < rules.skipBelow) return streets;
  const spacing = mesh.spacing;
  const walls = wall ? wall.parts.map((part) => (part.closed ? [...part.points, part.points[0] as Point] : part.points)) : [];
  const specials = [plaza, castle].filter((ward): ward is SpecialWard => ward !== undefined);
  const wet = (point: Point) => (river !== undefined && river.gap(point) <= 0) || (coast !== undefined && coast.gap(point) <= 0);
  const toHighway = (point: Point) => ground.toRoad(point);

  // ---- The borders a street may follow --------------------------------------------------------------------------
  const next = new Map<number, number[]>();
  for (const edge of mesh.edges) {
    if (mesh.onEdge[edge.a] || mesh.onEdge[edge.b]) continue;
    const [a, b] = [mesh.corners[edge.a] as Point, mesh.corners[edge.b] as Point];
    const middle = between(a, b);
    if (!ground.has(middle, rules.edgeMargin) || distance(a, b) < rules.shortest) continue;
    // A border that lies along a highway, the wall or the river is that line, and no street.
    if (toHighway(middle) < rules.highwayIs * spacing) continue;
    if (walls.some((line) => distanceToPolyline(middle, line) < rules.wallIs * spacing || crossingsAlong([a, b], line).length > 0)) continue;
    if (river && (river.nearest(middle).distance < river.width / 2 + rules.riverIs * spacing || river.crossed(a, b))) continue;
    if (wet(a) || wet(b) || wet(middle)) continue;
    // Nor one that bounds a special ward or runs into it.
    if (edge.cells.some((cell) => mesh.cells[cell]?.special !== undefined)) continue;
    if (specials.some((ward) => pointInPolygon(a, ward.polygon) || pointInPolygon(b, ward.polygon) || pointInPolygon(middle, ward.polygon))) continue;
    next.set(edge.a, [...(next.get(edge.a) ?? []), edge.b]);
    next.set(edge.b, [...(next.get(edge.b) ?? []), edge.a]);
  }

  // ---- Streets, nearest the centre first ------------------------------------------------------------------------
  const highways = [...roads.highways.map((highway) => highway.points), ...roads.mainStreets];
  const onto = (point: Point): Point => {
    let best = point;
    let least = Infinity;
    for (const line of highways) {
      const found = projectOnPolyline(line, point);
      if (found.distance < least) {
        least = found.distance;
        best = found.point;
      }
    }
    return best;
  };
  const size = (point: Point) => Math.hypot(point[0], point[1]);
  const starts = [...next.keys()].filter((corner) => toHighway(mesh.corners[corner] as Point) < rules.startWithin * spacing).sort((a, b) => size(mesh.corners[a] as Point) - size(mesh.corners[b] as Point) || a - b);
  const used = new Set<number>();
  /** Whether a line crosses the wall or the river, or touches water or a special ward. */
  const barred = (line: Point[]) => {
    if (walls.some((wall) => crossingsAlong(line, wall).length > 0) || (river !== undefined && crossingsAlong(line, river.line).length > 0)) return true;
    for (let at = 1; at < line.length; at++) {
      const [a, b] = [line[at - 1] as Point, line[at] as Point];
      const pieces = Math.max(1, Math.ceil(distance(a, b) / PROBE));
      for (let piece = 0; piece <= pieces; piece++) {
        const point = between(a, b, piece / pieces);
        if (wet(point) || specials.some((ward) => pointInPolygon(point, ward.polygon))) return true;
      }
    }
    return false;
  };
  for (const start of starts) {
    if ([...used].some((corner) => distance(mesh.corners[corner] as Point, mesh.corners[start] as Point) < rules.startsApart * spacing)) continue;
    const from = onto(mesh.corners[start] as Point);
    if (barred([from, mesh.corners[start] as Point])) continue;
    const chain = [start];
    const seen = new Set(chain);
    let before = from;
    for (;;) {
      const at = chain[chain.length - 1] as number;
      const here = mesh.corners[at] as Point;
      let best: number | undefined;
      let most = -Infinity;
      for (const other of next.get(at) ?? []) {
        const there = mesh.corners[other] as Point;
        if (seen.has(other) || toHighway(there) < rules.startWithin * spacing) continue;
        const cosine = ((here[0] - before[0]) * (there[0] - here[0]) + (here[1] - before[1]) * (there[1] - here[1])) / ((distance(before, here) || 1) * (distance(here, there) || 1));
        if (cosine > most) {
          most = cosine;
          best = other;
        }
      }
      if (best === undefined || most < rules.straightest) break;
      before = here;
      chain.push(best);
      seen.add(best);
    }
    if (chain.length + 1 < rules.least) continue;
    // Evened: each corner it passes through moves toward its neighbours along the street. A corner an earlier
    // street passes through stays where that street left it, and a street that evening would carry over water or
    // the wall is left as it was.
    const asLaid = chain.map((corner) => mesh.corners[corner] as Point);
    for (let round = 0; round < rules.smoothing; round++) {
      const points = [from, ...chain.map((corner) => mesh.corners[corner] as Point)];
      for (let at = 1; at < points.length - 1; at++) {
        if (used.has(chain[at - 1] as number)) continue;
        const [a, b, c] = [points[at - 1] as Point, points[at] as Point, points[at + 1] as Point];
        mesh.corners[chain[at - 1] as number] = [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4];
      }
    }
    if (barred([from, ...chain.map((corner) => mesh.corners[corner] as Point)])) chain.forEach((corner, at) => (mesh.corners[corner] = asLaid[at] as Point));
    streets.push({ points: [from, ...chain.map((corner) => mesh.corners[corner] as Point)], corners: chain });
    for (const corner of chain) used.add(corner);
  }
  // A corner moved for a later street may lie on an earlier one: each street is read off the mesh as it ended.
  for (const street of streets) if (street.corners.length > 0) street.points = [street.points[0] as Point, ...street.corners.map((corner) => mesh.corners[corner] as Point)];
  return streets;
}
