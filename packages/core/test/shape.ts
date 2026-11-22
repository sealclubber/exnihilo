/**
 * Measures of a laid-out town's shape for the phase 6D.2 acceptance table: road first, through streets, elongated
 * blocks, strip lots, districts as chunks, the wall's line and the order of growth. Each reads the layout format
 * alone, so it measures whatever made the layout. Shared by `grown.test.ts` and `scripts/measure-layout.ts`.
 */
import { type Layout, type Point, geometry } from '../src/index.ts';

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

/** Arterials: streets as wide as the given width, joined end to end; where each begins, and whether that is on a highway away from the centre. */
export function arterials(layout: Layout, width: number): Array<{ length: number; onHighway: boolean; atCentre: boolean }> {
  const wide = layout.segments.filter((segment) => segment.kind === 'street' && Math.abs(segment.width - width) < 1e-6);
  const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction.position]));
  const highwayAt = new Set(layout.segments.filter((segment) => segment.kind === 'arterial').flatMap((segment) => [segment.fromJunctionId, segment.toJunctionId]));
  const links = new Map<string, string[]>();
  for (const segment of wide) for (const [a, b] of [[segment.fromJunctionId, segment.toJunctionId], [segment.toJunctionId, segment.fromJunctionId]] as const) links.set(a, [...(links.get(a) ?? []), b]);
  const seen = new Set<string>();
  const result: Array<{ length: number; onHighway: boolean; atCentre: boolean }> = [];
  for (const start of [...links.keys()].sort()) {
    if (seen.has(start)) continue;
    const group = [start];
    seen.add(start);
    for (let at = 0; at < group.length; at++) for (const next of links.get(group[at] as string) ?? []) if (!seen.has(next)) (seen.add(next), group.push(next));
    const members = new Set(group);
    const length = wide.filter((segment) => members.has(segment.fromJunctionId)).reduce((sum, segment) => sum + polylineLength(segment.points), 0);
    const starts = group.filter((id) => highwayAt.has(id));
    const centre = Math.min(...[...highwayAt].map((id) => Math.hypot(...(junctions.get(id) as Point))));
    result.push({ length, onHighway: starts.length > 0, atCentre: starts.some((id) => Math.hypot(...(junctions.get(id) as Point)) <= centre + 1) && starts.every((id) => Math.hypot(...(junctions.get(id) as Point)) <= centre + 1) });
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

/**
 * Streets passing through junctions: at each junction the two ends that continue each other most nearly straight,
 * within `within` degrees, are one street. Returns the streets so traced with the junctions each passes and the
 * largest turn at any of them, and the share of three-way junctions with one pair of arms within `straight` degrees.
 */
export function throughStreets(layout: Layout, within = 40, straight = 25) {
  const streets = layout.segments.filter((segment) => segment.kind !== 'bridge');
  const ends = new Map<string, Array<{ segment: number; direction: Point }>>();
  streets.forEach((segment, index) => {
    const [first, second] = [segment.points[0] as Point, segment.points[1] as Point];
    const [last, before] = [segment.points[segment.points.length - 1] as Point, segment.points[segment.points.length - 2] as Point];
    // The direction each end leaves its junction in.
    ends.set(segment.fromJunctionId, [...(ends.get(segment.fromJunctionId) ?? []), { segment: index, direction: [second[0] - first[0], second[1] - first[1]] }]);
    ends.set(segment.toJunctionId, [...(ends.get(segment.toJunctionId) ?? []), { segment: index, direction: [before[0] - last[0], before[1] - last[1]] }]);
  });
  const deviation = (a: Point, b: Point) => {
    // Leaving in opposite directions is straight on.
    const cosine = -(a[0] * b[0] + a[1] * b[1]) / ((Math.hypot(...a) * Math.hypot(...b)) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
  };
  const partner = new Map<string, number>();
  let threeWay = 0;
  let tees = 0;
  for (const [junction, list] of ends) {
    const pairs: Array<{ dev: number; a: number; b: number }> = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.push({ dev: deviation((list[i] as { direction: Point }).direction, (list[j] as { direction: Point }).direction), a: i, b: j });
    pairs.sort((x, y) => x.dev - y.dev);
    if (list.length === 3) {
      threeWay++;
      if ((pairs[0]?.dev ?? 180) <= straight) tees++;
    }
    const used = new Set<number>();
    for (const { dev, a, b } of pairs) {
      if (dev > within || used.has(a) || used.has(b)) continue;
      used.add(a).add(b);
      partner.set(`${junction}:${(list[a] as { segment: number }).segment}`, (list[b] as { segment: number }).segment);
      partner.set(`${junction}:${(list[b] as { segment: number }).segment}`, (list[a] as { segment: number }).segment);
    }
  }
  const seen = new Set<number>();
  const chains: Array<{ length: number; passes: number; worstTurn: number }> = [];
  streets.forEach((segment, index) => {
    if (seen.has(index)) return;
    seen.add(index);
    let length = polylineLength(segment.points);
    let passes = 0;
    let worstTurn = 0;
    for (const from of [segment.toJunctionId, segment.fromJunctionId]) {
      let junction: string = from;
      let current = index;
      for (;;) {
        const next = partner.get(`${junction}:${current}`);
        if (next === undefined || seen.has(next)) break;
        seen.add(next);
        passes++;
        const nextSegment = streets[next] as (typeof streets)[number];
        const into = (streets[current] as (typeof streets)[number]);
        const inPoints = into.toJunctionId === junction ? into.points : [...into.points].reverse();
        const outPoints = nextSegment.fromJunctionId === junction ? nextSegment.points : [...nextSegment.points].reverse();
        worstTurn = Math.max(worstTurn, turnBetween(inPoints[inPoints.length - 2] as Point, inPoints[inPoints.length - 1] as Point, outPoints[1] as Point));
        length += polylineLength(nextSegment.points);
        junction = nextSegment.fromJunctionId === junction ? nextSegment.toJunctionId : nextSegment.fromJunctionId;
        current = next;
      }
    }
    chains.push({ length, passes, worstTurn });
  });
  // Turns within a segment, at the corners it passes without a junction.
  let insideTurn = 0;
  for (const segment of streets) for (let at = 2; at < segment.points.length; at++) insideTurn = Math.max(insideTurn, turnBetween(segment.points[at - 2] as Point, segment.points[at - 1] as Point, segment.points[at] as Point));
  const total = chains.reduce((sum, chain) => sum + chain.length, 0);
  return {
    throughShare: chains.filter((chain) => chain.passes >= 3).reduce((sum, chain) => sum + chain.length, 0) / (total || 1),
    teeShare: tees / (threeWay || 1),
    worstTurnAtJunction: Math.max(0, ...chains.map((chain) => chain.worstTurn)),
    worstTurnInSegment: insideTurn,
  };
}

/** A convex polygon's length over its depth: the sides of the smallest rectangle round it. */
export function elongation(polygon: readonly Point[]): number {
  let best = { area: Infinity, ratio: 1 };
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index] as Point;
    const b = polygon[(index + 1) % polygon.length] as Point;
    const length = distance(a, b);
    if (length < 1e-9) continue;
    const u: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const us = polygon.map((point) => point[0] * u[0] + point[1] * u[1]);
    const vs = polygon.map((point) => -point[0] * u[1] + point[1] * u[0]);
    const [w, h] = [Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs)];
    if (w * h < best.area) best = { area: w * h, ratio: Math.max(w, h) / Math.max(1e-9, Math.min(w, h)) };
  }
  return best.ratio;
}

