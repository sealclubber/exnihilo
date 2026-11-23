/**
 * Phase 6E, step 5: reservations and landmark templates, checked for every
 * settlement of Lomia.
 */
import { describe, expect, it } from 'vitest';
import { generateCity, parsePack } from '../src/index.ts';
import { distanceBetweenPolygons, polygonArea } from '../src/layout/geometry.ts';
import type { LandmarkBuilding } from '../src/layout/staged/landmarks.ts';
import { type TownPlan, landmarksOf, planTown, stagedSettings } from '../src/layout/staged/plan.ts';
import { outlineOf, rectInside, widenedRect } from '../src/layout/staged/rects.ts';
import type { Point, SettlementBrief } from '../src/schema.ts';
import { lomiaWorld, medievalPack, rawMedievalPack } from './pack.ts';

const pack = medievalPack();
const settings = stagedSettings(pack);
const rules = settings.landmarks;
let plans: Array<{ brief: SettlementBrief; plan: TownPlan; marks: LandmarkBuilding[] }> | undefined;
/** Every settlement's plan with its city's landmarks, made once. */
function everyPlan() {
  return (plans ??= lomiaWorld().settlements.map((brief) => {
    const city = generateCity(brief, pack);
    const marks = landmarksOf(city.buildings, pack);
    return { brief, marks, plan: planTown(brief, city.buildings.length, pack, brief.seed, marks) };
  }));
}
const named = (name: string) => everyPlan().find(({ brief }) => brief.name === name) as { brief: SettlementBrief; plan: TownPlan; marks: LandmarkBuilding[] };

describe('reservations', () => {
  it('every landmark the pack gives a ward or a block is placed once or reported, and none twice', () => {
    let placed = 0;
    let unplaced = 0;
    for (const { brief, plan, marks } of everyPlan()) {
      const wanting = marks.filter((mark) => ['ward', 'block'].includes(rules.types[mark.type]?.reservation as string)).map((mark) => mark.id).sort();
      expect([...plan.landmarks.map((landmark) => landmark.building), ...plan.unplaced.map((landmark) => landmark.id)].sort(), brief.name).toEqual(wanting);
      placed += plan.landmarks.length;
      unplaced += plan.unplaced.length;
    }
    expect(placed).toBeGreaterThan(4500);
    // Until districts say where each may stand, only the inner wards are looked at, and some find no block.
    expect(unplaced / (placed + unplaced)).toBeLessThan(0.25);
  });

  it('a block holds one landmark, whole and unclipped, and no house', () => {
    for (const { brief, plan } of everyPlan()) {
      const blocks = plan.landmarks.flatMap((landmark) => (landmark.block === undefined ? [] : [landmark.block]));
      expect(new Set(blocks).size, brief.name).toBe(blocks.length);
      const reserved = new Set(blocks);
      for (const house of plan.houses) expect(reserved.has(house.block), brief.name).toBe(false);
      for (const passage of plan.passages) expect(reserved.has(passage.block), brief.name).toBe(false);
      for (const landmark of plan.landmarks) {
        if (landmark.reservation !== 'block') continue;
        const block = plan.blocks[landmark.block as number] as TownPlan['blocks'][number];
        expect(block.ward, brief.name).toBe(landmark.ward);
        const outline = outlineOf(block.polygon);
        for (const part of landmark.parts) expect(rectInside(widenedRect(part, rules.block.margin - 0.01), outline), `${brief.name}: ${landmark.type}`).toBe(true);
        expect(landmark.area, brief.name).toBeGreaterThanOrEqual(rules.block.leastArea);
        expect(polygonArea(landmark.outline), brief.name).toBeCloseTo(landmark.area, 3);
      }
    }
  });

  it('a footprint is its template: rectangles joined, every corner a right angle', () => {
    for (const { brief, plan } of everyPlan()) {
      for (const landmark of plan.landmarks) {
        const template = rules.templates[rules.types[landmark.type]?.template as string];
        if (!template) {
          expect(landmark.outline, brief.name).toEqual([]);
          continue;
        }
        if (landmark.parts.length === 0) continue;
        expect(landmark.parts.length, brief.name).toBe(template.parts.length);
        landmark.outline.forEach((corner, at) => {
          const before = landmark.outline[(at + landmark.outline.length - 1) % landmark.outline.length] as Point;
          const after = landmark.outline[(at + 1) % landmark.outline.length] as Point;
          const turn = ((corner[0] - before[0]) * (after[0] - corner[0]) + (corner[1] - before[1]) * (after[1] - corner[1])) / (Math.hypot(corner[0] - before[0], corner[1] - before[1]) * Math.hypot(after[0] - corner[0], after[1] - corner[1]));
          expect(Math.abs(turn), `${brief.name}: ${landmark.type}`).toBeLessThan(1e-3);
        });
      }
    }
  });

  it('block landmarks stand apart from each other', () => {
    for (const { brief, plan } of everyPlan()) {
      const blocks = plan.landmarks.filter((landmark) => landmark.block !== undefined).map((landmark) => (plan.blocks[landmark.block as number] as TownPlan['blocks'][number]).polygon);
      blocks.forEach((one, at) => blocks.slice(at + 1).forEach((other) => expect(distanceBetweenPolygons(one, other), brief.name).toBeGreaterThanOrEqual(rules.block.apart)));
    }
  });

  it('the citadel stands in the castle with a keep, and the market square is the plaza', () => {
    let keeps = 0;
    for (const { brief, plan } of everyPlan()) {
      const citadel = plan.landmarks.find((landmark) => rules.types[landmark.type]?.ward === 'castle');
      expect(citadel !== undefined, brief.name).toBe(brief.flags.citadel);
      if (citadel) {
        expect(plan.wards[citadel.ward]?.kind, brief.name).toBe('castle');
        const outline = outlineOf((plan.castle as NonNullable<TownPlan['castle']>).polygon);
        for (const part of citadel.parts) expect(rectInside(part, outline), brief.name).toBe(true);
        if (citadel.parts.length > 0) keeps++;
      }
      const square = plan.landmarks.find((landmark) => rules.types[landmark.type]?.ward === 'plaza');
      expect(square !== undefined, brief.name).toBe(brief.flags.plaza);
      if (square) expect([plan.wards[square.ward]?.kind, square.parts.length], brief.name).toEqual(['plaza', 0]);
    }
    expect(keeps).toBe(102);
  });

  it('the temple is on the plaza, or where there is none near the centre', () => {
    for (const { brief, plan } of everyPlan()) {
      const temple = plan.landmarks.find((landmark) => rules.types[landmark.type]?.place === 'plaza' && rules.types[landmark.type]?.template === 'cross');
      if (!temple) continue;
      const block = (plan.blocks[temple.block as number] as TownPlan['blocks'][number]).polygon;
      const reach = Math.min(...block.map((corner) => Math.hypot(...corner)));
      expect(reach, brief.name).toBeLessThan(2 * plan.mesh.spacing);
    }
  });
});

