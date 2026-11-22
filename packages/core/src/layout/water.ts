/**
 * Water with no straight edge: a river that meanders and varies in width, and
 * a coast of bays and headlands. Water is made first, before roads and the
 * town's outline, so that everything else fits round its real shape.
 *
 * Both come from the brief's bearings and the pack's numbers, with randomness
 * from streams of their own.
 */
import { stepRng } from '../city/random.ts';
import type { GrownSettings } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import { bearingVector, distance } from './geometry.ts';

const TAU = 2 * Math.PI;
/** How many squares out from a point the nearest stretch of a river is looked for; further off, it is far and no more is said. */
const FAR_RINGS = 6;

/** A river as it lies on the map: its centre line, cut finely, and its width at each point of it. */
export interface River {
  line: Point[];
  widths: number[];
  /** The mean width. */
  width: number;
  /** How far along the line each point is. */
  along: number[];
  /** How far a point is from the water's edge: negative in the water. */
  gap(point: Point): number;
  /** The nearest point of the centre line: which piece it is on, how far along the line, and the width there. */
  nearest(point: Point): { index: number; along: number; point: Point; width: number; away: number };
  /** The point at a distance along the line, with the direction the river runs there and its width. */
  at(along: number): { point: Point; direction: Point; width: number };
}

/** The slow, seeded swing of something along a line: a few waves of different lengths, between -1 and 1. */
function swing(rng: { next(): number }, length: number): (along: number) => number {
  const waves = [1, 0.37, 2.3].map((scale) => ({ k: TAU / (length * scale), phase: rng.next() * TAU }));
  const shares = [0.6, 0.25, 0.15];
  return (along) => waves.reduce((sum, wave, index) => sum + (shares[index] as number) * Math.sin(wave.k * along + wave.phase), 0);
}

/**
 * The river of a brief, or nothing if it has none. It arrives and leaves on the brief's bearings and passes
 * beside the centre, at least `beside` metres from it; in between it meanders. `reach` is how far from the
 * centre its ends lie, which must be beyond anything that will be drawn.
 */
