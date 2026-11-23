/**
 * Draws the staged generator's plan of a town as far as its stages go, for checking phase 6E step by step.
 *
 * Usage: node scripts/render-stages.ts <out folder> <suffix> <settlement name>...
 * Writes <out folder>/<name>-<suffix>.svg for each.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCity } from '../packages/core/src/index.ts';
import { drawPlanSvg } from '../packages/core/src/layout/staged/draw.ts';
import { planTown, stagedSettings } from '../packages/core/src/layout/staged/plan.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const [out, suffix, ...names] = process.argv.slice(2);
if (!out || !suffix || names.length === 0) throw new Error('Usage: node scripts/render-stages.ts <out folder> <suffix> <settlement name>...');
const pack = medievalPack();
for (const name of names) {
  const brief = lomiaWorld().settlements.find((entry) => entry.name === name);
  if (!brief) throw new Error(`no settlement named ${name} in Lomia`);
  const city = generateCity(brief, pack);
  const started = performance.now();
  const plan = planTown(brief, city.buildings.length, pack);
  const took = performance.now() - started;
  writeFileSync(join(out, `${name.toLowerCase()}-${suffix}.svg`), drawPlanSvg(plan, brief, stagedSettings(pack).widths.highway));
  console.log(`${name}: ${plan.highways.length} highways, ${plan.bridges.length} bridges, ${Math.round(took)} ms${plan.notes.length ? ` · ${plan.notes.join('; ')}` : ''}`);
}
