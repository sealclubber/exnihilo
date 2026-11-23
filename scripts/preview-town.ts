/**
 * Draws the ground plan of a grown town before its buildings: water, the town's ground, its wards shaded by growth
 * (darker is older), the faces they stand on, and its roads at their widths. For checking the method of phase 6D.3
 * step by step.
 *
 * Usage: node scripts/preview-town.ts <settlement name> <out.svg> [--buildings | --districts]
 * With --buildings each ward is cut into buildings by the plain method, the counts not yet matched to the city.
 * With --districts the wards are given districts and cut into exactly the city's buildings.
 */
import { writeFileSync } from 'node:fs';
import { generateCity, lotSizeOf, riverOutline } from '../packages/core/src/index.ts';
import { stepRng } from '../packages/core/src/city/random.ts';
import { cutWard } from '../packages/core/src/layout/buildings.ts';
import { area as areaOf, inset, interiorPoint } from '../packages/core/src/layout/cutting.ts';
import { allot } from '../packages/core/src/layout/allot.ts';
import { layTown, waysOf } from '../packages/core/src/layout/town.ts';
import type { Point } from '../packages/core/src/schema.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const [name, out] = process.argv.slice(2);
if (!name || !out) throw new Error('Usage: node scripts/preview-town.ts <settlement name> <out.svg>');
const pack = medievalPack();
const grown = pack.layout.grown!;
const brief = lomiaWorld().settlements.find((entry) => entry.name === name)!;
const city = generateCity(brief, pack);
const area = (type: string) => lotSizeOf(type, pack).frontage * lotSizeOf(type, pack).depth;
const plaza = brief.flags.plaza ? city.buildings.find((building) => building.type === grown.plaza.building) : undefined;
const plazaArea = plaza ? Math.min(Math.max(brief.population * grown.plaza.perResident, grown.plaza.min), grown.plaza.max) : 0;
const kinds = new Map(pack.districts.kinds.map((kind) => [kind.id, kind.placement]));
const centre = new Set(city.districts.filter((district) => kinds.get(district.kind) === 'centre').map((district) => district.id));
const started = performance.now();
const town = layTown(brief, pack, grown, brief.seed, {
  lotArea: city.buildings.filter((building) => building !== plaza).reduce((sum, building) => sum + area(building.type), 0),
  plazaArea,
  centralLotArea: city.buildings.filter((building) => centre.has(building.districtId)).reduce((sum, building) => sum + area(building.type), 0),
  room: 1,
  ...(brief.flags.walls && { wall: { share: brief.population < grown.wall.enclosesAllBelow ? 1 : grown.wall.share, smoothing: grown.wall.smoothing, width: grown.wall.width } }),
});
const took = performance.now() - started;
const { wards, faces, streets } = town.wards;
const extent = 2.05 * town.radius;
const path = (points: readonly Point[], closed: boolean) => `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}${closed ? 'Z' : ''}`;
const parts: string[] = [];
parts.push(`<rect x="${-extent}" y="${-extent}" width="${2 * extent}" height="${2 * extent}" fill="#f6f4ee"/>`);
for (const outline of town.ground.outlines) parts.push(`<path d="${path(outline, true)}" fill="#e2ded3"/>`);
if (town.river) parts.push(`<path d="${path(riverOutline({ id: 'water-0-001', kind: 'river', centreLine: town.river.line, width: town.river.width, widths: town.river.widths }), true)}" fill="#a9cbe8"/>`);
if (town.coast) parts.push(`<path d="${path(town.coast.polygon, true)}" fill="#a9cbe8"/>`);
for (const ward of wards) {
  const rank = town.ground.rank(town.ground.cost(interiorPoint(ward.polygon)));
  const shade = Math.round(200 + 40 * rank);
  parts.push(`<path d="${path(ward.polygon, true)}" fill="rgb(${shade},${shade - 10},${shade - 30})" stroke="#8a8170" stroke-width="0.6"/>`);
}
let built = 0;
if (process.argv.includes('--buildings')) {
  const rng = stepRng(brief.seed, 'grown-buildings');
  const costs = wards.map((ward) => town.ground.cost(interiorPoint(ward.polygon)));
  const sorted = [...costs].sort((a, b) => a - b);
  const looseFrom = sorted[Math.floor((1 - grown.buildings.loose.share) * sorted.length)] as number;
  const most = sorted[sorted.length - 1] as number;
  const perBuilding = wards.reduce((sum, ward) => sum + areaOf(ward.polygon), 0) / city.buildings.length;
  const character = grown.buildings.character.default!;
  const pieces: string[] = [];
  const lanes: string[] = [];
  wards.forEach((ward, index) => {
    const cost = costs[index] as number;
    const loose = cost >= looseFrom;
    const vary = grown.buildings.vary.min + (grown.buildings.vary.max - grown.buildings.vary.min) * rng.next();
    const open = loose ? grown.buildings.loose.open.min + (grown.buildings.loose.open.max - grown.buildings.loose.open.min) * ((cost - looseFrom) / (most - looseFrom || 1)) : character.open;
    const cut = cutWard(
      {
        polygon: ward.polygon,
        size: (perBuilding * vary * (loose ? 1 - open : 1)) / grown.buildings.pieceShare,
        gridChaos: character.gridChaos.min + (character.gridChaos.max - character.gridChaos.min) * rng.next(),
        sizeChaos: character.sizeChaos,
        open,
        alley: grown.widths.alley,
        alleyAbove: grown.buildings.alleyAbove,
        squareBelow: grown.buildings.squareBelow,
        big: [],
        match: grown.buildings.bigMatch,
        leastWidth: grown.buildings.leastWidth,
        longest: grown.buildings.longest,
      },
      rng,
    );
    for (const piece of cut.pieces) {
      if (piece.open) continue;
      let polygon = piece.polygon;
      if (loose) polygon = inset(polygon, grown.buildings.loose.pull.min + (grown.buildings.loose.pull.max - grown.buildings.loose.pull.min) * rng.next()) ?? polygon;
      pieces.push(`<path d="${path(polygon, true)}" fill="#e6b8af" stroke="#3a3a36" stroke-width="0.4"/>`);
      built++;
    }
    for (const lane of cut.lanes) lanes.push(`<path d="${path(lane, false)}" fill="none" stroke="#c9a86b" stroke-width="0.5"/>`);
  });
  parts.push(...pieces, ...lanes);
}
let fixes = '';
if (process.argv.includes('--districts')) {
  const palette = ['#e6b8af', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#d5a6bd', '#b4a7d6', '#ea9999', '#93c47d', '#76a5af', '#c27ba0'];
  const held = new Set([plaza?.id, ...city.buildings.filter((building) => brief.flags.walls && building.type === grown.wall.gatehouse).map((building) => building.id)]);
  const started2 = performance.now();
  const result = allot({
    city,
    pack,
    grown,
    town,
    rng: (step) => stepRng(brief.seed, step),
    held: (building) => held.has(building.id),
    ways: waysOf(town, grown),
    ...(town.river && { river: town.river.line }),
    atWater: (polygon) => polygon.some((point) => town.dryBy(point) <= pack.layout.watersideReach),
  });
  const districtIndex = new Map(city.districts.map((district, index) => [district.id, index]));
  for (const lot of result.placed) {
    const colour = palette[(districtIndex.get(lot.building.districtId) as number) % palette.length];
    const polygon = lot.loose ? (inset(lot.polygon, 1.2) ?? lot.polygon) : lot.polygon;
    parts.push(`<path d="${path(polygon, true)}" fill="${colour}" stroke="#3a3a36" stroke-width="0.4"/>`);
    built++;
  }
  for (const lane of result.lanes) parts.push(`<path d="${path(lane, false)}" fill="none" stroke="#c9a86b" stroke-width="0.5"/>`);
  fixes = `${JSON.stringify(result.fixes)}, ${((performance.now() - started2) / 1000).toFixed(2)} s`;
}
for (const line of town.wall?.lines ?? []) parts.push(`<path d="${path(line, town.wall?.closed ?? false)}" fill="none" stroke="#333" stroke-width="3"/>`);
for (const line of town.wallStreet ?? []) parts.push(`<path d="${path(line, false)}" fill="none" stroke="red" stroke-width="2"/>`);
if (town.plaza) parts.push(`<path d="${path(town.plaza.polygon, true)}" fill="#c8b890"/>`);
for (const face of faces) parts.push(`<path d="${path(face, true)}" fill="none" stroke="#c44" stroke-width="1.2" stroke-dasharray="4,3"/>`);
for (const road of town.plan.roads) {
  const colour = road.kind === 'arterial' ? '#d8c9a8' : road.kind === 'bank' ? '#e0d4bb' : '#d2bd94';
  parts.push(`<path d="${path(road.points, false)}" fill="none" stroke="${colour}" stroke-width="${road.width}" stroke-opacity="0.85"/>`);
  for (const [a, b] of road.bridges) parts.push(`<path d="${path([a, b], false)}" fill="none" stroke="#5c5548" stroke-width="${grown.widths.bridge}"/>`);
}
for (const street of streets) parts.push(`<path d="${path(street, false)}" fill="none" stroke="#e8dcc4" stroke-width="${grown.widths.street}"/>`);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-extent} ${-extent} ${2 * extent} ${2 * extent}" width="1400" height="1400">${parts.join('')}<text x="${-extent * 0.97}" y="${-extent * 0.93}" font-size="${extent / 40}" font-family="sans-serif">${name}: ${wards.length} wards, ${built} buildings (target ${city.buildings.length}), ${(took / 1000).toFixed(2)} s</text></svg>`;
writeFileSync(out, svg);
console.log(`${name}: ${wards.length} wards in ${faces.length} faces, ${streets.length} ward streets, ${town.plan.roads.length} roads, ${built} buildings (target ${city.buildings.length}), ${(took / 1000).toFixed(2)} s ${fixes}`);
