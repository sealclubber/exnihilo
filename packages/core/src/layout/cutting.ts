/**
 * Cutting ground. A town's ground is cut by its roads into wards, and each
 * ward is cut in two again and again into buildings. Everything here is one
 * operation, the chord: where a line passes through a polygon from one side
 * to the other, the polygon is split along it in two. Subtracting a road's
 * strip is splitting along its outline and throwing away what is inside.
 *
 * Polygons are simple, without holes, and listed without the first point
 * repeated. Pure arithmetic: where a line touches a corner exactly, it is
 * moved aside by a hair (a fraction of a micrometre) and tried again, so
 * that every crossing is a clean one.
 */
import type { Point } from '../schema.ts';

/** How close, in metres, a crossing may come to a corner before the line is moved aside. */
const TOUCH = 1e-8;
/** How far a line is moved aside at each try, and how many tries. */
const NUDGE = 3e-7;
const TRIES = 12;

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const length = (a: Point) => Math.hypot(a[0], a[1]);
const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Twice the signed area: positive when the points run anticlockwise with y up (clockwise as drawn, y down). */
export function signedArea(ring: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return twice / 2;
}

export const area = (ring: readonly Point[]) => Math.abs(signedArea(ring));

/** The same ring, turned to run with positive signed area. */
export function oriented(ring: readonly Point[]): Point[] {
  return signedArea(ring) >= 0 ? [...ring] : [...ring].reverse();
}

/** Whether a point lies inside a ring, by the even-odd rule. On the edge it may go either way. */
export function inside(point: Point, ring: readonly Point[]): boolean {
  let within = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) within = !within;
  }
  return within;
}

/** The distance from a point to a piece of line. */
export function toPiece(point: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const span = dot(ab, ab);
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(point, a), ab) / span));
  return length(sub(point, lerp(a, b, t)));
}

/** The distance from a point to a ring's edge. */
export function toEdge(point: Point, ring: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) best = Math.min(best, toPiece(point, ring[i] as Point, ring[(i + 1) % ring.length] as Point));
  return best;
}

/** The distance from a point to a polyline. */
export function toLine(point: Point, line: readonly Point[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, toPiece(point, line[i - 1] as Point, line[i] as Point));
  return best;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boxAround(points: readonly Point[], margin = 0): Box {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
}

export const boxesMeet = (a: Box, b: Box) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

/** A point surely inside a ring: its centroid if that is, or else the middle of the widest run across it. */
export function interiorPoint(ring: readonly Point[]): Point {
  let twice = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const c = a[0] * b[1] - b[0] * a[1];
    twice += c;
    cx += (a[0] + b[0]) * c;
    cy += (a[1] + b[1]) * c;
  }
  const centroid: Point = twice === 0 ? (ring[0] as Point) : [cx / (3 * twice), cy / (3 * twice)];
  if (inside(centroid, ring) && toEdge(centroid, ring) > 1e-6) return centroid;
  const box = boxAround(ring);
  let best: Point = centroid;
  let widest = -1;
  for (const share of [0.5, 0.3, 0.7, 0.15, 0.85, 0.4, 0.6]) {
    const y = box.minY + (box.maxY - box.minY) * share;
    const xs: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Point;
      const b = ring[(i + 1) % ring.length] as Point;
      if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const span = (xs[k + 1] as number) - (xs[k] as number);
      if (span > widest) {
        widest = span;
        best = [((xs[k] as number) + (xs[k + 1] as number)) / 2, y];
      }
    }
    if (widest > 0) break;
  }
  return best;
}

/** Douglas–Peucker: the fewest points that keep a line within `tolerance` of where it was. The ends stay. */
export function simplify(line: readonly Point[], tolerance: number): Point[] {
  if (line.length <= 2) return [...line];
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, line.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop() as [number, number];
    let far = -1;
    let most = tolerance;
    for (let i = from + 1; i < to; i++) {
      const away = toPiece(line[i] as Point, line[from] as Point, line[to] as Point);
      if (away > most) {
        most = away;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([from, far], [far, to]);
    }
  }
  return line.filter((_, i) => keep[i] === 1);
}

