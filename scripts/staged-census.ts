/**
 * Lays out settlements of Lomia with the pack's generator (the staged generator for towns, the village generator
 * for villages) and says how many keep every layout invariant, which invariants the others break, and how
 * district ground falls, which is measured and not required: lots outside their own district's ground and
 * districts in more than one piece. For towns it also gives the districts stage's census (`sim-6g.md`): towns
 * not exact, the houses given to a short district from a neighbour's ground, shared blocks, districts spanning a
 * river, islands, and landmarks whose block ended in another district.
 *
 * Usage: node scripts/staged-census.ts [every] [--towns]
 *   every    lay out every nth settlement (default 1: all 682; 12 is the sample of 57)
 *   --towns  also list each failing settlement with its first problem
 */
import { checkLayout, generateCity, generateLayout, measureDistrictGround } from '../packages/core/src/index.ts';
import { planTown, townInput } from '../packages/core/src/layout/staged/plan.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const args = process.argv.slice(2);
const every = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 1);
const listTowns = args.includes('--towns');
const pack = medievalPack();
const below = pack.layout.village?.below ?? 0;

/** A problem with its names and numbers taken out, so that like problems count together. */
const kindOf = (problem: string) =>
  problem
    .replace(/[a-z]+-\d+-\d+/g, 'X')
    .replace(/-?\d+(\.\d+)?/g, 'N')
    .trim()
    .slice(0, 110);

const kinds = new Map<string, { settlements: number; example: string }>();
const failing: string[] = [];
let whole = 0;
let laidOut = 0;
let generating = 0;
const ground = { lots: 0, lotsOutside: 0, districts: 0, inPieces: 0, inPiecesAcrossBridges: 0 };
const settlementsWith = { lotsOutside: 0, inPieces: 0 };
const townGround = { lots: 0, lotsOutside: 0, districts: 0, inPieces: 0, inPiecesAcrossBridges: 0 };
const towns = { towns: 0, houses: 0, blocks: 0, notExact: 0, leftovers: 0, offAfterChains: 0, lent: 0, spans: 0, islands: 0, landmarks: 0, landmarksOutside: 0, redrawn: 0, moreGround: 0 };
const notExact: string[] = [];
const redrawn: string[] = [];

lomiaWorld().settlements.forEach((brief, index) => {
  if (index % every !== 0) return;
  laidOut++;
  const city = generateCity(brief, pack);
  let problems: string[];
  try {
    const started = performance.now();
    const layout = generateLayout(city, brief, pack, { check: false });
    generating += performance.now() - started;
    problems = checkLayout(layout, city, brief, pack);
    const measured = measureDistrictGround(layout);
    for (const key of Object.keys(ground) as Array<keyof typeof ground>) ground[key] += measured[key];
    if (measured.lotsOutside > 0) settlementsWith.lotsOutside++;
    if (measured.inPieces > 0) settlementsWith.inPieces++;
    if (brief.population >= below) {
      const plan = planTown(brief, townInput(city, pack), pack);
      const { drawn } = plan;
      for (const key of Object.keys(townGround) as Array<keyof typeof townGround>) townGround[key] += measured[key];
      towns.towns++;
      towns.houses += plan.selection.chosen.length;
      towns.blocks += plan.blocks.length;
      if (drawn.leftovers > 0) {
        towns.notExact++;
        notExact.push(`${brief.name} ${drawn.leftovers}`);
      }
      towns.leftovers += drawn.leftovers;
      towns.offAfterChains += drawn.offAfterChains;
      towns.lent += drawn.lent.size;
      towns.spans += drawn.spans;
      towns.islands += drawn.islands;
      towns.landmarks += plan.landmarks.filter((landmark) => landmark.district !== undefined && landmark.block !== undefined).length;
      towns.landmarksOutside += drawn.landmarksOutside;
      if (drawn.withoutLandmarks) {
        towns.redrawn++;
        redrawn.push(brief.name);
      }
      towns.moreGround += plan.moreGround;
    }
  } catch (error) {
    problems = [(error as Error).message.replace(/^[^:]*\(settlement-\d+\): /, '')];
  }
  if (problems.length === 0) whole++;
  else failing.push(`${brief.name} (${brief.id}, ${city.buildings.length} buildings): ${problems.length} problems, the first: ${problems[0]}`);
  for (const kind of new Set(problems.map(kindOf))) {
    const entry = kinds.get(kind) ?? { settlements: 0, example: brief.name };
    entry.settlements++;
    kinds.set(kind, entry);
  }
});

console.log(`${whole} of ${laidOut} settlements keep every invariant; ${laidOut - whole} do not`);
for (const [kind, { settlements, example }] of [...kinds].sort((a, b) => b[1].settlements - a[1].settlements)) {
  console.log(`${String(settlements).padStart(4)}  ${kind}  (for example ${example})`);
}
const share = (part: number, of: number) => `${((100 * part) / Math.max(of, 1)).toFixed(2)}%`;
console.log(`Lots outside their own district's ground: ${ground.lotsOutside} of ${ground.lots} (${share(ground.lotsOutside, ground.lots)}), in ${settlementsWith.lotsOutside} settlements`);
console.log(`Districts in more than one piece: ${ground.inPieces} of ${ground.districts}, in ${settlementsWith.inPieces} settlements; ${ground.inPiecesAcrossBridges} still are with their own bridge links counted as joins`);
console.log(`Towns (${towns.towns}, ${towns.houses} houses, ${towns.blocks} blocks):`);
console.log(`  lots outside their own district's ground: ${townGround.lotsOutside} of ${townGround.lots} (${share(townGround.lotsOutside, townGround.lots)}); districts in more than one piece: ${townGround.inPieces} of ${townGround.districts}, ${townGround.inPiecesAcrossBridges} with bridge links counted as joins`);
console.log(`  not exact after the districts stage: ${towns.notExact}, ${towns.leftovers} houses given from a neighbour's ground${notExact.length > 0 ? ` (${notExact.join(', ')})` : ''}`);
console.log(`  houses out after the chains, before single houses: ${towns.offAfterChains} (${share(towns.offAfterChains, towns.houses)})`);
console.log(`  shared blocks: ${towns.lent} (${share(towns.lent, towns.blocks)}); districts spanning a river: ${towns.spans}; islands: ${towns.islands} houses`);
console.log(`  landmarks whose block ended in another district: ${towns.landmarksOutside} of ${towns.landmarks} (${share(towns.landmarksOutside, towns.landmarks)})`);
console.log(`  drawn again without the landmarks: ${towns.redrawn}${redrawn.length > 0 ? ` (${redrawn.join(', ')})` : ''}; took more ground: ${towns.moreGround}`);
console.log(`Generating the layouts took ${(generating / 1000).toFixed(0)} s`);
if (listTowns) for (const line of failing) console.log(line);
