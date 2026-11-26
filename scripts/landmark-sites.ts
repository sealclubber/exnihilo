/**
 * Phase 6G, before the switch-over: how the landmark rule of `sim-6g.md` would fall. The districts stage is run
 * beside the generator over the kept houses, with the generator's targets; then each block landmark takes a free
 * site of its kind in its own district's ground, failing that one in a touching district (case 1), failing that an
 * ordinary house (case 2). Counted, not built.
 *
 * Usage: node scripts/landmark-sites.ts [every]   (KIND=any or KIND=template to loosen what counts as one kind)
 */
import { generateCity } from '../packages/core/src/index.ts';
import { drawDistricts } from '../packages/core/src/layout/staged/districting.ts';
import { planTown, stagedSettings, townInput } from '../packages/core/src/layout/staged/plan.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';
const pack = medievalPack(); const rules = stagedSettings(pack).districts.drawn!;
const every = Number(process.argv[2] ?? 1);
let marks = 0, own = 0, beside = 0, house = 0, towns = 0; const worst: string[] = [];
lomiaWorld().settlements.filter((b) => b.population >= 1000).forEach((brief, i) => { if (i % every) return;
  const city = generateCity(brief, pack); const plan = planTown(brief, townInput(city, pack), pack);
  const kept = plan.selection.district.flatMap((of, h) => (of === undefined ? [] : [h]));
  const place = new Map(plan.districts.map((d, k) => [d.id, k])); const gates = new Set(plan.gatehouses);
  const targets = plan.districts.map((d, k) => d.buildings - plan.landmarks.filter((l) => l.district === k).length - city.buildings.filter((b) => gates.has(b.id) && place.get(b.districtId) === k).length);
  const dr = drawDistricts({ rules, blocks: plan.blocks, wards: plan.wards, houses: plan.houses, kept, tilesBeside: plan.tilesBeside, links: plan.links, seeds: plan.forecast.seeds, targets });
  const B = plan.blocks.length; const touch = plan.districts.map(() => new Set<number>());
  for (let b = 0; b < B; b++) for (const m of plan.tilesBeside[b] ?? []) if (m < B) { const x = dr.blockDistrict[b], y = dr.blockDistrict[m]; if (x !== undefined && y !== undefined && x !== y) touch[x]!.add(y); }
  const sites = plan.landmarks.filter((l) => l.block !== undefined); const free = new Set(sites.map((_, k) => k));
  const kindOf = (l: any) => (process.env.KIND === "any" ? "any" : process.env.KIND === "template" ? l.site.template : `${l.site.template}|${l.site.place}`);
  const left: any[] = []; let here = { own: 0, beside: 0, house: 0 };
  for (const l of sites) { const k = [...free].find((s) => kindOf(sites[s]) === kindOf(l) && dr.blockDistrict[sites[s]!.block!] === l.district); if (k !== undefined) { free.delete(k); here.own++; } else left.push(l); }
  for (const l of left) { const k = [...free].find((s) => kindOf(sites[s]) === kindOf(l) && touch[l.district]?.has(dr.blockDistrict[sites[s]!.block!]!)); if (k !== undefined) { free.delete(k); here.beside++; } else here.house++; }
  towns++; marks += sites.length; own += here.own; beside += here.beside; house += here.house; if (here.house > 0) worst.push(`${brief.name} ${here.house}/${sites.length}`);
});
console.log({ towns, blockLandmarks: marks, own, beside, house, besideShare: (100 * beside / marks).toFixed(2) + '%' }); console.log(worst.slice(0, 30).join(', '));
