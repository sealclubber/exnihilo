/**
 * Draws the staged generator's plan of a town as far as its stages go, for checking phase 6E step by step.
 *
 * Usage: node scripts/render-stages.ts <out folder> <suffix> [--as flag,flag] <settlement name>...
 * Writes <out folder>/<name>-<suffix>.svg for each. `--as walls,plaza,citadel` draws each town as if its brief
 * had those flags too, to judge a stage on a town the world gave none.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCity } from '../packages/core/src/index.ts';
import { drawPlanSvg } from '../packages/core/src/layout/staged/draw.ts';
import { landmarksOf, planTown, stagedSettings } from '../packages/core/src/layout/staged/plan.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const [out, suffix, ...rest] = process.argv.slice(2);
const asIf = rest[0] === '--as' ? (rest[1] ?? '').split(',') : [];
const names = asIf.length > 0 ? rest.slice(2) : rest;
if (!out || !suffix || names.length === 0) throw new Error('Usage: node scripts/render-stages.ts <out folder> <suffix> <settlement name>...');
const pack = medievalPack();
for (const name of names) {
  const found = lomiaWorld().settlements.find((entry) => entry.name === name);
  if (!found) throw new Error(`no settlement named ${name} in Lomia`);
  const brief = { ...found, flags: { ...found.flags, ...Object.fromEntries(asIf.map((flag) => [flag, true])) } };
  // With `--as`, the city too is the one the flagged brief would have.
  const city = generateCity(brief, pack);
  const started = performance.now();
  const plan = planTown(brief, city.buildings.length, pack, brief.seed, landmarksOf(city.buildings, pack));
  const took = performance.now() - started;
  writeFileSync(join(out, `${name.toLowerCase()}-${suffix}.svg`), drawPlanSvg(plan, brief, stagedSettings(pack).widths.highway, stagedSettings(pack).widths.mainStreet, stagedSettings(pack).widths.wardBorder));
  console.log(`${name}: ${plan.highways.length} highways, ${plan.bridges.length} bridges, ${plan.wards.length} wards, ${plan.blocks.length} blocks, ${plan.houses.length} houses for ${plan.buildings} buildings, ${Math.round(took)} ms${plan.notes.length ? ` · ${plan.notes.join('; ')}` : ''}`);
}
