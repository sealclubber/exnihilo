/**
 * Generates Lomia from its saved `map` and `generation` options and compares the export built in memory with
 * `fixtures/afmg/lomia.json`, field by field. Prints each path that differs (list positions folded to `[]`),
 * how many times, and the first example.
 *
 * Usage: node packages/worldgen/scripts/compare-export.ts
 */
import { readFileSync } from 'node:fs';
import { loadGenerator } from '../src/generator.ts';

const lomia = JSON.parse(readFileSync(new URL('../../../fixtures/afmg/lomia.json', import.meta.url), 'utf8'));
const generate = await loadGenerator();
const made = JSON.parse((await generate({ map: lomia.settings.options.map, generation: lomia.settings.options.generation })).json);

const differences = new Map<string, { count: number; example: string }>();
const show = (value: unknown) => JSON.stringify(value)?.slice(0, 90);
const note = (path: string, mine: unknown, theirs: unknown) => {
  const key = path.replace(/\[\d+\]/g, '[]');
  const entry = differences.get(key) ?? { count: 0, example: `${path}: ${show(mine)}, fixture ${show(theirs)}` };
  entry.count++;
  differences.set(key, entry);
};
const walk = (mine: any, theirs: any, path: string): void => {
  if (mine === theirs) return;
  if (typeof mine !== 'object' || typeof theirs !== 'object' || mine === null || theirs === null || Array.isArray(mine) !== Array.isArray(theirs)) return note(path, mine, theirs);
  if (Array.isArray(mine)) {
    if (mine.length !== theirs.length) note(`${path}.length`, mine.length, theirs.length);
    for (let index = 0; index < Math.min(mine.length, theirs.length); index++) walk(mine[index], theirs[index], `${path}[${index}]`);
    return;
  }
  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    if (!(key in mine)) note(`${path}.${key} (only in the fixture)`, undefined, theirs[key]);
    else if (!(key in theirs)) note(`${path}.${key} (only in the generated)`, mine[key], undefined);
    else walk(mine[key], theirs[key], `${path}.${key}`);
  }
};
walk(made, lomia, '');
for (const [path, { count, example }] of [...differences].sort()) console.log(`${String(count).padStart(6)}  ${path}  | ${example}`);
