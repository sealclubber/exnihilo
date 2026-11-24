/**
 * Stage 5 of the staged generator: special wards, small and placed by rule
 * before ordinary wards exist.
 *
 * The plaza lies where the highways meet. The castle stands just off it, in
 * the widest gap between the roads that leave the centre, inside the wall,
 * and has a wall and towers of its own. Nothing later moves either, and no
 * road crosses them.
 */
import type { Rng } from '../../city/random.ts';
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { distancePolygonToPolyline } from '../geometry.ts';
import type { RoadPlan } from './highways.ts';
import { add, armsAt, cornered } from './lines.ts';
import type { Wall } from './wall.ts';
import type { Coast, River } from './water.ts';

export interface SpecialWard {
  kind: 'plaza' | 'castle';
  centre: Point;
  polygon: Point[];
  area: number;
}

export interface SpecialInput {
  settings: StagedSettings;
  rng: (step: string) => Rng;
  buildings: number;
  radius: number;
  flags: { plaza: boolean; citadel: boolean };
  roads: RoadPlan;
  wall?: Wall;
  river?: River;
  coast?: Coast;
}

const CENTRE: Point = [0, 0];
/** The sizes tried for a castle, as shares of its sides, largest first. */
const SMALLER = [1, 0.85, 0.7, 0.55];

/** The area of a special ward of a town of so many buildings. */
export function specialArea(buildings: number, settings: StagedSettings, rule: { perBuilding: number; min: number; max: number; groundShare: number }): number {
  return Math.min(Math.min(Math.max(buildings * rule.perBuilding, rule.min), rule.max), rule.groundShare * buildings * settings.extent.perBuilding);
}

/** How far the corners of a regular polygon of an area lie from its middle. */
export const cornerReach = (wanted: number, sides: number) => Math.sqrt((2 * wanted) / (sides * Math.sin((2 * Math.PI) / sides)));

/** How far a plaza reaches from the centre, at most. */
export function plazaRadius(buildings: number, settings: StagedSettings): number {
  return cornerReach(specialArea(buildings, settings, settings.plaza), settings.plaza.sides) * (1 + settings.plaza.jitter);
}

export function planSpecialWards({ settings, rng, buildings, radius, flags, roads, wall, river, coast }: SpecialInput): { plaza?: SpecialWard; castle?: SpecialWard; notes: string[] } {
  const notes: string[] = [];
  const arms = armsAt(roads.highways.map((highway) => highway.points), settings.widths.highway, settings.highways.armProbe);
  let plaza: SpecialWard | undefined;
  if (flags.plaza) {
    const wanted = specialArea(buildings, settings, settings.plaza);
    // Its sides lie square to the first road, which enters through the middle of one.
    const first = arms[0] ?? ([1, 0] as Point);
    const turn = Math.atan2(first[1], first[0]) + Math.PI / settings.plaza.sides;
    plaza = { kind: 'plaza', centre: CENTRE, polygon: cornered(rng('staged-plaza'), CENTRE, wanted, settings.plaza.sides, turn, settings.plaza.jitter), area: wanted };
  }
  let castle: SpecialWard | undefined;
  if (flags.citadel) {
    const rules = settings.castle;
    const draw = rng('staged-castle');
    const wanted = specialArea(buildings, settings, rules);
    const reach = cornerReach(wanted, rules.sides);
    const shape = cornered(draw, CENTRE, wanted, rules.sides, draw.next() * 2 * Math.PI, rules.jitter);
    const fits = (polygon: Point[]) => {
      if (wall && !(polygon.every((corner) => wall.inside(corner)) && wall.parts.every((part) => distancePolygonToPolyline(polygon, part.closed ? [...part.points, part.points[0] as Point] : part.points) >= rules.fromWall))) return false;
      if (river && distancePolygonToPolyline(polygon, river.line) - river.width / 2 < rules.fromWater) return false;
      if (coast && !(polygon.every((corner) => coast.gap(corner) >= rules.fromWater) && distancePolygonToPolyline(polygon, coast.shore) >= rules.fromWater)) return false;
      // A highway's ground reaches to the house fronts either side of it: the castle stands clear of all of it.
      if (roads.highways.some((highway) => distancePolygonToPolyline(polygon, highway.points) < settings.widths.highway / 2 + settings.wards.highwayVerge + settings.widths.wardBorder / 2 + rules.fromRoad)) return false;
      if (roads.mainStreets.some((street) => distancePolygonToPolyline(polygon, street) < settings.widths.mainStreet / 2 + rules.fromRoad)) return false;
      if (roads.harbour && distancePolygonToPolyline(polygon, roads.harbour.quay) < roads.harbour.width / 2 + rules.fromRoad) return false;
      return true;
    };
    // The gaps between the roads that leave the centre, widest first; then every way round from the widest.
    const angles = arms.map((arm) => Math.atan2(arm[1], arm[0])).sort((a, b) => a - b);
    const gaps = angles.map((angle, at) => ({ width: at + 1 < angles.length ? (angles[at + 1] as number) - angle : (angles[0] as number) + 2 * Math.PI - angle, from: angle }));
    gaps.sort((a, b) => b.width - a.width || a.from - b.from);
    const ways = gaps.length > 0 ? gaps.map((gap) => gap.from + gap.width / 2) : [draw.next() * 2 * Math.PI];
    const widest = ways[0] as number;
    for (let turned = rules.turn; turned < 360; turned += rules.turn) ways.push(widest + (turned * Math.PI) / 180);
    // With no plaza it may stand as near the centre as the roads leave room for.
    const from = plaza ? plazaRadius(buildings, settings) + reach + rules.offPlaza : reach;
    const limit = wall ? wall.long : radius;
    // Where a castle of the size asked for fits nowhere, a smaller one is tried: the same shape, scaled down.
    search: for (const scale of SMALLER) {
      for (const way of ways) {
        for (let out = from * scale; out <= Math.max(limit, from * scale); out += rules.step) {
          const centre = add(CENTRE, [Math.cos(way), Math.sin(way)], out);
          const polygon = shape.map((corner) => add(centre, corner, scale));
          if (!fits(polygon)) continue;
          castle = { kind: 'castle', centre, polygon, area: wanted * scale * scale };
          break search;
        }
      }
    }
    if (!castle) notes.push(`no ground for the castle ${wall ? 'inside the wall' : 'within the town'}, clear of roads and water`);
  }
  return { ...(plaza && { plaza }), ...(castle && { castle }), notes };
}
