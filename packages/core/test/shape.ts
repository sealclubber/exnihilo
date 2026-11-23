/**
 * Measures of a laid-out town's shape for the phase 6D.3 acceptance table: road first, arterials, districts as
 * chunks, the wall's line, wards and the lots cut from them. Each reads the layout format alone, so it measures
 * whatever made the layout. Shared by `grown.test.ts` and `scripts/measure-wards.ts`.
 */
import { type Layout, type Point, geometry } from '../src/index.ts';
import { smallestRectangle } from '../src/layout/cutting.ts';

const { distance, distanceToPolyline, polygonArea, polygonCentroid, pointInPolygon, polylineLength } = geometry;

const turnBetween = (a: Point, b: Point, c: Point) => {
  const one = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const other = Math.atan2(c[1] - b[1], c[0] - b[0]);
  return Math.abs(((((other - one) * 180) / Math.PI + 540) % 360) - 180);
};

/**
 * The highways: segments carrying a route. For each exit, whether its highway is one unbroken chain from the exit to
 * the centre: the segments of its route joined to its exit reach the centre. A route that passes through the town has
 * two exits, each with its own chain.
 */
export function highwayChains(layout: Layout): Array<{ exit: string; unbroken: boolean; length: number }> {
  const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction.position]));
  const plaza = layout.places.find((place) => place.kind === 'plaza');
  // The centre: the plaza's edge, or the junction of any highway nearest the middle of the town.
  const highwayJunctions = [...new Set(layout.segments.filter((segment) => segment.routeId !== undefined).flatMap((segment) => [segment.fromJunctionId, segment.toJunctionId]))];
  const nearest = Math.min(...highwayJunctions.map((id) => Math.hypot(...(junctions.get(id) as Point))));
  const atCentre = (id: string) => {
    const point = junctions.get(id) as Point;
    if (plaza) return geometry.distanceToPolygonEdge(point, plaza.polygon) <= 15;
    return Math.hypot(point[0], point[1]) <= nearest + 1;
  };
  return layout.exits.map((exit) => {
    const own = layout.segments.filter((segment) => segment.routeId === exit.routeId);
    const links = new Map<string, string[]>();
    for (const segment of own) {
      links.set(segment.fromJunctionId, [...(links.get(segment.fromJunctionId) ?? []), segment.toJunctionId]);
      links.set(segment.toJunctionId, [...(links.get(segment.toJunctionId) ?? []), segment.fromJunctionId]);
    }
    const seen = new Set([exit.junctionId]);
    const queue = [exit.junctionId];
    for (let at = 0; at < queue.length; at++) for (const next of links.get(queue[at] as string) ?? []) if (!seen.has(next)) (seen.add(next), queue.push(next));
    // A route that shares the centre's junctions with another reaches the centre through them.
    const reaches = [...seen].some(atCentre) || [...seen].some((id) => layout.segments.some((segment) => segment.routeId !== undefined && segment.routeId !== exit.routeId && (segment.fromJunctionId === id || segment.toJunctionId === id)));
    return { exit: exit.id, unbroken: reaches, length: own.filter((segment) => seen.has(segment.fromJunctionId)).reduce((sum, segment) => sum + polylineLength(segment.points), 0) };
  });
}

/**
 * Arterials: main roads that carry no route, joined end to end. For each, whether it starts on a highway or a
 * bridge, and whether it starts at the centre.
 */
export function arterials(layout: Layout): Array<{ length: number; onHighway: boolean; atCentre: boolean }> {
  // A port's quay is as wide as a highway and stands in for one.
  const widest = Math.max(0, ...layout.segments.filter((segment) => segment.routeId !== undefined).map((segment) => segment.width));
  const isHighway = (segment: Layout['segments'][number]) => segment.routeId !== undefined || (segment.kind === 'arterial' && segment.width >= widest);
  const wide = layout.segments.filter((segment) => segment.kind === 'arterial' && !isHighway(segment));
  const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction.position]));
  const highwayAt = new Set(layout.segments.filter((segment) => isHighway(segment) || segment.kind === 'bridge').flatMap((segment) => [segment.fromJunctionId, segment.toJunctionId]));
  const links = new Map<string, string[]>();
  for (const segment of wide) for (const [a, b] of [[segment.fromJunctionId, segment.toJunctionId], [segment.toJunctionId, segment.fromJunctionId]] as const) links.set(a, [...(links.get(a) ?? []), b]);
  const seen = new Set<string>();
  const result: Array<{ length: number; onHighway: boolean; atCentre: boolean }> = [];
  const centre = Math.min(...[...highwayAt].map((id) => Math.hypot(...(junctions.get(id) as Point))));
  for (const start of [...links.keys()].sort()) {
    if (seen.has(start)) continue;
    const group = [start];
    seen.add(start);
    for (let at = 0; at < group.length; at++) for (const next of links.get(group[at] as string) ?? []) if (!seen.has(next)) (seen.add(next), group.push(next));
    const members = new Set(group);
    const length = wide.filter((segment) => members.has(segment.fromJunctionId)).reduce((sum, segment) => sum + polylineLength(segment.points), 0);
    const starts = group.filter((id) => highwayAt.has(id));
    result.push({ length, onHighway: starts.length > 0, atCentre: starts.length > 0 && starts.every((id) => Math.hypot(...(junctions.get(id) as Point)) <= centre + 1) });
  }
  return result;
}