/** A ring simplified the same way, split at its two farthest-apart corners so that neither is lost. */
export function simplifyRing(ring: readonly Point[], tolerance: number): Point[] {
  if (ring.length <= 4) return [...ring];
  let far = 0;
  let most = -1;
  for (let i = 1; i < ring.length; i++) {
    const away = length(sub(ring[i] as Point, ring[0] as Point));
    if (away > most) {
      most = away;
      far = i;
    }
  }
  const one = simplify(ring.slice(0, far + 1), tolerance);
  const two = simplify([...ring.slice(far), ring[0] as Point], tolerance);
  const out = [...one, ...two.slice(1, -1)];
  return out.length >= 3 ? out : [...ring];
}

// ---- Crossings and chords ---------------------------------------------------------------------------------------

/** Where a line crosses a ring's edge: how far along the line (piece index plus share), the point, and the ring's edge and share along it. */
interface Crossing {
  at: number;
  point: Point;
  edge: number;
  share: number;
}

/** A piece of a line that runs through a ring from one side to the other: where it enters and leaves, and its corners between. */
export interface Chord {
  from: Crossing;
  to: Crossing;
  /** The line's corners strictly between the two crossings. */
  between: Point[];
}

class Touching extends Error {}

/** Every crossing of a line with a ring's edges, in order along the line; throws `Touching` where one is not clean. */
function crossingsOf(ring: readonly Point[], line: readonly Point[], closed: boolean): Crossing[] {
  const found: Crossing[] = [];
  const count = closed ? line.length : line.length - 1;
  const ringBox = boxAround(ring, TOUCH);
  for (let k = 0; k < count; k++) {
    const a = line[k] as Point;
    const b = line[(k + 1) % line.length] as Point;
    if (Math.max(a[0], b[0]) < ringBox.minX || Math.min(a[0], b[0]) > ringBox.maxX || Math.max(a[1], b[1]) < ringBox.minY || Math.min(a[1], b[1]) > ringBox.maxY) continue;
    const ab = sub(b, a);
    const runAB = length(ab);
    if (runAB === 0) continue;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i] as Point;
      const q = ring[(i + 1) % ring.length] as Point;
      if (Math.max(p[0], q[0]) < Math.min(a[0], b[0]) - TOUCH || Math.min(p[0], q[0]) > Math.max(a[0], b[0]) + TOUCH) continue;
      if (Math.max(p[1], q[1]) < Math.min(a[1], b[1]) - TOUCH || Math.min(p[1], q[1]) > Math.max(a[1], b[1]) + TOUCH) continue;
      const pq = sub(q, p);
      const runPQ = length(pq);
      if (runPQ === 0) continue;
      const denominator = cross(ab, pq);
      const ap = sub(p, a);
      if (Math.abs(denominator) <= 1e-12 * runAB * runPQ) {
        // Parallel: touching only if they lie along each other.
        if (Math.abs(cross(ab, ap)) / runAB < TOUCH) {
          const t0 = dot(ap, ab) / (runAB * runAB);
          const t1 = dot(sub(q, a), ab) / (runAB * runAB);
          if (Math.max(t0, t1) >= -TOUCH / runAB && Math.min(t0, t1) <= 1 + TOUCH / runAB) throw new Touching();
        }
        continue;
      }
      const t = cross(ap, pq) / denominator;
      const u = cross(ap, ab) / denominator;
      const slackT = TOUCH / runAB;
      const slackU = TOUCH / runPQ;
      if (t < -slackT || t > 1 + slackT || u < -slackU || u > 1 + slackU) continue;
      if (t < slackT || t > 1 - slackT || u < slackU || u > 1 - slackU) throw new Touching();
      found.push({ at: k + t, point: lerp(a, b, t), edge: i, share: u });
    }
  }
  return found.sort((x, y) => x.at - y.at);
}

const pointAt = (line: readonly Point[], at: number): Point => {
  const k = Math.min(Math.floor(at), line.length - 1);
  return lerp(line[k] as Point, line[(k + 1) % line.length] as Point, at - k);
};

/** The corners of a line strictly between two places along it, wrapping round a closed line. */
function cornersBetween(line: readonly Point[], from: number, to: number, closed: boolean): Point[] {
  const out: Point[] = [];
  if (to >= from) {
    for (let k = Math.floor(from) + 1; k <= Math.ceil(to) - 1; k++) if (k > from && k < to) out.push(line[k] as Point);
  } else if (closed) {
    for (let k = Math.floor(from) + 1; k < line.length; k++) out.push(line[k] as Point);
    for (let k = 0; k <= Math.ceil(to) - 1; k++) if (k < to) out.push(line[k] as Point);
  }
  return out;
}

