/**
 * Stage 7 of the staged generator: the mesh, whose cells are the wards.
 *
 * Seed points are scattered over the ground. Those close to a highway, the
 * river or the wall are removed, and pairs of seeds are set either side of
 * each such line, so that the line falls on the border between cells. The
 * castle and the plaza get a seed each, with one mirrored in each of their
 * sides, so that each is a cell of the mesh. The Voronoi diagram of the
 * seeds is the mesh: cells that share their corners.
 */
import { Delaunay } from 'd3-delaunay';
import type { Rng } from '../../city/random.ts';
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { distance, distanceToPolyline, pointAlongPolyline, polygonCentroid, polylineLength } from '../geometry.ts';
import type { Ground } from './ground.ts';
import type { RoadPlan } from './highways.ts';
import { add, drawFrom, left, tangentAt } from './lines.ts';
import type { SpecialWard } from './special.ts';
import type { Wall } from './wall.ts';
import type { River } from './water.ts';

export interface MeshCell {
  /** Its seed, by its place among the mesh's seeds. */
  seed: number;
  /** Its corners in order, by their place among the mesh's corners. */
  corners: number[];
  /** Whether it runs out to the edge of the diagram, and so is no ward. */
  open: boolean;
  /** The special ward it is the cell of, if it is one. */
  special?: 'plaza' | 'castle';
}

export interface MeshEdge {
  a: number;
  b: number;
  /** The cells either side of it. */
  cells: number[];
}

export interface Mesh {
  /** The spacing of seeds, in metres. */
  spacing: number;
  seeds: Point[];
  /** Corners are shared: a corner moved moves every cell and edge that has it. */
  corners: Point[];
  /** Whether each corner lies on the edge of the diagram. */
  onEdge: boolean[];
  /** One cell per seed, in the seeds' order. */
  cells: MeshCell[];
  edges: MeshEdge[];
}

export interface MeshInput {
  settings: StagedSettings;
  rng: Rng;
  radius: number;
  ground: Ground;
  roads: RoadPlan;
  river?: River;
  wall?: Wall;
  plaza?: SpecialWard;
  castle?: SpecialWard;
}

/** The lines that cell borders are made to follow: highways and the bridge roads beyond them, the river, the wall. */
export function meshLines({ roads, river, wall }: Pick<MeshInput, 'roads' | 'river' | 'wall'>): Point[][] {
  return [
    ...roads.highways.map((highway) => highway.points),
    ...roads.mainStreets,
    ...(river ? [river.line] : []),
    ...(wall ? wall.parts.map((part) => (part.closed ? [...part.points, part.points[0] as Point] : part.points)) : []),
  ];
}

/** The seed mirrored in each side of a polygon: with the seed itself, they make the polygon a cell. */
function mirrored(ward: SpecialWard): Point[] {
  return ward.polygon.map((from, at) => {
    const to = ward.polygon[(at + 1) % ward.polygon.length] as Point;
    const along = distance(from, to) || 1;
    const across: Point = [-(to[1] - from[1]) / along, (to[0] - from[0]) / along];
    const off = (ward.centre[0] - from[0]) * across[0] + (ward.centre[1] - from[1]) * across[1];
    return add(ward.centre, across, -2 * off);
  });
}