export function makeRiver(brief: SettlementBrief, meanWidth: number, settings: GrownSettings['river'], seed: number, beside: number, reach: number): River | undefined {
  if (!brief.river) return undefined;
  const arrives = brief.river.arrivesFrom?.bearing;
  const leaves = brief.river.leavesToward?.bearing ?? brief.coast.waterBearing ?? (arrives === undefined ? undefined : (arrives + 180) % 360);
  if (leaves === undefined) return undefined;
  const rng = stepRng(seed, 'grown-river');
  const meander = settings.meanderLength * meanWidth;
  const swingMost = settings.meanderSwing * meander;
  // Clear of the centre by its own swing as well.
  const clear = beside + swingMost;
  const end = (bearing: number): Point => {
    const [x, y] = bearingVector(bearing);
    return [x * reach, y * reach];
  };
  // The course before it meanders: straight in from where it arrives to a point beside the centre and straight
  // out to where it leaves, with the corner between rounded off into one long bend.
  let course: Point[];
  if (arrives === undefined) {
    const [x, y] = bearingVector(leaves + 90);
    course = [[x * clear, y * clear], end(leaves)];
  } else {
    const bend = ((leaves - arrives + 540) % 360) - 180;
    const [x, y] = bearingVector(arrives + (Math.abs(bend) === 180 ? 90 : bend / 2));
    const apex: Point = [x * clear, y * clear];
    const from = end(arrives);
    const to = end(leaves);
    const round = Math.min(1.5 * meander, distance(from, apex) / 2, distance(apex, to) / 2);
    const toward = (a: Point, b: Point, far: number): Point => {
      const length = distance(a, b);
      return [a[0] + ((b[0] - a[0]) * far) / length, a[1] + ((b[1] - a[1]) * far) / length];
    };
    const start = toward(apex, from, round);
    const finish = toward(apex, to, round);
    course = [from];
    for (let step = 0; step <= 24; step++) {
      const t = step / 24;
      course.push([(1 - t) * (1 - t) * start[0] + 2 * t * (1 - t) * apex[0] + t * t * finish[0], (1 - t) * (1 - t) * start[1] + 2 * t * (1 - t) * apex[1] + t * t * finish[1]]);
    }
    course.push(to);
  }
  // Walk the course in short steps, swinging aside from it as a meander of slowly varying length and reach.
  const lengths: number[] = [0];
  for (let index = 1; index < course.length; index++) lengths.push((lengths[index - 1] as number) + distance(course[index - 1] as Point, course[index] as Point));
  const total = lengths[lengths.length - 1] as number;
  const stretch = swing(rng, 9 * meander);
  const reachOf = swing(rng, 6 * meander);
  const wide = swing(rng, 5 * meander);
  const line: Point[] = [];
  const widths: number[] = [];
  let phase = rng.next() * TAU;
  let piece = 1;
  const step = settings.pieceLength;
  for (let walked = 0; walked <= total; walked += step) {
    while (piece < course.length - 1 && (lengths[piece] as number) < walked) piece++;
    const a = course[piece - 1] as Point;
    const b = course[piece] as Point;
    const span = (lengths[piece] as number) - (lengths[piece - 1] as number);
    const share = span === 0 ? 0 : (walked - (lengths[piece - 1] as number)) / span;
    const aside = swingMost * (0.75 + 0.25 * reachOf(walked)) * Math.sin(phase);
    line.push([a[0] + (b[0] - a[0]) * share - ((b[1] - a[1]) / span) * aside, a[1] + (b[1] - a[1]) * share + ((b[0] - a[0]) / span) * aside]);
    // Wider where it swings furthest, which is the outside of a bend, and varying besides.
    widths.push(meanWidth * (1 + settings.widthVariation * (0.6 * wide(walked) + 0.4 * Math.abs(Math.sin(phase)) * 2 - 0.4)));
    phase += (TAU * step) / (meander * (1 + 0.25 * stretch(walked)));
  }
  const along: number[] = [0];
  for (let index = 1; index < line.length; index++) along.push((along[index - 1] as number) + distance(line[index - 1] as Point, line[index] as Point));
  const mean = widths.reduce((sum, width) => sum + width, 0) / widths.length;

  // Pieces are filed by square, so that the nearest is found without looking at them all.
  const square = Math.max(40, 4 * meanWidth);
  const filed = new Map<string, number[]>();
  for (let index = 1; index < line.length; index++) {
    const [ax, ay] = line[index - 1] as Point;
    const [bx, by] = line[index] as Point;
    for (let x = Math.floor(Math.min(ax, bx) / square); x <= Math.floor(Math.max(ax, bx) / square); x++) {
      for (let y = Math.floor(Math.min(ay, by) / square); y <= Math.floor(Math.max(ay, by) / square); y++) {
        const key = `${x}:${y}`;
        const list = filed.get(key);
        if (list) list.push(index);
        else filed.set(key, [index]);
      }
    }
  }
  const nearest = (point: Point) => {
    let best = { index: 1, along: 0, point: line[0] as Point, width: widths[0] as number, away: Infinity };
    const look = (index: number) => {
      const a = line[index - 1] as Point;
      const b = line[index] as Point;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const squared = dx * dx + dy * dy;
      const t = squared === 0 ? 0 : Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / squared));
      const on: Point = [a[0] + dx * t, a[1] + dy * t];
      const away = distance(point, on);
      if (away < best.away) best = { index, along: (along[index - 1] as number) + t * Math.sqrt(squared), point: on, width: (widths[index - 1] as number) + ((widths[index] as number) - (widths[index - 1] as number)) * t, away };
    };
    // Rings of squares outward from the point's own, until one more ring could hold nothing nearer.
    const cx = Math.floor(point[0] / square);
    const cy = Math.floor(point[1] / square);
    // Beyond a few squares the river is simply far off: what is nearest then is not looked for.
    for (let ring = 0; ring <= FAR_RINGS; ring++) {
      if (best.away < (ring - 1) * square) break;
      for (let x = cx - ring; x <= cx + ring; x++) {
        for (let y = cy - ring; y <= cy + ring; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
          for (const index of filed.get(`${x}:${y}`) ?? []) look(index);
        }
      }
    }
    if (best.away === Infinity) best.away = FAR_RINGS * square;
    return best;
  };
  return {
    line,
    widths,
    width: mean,
    along,
    nearest,
    gap(point) {
      const found = nearest(point);
      return found.away - found.width / 2;
    },
    at(far) {
      let index = 1;
      let low = 1;
      let high = line.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((along[middle] as number) < far) low = middle + 1;
        else high = middle;
      }
      index = low;
      const a = line[index - 1] as Point;
      const b = line[index] as Point;
      const span = (along[index] as number) - (along[index - 1] as number);
      const t = span === 0 ? 0 : Math.min(1, Math.max(0, (far - (along[index - 1] as number)) / span));
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], direction: span === 0 ? [1, 0] : [(b[0] - a[0]) / span, (b[1] - a[1]) / span], width: (widths[index - 1] as number) + ((widths[index] as number) - (widths[index - 1] as number)) * t };
    },
  };
}