/** The chords of a line through a ring. A closed line is an outline; an open one runs on past its ends untouched. */
function chordsOf(ring: readonly Point[], line: readonly Point[], closed: boolean): Chord[] {
  const found = crossingsOf(ring, line, closed);
  if (found.length < 2) return [];
  const chords: Chord[] = [];
  const pairs = closed ? found.length : found.length - 1;
  for (let k = 0; k < pairs; k++) {
    const from = found[k] as Crossing;
    const to = found[(k + 1) % found.length] as Crossing;
    let middle: number;
    if (to.at > from.at) middle = (from.at + to.at) / 2;
    else middle = ((from.at + to.at + line.length) / 2) % line.length;
    if (!inside(pointAt(line, middle), ring)) continue;
    chords.push({ from, to, between: cornersBetween(line, from.at, to.at, closed) });
  }
  return chords;
}

/** Moves a line aside by a hair, a different way at each try. */
const nudged = (line: readonly Point[], attempt: number): Point[] => {
  if (attempt === 0) return line as Point[];
  const angle = attempt * 2.399963;
  const by = NUDGE * attempt;
  return line.map((point): Point => [point[0] + Math.cos(angle) * by, point[1] + Math.sin(angle) * by]);
};

/** Inserts a crossing into a ring as a corner; returns the new ring and where the corner is. */
function withCorner(ring: Point[], crossing: Crossing): { ring: Point[]; index: number } {
  // The corner goes after the edge's start and after any corner already inserted on that edge nearer its start.
  const start = ring[crossing.edge] as Point;
  let index = crossing.edge + 1;
  const along = (point: Point) => length(sub(point, start));
  const reach = along(crossing.point);
  const end = ring[(crossing.edge + 1) % ring.length] as Point;
  while (index < ring.length && ring[index] !== end && along(ring[index] as Point) < reach) index++;
  return { ring: [...ring.slice(0, index), crossing.point, ...ring.slice(index)], index };
}

/** Splits a ring along one chord whose ends lie on its edges. */
function splitOnce(ring: readonly Point[], chord: Chord): [Point[], Point[]] {
  // Find each end's edge in this ring: the edge it lies on.
  const locate = (point: Point): Crossing => {
    let best = 0;
    let gap = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const away = toPiece(point, ring[i] as Point, ring[(i + 1) % ring.length] as Point);
      if (away < gap) {
        gap = away;
        best = i;
      }
    }
    return { at: 0, point, edge: best, share: 0 };
  };
  const from = locate(chord.from.point);
  const to = locate(chord.to.point);
  // Insert the later one first so the earlier's index holds.
  let working = [...ring];
  let fromIndex: number;
  let toIndex: number;
  if (from.edge === to.edge) {
    const start = ring[from.edge] as Point;
    const first = length(sub(from.point, start)) <= length(sub(to.point, start));
    const one = withCorner(working, first ? from : to);
    working = one.ring;
    // The second lies after the first on the same edge.
    const later = first ? to : from;
    const index = one.index + 1;
    working = [...working.slice(0, index), later.point, ...working.slice(index)];
    fromIndex = first ? one.index : index;
    toIndex = first ? index : one.index;
  } else {
    const [early, late] = from.edge < to.edge ? [from, to] : [to, from];
    const lateCut = withCorner(working, late);
    working = lateCut.ring;
    const earlyCut = withCorner(working, early);
    working = earlyCut.ring;
    const lateIndex = lateCut.index + 1;
    fromIndex = from === early ? earlyCut.index : lateIndex;
    toIndex = to === early ? earlyCut.index : lateIndex;
  }
  const walk = (a: number, b: number) => {
    const out: Point[] = [];
    for (let i = a; ; i = (i + 1) % working.length) {
      out.push(working[i] as Point);
      if (i === b) break;
    }
    return out;
  };
  const one = [...walk(fromIndex, toIndex), ...[...chord.between].reverse()];
  const two = [...walk(toIndex, fromIndex), ...chord.between];
  return [clean(one), clean(two)];
}

/** Drops corners that fall on the one before. */
function clean(ring: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of ring) {
    const last = out[out.length - 1];
    if (!last || length(sub(point, last)) > 1e-9) out.push(point);
  }
  while (out.length > 1 && length(sub(out[0] as Point, out[out.length - 1] as Point)) <= 1e-9) out.pop();
  return out;
}

/**
 * Splits a ring along every chord of a line. Returns the pieces, and the chords split along (each a polyline from
 * one side of the ring to the other).
 */
