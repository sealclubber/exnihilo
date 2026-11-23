/**
 * Stage 10 of the staged generator: rows of houses.
 *
 * In every block houses are laid along each edge, longest edge first. A
 * house is a rectangle on the edge, facing the street, and half have a rear
 * wing that makes an L; the ground behind is the block's courtyard. A block
 * too shallow for a courtyard has one row right through. A house lies
 * wholly inside its block and never overlaps another or a passage: one that
 * does not fit is made a little narrower or shallower, and failing that is
 * not built, and the ground is left as yard. More houses are made here than
 * the town has; a later stage keeps exactly as many as it needs.
 */
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { simplifyRing, smallestRectangle } from '../cutting.ts';
import { distance } from '../geometry.ts';
import { normal } from '../lines.ts';
import { type Block, wardRng } from './blocks.ts';
import { add, drawFrom, left, unit } from './lines.ts';
import { type Outline, type Rect, type Standing, cornersOf, outlineOf, pointInside, rayDepth, rectInside, standingOf, standingOverlap, widenedRect } from './rects.ts';
import type { Ward } from './wards.ts';

export interface House {
  /** Its block and its ward, by their places in the plan. */
  block: number;
  ward: number;
  /** The edge of the block it was laid along, and its own front on it: its entrance is the middle of its front. */
  edge: [Point, Point];
  front: [Point, Point];
  /** Its outline: four corners, or six with a rear wing. Every corner is a right angle. */
  outline: Point[];
  /** The rectangles it is made of: the body, then any wing. */
  parts: Rect[];
  area: number;
  centre: Point;
}

export interface Passage {
  block: number;
  ward: number;
  rect: Rect;
  /** From the street to the courtyard. */
  axis: [Point, Point];
}

/** How a ward's rows differ from the town's ordinary ones. */
export interface RowCharacter {
  /** The chance that a house has a rear wing, and that a courtyard block has a passage. */
  wing: number;
  passage: number;
}

/** A hair's breadth, in metres: a house may touch the line it must stay inside. */
const HAIR = 0.01;
/** The shapes tried for a house that does not fit as drawn: shares of its width and of its depth. */
const SHAPES: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, 0.85], [0.85, 1], [0.85, 0.85], [1, 0.7], [0.7, 1], [1, 0.6], [0.6, 1]];

