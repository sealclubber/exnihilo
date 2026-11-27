/**
 * Worlds from a seed (phase 7A): AFMG's generator, run headless, turned into AFMG's export shape in memory and
 * read by the importer like any export. `core` never depends on this package; the server does.
 */
import { type World, importAfmg } from '@worldsim/core';
import { type AfmgOptions, loadGenerator } from './generator.ts';

export type { AfmgOptions, Generated, Generator } from './generator.ts';
export { loadGenerator } from './generator.ts';

/** AFMG's export of a world made from `options`, as the object a downloaded `.json` file parses to. */
export async function generateExport(options: AfmgOptions): Promise<unknown> {
  const { generate } = await loadGenerator();
  return JSON.parse((await generate(options)).json);
}

/** A world made from AFMG's options (any part of them; the rest are AFMG's defaults). */
export async function createWorld(options: AfmgOptions): Promise<World> {
  return importAfmg(await generateExport(options)).world;
}