export function splitAlong(ring: readonly Point[], line: readonly Point[], closed = false): { pieces: Point[][]; chords: Point[][] } {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const moved = nudged(line, attempt);
    let chords: Chord[];
    try {
      chords = chordsOf(ring, moved, closed);
    } catch (error) {
      if (error instanceof Touching) continue;
      throw error;
    }
    if (chords.length === 0) return { pieces: [oriented(ring)], chords: [] };
    let pieces: Point[][] = [oriented(ring)];
    for (const chord of chords) {
      const middle = chord.between.length > 0 ? lerp(chord.from.point, chord.between[0] as Point, 0.5) : lerp(chord.from.point, chord.to.point, 0.5);
      // The piece that holds it: both ends on its edge and its first stretch within it.
      const holder = pieces.findIndex((piece) => toEdge(chord.from.point, piece) < 1e-7 && toEdge(chord.to.point, piece) < 1e-7 && (inside(middle, piece) || toEdge(middle, piece) < 1e-9));
      if (holder < 0) continue;
      const [one, two] = splitOnce(pieces[holder] as Point[], chord);
      pieces.splice(holder, 1, ...[one, two].filter((piece) => piece.length >= 3).map(oriented));
    }
    return { pieces, chords: chords.map((chord) => [chord.from.point, ...chord.between, chord.to.point]) };
  }
  throw new Error('a line could not be made to cross a polygon cleanly');
}

/**
 * What is left of a ring once a closed outline is taken out of it. Where the outline lies wholly inside the ring it
 * would leave a hole: `hole` is then set and the ring is returned whole.
 */
export function subtract(ring: readonly Point[], outline: readonly Point[]): { pieces: Point[][]; hole: boolean } {
  const ringBox = boxAround(ring);
  if (!boxesMeet(ringBox, boxAround(outline))) return { pieces: [oriented(ring)], hole: false };
  const { pieces, chords } = splitAlong(ring, outline, true);
  if (chords.length === 0) {
    // With no crossing, one lies wholly inside the other or they are apart.
    if (inside(ring[0] as Point, outline)) return { pieces: [], hole: false };
    return { pieces: [oriented(ring)], hole: inside(outline[0] as Point, ring) };
  }
  return { pieces: pieces.filter((piece) => !inside(interiorPoint(piece), outline)), hole: false };
}

// ---- Lines with width -------------------------------------------------------------------------------------------

/** Where two lines through points with directions meet, or nothing if they are parallel. */
function meet(a: Point, da: Point, b: Point, db: Point): Point | undefined {
  const denominator = cross(da, db);
  if (Math.abs(denominator) < 1e-12) return undefined;
  const t = cross(sub(b, a), db) / denominator;
  return [a[0] + da[0] * t, a[1] + da[1] * t];
}

/** Takes out the loops a line makes where it crosses itself, as an offset line does on the inside of a bend. */
export function untangle(line: readonly Point[]): Point[] {
  let out = [...line];
  for (let guard = 0; guard < line.length; guard++) {
    let found = false;
    search: for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i] as Point;
      const b = out[i + 1] as Point;
      for (let j = out.length - 2; j > i + 1; j--) {
        const c = out[j] as Point;
        const d = out[j + 1] as Point;
        const ab = sub(b, a);
        const cd = sub(d, c);
        const denominator = cross(ab, cd);
        if (Math.abs(denominator) < 1e-12) continue;
        const t = cross(sub(c, a), cd) / denominator;
        const u = cross(sub(c, a), ab) / denominator;
        if (t > 0 && t < 1 && u > 0 && u < 1) {
          out = [...out.slice(0, i + 1), lerp(a, b, t), ...out.slice(j + 1)];
          found = true;
          break search;
        }
      }
    }
    if (!found) break;
  }
  return out;
}