/** How far the town's lots reach along the line between its first two exits, over how far across it. */
export function stretch(layout: Layout): number {
  const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction.position]));
  const ends = layout.exits.slice(0, 2).map((exit) => junctions.get(exit.junctionId) as Point);
  if (ends.length < 2) return 1;
  const [a, b] = ends as [Point, Point];
  const length = distance(a, b) || 1;
  const along: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const points = layout.lots.map((lot) => polygonCentroid(lot.polygon));
  const u = points.map((point) => point[0] * along[0] + point[1] * along[1]);
  const v = points.map((point) => -point[0] * along[1] + point[1] * along[0]);
  return (Math.max(...u) - Math.min(...u)) / (Math.max(...v) - Math.min(...v));
}

/** The share of district boundary length that lies along a highway, an arterial or the water. */
export function districtEdges(layout: Layout): number {
  const lines = layout.segments.filter((segment) => segment.kind === 'arterial' || segment.kind === 'bridge').map((segment) => segment.points);
  const keyOf = (a: Point, b: Point) => [a, b].map((point) => point.map((value) => value.toFixed(2)).join(',')).sort().join('|');
  const owners = new Map<string, Set<string>>();
  for (const area of layout.districtAreas) {
    for (const polygon of area.polygons) {
      polygon.forEach((point, index) => {
        const key = keyOf(point, polygon[(index + 1) % polygon.length] as Point);
        owners.set(key, (owners.get(key) ?? new Set()).add(area.districtId));
      });
    }
  }
  const river = layout.waters.find((water) => water.kind === 'river');
  let total = 0;
  let onRoads = 0;
  for (const area of layout.districtAreas) {
    for (const polygon of area.polygons) {
      polygon.forEach((point, index) => {
        const next = polygon[(index + 1) % polygon.length] as Point;
        const owned = owners.get(keyOf(point, next)) as Set<string>;
        if (owned.size < 2 || [...owned].sort()[0] !== area.districtId) return;
        const length = distance(point, next);
        const middle: Point = [(point[0] + next[0]) / 2, (point[1] + next[1]) / 2];
        total += length;
        const byRoad = lines.some((line) => distanceToPolyline(middle, line) < 3);
        const byWater = river !== undefined && river.kind === 'river' && distanceToPolyline(middle, river.centreLine) < river.width + 30;
        if (byRoad || byWater) onRoads += length;
      });
    }
  }
  return onRoads / (total || 1);
}

/** The districts whose blocks ring the centre without covering it: seen from the centre, they lie in every direction. */
export function ringDistricts(layout: Layout): string[] {
  return layout.districtAreas
    .filter((area) => {
      if (area.polygons.some((polygon) => pointInPolygon([0, 0], polygon))) return false;
      const reach = 5000;
      for (let index = 0; index < 16; index++) {
        const angle = (index / 16) * 2 * Math.PI;
        const ray: Point[] = [[0, 0], [Math.cos(angle) * reach, Math.sin(angle) * reach]];
        if (!area.polygons.some((polygon) => polygon.some((point, at) => geometry.piecesCross(ray[0] as Point, ray[1] as Point, point, polygon[(at + 1) % polygon.length] as Point)))) return false;
      }
      return true;
    })
    .map((area) => area.districtId);
}

/** Each line of a wall: its sharpest turn between consecutive points away from its gates and its ends, and its longest diameter over its shortest width. */
export function wallShape(layout: Layout): Array<{ worstTurn: number; diameters: number }> {
  const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction.position]));
  return layout.walls.flatMap((wall) => wall.lines.map((line) => ({ wall, line }))).map(({ wall, line }) => {
    const gates = wall.gates.map((gate) => junctions.get(gate.junctionId) as Point);
    let worstTurn = 0;
    const count = line.length;
    // An open line's last stretches run square to the bank: its two ends are left out.
    for (let index = wall.closed ? 1 : 2; index < count - (wall.closed ? 0 : 2); index++) {
      const [a, b, c] = [line[(index - 1 + count) % count] as Point, line[index] as Point, line[(index + 1) % count] as Point];
      if (gates.some((gate) => distance(gate, b) < 1e-6)) continue;
      worstTurn = Math.max(worstTurn, turnBetween(a, b, c));
    }
    let longest = 0;
    for (const a of line) for (const b of line) longest = Math.max(longest, distance(a, b));
    let shortest = Infinity;
    for (let degrees = 0; degrees < 180; degrees += 2) {
      const angle = (degrees * Math.PI) / 180;
      const values = line.map((point) => point[0] * Math.cos(angle) + point[1] * Math.sin(angle));
      shortest = Math.min(shortest, Math.max(...values) - Math.min(...values));
    }
    return { worstTurn, diameters: longest / (shortest || 1) };
  });
}

