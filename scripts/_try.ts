import { writeFileSync } from 'node:fs';
import { generateCity, generateLayout, renderLayoutSvg } from '../packages/core/src/index.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';
const pack = medievalPack();
const out = process.argv[2]!;
for (const name of process.argv.slice(3)) {
  const brief = lomiaWorld().settlements.find((s) => s.name === name)!;
  const city = generateCity(brief, pack);
  const t = performance.now();
  try {
    const layout = generateLayout(city, brief, pack, { generator: 'grown' });
    console.log(name, 'ok', layout.lots.length, 'lots', layout.segments.length, 'segments', `${(performance.now() - t).toFixed(0)} ms`, 'density', layout.summary.residentsPerHectare.toFixed(0), 'gates', layout.summary.counts.gates, 'ring', layout.summary.ringShare.toFixed(2), 'roads', layout.summary.roadsOut, 'bridges', layout.segments.filter((s) => s.kind === 'bridge').length, 'greens', layout.places.filter((p) => p.kind === 'green').length);
    writeFileSync(`${out}/${name.toLowerCase()}-grown.svg`, renderLayoutSvg(layout, { brief, districtNames: Object.fromEntries(city.districts.map((d) => [d.id, d.name])) }));
  } catch (error) {
    console.log(name, 'FAILED', `${(performance.now() - t).toFixed(0)} ms`, (error as Error).message.split('\n').slice(0, 8).join('\n   '), (error as Error).name === 'LayoutGenerationError' ? '' : (error as Error).stack?.split('\n').slice(1, 4).join(' | '));
  }
}
