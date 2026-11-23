/**
 * Stage 9 of the staged generator, second half: blocks.
 *
 * Each ward is split into blocks: cut across its long axis near the middle
 * by a lane, turned slightly, and its pieces cut again until they are small
 * enough. The line of each cut is kept: it is the lane's centre line. A
 * ward's cuts draw on a stream of the ward's own, named by its seed point,
 * so that changing one ward changes no other.
 */
import { type Rng, stepRng } from '../../city/random.ts';
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { smallestRectangle } from '../cutting.ts';
import { polygonArea } from '../geometry.ts';
import { normal } from '../lines.ts';
import { add, drawFrom } from './lines.ts';
import { without } from './shapes.ts';
import type { Ward } from './wards.ts';

export interface Block {
  /** Its ward, by its place among the plan's wards. */
  ward: number;
  polygon: Point[];
  area: number;
  /** The ward's scale: how large its houses and blocks are beside the town's ordinary ones. */
  scale: number;
}

export interface Lane {
  ward: number;
  /** The centre line of the cut, from one side of the piece it parted to the other. */
  line: [Point, Point];
}

/** The name of a ward's own stream: its seed point to the centimetre, and which piece of the cell it is. */
export const wardKey = (ward: Pick<Ward, 'seed' | 'piece'>) => `${ward.seed[0].toFixed(2)}:${ward.seed[1].toFixed(2)}:${ward.piece}`;
export const wardRng = (seed: number, ward: Pick<Ward, 'seed' | 'piece'>, step: string): Rng => stepRng(seed, `staged-${step}:${wardKey(ward)}`);

/** Where a line through a point crosses a polygon: the stretches of it that lie inside. */
function chords(point: Point, way: Point, polygon: readonly Point[]): Array<[Point, Point]> {
  const hits: number[] = [];
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a, b] = [polygon[j] as Point, polygon[i] as Point];
    const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
    const denominator = way[0] * ey - way[1] * ex;
    if (Math.abs(denominator) < 1e-12) continue;
    const t = ((a[0] - point[0]) * ey - (a[1] - point[1]) * ex) / denominator;
    const s = ((a[0] - point[0]) * way[1] - (a[1] - point[1]) * way[0]) / denominator;
    if (s >= 0 && s < 1) hits.push(t);
  }
  hits.sort((x, y) => x - y);
  const out: Array<[Point, Point]> = [];
  for (let at = 0; at + 1 < hits.length; at += 2) out.push([add(point, way, hits[at] as number), add(point, way, hits[at + 1] as number)]);
  return out;
}

export function cutBlocks(wards: readonly Ward[], settings: StagedSettings, seed: number, scaleOf: (ward: Ward, index: number) => number = () => 1): { blocks: Block[]; lanes: Lane[] } {
  const rules = settings.blocks;
  const blocks: Block[] = [];
  const lanes: Lane[] = [];
  wards.forEach((ward, index) => {
    if (ward.kind !== 'ordinary') return;
    const rng = wardRng(seed, ward, 'blocks');
    const scale = scaleOf(ward, index) * Math.min(Math.max(Math.exp(normal(rng) * rules.wardScale.spread), rules.wardScale.min), rules.wardScale.max);
    const split = (polygon: Point[], limit: number) => {
      const size = polygonArea(polygon);
      if (size < limit) {
        blocks.push({ ward: index, polygon, area: size, scale });
        return;
      }
      const box = smallestRectangle(polygon);
      const share = drawFrom(rng, rules.cut);
      const angle = normal(rng) * rules.turn;
      const drift = drawFrom(rng, rules.drift);
      const across = Math.hypot(box.short[0], box.short[1]) || 1;
      const reach = Math.hypot(box.long[0], box.long[1]) + across;
      const through: Point = [box.corner[0] + box.long[0] * share + box.short[0] * 0.5, box.corner[1] + box.long[1] * share + box.short[1] * 0.5];
      const [ux, uy] = [box.short[0] / across, box.short[1] / across];
      const way: Point = [ux * Math.cos(angle) - uy * Math.sin(angle), uy * Math.cos(angle) + ux * Math.sin(angle)];
      const side: Point = [-way[1], way[0]];
      const half = settings.widths.lane / 2;
      const strip = [add(add(through, way, -reach), side, -half), add(add(through, way, reach), side, -half), add(add(through, way, reach), side, half), add(add(through, way, -reach), side, half)];
      const pieces = without([polygon], [strip]).rings.filter((ring) => polygonArea(ring) > rules.least);
      if (pieces.length < 2) {
        blocks.push({ ward: index, polygon, area: size, scale });
        return;
      }
      for (const line of chords(through, way, polygon)) lanes.push({ ward: index, line });
      for (const piece of pieces) split(piece, limit * drift);
    };
    split(ward.polygon, drawFrom(rng, rules.area) * scale);
  });
  return { blocks, lanes };
}
