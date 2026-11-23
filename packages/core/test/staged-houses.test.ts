/**
 * Phase 6E, step 4: the staged generator's blocks and rows of houses,
 * checked for every settlement of Lomia. No house is chosen yet: every one
 * made is here.
 */
import { describe, expect, it } from 'vitest';
import { generateCity, parsePack } from '../src/index.ts';
import { smallestRectangle } from '../src/layout/cutting.ts';
import { distanceBetweenPolygons, distanceToPiece, distanceToPolygonEdge, pointInPolygon, polygonArea, polygonCentroid } from '../src/layout/geometry.ts';
import { type TownPlan, planTown, stagedSettings } from '../src/layout/staged/plan.ts';
import { outlineOf, rectInside, standingOf, standingOverlap, widenedRect } from '../src/layout/staged/rects.ts';
import type { Point, SettlementBrief } from '../src/schema.ts';
import { lomiaWorld, medievalPack, rawMedievalPack, settlement } from './pack.ts';

const pack = medievalPack();
const settings = stagedSettings(pack);
const rules = settings.rows;
let plans: Array<{ brief: SettlementBrief; plan: TownPlan }> | undefined;
/** Every settlement's plan, made once. */
function everyPlan() {
  return (plans ??= lomiaWorld().settlements.map((brief) => ({ brief, plan: planTown(brief, generateCity(brief, pack).buildings.length, pack) })));
}
const named = (name: string) => everyPlan().find(({ brief }) => brief.name === name) as { brief: SettlementBrief; plan: TownPlan };
const TEST_TOWNS = ['Badanos', 'Pombal', 'Cevilefon', 'Vereceldo', 'Flupines'];
const quantile = (values: number[], share: number) => [...values].sort((a, b) => a - b)[Math.floor(share * (values.length - 1))] as number;
const housesByBlock = (plan: TownPlan) => {
  const map = new Map<number, TownPlan['houses']>();
  for (const house of plan.houses) map.set(house.block, [...(map.get(house.block) ?? []), house]);
  return map;
};

describe('blocks', () => {
  it('every ordinary ward is split into blocks, and none is left without', () => {
    for (const { brief, plan } of everyPlan()) {
      const withBlocks = new Set(plan.blocks.map((block) => block.ward));
      plan.wards.forEach((ward, index) => expect(withBlocks.has(index), `${brief.name}: ward ${index}`).toBe(ward.kind === 'ordinary'));
      for (const block of plan.blocks) {
        expect(block.area, brief.name).toBeGreaterThan(settings.blocks.least);
        expect(block.scale, brief.name).toBeGreaterThanOrEqual(settings.blocks.wardScale.min);
        expect(block.scale, brief.name).toBeLessThanOrEqual(settings.blocks.wardScale.max);
      }
    }
  });

  it('lie inside their ward, a lane apart, and together cover it but for the lanes', () => {
    for (const name of [...TEST_TOWNS, 'Karlen', 'Tames']) {
      const { plan } = named(name);
      plan.wards.forEach((ward, index) => {
        const blocks = plan.blocks.filter((block) => block.ward === index);
        if (blocks.length === 0) return;
        for (const block of blocks) for (const corner of block.polygon) expect(pointInPolygon(corner, ward.polygon) || distanceToPolygonEdge(corner, ward.polygon) < 0.01, name).toBe(true);
        blocks.forEach((one, at) => blocks.slice(at + 1).forEach((other) => expect(distanceBetweenPolygons(one.polygon, other.polygon), name).toBeGreaterThan(settings.widths.lane - 0.01)));
        const covered = blocks.reduce((sum, block) => sum + block.area, 0);
        expect(covered, name).toBeLessThanOrEqual(ward.area + 0.01);
        expect(covered / ward.area, name).toBeGreaterThan(0.75);
      });
      // A lane is the centre line of a cut: each lies in its ward.
      for (const lane of plan.lanes) {
        const ward = (plan.wards[lane.ward] as TownPlan['wards'][number]).polygon;
        for (const end of lane.line) expect(pointInPolygon(end, ward) || distanceToPolygonEdge(end, ward) < 0.01, name).toBe(true);
      }
      expect(plan.lanes.length, name).toBeGreaterThan(plan.blocks.length / 3);
    }
  });
});