/** The share of lots that are strips: four sides, the two longest within 15 degrees of each other. */
export function stripShare(layout: Layout): number {
  const strips = layout.lots.filter((lot) => {
    if (lot.polygon.length !== 4) return false;
    const sides = lot.polygon.map((point, index) => ({ from: point, to: lot.polygon[(index + 1) % 4] as Point })).map((side) => ({ ...side, length: distance(side.from, side.to) }));
    const order = [...sides.keys()].sort((a, b) => (sides[b] as { length: number }).length - (sides[a] as { length: number }).length);
    const [one, two] = [sides[order[0] as number] as (typeof sides)[number], sides[order[1] as number] as (typeof sides)[number]];
    const angle = (side: (typeof sides)[number]) => Math.atan2(side.to[1] - side.from[1], side.to[0] - side.from[0]);
    const between = Math.abs(((((angle(one) - angle(two)) * 180) / Math.PI + 360) % 180));
    return Math.min(between, 180 - between) <= 15;
  });
  return strips.length / (layout.lots.length || 1);
}

/** Blocks with lots whose middle has open ground wider than `wide` metres that no lot covers. */
export function emptyMiddles(layout: Layout, wide = 12): number {
  const blocks = layout.blocks ?? [];
  const lotsIn = new Map<string, Layout['lots']>();
  for (const lot of layout.lots) {
    const middle = polygonCentroid(lot.polygon);
    const block = blocks.find((entry) => pointInPolygon(middle, entry.polygon));
    if (block) lotsIn.set(block.id, [...(lotsIn.get(block.id) ?? []), lot]);
  }
  let count = 0;
  for (const block of blocks) {
    const lots = lotsIn.get(block.id);
    if (!lots) continue;
    const box = geometry.boxOf(block.polygon);
    let empty = false;
    for (let x = box.minX; x <= box.maxX && !empty; x += 2) {
      for (let y = box.minY; y <= box.maxY && !empty; y += 2) {
        const point: Point = [x, y];
        if (!pointInPolygon(point, block.polygon) || geometry.distanceToPolygonEdge(point, block.polygon) <= wide / 2 + 6) continue;
        if (lots.some((lot) => pointInPolygon(point, lot.polygon) || geometry.distanceToPolygonEdge(point, lot.polygon) <= wide / 2)) continue;
        empty = true;
      }
    }
    if (empty) count++;
  }
  return count;
}