export function makeMesh({ settings, rng, radius, ground, roads, river, wall, plaza, castle }: MeshInput): Mesh {
  const rules = settings.mesh;
  const spacing = Math.min(Math.max(rules.spacing * radius, rules.min), rules.max);
  const box = { minX: ground.box.minX - spacing, minY: ground.box.minY - spacing, maxX: ground.box.maxX + spacing, maxY: ground.box.maxY + spacing };
  const lines = meshLines({ roads, ...(river && { river }), ...(wall && { wall }) });
  const specials = [plaza, castle].filter((ward): ward is SpecialWard => ward !== undefined);
  // Within twice its reach of a special ward's middle no other seed may stand, or the ward would not be a cell.
  const reaches = specials.map((ward) => 2 * Math.max(...ward.polygon.map((corner) => distance(corner, ward.centre))));
  const bySpecial = (point: Point, but = -1) => specials.some((ward, at) => at !== but && distance(point, ward.centre) < (reaches[at] as number));

  // ---- Scattered ------------------------------------------------------------------------------------------------
  let seeds: Point[] = [];
  for (let attempt = 0; attempt < rules.tries; attempt++) {
    const point: Point = [box.minX + rng.next() * (box.maxX - box.minX), box.minY + rng.next() * (box.maxY - box.minY)];
    const apart = spacing * drawFrom(rng, rules.apart);
    if (seeds.every((seed) => distance(seed, point) > apart)) seeds.push(point);
  }
  seeds = seeds.filter((seed) => lines.every((line) => distanceToPolyline(seed, line) > rules.clearOfLines * spacing));

  // ---- Paired along the lines ------------------------------------------------------------------------------------
  for (const line of lines) {
    const length = polylineLength(line);
    for (let along = rng.next() * spacing; along < length; along += spacing * drawFrom(rng, rules.pairs.every)) {
      const offset = 0.5 * spacing * drawFrom(rng, rules.pairs.offset);
      const point = pointAlongPolyline(line, along);
      if (Math.hypot(point[0], point[1]) >= rules.pairs.within * radius) continue;
      const across = left(tangentAt(line, along, length));
      seeds.push(add(point, across, offset), add(point, across, -offset));
    }
  }
  const kept: Point[] = [];
  for (const seed of seeds) {
    if (bySpecial(seed)) continue;
    if (kept.every((other) => distance(other, seed) >= rules.tooNear * spacing)) kept.push(seed);
  }

  // ---- The special wards ----------------------------------------------------------------------------------------
  const kinds: Array<'plaza' | 'castle' | undefined> = kept.map(() => undefined);
  specials.forEach((ward, at) => {
    kept.push(ward.centre);
    kinds.push(ward.kind);
    for (const seed of mirrored(ward)) {
      // One that would stand in another special ward's room is left out: the two wards then share that side's cell.
      if (bySpecial(seed, at)) continue;
      kept.push(seed);
      kinds.push(undefined);
    }
  });

  // ---- The diagram ----------------------------------------------------------------------------------------------
  const bounds: [number, number, number, number] = [box.minX - 4 * spacing, box.minY - 4 * spacing, box.maxX + 4 * spacing, box.maxY + 4 * spacing];
  const voronoi = Delaunay.from(kept).voronoi(bounds);
  const corners: Point[] = [];
  const onEdge: boolean[] = [];
  const known = new Map<string, number>();
  const cornerOf = (point: Point): number => {
    const key = `${point[0]}:${point[1]}`;
    let index = known.get(key);
    if (index === undefined) {
      index = corners.length;
      corners.push([point[0], point[1]]);
      onEdge.push(point[0] <= bounds[0] || point[1] <= bounds[1] || point[0] >= bounds[2] || point[1] >= bounds[3]);
      known.set(key, index);
    }
    return index;
  };
  const edges: MeshEdge[] = [];
  const edgeOf = new Map<string, number>();
  const cells = kept.map((_, seed): MeshCell => {
    const polygon = (voronoi.cellPolygon(seed) ?? []) as Point[];
    const ring: number[] = [];
    for (const point of polygon.slice(0, -1)) {
      const corner = cornerOf(point);
      if (ring[ring.length - 1] !== corner && ring[0] !== corner) ring.push(corner);
    }
    ring.forEach((a, at) => {
      const b = ring[(at + 1) % ring.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const found = edgeOf.get(key);
      if (found === undefined) {
        edgeOf.set(key, edges.length);
        edges.push({ a: Math.min(a, b), b: Math.max(a, b), cells: [seed] });
      } else (edges[found] as MeshEdge).cells.push(seed);
    });
    const kind = kinds[seed];
    return { seed, corners: ring, open: ring.length < 3 || ring.some((corner) => onEdge[corner]), ...(kind && { special: kind }) };
  });
  return { spacing, seeds: kept, corners, onEdge, cells, edges };
}

/** A cell's outline as it stands now. */
export const cellPolygon = (mesh: Mesh, cell: MeshCell): Point[] => cell.corners.map((corner) => mesh.corners[corner] as Point);

/** The cells that are wards: closed, with their middle on the ground or near it. */
export function wardCells(mesh: Mesh, ground: Ground, settings: StagedSettings): MeshCell[] {
  return mesh.cells.filter((cell) => !cell.open && ground.has(polygonCentroid(cellPolygon(mesh, cell)), settings.mesh.keep * mesh.spacing));
}
