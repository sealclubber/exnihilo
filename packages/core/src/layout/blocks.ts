/**
 * Blocks and the lots cut from them.
 *
 * A block is a polygon of ground with a street along some of its sides. It
 * is drawn in from each side by what that side needs: half a roadway and a
 * verge, a wall's clear strip, or nothing. Lots line its street sides. Each
 * street side owns the ground nearer to it than to any other street side, so
 * a lot runs back from its street to the middle of the block or to the lots
 * behind it, corners go to whichever street they are nearer, and lots of two
 * sides can never overlap. Along a side, lots are cut one after another by
 * lines that lean a little, each shared by the two lots it parts.
 */
import type { Point } from '../schema.ts';
import { distance, polygonArea } from './geometry.ts';

/** A straight boundary: everything on the side its normal points to is kept. */
interface HalfPlane {
  /** A point on the boundary, and the unit normal toward what is kept. */
  at: Point;
  normal: Point;
}

const side = (plane: HalfPlane, point: Point) => (point[0] - plane.at[0]) * plane.normal[0] + (point[1] - plane.at[1]) * plane.normal[1];

/** What is left of a polygon on the kept side of a boundary. The polygon should be convex, or nearly so. */
export function clip(polygon: readonly Point[], plane: HalfPlane): Point[] {
  const kept: Point[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index] as Point;
    const b = polygon[(index + 1) % polygon.length] as Point;
    const da = side(plane, a);
    const db = side(plane, b);
    if (da >= 0) kept.push(a);
    if (da >= 0 !== db >= 0 && da !== db) {
      const t = da / (da - db);
      kept.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  // Points that fall together are one point.
  return kept.filter((point, index) => distance(point, kept[(index + kept.length - 1) % kept.length] as Point) > 1e-7);
}

/** One side of a block, from one corner to the next. */
export interface BlockSide {
  a: Point;
  b: Point;
  /** How far the block is drawn in from this side. */
  inset: number;
  /** For a side with a street that lots may open onto: something to know it by. */
  street?: number;
  /** For a street that runs only part of the way along the side: the part, as shares of the side from `a`. */
  part?: [number, number];
}

/** The frontage of one street side of a block, along which lots are cut. */
export interface Track {
  street: number;
  /** A point on the frontage line, the direction lots are cut in along it, and the direction back into the block. */
  origin: Point;
  along: Point;
  back: Point;
  /** Where the frontage begins and ends along the line, and how far along lots have been cut. */
  from: number;
  to: number;
  cursor: number;
  /** The ground this side owns: nearer to it than to any other street side of the block. */
  ground: Point[];
  /** How the last cut leans: the next lot begins on the same line. */
  lean: number;
}

export interface Block {
  /** The block as drawn in from its sides. Empty if nothing is left of it. */
  polygon: Point[];
  tracks: Track[];
}

/** The boundary a block is drawn in to on one of its sides, given which way round the block's corners run. */
function insetPlane(sideOf: BlockSide, clockwise: boolean): HalfPlane {
  const length = distance(sideOf.a, sideOf.b) || 1;
  const dx = (sideOf.b[0] - sideOf.a[0]) / length;
  const dy = (sideOf.b[1] - sideOf.a[1]) / length;
  // The inward normal is to the left of the side's direction for corners that run one way round, to the right for the other.
  const normal: Point = clockwise ? [dy, -dx] : [-dy, dx];
  return { at: [sideOf.a[0] + normal[0] * sideOf.inset, sideOf.a[1] + normal[1] * sideOf.inset], normal };
}

/** Whether a polygon's corners run clockwise as the map is drawn, with y pointing south. */
function runsClockwise(polygon: readonly Point[]): boolean {
  let twice = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index] as Point;
    const b = polygon[(index + 1) % polygon.length] as Point;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return twice < 0;
}