/** A coast as it lies on the map: the sea is everything beyond the shore, on the side of the brief's water bearing. */
export interface Coast {
  /** The unit vector toward open water, and the one along the shore. */
  seaward: Point;
  alongShore: Point;
  /** The shore, as a line from one end of the map to the other. */
  shore: Point[];
  /** The sea, as a polygon that reaches well beyond anything drawn. */
  polygon: Point[];
  /** How far out the shore lies at a position along it. */
  shoreAt(along: number): number;
  /** How far a point is from the water, measured straight out to sea: negative in the water. */
  gap(point: Point): number;
}

/**
 * The coast of a brief, or nothing if it has none: broad bays and headlands with a smaller wobble on top, at
 * about `out` metres from the centre where the town stands. A port stands in a bay of its own: the shore is
 * nearest the centre there, and runs out to a headland on either side.
 */
export function makeCoast(brief: SettlementBrief, settings: GrownSettings['coast'], seed: number, out: number, reach: number): Coast | undefined {
  if (brief.coast.waterBearing === undefined) return undefined;
  const seaward = bearingVector(brief.coast.waterBearing);
  const alongShore: Point = [-seaward[1], seaward[0]];
  const rng = stepRng(seed, 'grown-coast');
  const bays = swing(rng, settings.bays.length);
  const wobble = swing(rng, settings.wobble.length);
  const harbour = brief.flags.port ? settings.harbour : undefined;
  const base = out - settings.bays.depth * bays(0) - settings.wobble.depth * wobble(0);
  const shoreAt = (along: number) =>
    base + settings.bays.depth * bays(along) + settings.wobble.depth * wobble(along) + (harbour ? harbour.depth * (1 - Math.exp(-(along * along) / (2 * (harbour.length / 2) ** 2))) : 0);
  const place = (along: number, outward: number): Point => [seaward[0] * outward + alongShore[0] * along, seaward[1] * outward + alongShore[1] * along];
  const shore: Point[] = [];
  const span = 2 * reach;
  for (let along = -span; along <= span; along += settings.pieceLength) shore.push(place(along, shoreAt(along)));
  return {
    seaward,
    alongShore,
    shore,
    polygon: [...shore, place(span, out + 2 * span), place(-span, out + 2 * span)],
    shoreAt,
    gap: (point) => shoreAt(point[0] * alongShore[0] + point[1] * alongShore[1]) - (point[0] * seaward[0] + point[1] * seaward[1]),
  };
}
