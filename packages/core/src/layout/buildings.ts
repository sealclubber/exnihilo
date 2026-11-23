/**
 * Buildings: each ward cut in two again and again until the pieces are
 * building-sized. The cutting is the method of Watabou's Medieval Fantasy
 * City Generator, after the prototype in docs/prototypes/proto_combined.py.
 *
 * A piece is cut across its long axis near the middle, the cut's place and a
 * small turn both wandering with the ward's grid chaos; no turn once the piece
 * is under a few building sizes. While a piece is large the cut leaves an
 * alley, with a lane down its middle; once one cut is made without an alley,
 * none below it has one, so that every lane runs between other lanes and the
 * roads. A half under the building size, times a factor drawn by the size
 * chaos, is finished: a building, or with a small chance open ground.
 * Otherwise it is cut again.
 */
import type { Rng } from '../city/random.ts';
import type { Point } from '../schema.ts';
import { area, interiorPoint, lineThrough, smallestRectangle, splitAlong } from './cutting.ts';

/** How a ward is to be cut. */
export interface WardCut {
  polygon: Point[];
  /** The building size: a half smaller than this, times a draw, is finished. */
  size: number;
  gridChaos: number;
  sizeChaos: number;
  /** The chance a finished piece is left open. */
  open: number;
  /** The width of an alley. */
  alley: number;
  /** A piece is cut with an alley while larger than the size times this over a small draw. */
  alleyAbove: number;
  /** Cuts are square once a piece is under this many building sizes. */
  squareBelow: number;
  /** Buildings to be cut for first, largest first: a half within `match` of one's area goes to it. */
  big: number[];
  match: number;
}

export interface Piece {
  polygon: Point[];
  open: boolean;
  /** For a piece cut for a big building: which, as an index into `big`. */
  big?: number;
}

export interface CutWard {
  pieces: Piece[];
  /** The middle of every alley a cut left: each a line from one side of what was cut to the other. */
  lanes: Point[][];
}

/** No piece smaller than this many square metres is kept: it is a sliver at the edge of a cut. */
const SLIVER = 6;
/** How deep cutting goes before a piece is left as it is. */
const DEEPEST = 40;

/** Cuts a piece across its long axis at a share along it, turned by an angle, leaving a gap; returns the parts and the lane down the gap. */
export function cutAcross(polygon: Point[], at: number, angle: number, gap: number): { parts: Point[][]; lanes: Point[][] } {
  const rect = smallestRectangle(polygon);
  const middle: Point = [rect.corner[0] + rect.long[0] * at + rect.short[0] * 0.5, rect.corner[1] + rect.long[1] * at + rect.short[1] * 0.5];
  const run = Math.hypot(rect.long[0], rect.long[1]) || 1;
  const across: Point = [-rect.long[1] / run, rect.long[0] / run];
  const direction: Point = [across[0] * Math.cos(angle) - across[1] * Math.sin(angle), across[1] * Math.cos(angle) + across[0] * Math.sin(angle)];
  const normal: Point = [-direction[1], direction[0]];
  const reach = run + Math.hypot(rect.short[0], rect.short[1]) + 10;
  const side = (point: Point, offset: number) => (point[0] - middle[0]) * normal[0] + (point[1] - middle[1]) * normal[1] - offset;
  if (gap <= 0) {
    const { pieces } = splitAlong(polygon, lineThrough(middle, direction, reach));
    return { parts: pieces.filter((piece) => area(piece) > SLIVER), lanes: [] };
  }
  const shifted = (offset: number) => lineThrough([middle[0] + normal[0] * offset, middle[1] + normal[1] * offset], direction, reach);
  const parts: Point[][] = [];
  // Beyond the gap on one side; then, of what is on the other, beyond the gap on that side.
  for (const piece of splitAlong(polygon, shifted(gap / 2)).pieces) {
    if (side(interiorPoint(piece), gap / 2) > 0) parts.push(piece);
    else for (const part of splitAlong(piece, shifted(-gap / 2)).pieces) if (side(interiorPoint(part), -gap / 2) < 0) parts.push(part);
  }
  const lanes = parts.length >= 2 ? splitAlong(polygon, lineThrough(middle, direction, reach)).chords : [];
  return { parts: parts.filter((part) => area(part) > SLIVER), lanes };
}

/** Cuts a ward into pieces by the plain method, with big buildings cut for first. */
export function cutWard(plan: WardCut, rng: Rng): CutWard {
  const pieces: Piece[] = [];
  const lanes: Point[][] = [];
  const waiting = plan.big.map((size, index) => ({ size, index })).sort((a, b) => b.size - a.size || a.index - b.index);
  const cut = (polygon: Point[], alley: boolean, depth: number) => {
    const spread = 0.8 * plan.gridChaos;
    const at = (1 - spread) / 2 + rng.next() * spread;
    const angle = (rng.next() - 0.5) * (Math.PI / 6) * plan.gridChaos * (area(polygon) < plan.size * plan.squareBelow ? 0 : 1);
    const { parts, lanes: made } = cutAcross(polygon, at, angle, alley ? plan.alley : 0);
    if (parts.length < 2 || depth > DEEPEST) {
      pieces.push({ polygon, open: false });
      return;
    }
    lanes.push(...made);
    for (const part of parts) {
      const size = area(part);
      // A half near the size of the next big building goes to it.
      const next = waiting[0];
      if (next && Math.abs(size - next.size) <= plan.match * next.size) {
        waiting.shift();
        pieces.push({ polygon: part, open: false, big: next.index });
        continue;
      }
      const finished = size < plan.size * 2 ** (4 * plan.sizeChaos * (rng.next() - 0.5));
      if (finished && (!next || size < next.size)) {
        pieces.push({ polygon: part, open: rng.next() < plan.open });
        continue;
      }
      const draw = rng.next() * rng.next();
      cut(part, alley && size > (plan.size * plan.alleyAbove) / Math.max(draw, 1e-9), depth + 1);
    }
  };
  cut(plan.polygon, true, 0);
  return { pieces, lanes };
}
