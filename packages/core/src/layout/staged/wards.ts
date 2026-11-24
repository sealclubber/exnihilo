/**
 * Stage 9 of the staged generator, first half: wards.
 *
 * A ward is its cell of the mesh, less the highways, main streets, water,
 * wall and special wards that were laid before it, moved in by half a ward
 * border. The plaza and the castle are wards too, each exactly the shape it
 * was given.
 */
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { boxOf, crossingsOfPolyline, polygonArea, polygonCentroid } from '../geometry.ts';
import type { Ground } from './ground.ts';
import type { RoadPlan } from './highways.ts';
import { type Mesh, cellPolygon, wardCells } from './mesh.ts';
import { grown, lengths, widened, without } from './shapes.ts';
import type { SpecialWard } from './special.ts';
import type { MainStreet } from './streets.ts';
import type { Wall } from './wall.ts';
import type { Coast, River } from './water.ts';

export interface Ward {
  kind: 'ordinary' | 'plaza' | 'castle';
  /** The seed of the cell it was cut from, which names it, and which piece of that cell it is, largest first. */
  seed: Point;
  /** That cell, by its place in the mesh. */
  cell: number;
  piece: number;
  polygon: Point[];
  area: number;
  /** How late in the town's growth it would be built on. */
  growthRank: number;
  /** Set where an edit asks for this ward to be drawn afresh: its own streams, and no other ward's, then differ. */
  redraw?: number;
}

export interface WardInput {
  settings: StagedSettings;
  mesh: Mesh;
  ground: Ground;
  roads: RoadPlan;
  streets: MainStreet[];
  river?: River;
  coast?: Coast;
  wall?: Wall;
  plaza?: SpecialWard;
  castle?: SpecialWard;
}

type Box = ReturnType<typeof boxOf>;
const meet = (a: Box, b: Box) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

export function cutWards({ settings, mesh, ground, roads, streets, river, coast, wall, plaza, castle }: WardInput): { wards: Ward[]; holes: number } {
  const { widths, wards: rules } = settings;
  const half = widths.wardBorder / 2;
  // Everything laid before, each with the box about it, so that a cell is cut only by what is near it.
  const taken: Array<{ ring: Point[]; box: Box }> = [];
  const take = (rings: Point[][]) => rings.forEach((ring) => taken.push({ ring, box: boxOf(ring) }));
  // After the ward is moved in by half a border, its edge stands a verge beyond the roadway.
  for (const highway of roads.highways) for (const length of lengths(highway.points)) take(widened([length], widths.highway + 2 * rules.highwayVerge));
  for (const street of streets) for (const length of lengths(street.points)) take(widened([length], Math.max(widths.mainStreet + 2 * rules.mainStreetVerge - widths.wardBorder, 0.01)));
  // The quay has no verge: houses face the harbour across it.
  if (roads.harbour) take(widened([roads.harbour.quay], roads.harbour.width));
  if (river) for (const length of lengths(river.line)) take(widened([length], river.width + 2 * rules.fromWater));
  if (coast) take(grown([coast.polygon], rules.fromWater, true).rings);
  if (wall) for (const part of wall.parts) for (const length of lengths(part.closed ? [...part.points, part.points[0] as Point] : part.points)) take(widened([length], 2 * rules.fromWall));
  if (plaza) take(grown([plaza.polygon], half + rules.roundPlaza).rings);
  if (castle) take(grown([castle.polygon], half + rules.roundCastle).rings);

  const wards: Ward[] = [];
  let holes = 0;
  for (const cell of wardCells(mesh, ground, settings)) {
    if (cell.special) continue;
    const polygon = cellPolygon(mesh, cell);
    const box = boxOf(polygon);
    const cut = without([polygon], taken.filter((entry) => meet(entry.box, box)).map((entry) => entry.ring));
    const inner = grown(cut.rings, -half, false, cut.holes);
    holes += inner.holes.length;
    const seed = mesh.seeds[cell.seed] as Point;
    inner.rings
      .map((ring) => ({ ring, area: polygonArea(ring) }))
      .filter((piece) => piece.area >= rules.least)
      // A town with no bridge has no ward across its river, however near the bank its ground comes.
      .filter((piece) => roads.farBank || !river || crossingsOfPolyline([0, 0], piece.ring[0] as Point, river.line) % 2 === 0)
      .sort((a, b) => b.area - a.area)
      .forEach(({ ring, area }, piece) => wards.push({ kind: 'ordinary', seed, cell: cell.seed, piece, polygon: ring, area, growthRank: ground.rank(polygonCentroid(ring)) }));
  }
  for (const ward of [plaza, castle]) if (ward) wards.push({ kind: ward.kind, seed: ward.centre, cell: mesh.cells.findIndex((cell) => cell.special === ward.kind), piece: 0, polygon: ward.polygon, area: ward.area, growthRank: ground.rank(ward.centre) });
  return { wards, holes };
}
