/**
 * Wards: what the roads cut a town's ground into.
 *
 * The ground is first split along the centre line of every road, the river
 * and the wall, into faces that meet each other along those lines; a face is
 * the ground a ward stands on with half of each road round it. Each road's
 * strip is then taken out of the faces, at the road's own width, and what is
 * left of a face is its ward. A ward larger than a limit drawn for it is split
 * in two by an ordinary street, cut across its long axis near the middle,
 * turned a little and bent a little; and so on until every ward is under its
 * limit.
 */
import type { Rng } from '../city/random.ts';
import type { GrownSettings } from '../pack/schema.ts';
import type { Point } from '../schema.ts';
import { type Box, area, boxAround, boxesMeet, interiorPoint, inside, merge, smallestRectangle, splitAlong, stripOutline, subtract, toEdge, toLine } from './cutting.ts';
import { chaikin, normal } from './lines.ts';

/** Kept between a roadway and the ground beside it, so that what is built never touches the roadway. */
export const VERGE = 0.05;

/** A line that cuts the ground: a road, the river, the wall or a street splitting a ward. */
export interface Cut {
  /** The centre line; for a closed one, a loop. */
  points: Point[];
  closed: boolean;
  /** The strip taken out round the line, as a closed outline; nothing for a line that only splits faces. */
  strip?: Point[];
  /** Splits faces along its line. */
  splits: boolean;
}

export interface Ward {
  polygon: Point[];
  /** The face it stands on: its ground with half the roads round it. */
  face: number;
}

export interface Wards {
  faces: Point[][];
  wards: Ward[];
  /** The face the plaza stands on, if there is one. */
  plazaFace?: number;
  /** The streets that split wards, each a line from one side of its face to the other. */
  streets: Point[][];
}

/** A line made a little longer at each end, so that it crosses whatever it ends on. */
export function lengthened(points: readonly Point[], by: number): Point[] {
  const out = [...points];
  const reach = (from: Point, toward: Point): Point => {
    const run = Math.hypot(from[0] - toward[0], from[1] - toward[1]) || 1;
    return [from[0] + ((from[0] - toward[0]) / run) * by, from[1] + ((from[1] - toward[1]) / run) * by];
  };
  if (out.length >= 2) {
    out[0] = reach(out[0] as Point, out[1] as Point);
    out[out.length - 1] = reach(out[out.length - 1] as Point, out[out.length - 2] as Point);
  }
  return out;
}

/** The outline of a road's strip: its roadway and a verge either side. */
export const roadStrip = (points: readonly Point[], width: number) => stripOutline(lengthened(points, VERGE), width + 2 * VERGE);

export interface WardInput {
  settings: GrownSettings;
  rng: Rng;
  ground: Point[][];
  /** Taken out of the ground before anything else, such as the sea. */
  removed: Point[][];
  cuts: Cut[];
  /** The width of a street that splits a ward. */
  streetWidth: number;
  /** Whether a point lies on a road a street may end at, rather than the ground's edge or the wall. */
  onRoad: (point: Point) => boolean;
  /** How far a point is from water: a street keeps its roadway out of it. */
  dryBy: (point: Point) => number;
  /** The plaza: the face that holds it is no ward. */
  reserved?: Point[];
  /** The street round a plaza at the centre: the faces inside it are joined into the plaza's. */
  reservedRing?: Point[];
}

