/**
 * Polygon arithmetic for the staged generator: taking shapes out of shapes,
 * moving outlines in and out, and giving lines width. All of it goes through
 * Clipper2 (`clipper2-ts`), which works on whole numbers, so that the same
 * shapes give the same answer everywhere. Coordinates are kept to the
 * millimetre.
 */
import { EndType, FillRule, JoinType, type PathD, areaD, differenceD, inflatePathsD, intersectD, unionD } from 'clipper2-ts';
import type { Point } from '../../schema.ts';

/** Decimal places kept: millimetres. */
const PLACES = 3;

const toPath = (ring: readonly Point[]): PathD => ring.map(([x, y]) => ({ x, y }));
const toRing = (path: PathD): Point[] => path.map(({ x, y }): Point => [x, y]);

export interface Shapes {
  /** Outlines, each a ring without its first point repeated. */
  rings: Point[][];
  /** Outlines of holes within them. */
  holes: Point[][];
}

function sorted(paths: PathD[]): Shapes {
  const rings: Point[][] = [];
  const holes: Point[][] = [];
  for (const path of paths) {
    if (path.length < 3) continue;
    (areaD(path) >= 0 ? rings : holes).push(toRing(path));
  }
  return { rings, holes };
}

/** What is left of some shapes once others are taken out of them. */
export function without(rings: ReadonlyArray<readonly Point[]>, taken: ReadonlyArray<readonly Point[]>): Shapes {
  if (taken.length === 0) return sorted(unionD(rings.map(toPath), FillRule.NonZero));
  return sorted(differenceD(rings.map(toPath), taken.map(toPath), FillRule.NonZero, PLACES));
}

/** What two sets of shapes have in common. */
export function shared(rings: ReadonlyArray<readonly Point[]>, others: ReadonlyArray<readonly Point[]>): Shapes {
  return sorted(intersectD(rings.map(toPath), others.map(toPath), FillRule.NonZero, PLACES));
}

/** Shapes made one. */
export function united(rings: ReadonlyArray<readonly Point[]>): Shapes {
  return sorted(unionD(rings.map(toPath), [], FillRule.NonZero, PLACES));
}

/**
 * Shapes with their outlines moved out by so many metres, or in by a negative number, corners kept sharp unless
 * `round`. Holes within them, given apart, shrink as the shapes grow.
 */
export function grown(rings: ReadonlyArray<readonly Point[]>, by: number, round = false, holes: ReadonlyArray<readonly Point[]> = []): Shapes {
  // Which way round an outline runs says whether it is a shape or a hole.
  const turned = (ring: readonly Point[], positive: boolean) => {
    const path = toPath(ring);
    return areaD(path) >= 0 === positive ? path : path.reverse();
  };
  const paths = [...rings.map((ring) => turned(ring, true)), ...holes.map((ring) => turned(ring, false))];
  return sorted(inflatePathsD(paths, by, round ? JoinType.Round : JoinType.Miter, EndType.Polygon, 2, PLACES));
}

/** Lines given a width, their ends rounded. */
export function widened(lines: ReadonlyArray<readonly Point[]>, width: number): Point[][] {
  return sorted(inflatePathsD(lines.filter((line) => line.length >= 2).map(toPath), width / 2, JoinType.Round, EndType.Round, 2, PLACES)).rings;
}

/** A line in lengths of so many points, each starting where the last ended, so that each has a small box about it. */
export function lengths(line: readonly Point[], points = 12): Point[][] {
  const out: Point[][] = [];
  for (let at = 0; at < line.length - 1; at += points - 1) out.push(line.slice(at, at + points));
  return out;
}
