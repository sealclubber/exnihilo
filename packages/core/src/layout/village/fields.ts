/**
 * Step 8 of the village generator: fields, last.
 *
 * The village has an envelope: its palisade, or a smooth outline round its
 * plots. Fields lie outside it, cut only by the roads, and keep off the water
 * and the green. Near the village they are long strips; farther out, closes;
 * farthest, larger commons. They carry furrows, and some far ones are
 * woodland. Fields, trees, barns and boats are drawing: no one lives or
 * works in them.
 */
import type { Rng } from '../../city/random.ts';
import type { VillageSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { smallestRectangle, stripOutline } from '../cutting.ts';
import { distanceToPolygonEdge, pointInPolygon, polygonArea, polygonCentroid } from '../geometry.ts';
import { add, crossingsAlong, drawFrom, size } from '../staged/lines.ts';
import { grown, widened, without } from '../staged/shapes.ts';
import type { Coast, River } from '../staged/water.ts';
import type { Palisade } from './palisade.ts';
import type { Way } from './roads.ts';

export type FieldKind = 'strip' | 'close' | 'common' | 'wood';

export interface Field {
  outline: Point[];
  kind: FieldKind;
  /** Lines along it, for drawing. */
  furrows: Point[][];
}

export interface Countryside {
  /** The outline the village keeps within: the palisade's, or one round its plots. */
  envelope: Point[];
  fields: Field[];
  /** A point and a radius each: in woods, at plots' backs. */
  trees: Array<{ point: Point; radius: number }>;
  boats: Point[][];
}

export interface FieldInput {
  settings: VillageSettings;
  rng: Rng;
  buildings: number;
  plots: readonly (readonly Point[])[];
  ways: readonly Way[];
  palisade?: Palisade;
  green?: readonly Point[];
  landing?: { outline: readonly Point[]; out: Point };
  river?: River;
  coast?: Coast;
}

/** How many points the circle of the countryside is drawn with. */
const CIRCLE = 72;
/** How deep a field is cut, at most. */
const DEPTH = 12;
/** How far inside its field a furrow stops, in metres, and the shortest drawn. */
const FURROW_INSET = 1.2;
const FURROW_SHORTEST = 6;
/** How many times a tree's place is drawn for each tree wanted, at most. */
const TREE_TRIES = 3;
/** How far a cutting line reaches either way, in metres: beyond any field. */
const FAR = 5000;

export function layFields({ settings, rng, buildings, plots, ways, palisade, green, landing, river, coast }: FieldInput): Countryside {
  const rules = settings.fields;
  // ---- The envelope ---------------------------------------------------------------------------------------------------
  let envelope: Point[];
  if (palisade) envelope = largest(grown([palisade.ring], rules.envelope.palisade, true).rings) ?? palisade.ring;
  else {
    const out = grown(plots as Point[][], rules.envelope.grow, true);
    envelope = largest(grown(out.rings, -rules.envelope.shrink, true, out.holes).rings) ?? (plots[0] as Point[]);
  }

  // ---- The countryside about it, less water, the green and the roads -----------------------------------------------------
  const points = plots.flat();
  const middle = points.reduce((sum, point): Point => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]);
  const radius = Math.max(...points.map((point) => size([point[0] - middle[0], point[1] - middle[1]]))) + (buildings >= rules.largeFrom ? rules.largeBand : rules.band);
  const circle = Array.from({ length: CIRCLE }, (_, k): Point => add(middle, [Math.cos((2 * Math.PI * k) / CIRCLE), Math.sin((2 * Math.PI * k) / CIRCLE)], radius));
  const taken: Point[][] = [envelope];
  if (river) taken.push(...grown([stripOutline(river.line, river.width)], rules.waterClear).rings);
  if (coast) taken.push(...grown([coast.polygon], rules.waterClear).rings);
  if (green) taken.push(...grown([green as Point[]], rules.greenClear).rings);
  for (const way of ways) if (way.kind === 'road') taken.push(...widened([way.points], way.width + 2 * rules.roadClear));
  let zone = without([circle], taken);
  // A ring of country with the village as its hole is cut once more, so that every piece is a plain outline.
  if (zone.holes.length > 0) zone = without([circle], [...taken, ...widened([[middle, add(middle, [1, 0], radius * 2)]], rules.gap)]);

  // ---- Cut into strips, closes and commons ---------------------------------------------------------------------------------
  const fields: Field[] = [];
  const awayFrom = (point: Point) => (pointInPolygon(point, envelope) ? 0 : distanceToPolygonEdge(point, envelope));
  /** A field cut in two by a line through a point, `gap` wide. */
  const cut = (ring: Point[], at: Point, direction: Point): Point[][] => {
    const turn = (rng.next() * 2 - 1) * 0.12;
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    const along: Point = [direction[0] * c - direction[1] * s, direction[1] * c + direction[0] * s];
    const parts = without([ring], widened([[add(at, along, -FAR), add(at, along, FAR)]], rules.gap));
    return parts.holes.length > 0 ? [ring] : parts.rings.filter((piece) => polygonArea(piece) >= rules.least);
  };
  const divide = (ring: Point[], depth: number, limit: number): void => {
    const box = smallestRectangle(ring);
    const [long, short] = [size(box.long), size(box.short)];
    const unitLong: Point = [box.long[0] / (long || 1), box.long[1] / (long || 1)];
    const unitShort: Point = [box.short[0] / (short || 1), box.short[1] / (short || 1)];
    const away = awayFrom(polygonCentroid(ring));
    const kind: FieldKind = away < rules.strips.within ? 'strip' : away < rules.commons.beyond ? 'close' : 'common';
    let pieces: Point[][] | undefined;
    if (depth < DEPTH) {
      const share = 0.35 + 0.3 * rng.next();
      if (kind === 'strip' && short > rules.strips.width.max) pieces = cut(ring, add(add(box.corner, box.short, share), box.long, 0.5), unitLong);
      else if (kind === 'strip' && long > rules.strips.length) pieces = cut(ring, add(add(box.corner, box.long, share), box.short, 0.5), unitShort);
      else if (kind !== 'strip' && polygonArea(ring) > limit) pieces = cut(ring, add(add(box.corner, box.long, share), box.short, 0.5), unitShort);
    }
    if (pieces && pieces.length >= 2) {
      for (const piece of pieces) divide(piece, depth + 1, drawFrom(rng, kind === 'common' ? rules.commons.area : rules.closes.area));
      return;
    }
    fields.push({ outline: ring, kind, furrows: [] });
  };
  for (const ring of zone.rings) if (polygonArea(ring) >= rules.least) divide(ring, 0, drawFrom(rng, rules.closes.area));

  // ---- Woods, furrows and trees ---------------------------------------------------------------------------------------------
  const trees: Countryside['trees'] = [];
  for (const field of fields) {
    if (field.kind !== 'strip' && awayFrom(polygonCentroid(field.outline)) > rules.wood.beyond && rng.next() < rules.wood.share) {
      field.kind = 'wood';
      const box = smallestRectangle(field.outline);
      const wanted = Math.floor(polygonArea(field.outline) / rules.wood.perTree);
      let planted = 0;
      for (let k = 0; k < wanted * TREE_TRIES && planted < wanted; k++) {
        const point = add(add(box.corner, box.long, rng.next()), box.short, rng.next());
        if (!pointInPolygon(point, field.outline)) continue;
        trees.push({ point, radius: drawFrom(rng, rules.wood.radius) });
        planted++;
      }
      continue;
    }
    const box = smallestRectangle(field.outline);
    const shrunk = largest(grown([field.outline], -FURROW_INSET).rings);
    if (!shrunk) continue;
    const across = Math.floor(size(box.short) / rules.furrow);
    const closed = [...shrunk, shrunk[0] as Point];
    for (let k = 1; k < across; k++) {
      const from = add(box.corner, box.short, k / across);
      const line: Point[] = [from, add(from, box.long, 1)];
      field.furrows.push(...clipTo(line, closed, shrunk));
    }
  }
  for (const plot of plots) {
    if (rng.next() >= rules.trees.share) continue;
    const corner = plot[rng.next() < 0.5 ? 2 : 3] as Point;
    trees.push({ point: corner, radius: drawFrom(rng, rules.trees.radius) });
  }

  // ---- Boats by the landing --------------------------------------------------------------------------------------------------
  const boats: Point[][] = [];
  if (landing) {
    const foot = landing.outline[0] as Point;
    const across: Point = [-landing.out[1], landing.out[0]];
    for (let k = 0; k < rules.boats.count; k++) {
      const middleOfBoat = add(add(foot, landing.out, drawFrom(rng, rules.boats.out)), across, (rng.next() * 2 - 1) * rules.boats.along);
      const turn = rng.next() * Math.PI;
      const [u, v]: [Point, Point] = [[Math.cos(turn), Math.sin(turn)], [-Math.sin(turn), Math.cos(turn)]];
      const hull = Array.from({ length: 10 }, (_, j) => add(add(middleOfBoat, u, (Math.cos((2 * Math.PI * j) / 10) * rules.boats.length) / 2), v, (Math.sin((2 * Math.PI * j) / 10) * rules.boats.width) / 2));
      if (hull.every((point) => (coast ? coast.gap(point) < 0 : river ? river.gap(point) < 0 : false))) boats.push(hull);
    }
  }
  return { envelope, fields, trees, boats };
}

