/**
 * The whole-world run: every settlement of Lomia, generated and checked.
 */
import { describe, expect, it } from 'vitest';
import { WORKFORCE_SHARE_LIMITS, checkCity, generateCity } from '../src/index.ts';
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
});
