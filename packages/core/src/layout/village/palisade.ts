/**
 * Step 7 of the village generator: the palisade, for a village flagged
 * `walls`, fitted after all plots.
 *
 * It is a near-circle round every plot and anchor, its axes along the spread
 * of the plots and never far from round, with a slight wobble, grown until
 * everything is well inside. Where a road passes it has a gap; where it would
 * cross water it stops at the bank. A lane's tail that runs out beyond it,
 * past every plot, is cut off at the palisade.
 */
import type { Rng } from '../../city/random.ts';
import type { VillageSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { distanceToPolygonEdge, pointAlongPolyline, pointInPolygon, polylineLength, slicePolyline } from '../geometry.ts';
import { crossingsAlong } from '../staged/lines.ts';
import type { Coast, River } from '../staged/water.ts';
import type { Way } from './roads.ts';

export interface Palisade {
  /** The closed ring it follows. */
  ring: Point[];
  /** The lengths actually built: the ring less its gaps for roads and water. */
  lines: Point[][];
  width: number;
}

export interface PalisadeInput {
  settings: VillageSettings;
  rng: Rng;
  /** The outlines it must enclose: every plot and anchor on land. */
  outlines: readonly (readonly Point[])[];
  ways: Way[];
  river?: River;
  coast?: Coast;
}

/** The ring is walked in steps of this many metres when its gaps are cut. */
const WALK = 2;
/** The least length of palisade kept between two gaps, in metres. */
const SHORTEST = 4;

export function fitPalisade({ settings, rng, outlines, ways, river, coast }: PalisadeInput): { palisade: Palisade; notes: string[] } {
  const rules = settings.palisade;
  const notes: string[] = [];
  const points = outlines.flat();
  const middle = points.reduce((sum, point): Point => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]);
  // The axes of the spread of the points: the eigenvectors of their covariance.
  let [xx, xy, yy] = [0, 0, 0];
  for (const [x, y] of points) {
    const [dx, dy] = [x - middle[0], y - middle[1]];
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const major: Point = [Math.cos(angle), Math.sin(angle)];
  const minor: Point = [-major[1], major[0]];
  // Centred on the middle of the village's extent along each axis, so that it is no larger than it must be.
  let [low1, high1, low2, high2] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [x, y] of points) {
    const [dx, dy] = [x - middle[0], y - middle[1]];
    const [a, b] = [dx * major[0] + dy * major[1], dx * minor[0] + dy * minor[1]];
    [low1, high1, low2, high2] = [Math.min(low1, a), Math.max(high1, a), Math.min(low2, b), Math.max(high2, b)];
  }
  const centre: Point = [middle[0] + major[0] * (low1 + high1) / 2 + minor[0] * (low2 + high2) / 2, middle[1] + major[1] * (low1 + high1) / 2 + minor[1] * (low2 + high2) / 2];
  let [r1, r2] = [(high1 - low1) / 2, (high2 - low2) / 2];
  // Never far from round.
  [r1, r2] = [Math.max(r1, rules.round * r2), Math.max(r2, rules.round * r1)];
  const phase = rng.next() * 2 * Math.PI;
  const ringAt = (scale: number): Point[] =>
    Array.from({ length: rules.points }, (_, k) => {
      const theta = (2 * Math.PI * k) / rules.points;
      const wobble = 1 + rules.wobble[0] * Math.sin(3 * theta + phase) + rules.wobble[1] * Math.sin(5 * theta + 2 * phase);
      const [a, b] = [Math.cos(theta) * r1 * scale * wobble, Math.sin(theta) * r2 * scale * wobble];
      return [centre[0] + major[0] * a + minor[0] * b, centre[1] + major[1] * a + minor[1] * b];
    });
  const encloses = (ring: Point[]) => points.every((point) => pointInPolygon(point, ring) && distanceToPolygonEdge(point, ring) >= rules.clear);
  let scale = 1;
  let ring = ringAt(scale);
  while (!encloses(ring) && scale < rules.most) {
    scale += rules.grow;
    ring = ringAt(scale);
  }
  if (!encloses(ring)) notes.push(`the palisade could not be fitted ${rules.clear} m clear of every plot within ${rules.most} times its first size`);

  // A lane's tail beyond the palisade is cut off where it crosses it.
  const closed = [...ring, ring[0] as Point];
  for (const way of ways) {
    if (way.kind !== 'lane') continue;
    for (const end of [1, 0]) {
      const line = end === 1 ? way.points : [...way.points].reverse();
      const tail = line[line.length - 1] as Point;
      if (pointInPolygon(tail, ring)) continue;
      const crossings = crossingsAlong(line, closed);
      const last = crossings[crossings.length - 1];
      if (last === undefined) continue;
      const kept = slicePolyline(line, 0, last);
      way.points = end === 1 ? kept : kept.reverse();
    }
  }

  // Gaps where a way passes and where the ring would be in the water.
  const length = polylineLength(closed);
  const open = (point: Point) =>
    (!river || river.gap(point) > rules.width) &&
    (!coast || coast.gap(point) > rules.width) &&
    ways.every((way) => {
      const reach = way.width / 2 + rules.gate;
      for (let k = 1; k < way.points.length; k++) {
        const [a, b] = [way.points[k - 1] as Point, way.points[k] as Point];
        const [ux, uy] = [b[0] - a[0], b[1] - a[1]];
        const run = ux * ux + uy * uy;
        const t = run === 0 ? 0 : Math.min(Math.max(((point[0] - a[0]) * ux + (point[1] - a[1]) * uy) / run, 0), 1);
        if (Math.hypot(point[0] - a[0] - ux * t, point[1] - a[1] - uy * t) < reach) return false;
      }
      return true;
    });
  // Walked from a gap, if there is one, so that no length is split where the walk begins.
  let begin = 0;
  for (let along = 0; along < length; along += WALK) {
    if (!open(pointAlongPolyline(closed, along))) {
      begin = along;
      break;
    }
  }
  const lines: Point[][] = [];
  let piece: Point[] = [];
  const flush = () => {
    if (piece.length >= 2 && polylineLength(piece) >= SHORTEST) lines.push(piece);
    piece = [];
  };
  for (let walked = 0; walked <= length; walked += WALK) {
    const point = pointAlongPolyline(closed, (begin + walked) % length);
    if (open(point)) piece.push(point);
    else flush();
  }
  flush();
  return { palisade: { ring, lines, width: rules.width }, notes };
}
