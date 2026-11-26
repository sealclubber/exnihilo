/**
 * Lays out settlements of Lomia with the pack's generator (the staged generator for towns, the village generator
 * for villages) and says how many keep every layout invariant, which invariants the others break, and how
 * district ground falls, which is measured and not required: lots outside their own district's ground and
 * districts in more than one piece. For towns it also gives the districts stage's census (`sim-6g.md`): how far
 * the districts' ground misses their counts, the houses that stand in a neighbour's ground to make the counts
 * exact, districts spanning a river, islands, and landmarks whose block ended in another district.
 *
 * Usage: node scripts/staged-census.ts [every] [--offset k] [--towns]
 *   every       lay out every nth settlement (default 1: all 682; 12 is the sample of 57)
 *   --offset k  the settlements k after every nth, for running the census in parts side by side
 *   --towns     also list each failing settlement with its first problem
 */
import { checkLayout, generateCity, generateLayout, measureDistrictGround } from '../packages/core/src/index.ts';
import { planTown, townInput } from '../packages/core/src/layout/staged/plan.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const args = process.argv.slice(2);
const every = Number(args.find((arg, at) => /^\d+$/.test(arg) && args[at - 1] !== '--offset') ?? 1);
const listTowns = args.includes('--towns');
/** With `--offset k`, the settlements `k` after every nth: for running the census in parts side by side. */
const offset = args.includes('--offset') ? Number(args[args.indexOf('--offset') + 1]) : 0;
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
const towns = { towns: 0, houses: 0, blocks: 0, off: 0, leftovers: 0, inPieces: 0, waterPaths: 0, headPaths: 0, spans: 0, islands: 0, landmarks: 0, landmarksOutside: 0, moreGround: 0 };
let worst = { name: '', off: 0, houses: 0 };
const over: string[] = [];
/** Towns with a district drawn in more than one piece even with its own bridge links counted as joins. */
const apart: string[] = [];

lomiaWorld().settlements.forEach((brief, index) => {
  if (index % every !== offset) return;
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
      towns.off += drawn.off;
      towns.leftovers += drawn.leftovers;
      if (drawn.off > worst.off) worst = { name: brief.name, off: drawn.off, houses: plan.selection.chosen.length };
      if (drawn.off / plan.selection.chosen.length > 0.02) over.push(`${brief.name} ${drawn.off} of ${plan.selection.chosen.length}`);
      towns.inPieces += drawn.inPieces;
      if (measured.inPiecesAcrossBridges > 0) apart.push(`${brief.name} ${measured.inPiecesAcrossBridges}`);
      towns.waterPaths += drawn.waterPaths;
      towns.headPaths += drawn.headPaths;
      towns.spans += drawn.spans;
      towns.islands += drawn.islands;
      towns.landmarks += plan.landmarks.filter((landmark) => landmark.district !== undefined && landmark.block !== undefined).length;
      towns.landmarksOutside += drawn.landmarksOutside;
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
console.log(`  houses the districts' ground misses their counts by: ${towns.off} (${share(towns.off, towns.houses)}); the worst town ${worst.name}, ${worst.off} of ${worst.houses}; over 2% of a town's houses: ${over.length}${over.length > 0 ? ` (${over.join(', ')})` : ''}`);
console.log(`  houses standing in a neighbour's ground to make every count exact, each hop counted: ${towns.leftovers} (${share(towns.leftovers, towns.houses)})`);
console.log(`  districts in more than one piece of blocks, in the stage's own terms: ${towns.inPieces}; districts spanning a river: ${towns.spans}; islands: ${towns.islands} houses`);
console.log(`  towns with a district drawn in pieces, bridge links counted as joins: ${apart.length}${apart.length > 0 ? ` (${apart.join(', ')})` : ''}`);
console.log(`  given a way of blocks to the water: ${towns.waterPaths}; to their bridgehead: ${towns.headPaths}`);
console.log(`  landmarks whose block ended in another district: ${towns.landmarksOutside} of ${towns.landmarks} (${share(towns.landmarksOutside, towns.landmarks)})`);
console.log(`  took more ground: ${towns.moreGround}`);
console.log(`Generating the layouts took ${(generating / 1000).toFixed(0)} s`);
if (listTowns) for (const line of failing) console.log(line);