/** A line moved sideways by `by` metres, to its left as it runs (with y down, to the right as drawn), corners mitred. */
export function offsetLine(line: readonly Point[], by: number): Point[] {
  const points = line.filter((point, i) => i === 0 || length(sub(point, line[i - 1] as Point)) > 1e-9);
  if (points.length < 2) return [...points];
  const normals = points.slice(1).map((point, i) => {
    const d = sub(point, points[i] as Point);
    const run = length(d);
    return [-d[1] / run, d[0] / run] as Point;
  });
  const out: Point[] = [];
  points.forEach((point, i) => {
    const before = normals[Math.max(0, i - 1)] as Point;
    const after = normals[Math.min(normals.length - 1, i)] as Point;
    if (i === 0 || i === points.length - 1) {
      const n = i === 0 ? after : before;
      out.push([point[0] + n[0] * by, point[1] + n[1] * by]);
      return;
    }
    const a: Point = [point[0] + before[0] * by, point[1] + before[1] * by];
    const b: Point = [point[0] + after[0] * by, point[1] + after[1] * by];
    const turnCos = dot(before, after);
    // A sharp turn is cut off square rather than mitred to a spike.
    if (turnCos < 0.5) {
      out.push(a, b);
      return;
    }
    const corner = meet(a, [before[1], -before[0]], b, [after[1], -after[0]]);
    out.push(corner ?? a);
  });
  return untangle(out);
}

/** The outline of a line drawn `width` metres wide, its ends cut square at the line's ends. */
export function stripOutline(line: readonly Point[], width: number): Point[] {
  const left = offsetLine(line, width / 2);
  const right = offsetLine(line, -width / 2);
  return [...left, ...right.reverse()];
}

// ---- Shapes of pieces ---------------------------------------------------------------------------------------------

/** The convex hull, by the monotone chain. */
export function hull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const half = (list: Point[]) => {
    const out: Point[] = [];
    for (const point of list) {
      while (out.length >= 2 && cross(sub(out[out.length - 1] as Point, out[out.length - 2] as Point), sub(point, out[out.length - 2] as Point)) <= 0) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** The smallest rectangle round a polygon: a corner, its long side and its short side as vectors from that corner. */
export interface Rectangle {
  corner: Point;
  long: Point;
  short: Point;
}

export function smallestRectangle(ring: readonly Point[]): Rectangle {
  const shell = hull(ring);
  let best: (Rectangle & { area: number }) | undefined;
  for (let i = 0; i < shell.length; i++) {
    const a = shell[i] as Point;
    const b = shell[(i + 1) % shell.length] as Point;
    const run = length(sub(b, a));
    if (run < 1e-9) continue;
    const u: Point = [(b[0] - a[0]) / run, (b[1] - a[1]) / run];
    const v: Point = [-u[1], u[0]];
    let [minU, maxU, minV, maxV] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const point of shell) {
      const pu = dot(point, u);
      const pv = dot(point, v);
      minU = Math.min(minU, pu);
      maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv);
      maxV = Math.max(maxV, pv);
    }
    const spanU = maxU - minU;
    const spanV = maxV - minV;
    const size = spanU * spanV;
    if (best && size >= best.area - 1e-9) continue;
    const corner: Point = [u[0] * minU + v[0] * minV, u[1] * minU + v[1] * minV];
    const along: Point = [u[0] * spanU, u[1] * spanU];
    const across: Point = [v[0] * spanV, v[1] * spanV];
    best = spanU >= spanV ? { corner, long: along, short: across, area: size } : { corner, long: across, short: along, area: size };
  }
  return best ?? { corner: (ring[0] as Point) ?? [0, 0], long: [1, 0], short: [0, 1] };
}

/** Whether a ring crosses itself. */
export function selfCrossing(ring: readonly Point[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % n] as Point;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j] as Point;
      const d = ring[(j + 1) % n] as Point;
      const ab = sub(b, a);
      const cd = sub(d, c);
      const denominator = cross(ab, cd);
      if (Math.abs(denominator) < 1e-15) continue;
      const t = cross(sub(c, a), cd) / denominator;
      const u = cross(sub(c, a), ab) / denominator;
      if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) return true;
    }
  }
  return false;
}

/** A ring drawn in by `by` metres all round, corners mitred; nothing if it would vanish or turn inside out. */
export function inset(ring: readonly Point[], by: number): Point[] | undefined {
  const turned = clean(oriented(ring));
  const n = turned.length;
  // With positive signed area the inside is to the left as the ring runs: each edge moved left by `by`, and each
  // corner where the moved edges either side of it meet.
  const normals = turned.map((point, i) => {
    const d = sub(turned[(i + 1) % n] as Point, point);
    const run = length(d) || 1;
    return [-d[1] / run, d[0] / run] as Point;
  });
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const before = normals[(i + n - 1) % n] as Point;
    const after = normals[i] as Point;
    const point = turned[i] as Point;
    const a: Point = [point[0] + before[0] * by, point[1] + before[1] * by];
    const b: Point = [point[0] + after[0] * by, point[1] + after[1] * by];
    out.push(meet(a, [before[1], -before[0]], b, [after[1], -after[0]]) ?? a);
  }
  if (out.length < 3 || selfCrossing(out) || signedArea(out) <= 0) return undefined;
  for (const point of out) if (!inside(point, turned) || toEdge(point, turned) < by * 0.5) return undefined;
  return out;
}

