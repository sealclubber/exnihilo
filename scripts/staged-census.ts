/**
 * Lays out settlements of Lomia with the staged generator and says how many keep every layout invariant, which
 * invariants the others break, and how district ground falls, which is measured and not required: lots outside
 * their own district's ground, districts in more than one piece, and houses given by the selection's
 * non-touching fallback.
 *
 * Usage: node scripts/staged-census.ts [every] [--towns] [--grown]
 *   every    lay out every nth settlement (default 1: all 682, about 6 minutes; 12 is the sample of 57)
 *   --towns  also list each failing settlement with its first problem
 *   --grown  grow the districts over the kept blocks after selection (phase 6F, Part B), whatever the pack says;
 *            then also count landmarks outside their owner's ground, districts spanning banks, and wards whose
 *            forecast kind is not their district's
 */
import { checkLayout, generateCity, generateStagedLayout, measureDistrictGround, type SettingPack } from '../packages/core/src/index.ts';
import { pointInPolygon, polygonCentroid } from '../packages/core/src/layout/geometry.ts';
import { planTown, townInput } from '../packages/core/src/layout/staged/plan.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const args = process.argv.slice(2);
const every = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 1);
const listTowns = args.includes('--towns');
const asGrown = args.includes('--grown');
const base = medievalPack();
const staged = base.layout.staged as NonNullable<SettingPack['layout']['staged']>;
const pack: SettingPack = asGrown ? { ...base, layout: { ...base.layout, staged: { ...staged, districts: { ...staged.districts, afterSelection: true } } } } : base;
const grownCounts = { landmarks: 0, landmarksOutside: 0, spanning: 0, spanningUnjoined: 0, overSpan: 0, inPiecesOnABank: 0, wards: 0, wardsOtherKind: 0 };
const piecesBy: string[] = [];
let generating = 0;

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
    const started = performance.now();
    const layout = generateStagedLayout(city, brief, pack, { check: false });
    generating += performance.now() - started;
    problems = checkLayout(layout, city, brief, pack);
    const measured = measureDistrictGround(layout);
    if (asGrown) {
      const plan = planTown(brief, townInput(city, pack), pack);
      const areas = new Map(layout.districtAreas.map((area) => [area.districtId, area.polygons]));
      const lotOf = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
      for (const landmark of plan.landmarks) {
        const lot = lotOf.get(landmark.building);
        if (!lot) continue;
        grownCounts.landmarks++;
        if (!(areas.get(lot.districtId) ?? []).some((polygon) => pointInPolygon(polygonCentroid(lot.polygon), polygon))) grownCounts.landmarksOutside++;
      }
      grownCounts.spanning += plan.banks.spanning.length;
      grownCounts.spanningUnjoined += plan.banks.unjoined.length;
      if (plan.banks.spanning.length > Math.max(plan.banks.banks.length - 1, 0)) grownCounts.overSpan++;
      // Wards whose forecast kind is not the kind of the district holding most of their kept houses.
      const byWard = new Map<number, Map<number, number>>();
      plan.houses.forEach((house, index) => {
        const of = plan.selection.district[index];
        if (of === undefined) return;
        const map = byWard.get(house.ward) ?? new Map<number, number>();
        map.set(of, (map.get(of) ?? 0) + 1);
        byWard.set(house.ward, map);
      });
      for (const [ward, map] of byWard) {
        const forecast = plan.forecast.of[ward];
        if (forecast === undefined) continue;
        const final = [...map].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] as number;
        grownCounts.wards++;
        if (plan.districts[final]?.kind !== plan.districts[forecast]?.kind) grownCounts.wardsOtherKind++;
      }
      if (measured.inPiecesAcrossBridges > 0) piecesBy.push(`${brief.name}:${measured.inPiecesAcrossBridges}`);
    }
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
console.log(`Generating the layouts took ${(generating / 1000).toFixed(0)} s`);
if (asGrown) {
  console.log(`Landmarks outside their owner's ground: ${grownCounts.landmarksOutside} of ${grownCounts.landmarks}`);
  console.log(`Districts spanning banks: ${grownCounts.spanning}, ${grownCounts.spanningUnjoined} with no bridge between; settlements with more than banks less one: ${grownCounts.overSpan}`);
  console.log(`Wards whose forecast kind is not their district's: ${grownCounts.wardsOtherKind} of ${grownCounts.wards}`);
  console.log(`Districts in pieces with bridge links counted, by settlement: ${piecesBy.join(' ')}`);
}
if (listTowns) for (const line of failing) console.log(line);
