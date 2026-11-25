/**
 * Step 6 of the village generator: thicken, never lengthen.
 *
 * The road is built no farther than its cap. When the plots have used up the
 * frontage, a lane is added: some candidates are drawn, each leaving a lane or
 * the road inside the village, square to it or straight on from a lane's end,
 * and, so that not every lane is a close, lanes joining two lane ends that lie
 * near each other. A candidate that meets another way joins it. One that
 * crosses water or an anchor, comes near the green or runs alongside another
 * way is refused. Near its start it may cut through the plots lining the way
 * it leaves: those are taken away and their buildings placed again, at a cost
 * to its score; farther out it must cross no plot. The one with the most free frontage is kept,
 * favouring joins and ground nearer the centre. The caller walks it with plots
 * and asks again until every building has a plot.
 */
import type { Rng } from '../../city/random.ts';
import type { VillageSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { distanceBetweenPolylines, distancePolygonToPolyline, pointAlongPolyline, polylineLength, projectOnPolyline, slicePolyline } from '../geometry.ts';
import { chaikin, normal } from '../lines.ts';
import { add, between, crossingsAlong, dot, drawFrom, left, size, stray, tangentAt, unit } from '../staged/lines.ts';
import type { Coast } from '../staged/water.ts';
import { DRY, type Ground, plotAt } from './ground.ts';
import type { Way } from './roads.ts';

export interface ThickenInput {
  settings: VillageSettings;
  rng: Rng;
  ground: Ground;
  cap: number;
  crossroads: boolean;
  walled: boolean;
  /** How much farther than the pack's reach a lane may go, after rounds in which none would do. */
  scale: number;
  /** The least score a lane must have; nothing once a round has found none. */
  least: number;
  green?: readonly Point[];
  coast?: Coast;
}

const CENTRE: Point = [0, 0];
/** A way shorter than this is not left by a new lane, in metres. */
const SHORT_BASE = 40;
/** How near the end of a lane a candidate leaves it to run straight on, in metres. */
const NEAR_END = 12;
/** A lane is walked in steps of this many metres when it is cut short at the water. */
const WALK = 4;
/** The ends of a lane not counted when it is tested for running alongside another way, in metres. */
const BODY_TRIM = 18;
/** The first stretch of a lane, which may stay near the way it leaves, in metres. */
const FIRST_STRETCH = 30;
/** How far the middle of a lane joining two lane ends is bowed aside, as a share of their distance. */
const LOOP_BOW = 0.25;
/** A lane end with no other way nearer than this many lane widths is a dead end. */
const DEAD_END = 1.5;

/** The best lane to add, and the plots near its start it takes away; or nothing if no candidate will do. */
export function thicken({ settings, rng, ground, cap, crossroads, walled, scale, least, green, coast }: ThickenInput): { lane: Way; displaced: Set<Point[]> } | undefined {
  const rules = settings.thicken;
  const width = settings.widths.lane;
  const gap = settings.gap;
  let reach = cap * (crossroads ? rules.crossroadsReach : rules.reach) * scale;
  if (walled) reach = Math.min(reach, cap * rules.walledReach * scale);
  const ways = ground.ways;

  /** A line cut short where it comes near the water. */
  const dryPart = (points: Point[]): Point[] => {
    const length = polylineLength(points);
    for (let along = 0; along <= length; along += WALK) {
      if (!ground.dry([pointAlongPolyline(points, along)], width / 2 + DRY + gap)) return along - WALK > 0 ? slicePolyline(points, 0, along - WALK) : [points[0] as Point];
    }
    return points;
  };
  /** Free plots along both sides of a line. */
  const frontage = (points: Point[]): number => {
    const way: Way = { kind: 'lane', points, width, routes: [] };
    const length = polylineLength(points);
    let count = 0;
    for (let along = rules.box.step / 2; along + rules.box.width <= length; along += rules.box.step) {
      for (const side of [1, -1] as const) {
        const plot = plotAt(way, length, along, side, rules.box.width, rules.box.depth, gap);
        if (plot && ground.free(plot.outline)) count++;
      }
    }
    return count;
  };
  /**
   * The plots a lane would take away, if it may be laid: clear of anchors, water and the green, not alongside
   * another way, and crossing plots only near where it leaves its way.
   */
  const allowed = (points: Point[], leaves: readonly Way[]): Point[][] | undefined => {
    const length = polylineLength(points);
    if (length < rules.shortest) return undefined;
    if (size(points[points.length - 1] as Point) > reach * rules.beyond) return undefined;
    if (!ground.dry(points, width / 2 + DRY)) return undefined;
    if (green && distancePolygonToPolyline(green as Point[], points) < rules.greenClear) return undefined;
    const body = slicePolyline(points, BODY_TRIM, Math.max(length - BODY_TRIM, BODY_TRIM + 1));
    for (const other of ways) if (!leaves.includes(other) && distanceBetweenPolylines(other.points, body) < rules.alongside) return undefined;
    for (const base of leaves) if (length > FIRST_STRETCH && distanceBetweenPolylines(base.points, slicePolyline(points, FIRST_STRETCH, length)) < rules.baseClear) return undefined;
    const { plots, anchor } = ground.blockers(points, width, gap);
    if (anchor) return undefined;
    // Only plots near its start, where it leaves the frontage of its way: farther out it must find free ground.
    const near = slicePolyline(points, 0, Math.min(rules.displaceWithin, length));
    if (plots.some((plot) => distancePolygonToPolyline(plot, near) >= width / 2 + gap)) return undefined;
    return plots;
  };
  const score = (points: Point[], joined: boolean) => frontage(points) * (joined ? rules.joinBonus : 1) - rules.nearness * size(pointAlongPolyline(points, polylineLength(points) / 2)) + rng.next() * rules.luck;

  let best: { points: Point[]; score: number; displaced: Point[][] } | undefined;
  const consider = (points: Point[], joined: boolean, leaves: readonly Way[]) => {
    const displaced = allowed(points, leaves);
    if (!displaced) return;
    const value = score(points, joined) - rules.displaceCost * displaced.length;
    if (value > least && (!best || value > best.score)) best = { points, score: value, displaced };
  };

  // ---- Lanes leaving a lane, or the road inside the village ---------------------------------------------------------
  for (let k = 0; k < rules.candidates; k++) {
    const base = ways[Math.min(Math.floor(rng.next() * ways.length), ways.length - 1)] as Way;
    const length = ground.lengthOf(base);
    if (length < SHORT_BASE) continue;
    const along = Math.min(Math.max(base.kind === 'road' ? projectOnPolyline(base.points, CENTRE).along + (rng.next() * 2 - 1) * cap : (0.3 + 0.7 * rng.next()) * length, 3), length - 3);
    const start = pointAlongPolyline(base.points, along);
    if (size(start) > reach) continue;
    const forward = tangentAt(base.points, along, length);
    const atEnd = base.kind === 'lane' && along > length - NEAR_END;
    let heading: Point;
    if (atEnd) {
      const turn = normal(rng) * rules.endTurn;
      heading = add([forward[0] * Math.cos(turn), forward[1] * Math.cos(turn)], left(forward), Math.sin(turn));
    } else {
      const side = rng.next() < 0.5 ? 1 : -1;
      const turn = normal(rng) * rules.turn;
      const across: Point = [left(forward)[0] * side, left(forward)[1] * side];
      heading = add([across[0] * Math.cos(turn), across[1] * Math.cos(turn)], forward, Math.sin(turn));
    }
    const reachOut = drawFrom(rng, rules.length);
    if (coast && dot(heading, coast.seaward) > 0.3) continue;
    let points = dryPart(stray(rng, start, add(start, heading, reachOut), rules.stray));
    if (points.length < 2) continue;
    // Where it meets another way, it stops there and joins it; where it ends near one, it is carried on to it.
    let joined = false;
    let hit = Infinity;
    for (const other of ways) {
      if (other === base) continue;
      for (const crossing of crossingsAlong(points, other.points)) if (crossing > rules.joinAfter && crossing < hit) hit = crossing;
    }
    if (hit < Infinity) {
      points = slicePolyline(points, 0, hit);
      joined = true;
    } else {
      const end = points[points.length - 1] as Point;
      const near = ground.nearestWay(end, ways.filter((other) => other !== base));
      if (near && near.distance < rules.joinWithin) {
        points = [...points, near.point];
        joined = true;
      }
    }
    consider(points, joined, [base]);
  }

  // ---- Lanes joining two lane ends near each other, so that some lanes loop -----------------------------------------
  const ends: Array<{ way: Way; point: Point; heading: Point }> = [];
  for (const way of ways) {
    if (way.kind !== 'lane') continue;
    for (const at of [0, way.points.length - 1]) {
      const point = way.points[at] as Point;
      if (ways.some((other) => other !== way && projectOnPolyline(other.points, point).distance < width * DEAD_END)) continue;
      const inner = way.points[at === 0 ? 1 : at - 1] as Point;
      ends.push({ way, point, heading: unit(inner, point) });
    }
  }
  // Each dead end, straight on, so that a village growing outward always has a lane to try at its edge.
  for (const end of ends) {
    if (size(end.point) > reach) continue;
    const turn = normal(rng) * rules.endTurn;
    const heading = add([end.heading[0] * Math.cos(turn), end.heading[1] * Math.cos(turn)], left(end.heading), Math.sin(turn));
    if (coast && dot(heading, coast.seaward) > 0.3) continue;
    const points = dryPart(stray(rng, end.point, add(end.point, heading, drawFrom(rng, rules.length)), rules.stray));
    if (points.length < 2) continue;
    const near = ground.nearestWay(points[points.length - 1] as Point, ways.filter((other) => other !== end.way));
    const joined = near !== undefined && near.distance < rules.joinWithin;
    consider(joined ? [...points, (near as { point: Point }).point] : points, joined, [end.way]);
  }
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const [a, b] = [ends[i] as (typeof ends)[number], ends[j] as (typeof ends)[number]];
      const apart = Math.hypot(b.point[0] - a.point[0], b.point[1] - a.point[1]);
      if (a.way === b.way || apart > rules.loopWithin || apart < rules.shortest / 2) continue;
      if (size(between(a.point, b.point)) > reach) continue;
      // Out of each end the way it was going, and round to the other.
      const bend = LOOP_BOW * apart;
      const points = chaikin([a.point, add(a.point, a.heading, bend), add(b.point, b.heading, bend), b.point], 4);
      if (dryPart(points).length !== points.length) continue;
      consider(points, true, [a.way, b.way]);
    }
  }
  return best ? { lane: { kind: 'lane', points: best.points, width, routes: [] }, displaced: new Set(best.displaced) } : undefined;
}
