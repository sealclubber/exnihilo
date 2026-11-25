/**
 * Draws the village generator's plan of a settlement as far as its steps go, for checking it step by step.
 *
 * Usage: node scripts/render-village.ts <out folder> <suffix> [--as flag,flag] <settlement name>...
 * Writes <out folder>/<name>-<suffix>.svg for each. `--as walls,plaza,citadel` draws each village as if its brief
 * had those flags too, to judge a step on a village the world gave none.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCity } from '../packages/core/src/index.ts';
import { drawVillageSvg } from '../packages/core/src/layout/village/draw.ts';
import { planVillage, villageInput } from '../packages/core/src/layout/village/plan.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const [out, suffix, ...rest] = process.argv.slice(2);
const asIf = rest[0] === '--as' ? (rest[1] ?? '').split(',') : [];
const names = asIf.length > 0 ? rest.slice(2) : rest;
if (!out || !suffix || names.length === 0) throw new Error('Usage: node scripts/render-village.ts <out folder> <suffix> [--as flag,flag] <settlement name>...');
const pack = medievalPack();
for (const name of names) {
  const found = lomiaWorld().settlements.find((entry) => entry.name === name);
  if (!found) throw new Error(`no settlement named ${name} in Lomia`);
  const brief = { ...found, flags: { ...found.flags, ...Object.fromEntries(asIf.map((flag) => [flag, true])) } };
  const city = generateCity(brief, pack);
  const started = performance.now();
  const plan = planVillage(brief, villageInput(city), pack);
  const took = performance.now() - started;
  writeFileSync(join(out, `${name.toLowerCase()}-${suffix}.svg`), drawVillageSvg(plan, brief));
  console.log(`${name}: ${plan.shape}, ${plan.buildings} buildings, ${plan.ways.length} ways, ${plan.bridges.length} bridges, anchors ${plan.anchors.sites.map((site) => `${site.role}${site.building ? '' : ' (empty)'}`).join(', ') || 'none'}, ${Math.round(took)} ms${plan.notes.length ? ` · ${plan.notes.join('; ')}` : ''}`);
}
