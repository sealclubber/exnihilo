/**
 * Lays out settlements of Lomia with the staged generator and says how many keep every layout invariant, which
 * invariants the others break, and how district ground falls, which is measured and not required: lots outside
 * their own district's ground, districts in more than one piece, and houses given by the selection's
 * non-touching fallback.
 *
 * Usage: node scripts/staged-census.ts [every] [--towns]
 *   every    lay out every nth settlement (default 1: all 682, about 6 minutes; 12 is the sample of 57)
 *   --towns  also list each failing settlement with its first problem
 */
import { checkLayout, generateCity, generateStagedLayout, measureDistrictGround } from '../packages/core/src/index.ts';
import { planTown, townInput } from '../packages/core/src/layout/staged/plan.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const args = process.argv.slice(2);
const every = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 1);
const listTowns = args.includes('--towns');
const pack = medievalPack();

/** A problem with its names and numbers taken out, so that like problems count together. */
const kindOf = (problem: string) =>
  problem
    .replace(/[a-z]+-\d+-\d+/g, 'X')
    .replace(/-?\d+(\.\d+)?/g, 'N')
    .trim()
    .slice(0, 110);

const kinds = new Map<string, { settlements: number; example: string }>();
const failing: string[] = [];
const fallbacks: string[] = [];
let whole = 0;
let laidOut = 0;
let fallbackHouses = 0;
let borrowed = 0;
let kept = 0;
let moreGround = 0;
const ground = { lots: 0, lotsOutside: 0, districts: 0, inPieces: 0, inPiecesAcrossBridges: 0 };
const settlementsWith = { lotsOutside: 0, inPieces: 0 };

lomiaWorld().settlements.forEach((brief, index) => {
  if (index % every !== 0) return;
  laidOut++;
  const city = generateCity(brief, pack);
  let problems: string[];
  try {
    const layout = generateStagedLayout(city, brief, pack, { check: false });
    problems = checkLayout(layout, city, brief, pack);
    const measured = measureDistrictGround(layout);
    for (const key of Object.keys(ground) as Array<keyof typeof ground>) ground[key] += measured[key];
    if (measured.lotsOutside > 0) settlementsWith.lotsOutside++;
    if (measured.inPieces > 0) settlementsWith.inPieces++;
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
  const { selection, moreGround: more } = planTown(brief, townInput(city, pack), pack);
  if (selection.fallback > 0) fallbacks.push(`${brief.name}:${selection.fallback}`);
  fallbackHouses += selection.fallback;
  borrowed += selection.borrowed.reduce((sum, count) => sum + count, 0);
  kept += selection.kept.reduce((sum, count) => sum + count, 0);
  moreGround += more;
});

console.log(`${whole} of ${laidOut} settlements keep every invariant; ${laidOut - whole} do not`);
for (const [kind, { settlements, example }] of [...kinds].sort((a, b) => b[1].settlements - a[1].settlements)) {
  console.log(`${String(settlements).padStart(4)}  ${kind}  (for example ${example})`);
}
const share = (part: number, whole: number) => `${((100 * part) / Math.max(whole, 1)).toFixed(2)}%`;
console.log(`Lots outside their own district's ground: ${ground.lotsOutside} of ${ground.lots} (${share(ground.lotsOutside, ground.lots)}), in ${settlementsWith.lotsOutside} settlements`);
console.log(`Districts in more than one piece: ${ground.inPieces} of ${ground.districts}, in ${settlementsWith.inPieces} settlements; ${ground.inPiecesAcrossBridges} still are with their own bridge links counted as joins`);
console.log(`Non-touching fallback: ${fallbacks.length} settlements, ${fallbackHouses} houses`);
console.log(`Houses standing in a neighbour's block: ${borrowed} of ${kept}; settlements that took more ground: ${moreGround}`);
if (fallbacks.length > 0) console.log(`Fallback by settlement: ${fallbacks.join(' ')}`);
if (listTowns) for (const line of failing) console.log(line);
