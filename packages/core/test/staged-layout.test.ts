/**
 * Phase 6E, step 8: the staged generator's town as a layout in the one
 * format, with its walking network, entrances, gates and district ground.
 */
import { describe, expect, it } from 'vitest';
import { type City, type Layout, VILLAGE_GENERATOR, checkLayout, createLife, createPlanChecker, generateCity, generateLayout, measureDistrictGround, placeFlagsOf } from '../src/index.ts';
import { groundOf, outsideGrounds } from '../src/life/wander.ts';
import { STAGED_GENERATOR, generateStagedLayout } from '../src/layout/staged/layout.ts';
import { planTown, townInput } from '../src/layout/staged/plan.ts';
import { pointInPolygon, polygonCentroid } from '../src/layout/geometry.ts';
import type { SettlementBrief } from '../src/schema.ts';
import { lomiaWorld, medievalPack } from './pack.ts';

const pack = medievalPack();
const made = new Map<string, { brief: SettlementBrief; city: City; layout: Layout; problems: string[] }>();
/** A settlement's staged layout, whether or not it passes every invariant, and what it breaks. */
function staged(name: string) {
  let entry = made.get(name);
  if (!entry) {
    const brief = lomiaWorld().settlements.find((settlement) => settlement.name === name) as SettlementBrief;
    const city = generateCity(brief, pack);
    const layout = generateStagedLayout(city, brief, pack, { check: false });
    made.set(name, (entry = { brief, city, layout, problems: checkLayout(layout, city, brief, pack) }));
  }
  return entry;
}
const SAMPLE = lomiaWorld().settlements.filter((_, at) => at % 12 === 0).map((settlement) => settlement.name);