/** Makes a block of a polygon of ground and what lies along each of its sides. */
export function makeBlock(sides: readonly BlockSide[]): Block {
  const outline = sides.map((entry) => entry.a);
  const clockwise = runsClockwise(outline);
  const planes = sides.map((entry) => insetPlane(entry, clockwise));
  let polygon: Point[] = outline;
  for (const plane of planes) {
    polygon = clip(polygon, plane);
    if (polygon.length < 3) return { polygon: [], tracks: [] };
  }
  if (polygonArea(polygon) < 1) return { polygon: [], tracks: [] };
  const tracks: Track[] = [];
  sides.forEach((entry, index) => {
    if (entry.street === undefined) return;
    const plane = planes[index] as HalfPlane;
    const length = distance(entry.a, entry.b) || 1;
    const along: Point = [(entry.b[0] - entry.a[0]) / length, (entry.b[1] - entry.a[1]) / length];
    // The ground this side owns: the block as far as the side runs, less whatever is nearer another street side.
    let ground = clip(polygon, { at: entry.a, normal: along });
    if (ground.length >= 3) ground = clip(ground, { at: entry.b, normal: [-along[0], -along[1]] });
    sides.forEach((other, otherIndex) => {
      if (otherIndex === index || other.street === undefined || ground.length < 3) return;
      // Where the block's outline bends outward between this side and the next, each already keeps to its own stretch,
      // and neither line says anything about the ground along the other.
      const before = otherIndex === (index + sides.length - 1) % sides.length;
      const after = otherIndex === (index + 1) % sides.length;
      if (before || after) {
        const [first, second] = before ? [other, entry] : [entry, other];
        const bend = (first.b[0] - first.a[0]) * (second.b[1] - second.a[1]) - (first.b[1] - first.a[1]) * (second.b[0] - second.a[0]);
        if (clockwise ? bend >= 0 : bend <= 0) return;
      }
      const rival = planes[otherIndex] as HalfPlane;
      // Nearer this side's line than the rival's: a boundary along the line midway between the two.
      const nx = rival.normal[0] - plane.normal[0];
      const ny = rival.normal[1] - plane.normal[1];
      const size = Math.hypot(nx, ny);
      if (size < 1e-9) return;
      const offset = rival.at[0] * rival.normal[0] + rival.at[1] * rival.normal[1] - (plane.at[0] * plane.normal[0] + plane.at[1] * plane.normal[1]);
      // Points p with p·(rival.normal - plane.normal) >= offset are nearer this side.
      const normal: Point = [nx / size, ny / size];
      ground = clip(ground, { at: [normal[0] * (offset / size), normal[1] * (offset / size)], normal });
    });
    if (ground.length < 3) return;
    // The frontage: the stretch of the block's own outline that lies on this side's line.
    const on = ground.filter((point) => Math.abs(side(plane, point)) < 1e-6).map((point) => (point[0] - plane.at[0]) * along[0] + (point[1] - plane.at[1]) * along[1]);
    if (on.length < 2) return;
    let from = Math.min(...on);
    let to = Math.max(...on);
    if (entry.part) {
      // The street runs only part of the way: so does the frontage.
      const start = (entry.a[0] - plane.at[0]) * along[0] + (entry.a[1] - plane.at[1]) * along[1];
      from = Math.max(from, start + entry.part[0] * length);
      to = Math.min(to, start + entry.part[1] * length);
    }
    if (to - from < 1) return;
    tracks.push({ street: entry.street, origin: plane.at, along, back: plane.normal, from, to, cursor: from, ground, lean: 0 });
  });
  return { polygon, tracks };
}

/** A lot cut from a track: its outline, the part of its frontage it has, and how deep it runs. */
export interface Cut {
  polygon: Point[];
  from: number;
  to: number;
  depth: number;
  area: number;
}

/** The point at a distance along a track's frontage line. */
export const frontage = (track: Track, along: number): Point => [track.origin[0] + track.along[0] * along, track.origin[1] + track.along[1] * along];

/**
 * Cuts a lot from a track between two distances along its frontage, no deeper than `depth`. The two cuts lean from
 * square by the angles given, in radians; a positive lean carries the back of the cut further along the frontage.
 */
export function cutLot(track: Track, from: number, to: number, depth: number, leanFrom: number, leanTo: number): Cut {
  const cutPlane = (along: number, lean: number, keepAfter: boolean): HalfPlane => {
    // The cut runs back into the block, turned by its lean; what is kept lies after it, or before it.
    const across: Point = [track.along[0] * Math.cos(lean) - track.back[0] * Math.sin(lean), track.along[1] * Math.cos(lean) - track.back[1] * Math.sin(lean)];
    return { at: frontage(track, along), normal: keepAfter ? across : [-across[0], -across[1]] };
  };
  let polygon = clip(track.ground, cutPlane(from, leanFrom, true));
  if (polygon.length >= 3) polygon = clip(polygon, cutPlane(to, leanTo, false));
  if (polygon.length >= 3) polygon = clip(polygon, { at: [track.origin[0] + track.back[0] * depth, track.origin[1] + track.back[1] * depth], normal: [-track.back[0], -track.back[1]] });
  if (polygon.length < 3) return { polygon: [], from, to, depth: 0, area: 0 };
  const deepest = Math.max(...polygon.map((point) => (point[0] - track.origin[0]) * track.back[0] + (point[1] - track.origin[1]) * track.back[1]));
  return { polygon, from, to, depth: deepest, area: polygonArea(polygon) };
}

/** The part of a lot nearest its street, as deep as a share of the lot's own depth: where its building stands. */
export function frontOf(track: Track, lot: Cut, share: number): Point[] {
  if (share <= 0 || lot.polygon.length < 3) return [];
  if (share >= 1) return lot.polygon;
  const deep = lot.depth * share;
  const built = clip(lot.polygon, { at: [track.origin[0] + track.back[0] * deep, track.origin[1] + track.back[1] * deep], normal: [-track.back[0], -track.back[1]] });
  return built.length >= 3 && polygonArea(built) > 0.01 ? built : [];
}