/** The largest of some outlines. */
function largest(rings: readonly Point[][]): Point[] | undefined {
  let best: Point[] | undefined;
  for (const ring of rings) if (!best || polygonArea(ring) > polygonArea(best)) best = ring;
  return best;
}

/** The pieces of a straight line, run on far either way, that lie inside an outline. */
function clipTo(line: Point[], closed: Point[], ring: Point[]): Point[][] {
  const [a, b] = [line[0] as Point, line[1] as Point];
  const direction: Point = [b[0] - a[0], b[1] - a[1]];
  const long: Point[] = [add(a, direction, -FAR / Math.max(size(direction), 1)), add(a, direction, FAR / Math.max(size(direction), 1))];
  const length = size([long[1]![0] - long[0]![0], long[1]![1] - long[0]![1]]);
  const at = (along: number): Point => add(long[0] as Point, [(long[1]![0] - long[0]![0]) / length, (long[1]![1] - long[0]![1]) / length], along);
  const crossings = crossingsAlong(long, closed);
  const pieces: Point[][] = [];
  for (let k = 1; k < crossings.length; k++) {
    const [from, to] = [crossings[k - 1] as number, crossings[k] as number];
    if (to - from < FURROW_SHORTEST) continue;
    if (pointInPolygon(at((from + to) / 2), ring)) pieces.push([at(from), at(to)]);
  }
  return pieces;
}