/** A lot's length over its width: the sides of the smallest rectangle round it. */
export function aspect(polygon: Point[]): number {
  const rect = smallestRectangle(polygon);
  return Math.hypot(...rect.long) / Math.max(1e-9, Math.hypot(...rect.short));
}

/** A lot's width: the short side of the smallest rectangle round it. */
export function width(polygon: Point[]): number {
  const rect = smallestRectangle(polygon);
  return Math.hypot(...rect.short);
}

/** The median lot's length over width; the share more than four times as long as wide and the number more than six; how many are under 4 m wide, and the narrowest. */
export function lotShapes(layout: Layout): { median: number; overFour: number; overSix: number; under4: number; narrowest: number } {
  const values = layout.lots.map((lot) => aspect(lot.polygon)).sort((a, b) => a - b);
  const widths = layout.lots.map((lot) => width(lot.polygon));
  return {
    median: values[Math.floor(values.length / 2)] ?? 0,
    overFour: values.filter((value) => value > 4).length / (values.length || 1),
    overSix: values.filter((value) => value > 6).length,
    under4: widths.filter((value) => value < 4).length,
    narrowest: Math.min(...widths),
  };
}

/** For each district, the spread of its lots' areas: their standard deviation over their mean. */
export function sizeSpread(layout: Layout): Map<string, number> {
  const areas = new Map<string, number[]>();
  for (const lot of layout.lots) areas.set(lot.districtId, [...(areas.get(lot.districtId) ?? []), polygonArea(lot.polygon)]);
  return new Map([...areas].map(([district, list]) => {
    const mean = list.reduce((sum, value) => sum + value, 0) / list.length;
    return [district, Math.sqrt(list.reduce((sum, value) => sum + (value - mean) ** 2, 0) / list.length) / mean];
  }));
}

/** Each ward (block): its growth rank, its area, how many lots stand in it and how much of it they cover. */
export function wards(layout: Layout): Array<{ rank: number; area: number; lots: number; coverage: number }> {
  const blocks = layout.blocks ?? [];
  const filed = blocks.map(() => ({ lots: 0, area: 0 }));
  const boxes = blocks.map((block) => geometry.boxOf(block.polygon));
  for (const lot of layout.lots) {
    const middle = polygonCentroid(lot.polygon);
    const at = blocks.findIndex((block, index) => {
      const box = boxes[index] as ReturnType<typeof geometry.boxOf>;
      return middle[0] >= box.minX && middle[0] <= box.maxX && middle[1] >= box.minY && middle[1] <= box.maxY && pointInPolygon(middle, block.polygon);
    });
    if (at < 0) continue;
    (filed[at] as { lots: number }).lots++;
    (filed[at] as { area: number }).area += polygonArea(lot.polygon);
  }
  return blocks.map((block, at) => ({ rank: block.growthRank, area: polygonArea(block.polygon), lots: (filed[at] as { lots: number }).lots, coverage: (filed[at] as { area: number }).area / polygonArea(block.polygon) }));
}

/** The share of lots entered from a lane. */
export function laneShare(layout: Layout): number {
  const kinds = new Map(layout.segments.map((segment) => [segment.id, segment.kind]));
  return layout.lots.filter((lot) => kinds.get(lot.entrance.segmentId) === 'lane').length / (layout.lots.length || 1);
}