export function layWards(input: WardInput): Wards {
  const { settings, rng } = input;
  const least = settings.wards.least;
  let faces: Point[][] = [...input.ground];
  for (const outline of input.removed) faces = faces.flatMap((face) => subtract(face, outline).pieces);
  // Split along every line, in order.
  for (const cut of input.cuts) {
    if (!cut.splits) continue;
    const box = boxAround(cut.points);
    faces = faces.flatMap((face) => (boxesMeet(boxAround(face), box) ? splitAlong(face, cut.closed ? cut.points : lengthened(cut.points, 0.5), cut.closed).pieces : [face]));
  }
  faces = faces.filter((face) => area(face) > 1);
  if (input.reservedRing) {
    const ring = input.reservedRing;
    const within = faces.filter((face) => inside(interiorPoint(face), ring));
    let joined = within[0];
    let left = within.slice(1);
    for (let guard = 0; joined && left.length > 0 && guard < 20; guard++) {
      for (const face of [...left]) {
        const both = merge(joined as Point[], face, 1e-5);
        if (both) {
          joined = both;
          left = left.filter((other) => other !== face);
        }
      }
    }
    if (joined) faces = [...faces.filter((face) => !within.includes(face)), joined, ...left];
  }
  const strips = input.cuts.filter((cut) => cut.strip).map((cut) => ({ outline: cut.strip as Point[], box: boxAround(cut.strip as Point[]) }));
  /** What is left of a piece of ground once every strip near it is taken out. */
  const stripped = (piece: Point[], extra: Array<{ outline: Point[]; box: Box }> = []) => {
    let left = [piece];
    for (const strip of [...strips, ...extra]) {
      left = left.flatMap((part) => (boxesMeet(boxAround(part), strip.box) ? subtract(part, strip.outline).pieces : [part]));
    }
    return left;
  };
  const wards: Ward[] = [];
  const streets: Point[][] = [];
  const faceList: Point[][] = [];
  const turn = (settings.wards.turn * Math.PI) / 180;
  const extras: Array<{ outline: Point[]; box: Box }> = [];

  /** Splits a face, and its ward, while the ward is larger than its limit. */
  const settle = (face: Point[], ward: Point[], depth: number) => {
    const limit = settings.wards.limit.min + (settings.wards.limit.max - settings.wards.limit.min) * rng.next();
    if (area(ward) < limit || depth >= settings.wards.rounds) {
      faceList.push(face);
      wards.push({ polygon: ward, face: faceList.length - 1 });
      return;
    }
    // Across the long axis, so that the street reaches a road or another street at one end at least; failing
    // that, along it.
    for (let attempt = 0; attempt < 8; attempt++) {
      const line = streetAcross(ward, rng, settings, turn, attempt >= 6);
      // Only the stretches of it that pass through the ward, ending on a road at one end at least.
      const { pieces, chords } = splitAlong(face, line);
      if (chords.length === 0 || pieces.length < 2) continue;
      const through = chords.filter((chord) => chord.some((point, at) => at > 0 && inside(midpoint(chord[at - 1] as Point, point), ward)));
      const wet = through.some((chord) => chord.some((point, at) => {
        if (at === 0) return false;
        const from = chord[at - 1] as Point;
        const steps = Math.ceil(Math.hypot(point[0] - from[0], point[1] - from[1]) / 2);
        for (let step = 0; step <= steps; step++) if (input.dryBy([from[0] + ((point[0] - from[0]) * step) / steps, from[1] + ((point[1] - from[1]) * step) / steps]) < input.streetWidth / 2 + VERGE) return true;
        return false;
      }));
      if (wet) continue;
      const reaches = (point: Point) => input.onRoad(point) || streets.some((street) => toLine(point, street) < 1e-4);
      if (through.length === 0 || !through.every((chord) => reaches(chord[0] as Point) || reaches(chord[chord.length - 1] as Point))) continue;
      // Split along the chords that pass through the ward and no others.
      let parts: Point[][] = [face];
      for (const chord of through) parts = parts.flatMap((part) => splitAlong(part, lengthened(chord, 1e-3)).pieces);
      if (parts.length < 2) continue;
      const strip = through.map((chord) => ({ outline: roadStrip(chord, input.streetWidth), box: boxAround(roadStrip(chord, input.streetWidth)) }));
      let halves = [ward];
      for (const one of strip) halves = halves.flatMap((part) => (boxesMeet(boxAround(part), one.box) ? subtract(part, one.outline).pieces : [part]));
      halves = halves.filter((half) => area(half) >= least);
      if (halves.length < 2) continue;
      streets.push(...through);
      extras.push(...strip);
      for (const part of parts) {
        const own = halves.filter((half) => inside(interiorPoint(half), part));
        if (own.length === 0) continue;
        const largest = own.reduce((best, half) => (area(half) > area(best) ? half : best));
        settle(part, largest, depth + 1);
      }
      return;
    }
    faceList.push(face);
    wards.push({ polygon: ward, face: faceList.length - 1 });
  };

  let plazaFace: number | undefined;
  const plazaMiddle = input.reserved ? interiorPoint(input.reserved) : undefined;
  for (const face of faces) {
    if (plazaMiddle && plazaFace === undefined && inside(plazaMiddle, face)) {
      faceList.push(face);
      plazaFace = faceList.length - 1;
      continue;
    }
    const pieces = stripped(face).filter((piece) => area(piece) >= least);
    if (pieces.length === 0) continue;
    // A face is one ward: its largest piece. Slivers a strip cut off are no ward.
    const ward = pieces.reduce((best, piece) => (area(piece) > area(best) ? piece : best));
    settle(face, ward, 0);
  }
  return { faces: faceList, wards, streets, ...(plazaFace !== undefined && { plazaFace }) };
}