// ---- Joining pieces -------------------------------------------------------------------------------------------------

/** How long a stretch two pieces share: the length of one's edges that lie along the other's. */
export function sharedLength(a: readonly Point[], b: readonly Point[], tolerance = 1e-6): number {
  if (!boxesMeet(boxAround(a, tolerance), boxAround(b, tolerance))) return 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as Point;
    const q = a[(i + 1) % a.length] as Point;
    if (toEdge(p, b) < tolerance && toEdge(q, b) < tolerance && toEdge(lerp(p, q, 0.5), b) < tolerance) total += length(sub(q, p));
  }
  return total;
}

/** Adds to a ring, as corners, any of another's corners that lie on its edges. */
function takeCorners(ring: readonly Point[], other: readonly Point[], tolerance: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] as Point;
    const q = ring[(i + 1) % ring.length] as Point;
    out.push(p);
    const run = length(sub(q, p));
    const on = other
      .filter((point) => toPiece(point, p, q) < tolerance && length(sub(point, p)) > tolerance && length(sub(point, q)) > tolerance)
      .map((point) => ({ point, at: run === 0 ? 0 : dot(sub(point, p), sub(q, p)) / run }))
      .sort((x, y) => x.at - y.at);
    for (const { point } of on) out.push(point);
  }
  return out;
}

/**
 * Two pieces that share a stretch of boundary, made one. Nothing if they share none, or share it in more than one
 * place (which would leave a hole).
 */
export function merge(a: readonly Point[], b: readonly Point[], tolerance = 1e-6): Point[] | undefined {
  const one = takeCorners(oriented(a), b, tolerance);
  const two = takeCorners(oriented(b), a, tolerance);
  const onTwo = one.map((point) => toEdge(point, two) < tolerance);
  const edgeShared = one.map((point, i) => onTwo[i] && onTwo[(i + 1) % one.length] && toEdge(lerp(point, one[(i + 1) % one.length] as Point, 0.5), two) < tolerance);
  const sharedEdges = edgeShared.filter(Boolean).length;
  if (sharedEdges === 0 || sharedEdges === one.length) return undefined;
  // One run of shared edges, from corner `start` to corner `end` going forward.
  let start = -1;
  for (let i = 0; i < one.length; i++) if (edgeShared[i] && !edgeShared[(i + one.length - 1) % one.length]) {
    if (start >= 0) return undefined;
    start = i;
  }
  let end = start;
  while (edgeShared[end % one.length]) end = (end + 1) % one.length;
  const first = one[start] as Point;
  const last = one[end] as Point;
  const near = (ring: Point[], point: Point) => {
    let best = 0;
    let gap = Infinity;
    ring.forEach((corner, i) => {
      const away = length(sub(corner, point));
      if (away < gap) {
        gap = away;
        best = i;
      }
    });
    return gap < tolerance * 10 ? best : -1;
  };
  const firstOnTwo = near(two, first);
  const lastOnTwo = near(two, last);
  if (firstOnTwo < 0 || lastOnTwo < 0) return undefined;
  const out: Point[] = [];
  // Round `one` from the end of the shared run back to its start, the long way.
  for (let i = end; ; i = (i + 1) % one.length) {
    out.push(one[i] as Point);
    if (i === start) break;
  }
  // Then round `two` from the shared run's start to its end, the long way, its ends left out.
  for (let i = (firstOnTwo + 1) % two.length; i !== lastOnTwo; i = (i + 1) % two.length) out.push(two[i] as Point);
  const merged = clean(out);
  if (merged.length < 3 || selfCrossing(merged)) return undefined;
  if (Math.abs(area(merged) - area(a) - area(b)) > 1e-4 * Math.max(1, area(merged))) return undefined;
  return merged;
}

/** The straight line through a point with a direction, long enough to cross anything within `reach` of the point. */
export function lineThrough(point: Point, direction: Point, reach: number): Point[] {
  const run = length(direction) || 1;
  const d: Point = [(direction[0] / run) * reach, (direction[1] / run) * reach];
  return [
    [point[0] - d[0], point[1] - d[1]],
    [point[0] + d[0], point[1] + d[1]],
  ];
}
