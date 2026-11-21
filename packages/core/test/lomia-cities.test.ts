/**
 * The whole-world run: every settlement of Lomia, generated and checked.
 */
import { describe, expect, it } from 'vitest';
import {
  WORKFORCE_SHARE_LIMITS,
  checkCity,
  checkLayout,
  createLife,
  createPathFinder,
  createPlanChecker,
  createRng,
  generateCity,
  generateLayout,
  geometry,
  placeFlagsOf,
} from '../src/index.ts';
import { lomiaWorld, medievalPack } from './pack.ts';

describe('every settlement of Lomia', () => {
  it('generates with every invariant holding, 2,935,089 people in all, and no runesmith', { timeout: 120_000 }, () => {
    const pack = medievalPack();
    const { settlements } = lomiaWorld();
    expect(settlements).toHaveLength(682);

    let people = 0;
    const failures: string[] = [];
    const started = performance.now();
    for (const brief of settlements) {
      try {
        const city = generateCity(brief, pack);
        people += city.people.length;
        if (city.people.length !== brief.population) failures.push(`${brief.id}: ${city.people.length} people, not ${brief.population}`);
        // The generator checks itself; the rules are run again here so the test does not rely on that.
        failures.push(...checkCity(city, brief, pack).map((problem) => `${brief.id}: ${problem}`));
        const share = city.summary.workforce.working / city.people.length;
        if (share < WORKFORCE_SHARE_LIMITS.min || share > WORKFORCE_SHARE_LIMITS.max) failures.push(`${brief.id}: workforce share ${share}`);
        if (city.summary.occupations.runesmith) failures.push(`${brief.id}: has a runesmith`);
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    const seconds = (performance.now() - started) / 1000;
    console.log(`Generated and checked ${settlements.length} settlements, ${people.toLocaleString('en-US')} people, in ${seconds.toFixed(1)} s`);

    expect(failures.slice(0, 10)).toEqual([]);
    expect(people).toBe(2_935_089);
  });

  it('lays out with every layout invariant holding, a path between lots everywhere, and sound day plans', { timeout: 180_000 }, () => {
    const pack = medievalPack();
    const { settlements } = lomiaWorld();
    const RESIDENTS_SAMPLED = 12;
    let plans = 0;
    let lots = 0;
    let slowest = { seconds: 0, id: '' };
    let layoutSeconds = 0;
    const failures: string[] = [];
    let footprints = 0;
    let openAirLots = 0;
    for (const brief of settlements) {
      try {
        const city = generateCity(brief, pack);
        const started = performance.now();
        const layout = generateLayout(city, brief, pack);
        const seconds = (performance.now() - started) / 1000;
        layoutSeconds += seconds;
        if (seconds > slowest.seconds) slowest = { seconds, id: brief.id };
        lots += layout.lots.length;
        if (layout.lots.length !== city.buildings.length) failures.push(`${brief.id}: ${layout.lots.length} lots for ${city.buildings.length} buildings`);
        // The generator checks itself; the rules are run again here so the test does not rely on that.
        failures.push(...checkLayout(layout, city, brief, pack).map((problem) => `${brief.id}: ${problem}`));
        // Footprints lie inside their lots without overlapping (checked above, with the rest), and an open-air building has open ground.
        const types = new Map(city.buildings.map((building) => [building.id, building.type]));
        for (const lot of layout.lots) {
          footprints += lot.footprints.length;
          if (!placeFlagsOf(types.get(lot.buildingId) as string, pack).openAir) continue;
          openAirLots++;
          const built = lot.footprints.reduce((sum, footprint) => sum + geometry.polygonArea(footprint), 0);
          if (!(built < geometry.polygonArea(lot.polygon) * 0.9)) failures.push(`${brief.id}: ${lot.id} is open-air but has no open ground to speak of`);
        }
        // A path exists from the first lot to a spread of others, the last among them.
        const finder = createPathFinder(layout);
        const step = Math.max(1, Math.floor(layout.lots.length / 12));
        for (let at = layout.lots.length - 1; at >= 0; at -= step) {
          const path = finder.path(layout.lots[0]!.id, layout.lots[at]!.id);
          if (!(path.length >= 0) || path.segmentIds.length === 0) failures.push(`${brief.id}: no path to ${layout.lots[at]!.id}`);
        }
        // A seeded sample of residents has a sound plan for day 1 that joins on to day 2.
        const life = createLife({ city, layout, pack });
        const checker = createPlanChecker({ city, layout, pack });
        const pick = createRng(brief.seed);
        for (let sample = 0; sample < RESIDENTS_SAMPLED; sample++) {
          const person = city.people[pick.int(0, city.people.length - 1)]!;
          const today = life.plan(person.id, 1);
          plans++;
          failures.push(...checker.check(today), ...checker.checkContinuity(today, life.plan(person.id, 2)));
        }
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    console.log(`Checked the day plans of ${plans.toLocaleString('en-US')} sampled residents across ${settlements.length} settlements`);
    console.log(
      `Laid out ${settlements.length} settlements, ${lots.toLocaleString('en-US')} lots, in ${layoutSeconds.toFixed(1)} s; the slowest was ${slowest.id} at ${slowest.seconds.toFixed(2)} s`,
    );
    expect(failures.slice(0, 10)).toEqual([]);
    expect(slowest.seconds).toBeLessThan(5);
    expect(footprints).toBeGreaterThan(400_000);
    expect(openAirLots).toBeGreaterThan(10_000);
  });
});
