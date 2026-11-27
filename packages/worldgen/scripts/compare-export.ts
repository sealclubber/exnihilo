/**
 * Generates Lomia from its saved `map` and `generation` options and compares the export built in memory with
 * `fixtures/afmg/lomia.json`, field by field. Prints each path that differs (list positions folded to `[]`),
 * how many times, and the first example.
 *
 * Usage: node packages/worldgen/scripts/compare-export.ts
 */
import { readFileSync } from 'node:fs';
import { differences } from '../src/compare.ts';
import { loadGenerator } from '../src/generator.ts';

const lomia = JSON.parse(readFileSync(new URL('../../../fixtures/afmg/lomia.json', import.meta.url), 'utf8'));
const { generate } = await loadGenerator();
const made = JSON.parse((await generate({ map: lomia.settings.options.map, generation: lomia.settings.options.generation })).json);

const found = differences(made, lomia);
for (const [path, { count, example }] of [...found].sort()) console.log(`${String(count).padStart(6)}  ${path}  | ${example}`);
