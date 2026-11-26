/**
 * Runs the districts stage (phase 6G, `staged/districting.ts`) beside the staged generator on every town of Lomia
 * of 1,000 people or more, over the houses selection keeps, and measures what `sim-6g.md`'s census table asks.
 *
 * Usage: node scripts/districting-census.ts [--generator] [--towns name,name] [--every n] [--out file.json]
 *   --generator  targets as the generator will give them, each district's buildings that need a house; without
 *                it, as the reference sandbox did, each district's buildings scaled to the kept total
 *   --towns      only the towns named, each with a line of its own
 *   --every      every nth town
 *   --out        write each town's figures to a JSON file
 *   --plain      without the landmarks leading the ground
 */
import { writeFileSync } from 'node:fs';
import { generateCity } from '../packages/core/src/index.ts';
import { drawDistricts } from '../packages/core/src/layout/staged/districting.ts';
import { planTown, stagedSettings, townInput } from '../packages/core/src/layout/staged/plan.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const generatorTargets = args.includes('--generator');
const only = option('--towns')?.split(',');
const every = Number(option('--every') ?? 1);
const plain = args.includes('--plain');
const pack = medievalPack();
const rules = stagedSettings(pack).districts.drawn;
if (!rules) throw new Error('the pack has no layout.staged.districts.drawn');

const all = lomiaWorld().settlements.filter((brief) => brief.population >= 1000);
const towns = only ? all.filter((brief) => only.includes(brief.name)) : all.filter((_, index) => index % every === 0);
const sum = { towns: 0, houses: 0, districts: 0, blocks: 0, inPieces: 0, notExact: 0, offExact: 0, offAfterChains: 0, offAfterChainsUnrounded: 0, lentBlocks: 0, lentHouses: 0, spans: 0, islands: 0, unclaimed: 0, reseeded: 0, relocated: 0, landmarks: 0, landmarksOutside: 0, redrawn: 0, claimed: 0, released: 0 };
const notExact: string[] = [];
const redrawn: string[] = [];
const out: Record<string, unknown> = {};
const started = Date.now();
for (const brief of towns) {
  const city = generateCity(brief, pack);
  const plan = planTown(brief, townInput(city, pack), pack);
  const kept = plan.selection.district.flatMap((of, house) => (of === undefined ? [] : [house]));
  const total = kept.length;
  let targets: number[];
  if (generatorTargets) {
    const place = new Map(plan.districts.map((district, index) => [district.id, index]));
    const gates = new Set(plan.gatehouses);
    targets = plan.districts.map(
      (district, index) =>
        district.buildings - plan.landmarks.filter((landmark) => landmark.district === index).length - city.buildings.filter((building) => gates.has(building.id) && place.get(building.districtId) === index).length,
    );
  } else {
    const all = plan.districts.reduce((count, district) => count + district.buildings, 0);
    targets = plan.districts.map((district) => (district.buildings * total) / all);
  }
  const drawn = drawDistricts({ rules, blocks: plan.blocks, wards: plan.wards, houses: plan.houses, kept, tilesBeside: plan.tilesBeside, links: plan.links, seeds: plan.forecast.seeds, targets, ...(!plain && { landmarks: plan.landmarks }) });
  const lentHouses = [...drawn.lent.values()].reduce((count, entry) => count + entry.houses, 0);
  sum.towns++;
  sum.houses += total;
  sum.districts += plan.districts.length;
  sum.blocks += plan.blocks.length;
  sum.inPieces += drawn.inPieces;
  sum.offAfterChains += drawn.offAfterChains;
  sum.offExact += drawn.off;
  // As the sandbox also measured it: against the targets as given, before they were made whole numbers.
  const afterChains = targets.map(() => 0);
  drawn.units.forEach((unit, at) => (afterChains[unit.district] = (afterChains[unit.district] as number) + (drawn.unitHave[at] as number)));
  const unrounded = Math.round(afterChains.reduce((total, have, at) => total + Math.abs(have - (targets[at] as number)), 0) / 2);
  sum.offAfterChainsUnrounded += unrounded;
  if (drawn.off > 0) {
    sum.notExact++;
    notExact.push(`${brief.name} ${drawn.off}`);
  }
  sum.lentBlocks += drawn.lent.size;
  sum.lentHouses += lentHouses;
  sum.spans += drawn.spans;
  sum.islands += drawn.islands;
  sum.unclaimed += drawn.unclaimed;
  sum.reseeded += drawn.reseeded;
  sum.relocated += drawn.relocated;
  sum.landmarks += plan.landmarks.filter((landmark) => landmark.district !== undefined && landmark.block !== undefined).length;
  sum.landmarksOutside += drawn.landmarksOutside;
  sum.claimed += drawn.claimed;
  sum.released += drawn.released;
  if (drawn.withoutLandmarks) {
    sum.redrawn++;
    redrawn.push(brief.name);
  }
  const line = { houses: total, districts: plan.districts.length, blocks: plan.blocks.length, inPieces: drawn.inPieces, offAfterChains: drawn.offAfterChains, unrounded, off: drawn.off, lentBlocks: drawn.lent.size, lentHouses, spans: drawn.spans, islands: drawn.islands, reseeded: drawn.reseeded, relocated: drawn.relocated, chainMoves: drawn.chainMoves, landmarksOutside: drawn.landmarksOutside, claimed: drawn.claimed, released: drawn.released, withoutLandmarks: drawn.withoutLandmarks };
  out[brief.name] = line;
  if (only) console.log(brief.name, JSON.stringify(line));
}
const share = (part: number, of: number) => `${((100 * part) / Math.max(of, 1)).toFixed(2)}%`;
console.log(`${sum.towns} towns, ${sum.houses} houses, ${sum.districts} districts, ${sum.blocks} blocks; targets ${generatorTargets ? "the generator's" : "scaled, as the sandbox's"}; ${Math.round((Date.now() - started) / 1000)} s`);
console.log(`Districts in more than one piece (bridges count as joins): ${sum.inPieces}`);
console.log(`Towns not exact after step 5: ${sum.notExact}, ${sum.offExact} houses${notExact.length > 0 ? ` (${notExact.join(', ')})` : ''}`);
console.log(`Houses out after step 4, before step 5: ${sum.offAfterChains} (${share(sum.offAfterChains, sum.houses)}); ${sum.offAfterChainsUnrounded} against the targets before rounding`);
console.log(`Shared blocks: ${sum.lentBlocks} (${share(sum.lentBlocks, sum.blocks)} of blocks), ${sum.lentHouses} houses lent`);
console.log(`Districts spanning a river: ${sum.spans}`);
console.log(`Islands: ${sum.islands} houses; unclaimed: ${sum.unclaimed}; re-seeded for want of a bridge: ${sum.reseeded}; moved across whole: ${sum.relocated}`);
console.log(`Landmarks outside their district's ground: ${sum.landmarksOutside} of ${sum.landmarks} block landmarks (${share(sum.landmarksOutside, sum.landmarks)}); ${sum.claimed} claimed, ${sum.released} blocks let go`);
console.log(`Towns not exact with the landmarks leading, so drawn again without: ${sum.redrawn}${redrawn.length > 0 ? ` (${redrawn.join(', ')})` : ''}`);
const file = option('--out');
if (file) writeFileSync(file, JSON.stringify(out, null, 1));
