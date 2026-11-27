/**
 * Phase 7A, step 4: two new worlds, made as AFMG makes a new map from a seed (`newWorldOptions`), hold to the
 * fingerprints saved in `fixtures/worlds/` (cell counts, a hash of the heights, rivers and burgs), and pass
 * through the importer.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importAfmg } from '@worldsim/core';
import { type Fingerprint, fingerprint } from '../src/fingerprint.ts';
import { type NewWorld, generateExport, newWorldOptions } from '../src/index.ts';

const saved = (name: string): { options: NewWorld; fingerprint: Fingerprint } =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/worlds/${name}.json`, import.meta.url), 'utf8'));

describe.each(['continents-20000', 'archipelago-5000'])('the %s world', (name) => {
  it('holds to its fingerprint and passes through the importer', async () => {
    const world = saved(name);
    const exported = await generateExport(...newWorldOptions(world.options));
    expect(fingerprint(exported)).toEqual(world.fingerprint);
    const { world: imported } = importAfmg(exported);
    expect(imported.settlements.length).toBe(world.fingerprint.burgs);
  });
});