/** The share of district boundary length that lies along a highway, an arterial or the water. */
export function districtEdges(layout: Layout, arterialWidth: number): number {
  const lines = layout.segments.filter((segment) => segment.kind === 'arterial' || segment.kind === 'bridge' || (segment.kind === 'street' && segment.width >= arterialWidth)).map((segment) => segment.points);
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

/** A wall's sharpest turn between consecutive points away from its gates, and its longest diameter over its shortest width. */
export function wallShape(layout: Layout): Array<{ worstTurn: number; diameters: number }> {
  const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction.position]));
  return layout.walls.map((wall) => {
    const gates = wall.gates.map((gate) => junctions.get(gate.junctionId) as Point);
    const line = wall.line;
    let worstTurn = 0;
    const count = line.length;
    for (let index = 1; index < count - (wall.closed ? 0 : 1); index++) {
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

/** Whether every block has a growth rank, and the share of the oldest tenth that touches a highway. */
export function growthOrder(layout: Layout, highwayWidth: number): { ranked: boolean; oldestOnHighway: number } {
  const blocks = layout.blocks ?? [];
  const highways = layout.segments.filter((segment) => segment.kind === 'arterial').map((segment) => segment.points);
  const oldest = [...blocks].sort((a, b) => a.growthRank - b.growthRank).slice(0, Math.max(1, Math.round(blocks.length / 10)));
  const touches = oldest.filter((block) => highways.some((line) => geometry.distancePolygonToPolyline(block.polygon, line) <= highwayWidth / 2 + 1));
  return { ranked: blocks.length > 0 && blocks.every((block) => block.growthRank >= 0 && block.growthRank <= 1), oldestOnHighway: touches.length / (oldest.length || 1) };
}

/** The median of block length over depth, for the blocks that hold lots. */
export function medianElongation(layout: Layout): number {
  const blocks = (layout.blocks ?? []).filter((block) => block.districtId !== undefined && polygonArea(block.polygon) > 0);
  const values = blocks.map((block) => elongation(block.polygon)).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}