const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** The bell used to even out a bent line's offsets. */
const BELL = [-2, -1, 0, 1, 2].map((k) => Math.exp(-(k * k) / (2 * 0.8 * 0.8)));

/** A street across a ward's long axis (or along it), near its middle, turned a little and bent a little. */
function streetAcross(ward: Point[], rng: Rng, settings: GrownSettings, turn: number, along: boolean): Point[] {
  const rect = smallestRectangle(ward);
  const at = settings.wards.at.min + (settings.wards.at.max - settings.wards.at.min) * rng.next();
  const [long, short] = along ? [rect.short, rect.long] : [rect.long, rect.short];
  const middle: Point = [rect.corner[0] + long[0] * at + short[0] * 0.5, rect.corner[1] + long[1] * at + short[1] * 0.5];
  const longRun = Math.hypot(long[0], long[1]) || 1;
  const shortRun = Math.hypot(short[0], short[1]);
  const angle = normal(rng) * turn;
  // Across the axis, turned.
  const across: Point = [-long[1] / longRun, long[0] / longRun];
  const u: Point = [across[0] * Math.cos(angle) - across[1] * Math.sin(angle), across[1] * Math.cos(angle) + across[0] * Math.sin(angle)];
  const v: Point = [-u[1], u[0]];
  const reach = longRun + shortRun + 50;
  const half = shortRun * 0.75;
  const raw = Array.from({ length: 7 }, (_, k) => (k === 0 || k === 6 ? 0 : normal(rng) * settings.wards.bend * half));
  const offsets = raw.map((_, k) => {
    if (k === 0 || k === 6) return 0;
    let sum = 0;
    let weight = 0;
    BELL.forEach((share, index) => {
      const from = k + index - 2;
      if (from < 0 || from > 6) return;
      sum += share * (raw[from] as number);
      weight += share;
    });
    return sum / weight;
  });
  const bent = offsets.map((offset, k): Point => {
    const t = -1 + (2 * k) / 6;
    return [middle[0] + u[0] * half * t + v[0] * offset, middle[1] + u[1] * half * t + v[1] * offset];
  });
  return [[middle[0] - u[0] * reach, middle[1] - u[1] * reach], ...chaikin(bent, 2), [middle[0] + u[0] * reach, middle[1] + u[1] * reach]];
}

/** Whether a point lies on any of a set of lines, within a hair. */
export function onAnyLine(lines: readonly Point[][]): (point: Point) => boolean {
  return (point) => lines.some((line) => toLine(point, line) < 1e-5);
}

export { toEdge };
