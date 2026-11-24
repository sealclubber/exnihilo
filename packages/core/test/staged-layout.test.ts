/**
 * Phase 6E, step 8: the staged generator's town as a layout in the one
 * format, with its walking network, entrances, gates and district ground.
 */
import { describe, expect, it } from 'vitest';
import { type City, type Layout, checkLayout, createLife, createPlanChecker, generateCity, generateLayout } from '../src/index.ts';
import { STAGED_GENERATOR, generateStagedLayout } from '../src/layout/staged/layout.ts';
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
/** The rules about lots and district ground, which the town's choice of houses does not yet always keep. */
const ofGround = (problem: string) => /which does not touch its own|lie outside its ground|lies outside the ground/.test(problem);
const SAMPLE = lomiaWorld().settlements.filter((_, at) => at % 12 === 0).map((settlement) => settlement.name);

describe('the staged generator as a layout', () => {
  it('passes every invariant in Flupines and Vereceldo, by the name the pack or the caller gives it', () => {
    for (const name of ['Flupines', 'Vereceldo']) {
      const { brief, city, problems } = staged(name);
      expect(problems, name).toEqual([]);
      const layout = generateLayout(city, brief, pack, { generator: 'staged' });
      expect(layout.summary.generator).toBe(STAGED_GENERATOR);
      expect(layout.lots.length).toBe(city.buildings.length);
    }
    // The grid is still what a pack gets that names no generator.
    const { brief, city } = staged('Flupines');
    expect(generateLayout(city, brief, pack).summary.generator).toBe('grid');
  });

  it('breaks nothing but the rules about lots and district ground, across a sample of Lomia', () => {
    let whole = 0;
    const others: string[] = [];
    for (const name of SAMPLE) {
      const { problems } = staged(name);
      if (problems.length === 0) whole++;
      for (const problem of problems) if (!ofGround(problem)) others.push(`${name}: ${problem}`);
    }
    console.log(`Staged layouts, ${SAMPLE.length} settlements: ${whole} pass every invariant; the rest break only the district-ground rules`);
    // Measured: 55 of the 57. Nothing else is broken anywhere in the sample.
    expect(others).toEqual([]);
    expect(whole / SAMPLE.length).toBeGreaterThan(0.9);
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