/** How far each arterial's far end lies beyond the nearest ward: past the town's ground, less the street at its edge. */
export function arterialOverrun(layout: Layout): number[] {
  const blocks = layout.blocks ?? [];
  const degree = new Map<string, number>();
  for (const segment of layout.segments) for (const id of [segment.fromJunctionId, segment.toJunctionId]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const widest = Math.max(0, ...layout.segments.filter((segment) => segment.routeId !== undefined).map((segment) => segment.width));
  const ends = layout.segments.filter((segment) => segment.kind === 'arterial' && segment.routeId === undefined && segment.width < widest).flatMap((segment) => [segment.fromJunctionId, segment.toJunctionId].filter((id) => degree.get(id) === 1).map((id) => (id === segment.fromJunctionId ? segment.points[0] : segment.points[segment.points.length - 1]) as Point));
  return ends.map((end) => Math.min(...blocks.map((block) => (pointInPolygon(end, block.polygon) ? 0 : geometry.distanceToPolygonEdge(end, block.polygon)))));
}

/** How far from square to the river each bridge stands, in degrees. */
export function bridgeAngles(layout: Layout): number[] {
  const river = layout.waters.find((water) => water.kind === 'river');
  if (!river || river.kind !== 'river') return [];
  return layout.segments.filter((segment) => segment.kind === 'bridge').map((segment) => {
    const [a, b] = [segment.points[0] as Point, segment.points[segment.points.length - 1] as Point];
    const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let nearest = 1;
    for (let at = 1; at < river.centreLine.length; at++) if (distance(river.centreLine[at] as Point, middle) < distance(river.centreLine[nearest] as Point, middle)) nearest = at;
    const [p, q] = [river.centreLine[Math.max(0, nearest - 1)] as Point, river.centreLine[Math.min(river.centreLine.length - 1, nearest + 1)] as Point];
    const flow = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const across = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const between = Math.abs(((((across - flow) * 180) / Math.PI + 540) % 180));
    return Math.abs(90 - Math.min(between, 180 - between));
  });
}

/**
 * The longest stretch of wall, in metres, that runs within `near` metres of water, and the longest that runs along a
 * roadway (within half the wall's and half the road's width of its centre line, the road running within 30 degrees
 * of the wall's line), away from the gates. Sampled every metre. An open line's last stretch at each end, which runs
 * square to the bank to meet it, is not counted as running along the water.
 */
export function wallStretches(layout: Layout, near = 12): { alongWater: number; onRoad: number } {
  const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction.position]));
  const river = layout.waters.find((water) => water.kind === 'river');
  const sea = layout.waters.find((water) => water.kind === 'sea');
  const toWater = (point: Point) =>
    Math.min(
      river && river.kind === 'river' ? distanceToPolyline(point, river.centreLine) - river.width / 2 : Infinity,
      sea && sea.kind === 'sea' ? (pointInPolygon(point, sea.polygon) ? 0 : geometry.distanceToPolygonEdge(point, sea.polygon)) : Infinity,
    );
  /** The direction of a polyline where it passes nearest a point. */
  const directionNear = (points: readonly Point[], point: Point): Point => {
    let best: Point = [1, 0];
    let gap = Infinity;
    for (let k = 1; k < points.length; k++) {
      const [a, b] = [points[k - 1] as Point, points[k] as Point];
      const away = geometry.distanceToPiece(point, a, b);
      if (away < gap) {
        gap = away;
        const run = distance(a, b) || 1;
        best = [(b[0] - a[0]) / run, (b[1] - a[1]) / run];
      }
    }
    return best;
  };
  let alongWater = 0;
  let onRoad = 0;
  for (const wall of layout.walls) {
    const gates = wall.gates.map((gate) => junctions.get(gate.junctionId) as Point);
    for (const raw of wall.lines) {
      const line = wall.closed ? [...raw, raw[0] as Point] : raw;
      const total = polylineLength(line);
      let water = 0;
      let road = 0;
      let walked = 0;
      for (let k = 1; k < line.length; k++) {
        const [a, b] = [line[k - 1] as Point, line[k] as Point];
        const run = distance(a, b);
        const along: Point = [(b[0] - a[0]) / (run || 1), (b[1] - a[1]) / (run || 1)];
        const steps = Math.max(1, Math.round(run));
        for (let step = 0; step < steps; step++) {
          const point: Point = [a[0] + (b[0] - a[0]) * ((step + 0.5) / steps), a[1] + (b[1] - a[1]) * ((step + 0.5) / steps)];
          const at = walked + (run * (step + 0.5)) / steps;
          const piece = run / steps;
          const end = !wall.closed && (at < 15 || at > total - 15);
          water = !end && toWater(point) < near ? water + piece : 0;
          const atGate = gates.some((gate) => distance(gate, point) < 10);
          const alongRoad =
            !atGate &&
            layout.segments.some((segment) => {
              if (distanceToPolyline(point, segment.points) >= segment.width / 2 + wall.width / 2) return false;
              const direction = directionNear(segment.points, point);
              return Math.abs(direction[0] * along[0] + direction[1] * along[1]) > Math.cos(Math.PI / 6);
            });
          road = alongRoad ? road + piece : 0;
          alongWater = Math.max(alongWater, water);
          onRoad = Math.max(onRoad, road);
        }
        walked += run;
      }
    }
  }
  return { alongWater, onRoad };
}
