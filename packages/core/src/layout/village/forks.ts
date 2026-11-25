/**
 * Step 4 of the village generator: central forks.
 *
 * From the pack's `forks.from` buildings, lanes fork off the road near the
 * centre at a slant; some loop back to the road farther out. Two forks in a
 * smaller village, three in a larger. They leave the road arms in turn, each
 * round a little farther out, so that they do not all meet at one point. At
 * a crossroads, curved links join neighbouring arms. A lane is kept clear of
 * the water and of the anchors, or drawn again.
 */
import type { Rng } from '../../city/random.ts';
import type { VillageSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { pointAlongPolyline, polylineLength, projectOnPolyline } from '../geometry.ts';
import { chaikin } from '../lines.ts';
import { add, between, dot, drawFrom, left, size, stray, tangentAt } from '../staged/lines.ts';
import type { Coast } from '../staged/water.ts';
import { DRY, type Ground } from './ground.ts';
import type { Way } from './roads.ts';

/** A road leaving the centre: the way, where along it the centre is, and which way along it the arm runs. */
export interface Arm {
  way: Way;
  from: number;
  direction: 1 | -1;
  /** Its bearing from the centre, in radians from east, for ordering arms round the centre. */
  angle: number;
}

export interface ForkInput {
  settings: VillageSettings;
  rng: Rng;
  ground: Ground;
  buildings: number;
  /** Whether the village is a crossroads, whose arms are joined by links. */
  crossroads: boolean;
  green?: readonly Point[];
  coast?: Coast;
}

const CENTRE: Point = [0, 0];
/** How far along an arm its direction from the centre is taken, in metres. */
const PROBE = 60;
/** A road that passes farther than this from the centre has no arms there, in metres. */
const ARM_NEAR = 15;
/** A lane is walked in steps of this many metres when it is cut short at the water. */
const WALK = 4;
/** A lane shorter than this once cut short at the water is not kept, in metres. */
const SHORTEST = 40;
/** The shares of a loop's length its first bend is taken along it, and of its bow the bend before it rejoins. */
const LOOP_LEAVE = 0.2;
const LOOP_RETURN = 0.25;

/** The arms of the roads at the centre, in order round it. */
export function armsOf(roads: readonly Way[]): Arm[] {
  const arms: Arm[] = [];
  for (const way of roads) {
    if (way.kind !== 'road') continue;
    const found = projectOnPolyline(way.points, CENTRE);
    if (found.distance > ARM_NEAR) continue;
    const length = polylineLength(way.points);
    for (const direction of [1, -1] as const) {
      const to = found.along + direction * PROBE;
      if (to < 0 || to > length) continue;
      const [x, y] = pointAlongPolyline(way.points, to);
      arms.push({ way, from: found.along, direction, angle: Math.atan2(y, x) });
    }
  }
  return arms.sort((a, b) => a.angle - b.angle);
}

export function layForks({ settings, rng, ground, buildings, crossroads, green, coast }: ForkInput): { lanes: Way[]; notes: string[] } {
  const notes: string[] = [];
  const lanes: Way[] = [];
  const { forks: rules, links } = settings;
  if (buildings < rules.from) return { lanes, notes };
  const width = settings.widths.lane;
  const arms = armsOf(ground.ways);
  if (arms.length === 0) return { lanes, notes: ['no road passes the centre, so no lane forks off it'] };
  const greenMiddle = green && green.reduce((sum, point): Point => [sum[0] + point[0] / green.length, sum[1] + point[1] / green.length], [0, 0]);

  /** A lane cut short where it comes near the water, or nothing if too little is left or it meets an anchor. */
  const kept = (points: Point[]): Point[] | undefined => {
    const length = polylineLength(points);
    let end = length;
    for (let along = 0; along <= length; along += WALK) {
      if (!ground.dry([pointAlongPolyline(points, along)], width / 2 + DRY + settings.gap)) {
        end = along - WALK;
        break;
      }
    }
    if (end < SHORTEST) return undefined;
    const line = end < length ? [...points.filter((_, at) => polylineLength(points.slice(0, at + 1)) < end), pointAlongPolyline(points, end)] : points;
    return ground.clearLine(line, width, settings.gap) ? line : undefined;
  };

  // ---- Forks off the road near the centre ---------------------------------------------------------------------------
  const count = (rules.counts.find((entry) => entry.below === undefined || buildings < entry.below) ?? (rules.counts[rules.counts.length - 1] as { forks: number })).forks;
  for (let k = 0; k < count; k++) {
    const arm = arms[k % arms.length] as Arm;
    const round = Math.floor(k / arms.length);
    let laid: Point[] | undefined;
    for (let attempt = 0; attempt < rules.tries && !laid; attempt++) {
      const length = ground.lengthOf(arm.way);
      const at = Math.min(Math.max(arm.from + arm.direction * drawFrom(rng, rules.start) * (1 + rules.startGrowth * round), 0), length);
      const start = pointAlongPolyline(arm.way.points, at);
      const forward = tangentAt(arm.way.points, at, length);
      const ahead: Point = [forward[0] * arm.direction, forward[1] * arm.direction];
      const side = (k + round + attempt) % 2 === 0 ? 1 : -1;
      let aside: Point = [left(ahead)[0] * side, left(ahead)[1] * side];
      // Away from the green and from the sea.
      if (greenMiddle && dot(aside, [greenMiddle[0] - start[0], greenMiddle[1] - start[1]]) > 0) aside = [-aside[0], -aside[1]];
      if (coast && dot(aside, coast.seaward) > 0) aside = [-aside[0], -aside[1]];
      const angle = (drawFrom(rng, rules.angle) * Math.PI) / 180;
      const heading = add([ahead[0] * Math.cos(angle), ahead[1] * Math.cos(angle)], aside, Math.sin(angle));
      const reach = drawFrom(rng, rules.length);
      let points: Point[];
      if (rng.next() < rules.loop) {
        // A loop: out from the road and back to it farther along.
        const back = Math.min(Math.max(at + arm.direction * reach * rules.loopReach, 0), length);
        const end = pointAlongPolyline(arm.way.points, back);
        const bow = drawFrom(rng, rules.loopOut);
        points = chaikin([start, add(start, heading, reach * LOOP_LEAVE), add(between(start, end), aside, bow), add(end, aside, bow * LOOP_RETURN), end], 4);
      } else points = stray(rng, start, add(start, heading, reach), rules.stray);
      laid = kept(points);
    }
    if (laid) {
      const lane: Way = { kind: 'lane', points: laid, width, routes: [] };
      lanes.push(lane);
      ground.addWay(lane);
    } else notes.push(`fork ${k + 1} could not be laid clear of the water and the anchors`);
  }

  // ---- At a crossroads, links between neighbouring arms -------------------------------------------------------------
  if (crossroads && arms.length >= 2) {
    arms.forEach((arm, at) => {
      const next = arms[(at + 1) % arms.length] as Arm;
      if (next === arm || (arms.length === 2 && at === 1)) return;
      const apart = ((next.angle - arm.angle + 2 * Math.PI) % (2 * Math.PI)) * (180 / Math.PI);
      if (apart > links.widest) return;
      let laid: Point[] | undefined;
      for (let attempt = 0; attempt < rules.tries && !laid; attempt++) {
        const radius = drawFrom(rng, links.radius);
        const a = pointAlongPolyline(arm.way.points, arm.from + arm.direction * radius);
        const b = pointAlongPolyline(next.way.points, next.from + next.direction * radius * drawFrom(rng, links.spread));
        const middle = between(a, b);
        if (size(middle) < 1e-6) continue;
        const bulge = drawFrom(rng, links.bulge);
        const bowed: Point = [middle[0] * bulge, middle[1] * bulge];
        const points = chaikin([a, bowed, b], 4);
        // A link that cannot reach the arm beyond is no link.
        const line = kept(points);
        laid = line && line.length === points.length ? line : undefined;
      }
      if (laid) {
        const lane: Way = { kind: 'lane', points: laid, width, routes: [] };
        lanes.push(lane);
        ground.addWay(lane);
      } else notes.push('a link between two arms could not be laid clear of the water and the anchors');
    });
  }
  return { lanes, notes };
}
