/**
 * Worlds from a seed (phase 7A): AFMG's generator, run headless, turned into AFMG's export shape in memory and
 * read by the importer like any export. `core` never depends on this package; the server does.
 */
import { type World, importAfmg } from '@worldsim/core';
import { type AfmgOptions, type Settings, loadGenerator } from './generator.ts';

export type { AfmgOptions, Generated, Generator, Settings } from './generator.ts';
export { loadGenerator } from './generator.ts';

/** AFMG's export of a world made from `options`, as the object a downloaded `.json` file parses to. */
export async function generateExport(options: AfmgOptions, settings: Settings = {}): Promise<unknown> {
  const { generate } = await loadGenerator();
  return JSON.parse((await generate(options, settings)).json);
}

/**
 * A world made from AFMG's options: any part of them, merged over AFMG's defaults, or with `roll` over what AFMG
 * rolls for a new map from `map.seed`.
 */
export async function createWorld(options: AfmgOptions, settings: Settings = {}): Promise<World> {
  return importAfmg(await generateExport(options, settings)).world;
}

/** The options of a new world: a seed, one of AFMG's 14 procedural templates, and how many points. */
export interface NewWorld {
  seed: string;
  template: string;
  points: number;
}

/** A new world as AFMG would make it from a seed, with the template and the number of points chosen. */
export function newWorldOptions({ seed, template, points }: NewWorld): [AfmgOptions, Settings] {
  return [{ map: { seed, graph: { points } }, generation: { template } }, { roll: true }];
}
