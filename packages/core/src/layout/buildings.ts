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
  /** No cut leaves a piece narrower than this, nor longer than `longest` times its width unless no longer than before. */
  leastWidth: number;
  longest: number;
  /** Whether a piece has a way along it, the lanes cut so far counted; a cut that would leave one without is made with an alley, or not at all. */
  fronts?: (polygon: Point[], lanes: Point[][]) => boolean;
  /** Whether a lane reaches a way, or one of the lanes cut so far, at one end at least. */
  reaches?: (lane: Point[], lanes: Point[][]) => boolean;
}

/** A piece's width and its length over width, on its smallest rectangle. */
export function shapeOf(polygon: Point[]): { width: number; ratio: number } {
  const rect = smallestRectangle(polygon);
  const width = Math.hypot(rect.short[0], rect.short[1]);
  return { width, ratio: Math.hypot(rect.long[0], rect.long[1]) / Math.max(width, 1e-9) };
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
export function cutAcross(polygon: Point[], at: number, angle: number, gap: number, along = false): { parts: Point[][]; lanes: Point[][] } {
  const rect = smallestRectangle(polygon);
  // Across the long axis, or along it: then the short side is the one cut at a share along.
  const [long, short] = along ? [rect.short, rect.long] : [rect.long, rect.short];
  const middle: Point = [rect.corner[0] + long[0] * at + short[0] * 0.5, rect.corner[1] + long[1] * at + short[1] * 0.5];
  const run = Math.hypot(long[0], long[1]) || 1;
  const across: Point = [-long[1] / run, long[0] / run];
  const direction: Point = [across[0] * Math.cos(angle) - across[1] * Math.sin(angle), across[1] * Math.cos(angle) + across[0] * Math.sin(angle)];
  const normal: Point = [-direction[1], direction[0]];
  const reach = run + Math.hypot(short[0], short[1]) + 10;
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
export function cutWard(plan: WardCut, rng: Rng): CutWard & { tryCut: (polygon: Point[]) => { parts: Point[][]; lanes: Point[][] } | undefined } {
  const pieces: Piece[] = [];
  const lanes: Point[][] = [];
  const waiting = plan.big.map((size, index) => ({ size, index })).sort((a, b) => b.size - a.size || a.index - b.index);
  /** Whether a cut's parts all keep the floor: wide enough, and no longer than allowed unless no longer than the piece cut. */
  const keepsFloor = (parts: Point[][], parent: Point[]) => {
    const before = shapeOf(parent).ratio;
    return parts.every((part) => {
      const { width, ratio } = shapeOf(part);
      return width >= plan.leastWidth && (ratio <= plan.longest || ratio <= before);
    });
  };
  /**
   * A cut of a piece that keeps the floor and leaves every part with a way along it: at the share drawn and turned as
   * drawn, then at other shares square, then along the other axis; with an alley where one is wanted, or where none
   * would leave a part with no way. Nothing if no cut will do.
   */
  const tryCut = (polygon: Point[], at: number, angle: number, alley: boolean) => {
    const shares = [at, 0.5, 0.42, 0.58, 0.34, 0.66];
    // Failing every cut that leaves each part a way, the first that keeps the floor: a part left with no way joins a
    // neighbour that has one afterwards.
    let fallback: ReturnType<typeof cutAcross> | undefined;
    for (const along of [false, true]) {
      for (const [index, share] of shares.entries()) {
        const turn = !along && index === 0 ? angle : 0;
        for (const gap of alley ? [plan.alley, 0] : [0, plan.alley]) {
          const made = cutAcross(polygon, share, turn, gap, along);
          if (made.parts.length < 2 || !keepsFloor(made.parts, polygon)) continue;
          if (gap > 0 && plan.reaches && !made.lanes.every((lane) => (plan.reaches as NonNullable<WardCut['reaches']>)(lane, lanes))) continue;
          // A cut meant to leave an alley is made without one only as a last resort.
          if (alley && gap === 0) {
            if (!fallback) fallback = made;
            continue;
          }
          if (plan.fronts && !made.parts.every((part) => (plan.fronts as NonNullable<WardCut['fronts']>)(part, [...lanes, ...made.lanes]))) {
            if (!fallback && gap === 0) fallback = made;
            continue;
          }
          return made;
        }
      }
    }
    return fallback;
  };
  const cut = (polygon: Point[], alley: boolean, depth: number) => {
    const spread = 0.8 * plan.gridChaos;
    const at = (1 - spread) / 2 + rng.next() * spread;
    const angle = (rng.next() - 0.5) * (Math.PI / 6) * plan.gridChaos * (area(polygon) < plan.size * plan.squareBelow ? 0 : 1);
    const made = depth > DEEPEST ? undefined : tryCut(polygon, at, angle, alley);
    if (!made) {
      pieces.push({ polygon, open: false });
      return;
    }
    const { parts, lanes: cutLanes } = made;
    lanes.push(...cutLanes);
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
      cut(part, alley && cutLanes.length > 0 && size > (plan.size * plan.alleyAbove) / Math.max(draw, 1e-9), depth + 1);
    }
  };
  cut(plan.polygon, true, 0);
  return { pieces, lanes, tryCut: (polygon) => tryCut(polygon, 0.5, 0, false) };
}