describe('determinism, independence and pack edits', () => {
  it('reserving blocks changes no other block: the houses elsewhere are those of a town with no landmarks', () => {
    const { brief, plan, marks } = named('Badanos');
    expect(plan.landmarks.length).toBeGreaterThan(8);
    expect(marks.length).toBeGreaterThan(plan.landmarks.length);
    const bare = planTown(brief, plan.buildings, pack);
    expect(bare.landmarks).toEqual([]);
    const reserved = new Set(plan.landmarks.map((landmark) => landmark.block));
    expect(JSON.stringify(plan.houses)).toBe(JSON.stringify(bare.houses.filter((house) => !reserved.has(house.block))));
  });

  it('the same inputs give the same landmarks', () => {
    const { brief, plan, marks } = named('Flupines');
    expect(JSON.stringify(planTown(brief, plan.buildings, pack, brief.seed, marks).landmarks)).toBe(JSON.stringify(plan.landmarks));
  });

  it('a pack that marks an unknown type or names an unknown template is refused, saying which', () => {
    const raw = rawMedievalPack();
    raw.layout.staged.landmarks.types['moon-base'] = { reservation: 'block', template: 'hall' };
    expect(() => parsePack(raw)).toThrow(/moon-base/);
    const other = rawMedievalPack();
    other.layout.staged.landmarks.types.temple.template = 'pyramid';
    expect(() => parsePack(other)).toThrow(/pyramid/);
  });

  it('a type the pack no longer marks is an ordinary building again', () => {
    const raw = rawMedievalPack();
    delete raw.layout.staged.landmarks.types.inn;
    const { brief, plan } = named('Badanos');
    const city = generateCity(brief, pack);
    const fewer = planTown(brief, plan.buildings, parsePack(raw), brief.seed, landmarksOf(city.buildings, parsePack(raw)));
    expect(fewer.landmarks.some((landmark) => landmark.type === 'inn')).toBe(false);
    expect(plan.landmarks.some((landmark) => landmark.type === 'inn') || plan.unplaced.some((landmark) => landmark.type === 'inn')).toBe(true);
  });
});