describe('the staged generator as a layout', () => {
  it('passes every invariant in Flupines and Vereceldo, and hands them, as villages, to the village generator', () => {
    for (const name of ['Flupines', 'Vereceldo']) {
      // Laid out by the staged pipeline when asked for directly, as the census does.
      const { brief, city, problems } = staged(name);
      expect(problems, name).toEqual([]);
      // By the generator's name, a settlement under the pack's village size is a village.
      const layout = generateLayout(city, brief, pack, { generator: 'staged' });
      expect(layout.summary.generator).toBe(VILLAGE_GENERATOR);
      expect(layout.lots.length).toBe(city.buildings.length);
    }
    // The pack names the staged generator, which lays out a town itself; a pack that names none still gets the grid.
    const town = staged('Badanos');
    expect(generateLayout(town.city, town.brief, pack).summary.generator).toBe(STAGED_GENERATOR);
    const { brief, city } = staged('Flupines');
    const { generator: _named, ...unnamed } = pack.layout;
    expect(generateLayout(city, brief, { ...pack, layout: unnamed }).summary.generator).toBe('grid');
  });

  it('keeps every invariant across a sample of Lomia, and measures how district ground falls', () => {
    const lots = { all: 0, outside: 0 };
    for (const name of SAMPLE) {
      const { layout, problems } = staged(name);
      expect(problems, name).toEqual([]);
      const measured = measureDistrictGround(layout);
      lots.all += measured.lots;
      lots.outside += measured.lotsOutside;
    }
    // District ground is each block's tile given to the district holding most of its lots: a lot in a block a
    // neighbour holds most of stands in the neighbour's ground. Measured: 268 of 52,381 in the sample.
    console.log(`Lots outside their own district's ground, ${SAMPLE.length} settlements: ${lots.outside} of ${lots.all}`);
    expect(lots.outside / lots.all).toBeLessThan(0.02);
  });

  it('gives open-air places open ground, and has people outside on it in Badanos on a work day, with courtyards behind the houses', () => {
    const { city, layout } = staged('Badanos');
    const lotOf = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
    // Every open-air workplace has ground of its own to work on.
    const openAir = city.buildings.filter((building) => placeFlagsOf(building.type, pack).openAir);
    expect(openAir.length).toBeGreaterThan(10);
    for (const building of openAir) expect(groundOf(lotOf.get(building.id)!).open, `${building.id}, a ${building.type}`).toBe(true);
    // Most houses are built right over their lots and back onto a courtyard.
    const backed = new Set((layout.courtyards ?? []).flatMap((courtyard) => courtyard.lotIds));
    expect(backed.size / layout.lots.length).toBeGreaterThan(0.9);
    // Outside stays on the first work day, by where they are spent, and how many of their wanders move.
    const groundAt = outsideGrounds(layout);
    const life = createLife({ city, layout, pack });
    const where = { lot: 0, courtyard: 0, plaza: 0, street: 0 };
    let moving = 0;
    for (const plan of life.plansForDay(1)) {
      for (const activity of plan.activities) {
        if ((activity.kind !== 'work' && activity.kind !== 'visit') || !activity.outside) continue;
        where[activity.onStreet ? 'street' : groundAt(lotOf.get(activity.buildingId)!).kind]++;
        if (new Set(activity.wander!.points.map(String)).size > 1) moving++;
      }
    }
    const out = where.lot + where.courtyard + where.plaza + where.street;
    console.log(`Badanos, day 1: ${out} stays outside, ${where.lot} on their own lot's ground, ${where.courtyard} in a courtyard, ${where.plaza} on the plaza and ${where.street} on the street in front; ${moving} wanders move`);
    // The pack sends no one outside at a building without ground of its own but on the street in front, where
    // the visit says so: the courtyards are there for when it does.
    expect(where.lot).toBeGreaterThan(1000);
    expect(moving / out).toBeGreaterThan(0.5);
  });

  it('draws the districts after the houses: every invariant and every count kept, each district whole, a waterside district at the water', () => {
    // Pombal's harbour once ended 140 m from the river; Charoy's once lay in stripes across it; Montica's one bridge
    // ends at a landmark's block.
    for (const name of ['Badanos', 'Montica', 'Pombal', 'Charoy']) {
      const brief = lomiaWorld().settlements.find((settlement) => settlement.name === name)!;
      const city = generateCity(brief, pack);
      const layout = generateStagedLayout(city, brief, pack, { check: false });
      expect(checkLayout(layout, city, brief, pack), name).toEqual([]);
      const plan = planTown(brief, townInput(city, pack), pack);
      // Every kept house has exactly one district, and every district exactly its count.
      expect(plan.drawn.district.filter((district) => district !== undefined).length, name).toBe(plan.selection.chosen.length);
      expect(plan.drawn.kept, name).toEqual(plan.drawn.targets);
      expect(plan.drawn.inPieces, name).toBe(0);
      // Few lots stand outside their own district's ground.
      const ground = measureDistrictGround(layout);
      expect(ground.lotsOutside / ground.lots, name).toBeLessThan(0.05);
      // Every landmark with ground of its own stands in the ground of the district its lot names.
      const areas = new Map(layout.districtAreas.map((area) => [area.districtId, area.polygons]));
      const lotOf = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
      for (const landmark of plan.landmarks) {
        const lot = lotOf.get(landmark.building)!;
        expect(areas.get(lot.districtId)!.some((polygon) => pointInPolygon(polygonCentroid(lot.polygon), polygon)), `${name}: ${landmark.type}`).toBe(true);
      }
    }
  });

  it('gives every building one lot, a house its front, and each lot an entrance on a way of the one network', () => {
    for (const name of ['Badanos', 'Karlen', 'Cevilefon']) {
      const { city, layout } = staged(name);
      expect(layout.lots.map((lot) => lot.buildingId), name).toEqual(city.buildings.map((building) => building.id));
      expect(layout.lots.filter((lot) => lot.front).length / layout.lots.length, name).toBeGreaterThan(0.95);
      expect(layout.wards?.length, name).toBeGreaterThan(10);
      expect(layout.blocks?.length, name).toBeGreaterThan(100);
      const segments = new Set(layout.segments.map((segment) => segment.id));
      for (const lot of layout.lots) expect(segments.has(lot.entrance.segmentId), name).toBe(true);
    }
  });

  it('has a gate at every way through the wall, kept by a gatehouse while there are gatehouses, and a quay exit for a sea route', () => {
    const karlen = staged('Karlen');
    const gates = karlen.layout.walls.flatMap((wall) => wall.gates);
    const gatehouses = karlen.city.buildings.filter((building) => building.type === 'gatehouse').map((building) => building.id);
    expect(gates.length).toBeGreaterThanOrEqual(4);
    const keepers = gates.flatMap((gate) => (gate.buildingId === undefined ? [] : [gate.buildingId]));
    expect(new Set(keepers).size).toBe(keepers.length);
    for (const keeper of keepers) expect(gatehouses).toContain(keeper);
    // Highways' gates are kept before any other.
    for (const gate of gates) if (gate.arterial && keepers.length < gates.length && gatehouses.length >= gates.filter((other) => other.arterial).length) expect(gate.buildingId).toBeDefined();
    const cevilefon = staged('Cevilefon');
    const sea = cevilefon.layout.exits.filter((exit) => exit.kind === 'sea-route');
    expect(sea.length).toBeGreaterThan(0);
    for (const exit of sea) expect(exit.atQuay).toBe(true);
    for (const exit of cevilefon.layout.exits) if (exit.kind !== 'sea-route') expect(exit.atQuay).toBeUndefined();
  });

  it('is the same town each time, and the same with an empty list of pins as with none', () => {
    const { brief, city, layout } = staged('Flupines');
    expect(JSON.stringify(generateStagedLayout(city, brief, pack, { check: false }))).toBe(JSON.stringify(layout));
    expect(JSON.stringify(generateStagedLayout(city, brief, pack, { check: false, pins: [] }))).toBe(JSON.stringify(layout));
    expect(JSON.stringify(generateStagedLayout(city, brief, pack, { check: false, seed: brief.seed + 1 }))).not.toBe(JSON.stringify(layout));
  });
});

describe('life on a staged layout', () => {
  it('plans a day in Flupines that keeps every rule of a day plan', () => {
    const { city, layout } = staged('Flupines');
    const life = createLife({ city, layout, pack });
    const checker = createPlanChecker({ city, layout, pack });
    const problems: string[] = [];
    const today = life.plansForDay(1);
    const tomorrow = life.plansForDay(2);
    today.forEach((plan, at) => problems.push(...checker.check(plan), ...checker.checkContinuity(plan, tomorrow[at] as (typeof tomorrow)[number])));
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it('has the residents of Badanos make about as many trips as on the grid', () => {
    const { brief, city, layout } = staged('Badanos');
    const grid = generateLayout(city, brief, pack, { generator: 'grid' });
    const trips = (on: Layout) => createLife({ city, layout: on, pack }).daySummary(1).trips / city.people.length;
    const [onStaged, onGrid] = [trips(layout), trips(grid)];
    console.log(`Trips per resident in Badanos on day 1: ${onStaged.toFixed(2)} on the staged layout, ${onGrid.toFixed(2)} on the grid`);
    expect(Math.abs(onStaged - onGrid) / onGrid).toBeLessThan(0.15);
  });
});
