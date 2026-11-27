/**
 * Phase 7A, steps 2 and 3, and the wrapper's own promises: AFMG's export built in memory differs from
 * `fixtures/afmg/lomia.json` only where it may, and `createWorld` gives the world the importer makes of the
 * fixture. Two runs give the same world, one world does not leak into the next, `Math.random` is put back,
 * and overlapping calls wait their turn.
 *
 * The fixture was exported from AFMG 1.158.0 and the pin is 1.159.0. What differs is the export's metadata, the
 * coats of arms, AFMG's history layer (wars, regiments, battle markers, zones, journeys) and the exporter's
 * interface preferences; none of it is wanted (`FINDINGS-7A.md`). Of all that, the importer reads only the
 * version and each state's wars.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { importAfmg } from '@worldsim/core';
import { differences } from '../src/compare.ts';
import { loadGenerator } from '../src/generator.ts';
import { createWorld, generateExport } from '../src/index.ts';

const text = readFileSync(new URL('../../../fixtures/afmg/lomia.json', import.meta.url), 'utf8');
const lomia = JSON.parse(text);
const lomiaOptions = { map: lomia.settings.options.map, generation: lomia.settings.options.generation };
const smallWorld = { map: { seed: '7', graph: { points: 2000 } }, generation: { template: 'archipelago' } };

/** The paths, list positions folded, where the generated export may differ from the fixture. */
const MAY_DIFFER = [
  /^\.info\.(exportedAt|mapId|version)$/,
  /\.coa\b/,
  /^\.pack\.events\b/,
  /^\.pack\.states\[\]\.campaigns\b/,
  /^\.pack\.states\[\]\.diplomacy \(only in the second\)$/,
  /^\.pack\.states\[\]\.military\b/,
  /^\.pack\.markers\[\]\.note$/,
  /^\.pack\.zones\b/,
  /^\.pack\.journeys\b/,
  /^\.settings\.options\.app\b/,
];

/** An export with what changes from run to run taken out: when it was exported, and a clock-made id. */
const steady = (exported: any) => {
  const { exportedAt: _at, mapId: _id, ...info } = exported.info;
  return JSON.stringify({ ...exported, info });
};

let exported: any;

beforeAll(async () => {
  exported = await generateExport(lomiaOptions);
});

describe('the export built in memory (step 2)', () => {
  it("differs from Lomia's only in metadata, coats of arms, the history layer and interface preferences", () => {
    const found = differences(exported, lomia);
    const unexpected = [...found].filter(([path]) => !MAY_DIFFER.some((pattern) => pattern.test(path)));
    expect(unexpected).toEqual([]);
    // The terrain, the towns and the states themselves are among what is equal.
    for (const part of ['.grid', '.pack.cells', '.pack.vertices', '.pack.features', '.pack.rivers', '.pack.routes', '.nameBases']) {
      expect([...found.keys()].filter((path) => path.startsWith(part))).toEqual([]);
    }
  });
});

describe('createWorld (step 3)', () => {
  it("gives the world imported from Lomia's export, but for the AFMG version and the states' wars", async () => {
    const made = await createWorld(lomiaOptions);
    const fixture = importAfmg(JSON.parse(text)).world;
    expect(made.info.source.version).toBe('1.159.0');
    expect(fixture.info.source.version).toBe('1.158.0');
    // AFMG 1.159 keeps wars in `pack.events`, which the importer does not read.
    expect(made.states.every((state) => state.wars.length === 0)).toBe(true);
    const without = (world: typeof made) => ({
      ...world,
      info: { ...world.info, source: { ...world.info.source, version: '' } },
      states: world.states.map((state) => ({ ...state, wars: [] })),
    });
    expect(without(made)).toEqual(without(fixture));
  });
});

describe('the wrapper', () => {
  it('gives the same world for the same options', async () => {
    expect(steady(await generateExport(lomiaOptions))).toBe(steady(exported));
  });

  it('lets nothing of one world leak into the next', async () => {
    await generateExport(smallWorld);
    expect(steady(await generateExport(lomiaOptions))).toBe(steady(exported));
  });

  it('puts Math.random back after a run, and after a run that throws', async () => {
    const { generate } = await loadGenerator();
    const original = Math.random;
    await generate(smallWorld);
    expect(Math.random).toBe(original);
    // No climate: AFMG itself fails in its temperatures step, long after it has seeded Math.random.
    await expect(generate({ ...smallWorld, map: { ...smallWorld.map, climate: null } })).rejects.toThrow(/temperatures/);
    expect(Math.random).toBe(original);
  });

  it('runs overlapping calls one at a time, each correct', async () => {
    const [first, second, third] = await Promise.all([generateExport(lomiaOptions), generateExport(smallWorld), generateExport(lomiaOptions)]);
    expect(steady(first)).toBe(steady(exported));
    expect(steady(third)).toBe(steady(exported));
    expect(steady(second)).toBe(steady(await generateExport(smallWorld)));
  });

  it('refuses a template that is not procedural, a missing seed and no points, naming what to change', async () => {
    await expect(generateExport({ map: { seed: '7' }, generation: { template: 'europe' } })).rejects.toThrow(/generation\.template must be one of volcano, .*fractious/);
    await expect(generateExport({ generation: { template: 'continents' } })).rejects.toThrow(/map\.seed is missing/);
    await expect(generateExport({ map: { seed: '7', graph: { points: 0 } }, generation: { template: 'continents' } })).rejects.toThrow(/points must be above 0/);
  });

  it('knows the 14 procedural templates', async () => {
    expect(await (await loadGenerator()).templateIds()).toHaveLength(14);
  });
});
