/**
 * Measures the phase 6D.2 acceptance table: road first, arterials, stretch along the road, through streets,
 * T-junctions, kinks, elongated blocks, strip lots, districts as chunks, the wall and the order of growth.
 *
 * Usage: node scripts/measure-road-first.ts [--all]
 *
 * Prints the five test towns; with --all also checks every highway of every settlement of Lomia for an unbroken chain.
 */
import { generateCity, generateLayout } from '../packages/core/src/index.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';
import { arterials, districtEdges, emptyMiddles, growthOrder, highwayChains, medianElongation, ringDistricts, stretch, stripShare, throughStreets, wallShape } from '../packages/core/test/shape.ts';

const pack = medievalPack();
const grown = pack.layout.grown!;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
for (const name of ['Badanos', 'Pombal', 'Cevilefon', 'Vereceldo', 'Flupines']) {
  const brief = lomiaWorld().settlements.find((entry) => entry.name === name)!;
  const city = generateCity(brief, pack);
  const started = performance.now();
  const layout = generateLayout(city, brief, pack);
  const took = performance.now() - started;
  const chains = highwayChains(layout);
  const branches = arterials(layout, grown.arterials.width);
  const through = throughStreets(layout);
  const walls = wallShape(layout);
  const growth = growthOrder(layout, pack.layout.streetWidths.arterial);
  console.log(`\n${name}, ${brief.population.toLocaleString('en')} residents, ${took.toFixed(0)} ms`);
  console.log(`  highways unbroken from exit to centre: ${chains.filter((chain) => chain.unbroken).length} of ${chains.length}`);
  console.log(`  arterials: ${branches.length}, starting on a highway ${branches.filter((entry) => entry.onHighway).length}, starting at the centre ${branches.filter((entry) => entry.atCentre).length}`);
  console.log(`  extent along the road over across: ${stretch(layout).toFixed(2)}`);
  console.log(`  street length in through streets passing 3 or more junctions: ${pct(through.throughShare)}`);
  console.log(`  three-way junctions with a straight pair within 25°: ${pct(through.teeShare)}`);
  console.log(`  sharpest turn along a through street at a junction: ${through.worstTurnAtJunction.toFixed(1)}°, within a segment: ${through.worstTurnInSegment.toFixed(1)}°`);
  console.log(`  median block length over depth: ${medianElongation(layout).toFixed(2)}`);
  console.log(`  strip lots: ${pct(stripShare(layout))}; blocks with an empty middle over 12 m: ${emptyMiddles(layout)}`);
  console.log(`  district boundary on a highway, arterial or the water: ${pct(districtEdges(layout, grown.arterials.width))}; districts ringing the centre: ${ringDistricts(layout).length}`);
  console.log(`  greens: ${layout.places.filter((place) => place.kind === 'green').length}`);
  for (const wall of walls) console.log(`  wall: sharpest turn away from gates ${wall.worstTurn.toFixed(1)}°, longest diameter over shortest width ${wall.diameters.toFixed(2)}`);
  console.log(`  blocks ranked: ${growth.ranked}; of the oldest tenth, touching a highway: ${pct(growth.oldestOnHighway)}`);
}
if (process.argv.includes('--all')) {
  let broken = 0;
  const names: string[] = [];
  for (const brief of lomiaWorld().settlements) {
    const layout = generateLayout(generateCity(brief, pack), brief, pack);
    const bad = highwayChains(layout).filter((chain) => !chain.unbroken).length;
    if (bad > 0) {
      broken++;
      names.push(`${brief.name} ${bad}`);
    }
  }
  console.log(`\nAll Lomia: settlements with a broken highway: ${broken} (${names.slice(0, 10).join(', ')})`);
}