export function layRows(
  blocks: readonly Block[],
  wards: readonly Ward[],
  settings: StagedSettings,
  seed: number,
  /** The blocks given to landmarks: no row is laid in them. */
  reserved: ReadonlySet<number> = new Set(),
  characterOf: (ward: Ward, index: number) => RowCharacter = () => ({ wing: settings.rows.wing.chance, passage: settings.rows.passage.chance }),
): { houses: House[]; passages: Passage[] } {
  const rules = settings.rows;
  const houses: House[] = [];
  const passages: Passage[] = [];
  /** How many blocks of each ward have been seen: a block's rows draw on a stream named by its ward and its place in it. */
  const seen = new Map<number, number>();
  blocks.forEach((block, index) => {
    const ward = wards[block.ward] as Ward;
    const place = seen.get(block.ward) ?? 0;
    seen.set(block.ward, place + 1);
    // No row is laid in a reserved block. Each block has a stream of its own, so that changes no other block.
    if (reserved.has(index)) return;
    const rng = wardRng(seed, ward, `rows-${place}`);
    const character = characterOf(ward, block.ward);
    const outline = outlineOf(block.polygon);
    const shell = simplifyRing(block.polygon, rules.simplify);
    const box = smallestRectangle(block.polygon);
    const narrow = Math.hypot(box.short[0], box.short[1]);
    const court = narrow >= rules.court.least;
    let wantPassage = rng.chance(character.passage);
    /** Everything standing in the block so far: houses' parts and passages. */
    const standing: Standing[] = [];
    const clear = (rect: Rect) => {
      const wide = standingOf(widenedRect(rect, rules.gap));
      for (const other of standing) if (standingOverlap(wide, other)) return false;
      return true;
    };
    const fits = (rect: Rect) => clear(rect) && rectInside(widenedRect(rect, rules.inset - HAIR), outline);

    const edges = shell.map((from, at) => ({ from, to: shell[(at + 1) % shell.length] as Point, at })).sort((a, b) => distance(b.from, b.to) - distance(a.from, a.to) || a.at - b.at);
    for (const { from, to } of edges) {
      const length = distance(from, to);
      if (length < rules.edgeLeast) continue;
      const along = unit(from, to);
      let inward = left(along);
      if (!pointInside(add(add(from, along, length / 2), inward, 2), outline)) inward = [-inward[0], -inward[1]];
      let rowDepth = drawFrom(rng, rules.depth) * Math.sqrt(block.scale);
      // Too shallow for a courtyard: one row right through. Otherwise a courtyard always remains.
      rowDepth = court ? Math.min(rowDepth, rules.court.share * narrow) : narrow;
      const at = (x: number, back: number): Point => add(add(from, along, x), inward, back);
      /** How deep a house may be at a place on the edge before it meets the far side of the block. */
      const room = (x: number, width: number, back: number) => Math.min(...[0.02, 0.5, 0.98].map((share) => rayDepth(at(x + width * share, back + HAIR), inward, outline))) - rules.inset;

      for (let x = 0; x < length - rules.stopShort; ) {
        if (wantPassage && court && x > rules.passage.after * length && length > rules.passage.edgeLeast) {
          const depth = Math.min(rowDepth * rules.passage.depth, room(x, rules.passage.width, 0));
          const rect: Rect = { corner: at(x, 0), along, inward, width: rules.passage.width, depth: Math.max(depth, HAIR) };
          // Only where no house of an earlier row stands in its way; otherwise it is tried further along.
          if (clear(rect)) {
            passages.push({ block: index, ward: block.ward, rect, axis: [at(x + rules.passage.width / 2, 0), at(x + rules.passage.width / 2, rect.depth)] });
            standing.push(standingOf(rect));
            x += rules.passage.width + rules.gap + HAIR;
            wantPassage = false;
            continue;
          }
        }
        let width = Math.min(Math.min(Math.max(Math.exp(Math.log(rules.width.median * block.scale) + normal(rng) * rules.width.spread), rules.width.min), rules.width.max), length - x);
        if (length - x - width < rules.endLeast) width = length - x;
        const depth = rowDepth * drawFrom(rng, rules.depth.vary);
        // A wing is drawn for every house, built or not, so that one house's fit never changes the next one's draws.
        const wing = { wanted: rng.chance(character.wing), share: drawFrom(rng, rules.wing.width), depth: drawFrom(rng, rules.wing.depth), atStart: rng.chance(0.5) };

        let body: Rect | undefined;
        search: for (const back of rules.setBack > 0 ? [0, rules.setBack] : [0]) {
          const intended = Math.min(depth, room(x, width, back + rules.inset));
          if (intended < rules.narrowest) continue;
          for (const [wide, deep] of SHAPES) {
            if (wide * deep < rules.keep - 1e-9 || width * wide < rules.narrowest || intended * deep < rules.narrowest || width * wide * intended * deep < rules.leastArea) continue;
            // A narrower house is tried at the start of its place and at the end.
            for (const shift of wide < 1 ? [0, width * (1 - wide)] : [0]) {
              const rect: Rect = { corner: at(x + shift, back + rules.inset), along, inward, width: width * wide, depth: intended * deep };
              if (!fits(rect)) continue;
              body = rect;
              break search;
            }
          }
        }
        if (!body) {
          // Yard: the row moves on a little and tries again.
          x += rules.step;
          continue;
        }
        const parts = [body];
        const corners = cornersOf(body);
        let shape: Point[] = corners;
        if (wing.wanted && court && body.width > rules.wing.bodyLeast) {
          const wingWidth = body.width * wing.share;
          for (const atStart of [wing.atStart, !wing.atStart]) {
            const rect: Rect = { corner: add(add(body.corner, inward, body.depth), along, atStart ? 0 : body.width - wingWidth), along, inward, width: wingWidth, depth: wing.depth };
            // The body is not standing yet, so the wing is tested against everything else.
            if (!clear(rect) || !rectInside(widenedRect(rect, rules.inset - HAIR), outline)) continue;
            parts.push(rect);
            const [w0, w1, w2, w3] = cornersOf(rect);
            shape = atStart ? [corners[0], corners[1], corners[2], w1, w2, w3] : [corners[0], corners[1], w2, w3, w0, corners[3]];
            break;
          }
        }
        for (const part of parts) standing.push(standingOf(part));
        houses.push({
          block: index,
          ward: block.ward,
          edge: [from, to],
          front: [corners[0], corners[1]],
          outline: shape,
          parts,
          area: parts.reduce((sum, part) => sum + part.width * part.depth, 0),
          centre: add(add(body.corner, along, body.width / 2), inward, body.depth / 2),
        });
        // The next house stands a gap along: a row is a terrace of separate houses.
        x += width + rules.gap + HAIR;
      }
    }
  });
  return { houses, passages };
}

/** A block's outline, ready for tests against it. */
export const blockOutline = (block: Block): Outline => outlineOf(block.polygon);
