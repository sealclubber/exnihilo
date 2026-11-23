/**
 * Draws the ground plan of a grown town before its buildings: water, the town's ground, its wards shaded by growth
 * (darker is older), the faces they stand on, and its roads at their widths. For checking the method of phase 6D.3
 * step by step.
 *
 * Usage: node scripts/preview-town.ts <settlement name> <out.svg>
 */
import { writeFileSync } from 'node:fs';
import { generateCity, lotSizeOf, riverOutline } from '../packages/core/src/index.ts';
import { interiorPoint } from '../packages/core/src/layout/cutting.ts';
import { layTown } from '../packages/core/src/layout/town.ts';
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
for (const face of faces) parts.push(`<path d="${path(face, true)}" fill="none" stroke="#c44" stroke-width="1.2" stroke-dasharray="4,3"/>`);
for (const road of town.plan.roads) {
  const colour = road.kind === 'arterial' ? '#d8c9a8' : road.kind === 'bank' ? '#e0d4bb' : '#d2bd94';
  parts.push(`<path d="${path(road.points, false)}" fill="none" stroke="${colour}" stroke-width="${road.width}" stroke-opacity="0.85"/>`);
  for (const [a, b] of road.bridges) parts.push(`<path d="${path([a, b], false)}" fill="none" stroke="#5c5548" stroke-width="${grown.widths.bridge}"/>`);
}
for (const street of streets) parts.push(`<path d="${path(street, false)}" fill="none" stroke="#e8dcc4" stroke-width="${grown.widths.street}"/>`);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-extent} ${-extent} ${2 * extent} ${2 * extent}" width="1400" height="1400">${parts.join('')}<text x="${-extent * 0.97}" y="${-extent * 0.93}" font-size="${extent / 40}" font-family="sans-serif">${name}: ${wards.length} wards, ${city.buildings.length} buildings, ${(took / 1000).toFixed(2)} s</text></svg>`;
writeFileSync(out, svg);
console.log(`${name}: ${wards.length} wards in ${faces.length} faces, ${streets.length} ward streets, ${town.plan.roads.length} roads, ${(took / 1000).toFixed(2)} s`);
