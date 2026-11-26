/**
 * The staged generator's own checks, run on every town it makes and not
 * only in tests. Each counts something that must not happen at all.
 */
import { polygonArea } from '../geometry.ts';
import type { TownPlan } from './plan.ts';
import { outlineOf, rectInside, standingOf, standingOverlap, widenedRect } from './rects.ts';

export interface BuiltInChecks {
  /** Pairs of kept buildings that overlap, by more than a hair. */
  overlappingPairs: number;
  /** Kept buildings not wholly inside their block. */
  outsideBlock: number;
  /** Kept buildings that stand in a passage. */
  inPassage: number;
  /** Landmarks clipped, or not wholly inside the block or ward reserved for them. */
  landmarksOutside: number;
  /** Ordinary wards with no blocks. */
  wardsWithoutBlocks: number;
}

export function builtInChecks(plan: TownPlan): BuiltInChecks {
  const kept = plan.houses.map((house, index) => ({ house, index })).filter(({ index }) => plan.drawn.district[index] !== undefined);
  const byBlock = new Map<number, typeof kept>();
  for (const entry of kept) {
    if (!byBlock.has(entry.house.block)) byBlock.set(entry.house.block, []);
    byBlock.get(entry.house.block)?.push(entry);
  }
  let overlappingPairs = 0;
  let outsideBlock = 0;
  let inPassage = 0;
  const passages = new Map<number, ReturnType<typeof standingOf>[]>();
  for (const passage of plan.passages) passages.set(passage.block, [...(passages.get(passage.block) ?? []), standingOf(passage.rect)]);
  for (const [block, houses] of byBlock) {
    const outline = outlineOf((plan.blocks[block] as TownPlan['blocks'][number]).polygon);
    const parts = houses.flatMap(({ house }, at) => house.parts.map((part) => ({ at, part, standing: standingOf(widenedRect(part, -0.01)) })));
    for (const { house } of houses) if (!house.parts.every((part) => rectInside(widenedRect(part, -0.01), outline))) outsideBlock++;
    parts.forEach((one, at) => {
      for (const other of parts.slice(at + 1)) if (one.at !== other.at && standingOverlap(one.standing, other.standing)) overlappingPairs++;
      if ((passages.get(block) ?? []).some((passage) => standingOverlap(one.standing, passage))) inPassage++;
    });
  }
  let landmarksOutside = 0;
  for (const landmark of plan.landmarks) {
    if (landmark.parts.length === 0) continue;
    const ground = landmark.block !== undefined ? (plan.blocks[landmark.block] as TownPlan['blocks'][number]).polygon : (plan.wards[landmark.ward] as TownPlan['wards'][number]).polygon;
    const outline = outlineOf(ground);
    // Whole: every rectangle of its template inside its ground, and its outline no smaller than the largest of them.
    const whole = landmark.parts.every((part) => rectInside(part, outline)) && polygonArea(landmark.outline) >= Math.max(...landmark.parts.map((part) => part.width * part.depth)) - 0.5;
    if (!whole) landmarksOutside++;
  }
  const withBlocks = new Set(plan.blocks.map((block) => block.ward));
  const wardsWithoutBlocks = plan.wards.filter((ward, index) => ward.kind === 'ordinary' && !withBlocks.has(index)).length;
  return { overlappingPairs, outsideBlock, inPassage, landmarksOutside, wardsWithoutBlocks };
}
