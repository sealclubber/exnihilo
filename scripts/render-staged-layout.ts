/**
 * Draws the staged generator's layout of a town with the layout renderer, whether or not it keeps every invariant,
 * and says what it breaks: for checking phase 6E step 8.
 *
 * Usage: node scripts/render-staged-layout.ts <out folder> <suffix> <settlement name>...
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLayout, generateCity, generateStagedLayout, renderLayoutSvg } from '../packages/core/src/index.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const [out, suffix, ...names] = process.argv.slice(2);
if (!out || !suffix || names.length === 0) throw new Error('Usage: node scripts/render-staged-layout.ts <out folder> <suffix> <settlement name>...');
const pack = medievalPack();
for (const name of names) {
  const brief = lomiaWorld().settlements.find((entry) => entry.name === name);
  if (!brief) throw new Error(`no settlement named ${name} in Lomia`);
  const city = generateCity(brief, pack);
  const started = performance.now();
  const layout = generateStagedLayout(city, brief, pack, { check: false });
  const took = performance.now() - started;
  const problems = checkLayout(layout, city, brief, pack);
  writeFileSync(join(out, `${name.toLowerCase()}-${suffix}.svg`), renderLayoutSvg(layout, { brief }));
  console.log(`${name}: ${layout.summary.counts.lots} lots, ${layout.summary.counts.segments} segments, ${layout.summary.counts.gates} gates, ${Math.round(took)} ms, ${problems.length === 0 ? 'every invariant kept' : `${problems.length} problems, the first: ${problems[0]}`}`);
}
