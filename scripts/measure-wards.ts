/**
 * Measures the phase 6D.3 acceptance table on the five test towns: exact buildings, lots and their shapes, wards,
 * lanes, arterials, bridges, road first, districts as chunks, walls, and cost.
 *
 * Usage: node scripts/measure-wards.ts [names...]
 */
import { checkLayout, generateCity, generateLayout } from '../packages/core/src/index.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';
import { arterialOverrun, arterials, bridgeAngles, districtEdges, highwayChains, laneShare, lotShapes, ringDistricts, sizeSpread, stretch, wallShape, wards } from '../packages/core/test/shape.ts';

const pack = medievalPack();
const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['Badanos', 'Pombal', 'Cevilefon', 'Vereceldo', 'Flupines'];
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
for (const name of names) {
  const brief = lomiaWorld().settlements.find((entry) => entry.name === name)!;
  const city = generateCity(brief, pack);
  const started = performance.now();
  const layout = generateLayout(city, brief, pack);
  const took = performance.now() - started;
  console.log(`\n${name}, ${brief.population.toLocaleString('en')} residents, ${city.buildings.length} buildings, ${(took / 1000).toFixed(2)} s`);
  console.log(`  lots: ${layout.lots.length}; rules broken: ${checkLayout(layout, city, brief, pack).length}`);
  const shapes = lotShapes(layout);
  console.log(`  lot length over width: median ${shapes.median.toFixed(2)}, over 4: ${pct(shapes.overFour)}`);
  const spread = [...sizeSpread(layout).values()];
  console.log(`  lot area spread by district: least ${Math.min(...spread).toFixed(2)}, most ${Math.max(...spread).toFixed(2)}`);
  const list = wards(layout);
  const looseFrom = 0.8;
  const tight = list.filter((ward) => ward.rank < looseFrom);
  console.log(`  wards: ${list.length}, largest ${(Math.max(...list.map((ward) => ward.area)) / 10_000).toFixed(2)} ha, median lots ${median(list.map((ward) => ward.lots))}, empty ${list.filter((ward) => ward.lots === 0).length}`);
  console.log(`  coverage of wards not loose: median ${pct(median(tight.map((ward) => ward.coverage)))}, under 75% ${tight.filter((ward) => ward.coverage < 0.75).length} of ${tight.length}; under 60% and not in the last fifth: ${list.filter((ward) => ward.coverage < 0.6 && ward.rank < looseFrom).length}`);
  console.log(`  lots entered from a lane: ${pct(laneShare(layout))}`);
  const branches = arterials(layout);
  console.log(`  arterials: ${branches.length}, starting on a highway or bridge ${branches.filter((entry) => entry.onHighway).length}, at the centre ${branches.filter((entry) => entry.atCentre).length}; furthest end past the wards ${Math.max(0, ...arterialOverrun(layout)).toFixed(1)} m`);
  const angles = bridgeAngles(layout);
  console.log(`  bridges: ${angles.length}, furthest from square ${Math.max(0, ...angles).toFixed(1)}°`);
  console.log(`  highways unbroken: ${highwayChains(layout).filter((chain) => chain.unbroken).length} of ${layout.exits.length}; stretch along the road ${stretch(layout).toFixed(2)}`);
  console.log(`  district boundary on a highway, arterial or the water: ${pct(districtEdges(layout))}; districts ringing the centre ${ringDistricts(layout).length}`);
  for (const wall of wallShape(layout)) console.log(`  wall: sharpest turn ${wall.worstTurn.toFixed(1)}°, diameters ${wall.diameters.toFixed(2)}`);
  console.log(`  gates ${layout.summary.counts.gates}, density ${layout.summary.residentsPerHectare.toFixed(0)} residents per hectare`);
}