describe('houses', () => {
  it('are rectangles and Ls: four or six corners, every one a right angle, none under the narrowest side', () => {
    let wings = 0;
    let count = 0;
    for (const { brief, plan } of everyPlan()) {
      for (const house of plan.houses) {
        count++;
        if (house.outline.length === 6) wings++;
        expect([4, 6], brief.name).toContain(house.outline.length);
        expect(house.parts.length, brief.name).toBe(house.outline.length === 6 ? 2 : 1);
        house.outline.forEach((corner, at) => {
          const before = house.outline[(at + house.outline.length - 1) % house.outline.length] as Point;
          const after = house.outline[(at + 1) % house.outline.length] as Point;
          const turn = ((corner[0] - before[0]) * (after[0] - corner[0]) + (corner[1] - before[1]) * (after[1] - corner[1])) / (Math.hypot(corner[0] - before[0], corner[1] - before[1]) * Math.hypot(after[0] - corner[0], after[1] - corner[1]));
          expect(Math.abs(turn), brief.name).toBeLessThan(1e-9);
        });
        const body = house.parts[0] as TownPlan['houses'][number]['parts'][number];
        expect(Math.min(body.width, body.depth), brief.name).toBeGreaterThanOrEqual(rules.narrowest - 1e-9);
        expect(house.area, brief.name).toBeGreaterThanOrEqual(rules.leastArea - 1e-9);
        expect(polygonArea(house.outline), brief.name).toBeCloseTo(house.area, 6);
      }
    }
    expect(count).toBeGreaterThan(1_000_000);
    expect(wings / count).toBeGreaterThan(0.15);
  });

  it('lie wholly inside their block, on the edge they were laid along, and never overlap another house or a passage', () => {
    for (const { brief, plan } of everyPlan()) {
      const passages = new Map<number, TownPlan['passages']>();
      for (const passage of plan.passages) passages.set(passage.block, [...(passages.get(passage.block) ?? []), passage]);
      for (const [index, houses] of housesByBlock(plan)) {
        const outline = outlineOf((plan.blocks[index] as TownPlan['blocks'][number]).polygon);
        const parts = houses.flatMap((house, at) => house.parts.map((part) => ({ at, standing: standingOf(part), wide: standingOf(widenedRect(part, rules.gap - 0.02)) })));
        for (const house of houses) {
          for (const part of house.parts) expect(rectInside(widenedRect(part, rules.inset - 0.02), outline), brief.name).toBe(true);
          for (const end of house.front) expect(distanceToPiece(end, house.edge[0], house.edge[1]), brief.name).toBeLessThan(rules.inset + rules.setBack + 0.01);
        }
        parts.forEach((one, at) => {
          // The later house, with the gap added all round it, clears the earlier: so no two are nearer than the gap.
          for (const other of parts.slice(at + 1)) if (one.at !== other.at) expect(standingOverlap(other.wide, one.standing), `${brief.name}: two houses nearer than the gap`).toBe(false);
          for (const passage of passages.get(index) ?? []) expect(standingOverlap(one.wide, standingOf(passage.rect)), `${brief.name}: a house in a passage`).toBe(false);
        });
      }
    }
  });

  it('are made in every town, at least half as many again as it has buildings', () => {
    const ratios = everyPlan().map(({ plan }) => plan.houses.length / plan.buildings);
    for (const { brief, plan } of everyPlan()) expect(plan.houses.length / plan.buildings, brief.name).toBeGreaterThan(1.5);
    expect(quantile(ratios, 0.5)).toBeGreaterThan(2.2);
    expect(quantile(ratios, 0.5)).toBeLessThan(3);
  });

  it('leave a courtyard: in most blocks deep enough for one, the middle is open ground', () => {
    let deep = 0;
    let open = 0;
    let passages = 0;
    for (const { plan } of everyPlan()) {
      const houses = housesByBlock(plan);
      const withPassage = new Set(plan.passages.map((passage) => passage.block));
      plan.blocks.forEach((block, index) => {
        const box = smallestRectangle(block.polygon);
        if (Math.hypot(box.short[0], box.short[1]) < rules.court.least) {
          expect(withPassage.has(index)).toBe(false);
          return;
        }
        deep++;
        if (withPassage.has(index)) passages++;
        const middle = polygonCentroid(block.polygon);
        if (!(houses.get(index) ?? []).some((house) => pointInPolygon(middle, house.outline))) open++;
      });
    }
    expect(open / deep).toBeGreaterThan(0.8);
    // About a third of courtyard blocks have a passage through one row.
    expect(passages / deep).toBeGreaterThan(0.2);
    expect(passages / deep).toBeLessThan(rules.passage.chance);
  });

  it('vary in size within a town, the large about three times the small', () => {
    for (const name of TEST_TOWNS) {
      const areas = named(name).plan.houses.map((house) => house.area);
      const spread = quantile(areas, 0.9) / quantile(areas, 0.1);
      // Every ward has the same character still; districts will widen this.
      expect(spread, name).toBeGreaterThan(2.3);
      expect(spread, name).toBeLessThan(4.5);
    }
  });
});

describe('determinism and pack edits', () => {
  it('the same brief, pack and seed give the same houses, and another seed different ones', () => {
    const brief = settlement(named('Flupines').brief.id);
    const drawn = (plan: TownPlan) => JSON.stringify([plan.blocks, plan.lanes, plan.houses, plan.passages]);
    expect(drawn(planTown(brief, 95, pack))).toBe(drawn(planTown(brief, 95, pack)));
    expect(drawn(planTown(brief, 95, pack, brief.seed + 1))).not.toBe(drawn(planTown(brief, 95, pack)));
  });

  it('wider houses in a copy of the pack make fewer, and no wings or passages none', () => {
    const brief = settlement(named('Badanos').brief.id);
    const raw = rawMedievalPack();
    raw.layout.staged.rows.width.median = 20;
    raw.layout.staged.rows.wing.chance = 0;
    raw.layout.staged.rows.passage.chance = 0;
    const wide = planTown(brief, 1825, parsePack(raw));
    expect(wide.houses.length).toBeLessThan(0.8 * named('Badanos').plan.houses.length);
    expect(wide.houses.every((house) => house.outline.length === 4)).toBe(true);
    expect(wide.passages).toEqual([]);
    // Nothing before the rows changed.
    expect(JSON.stringify(wide.blocks)).toBe(JSON.stringify(named('Badanos').plan.blocks));
  });
});
