/**
 * Draws the fabric of a grown town before districts and lots: water, its blocks shaded by growth rank (darker is
 * older), and its streets by kind. For checking the road-first method step by step.
 *
 * Usage: node scripts/preview-town.ts <settlement name> <out.svg> [--lines]
 * With --lines the planned road lines are drawn over it in red.
 */
import { writeFileSync } from 'node:fs';
import { generateCity, lotSizeOf, riverOutline } from '../packages/core/src/index.ts';
import { layTown } from '../packages/core/src/layout/town.ts';
import type { Point } from '../packages/core/src/schema.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const [name, out] = process.argv.slice(2);
if (!name || !out) throw new Error('Usage: node scripts/preview-town.ts <settlement name> <out.svg> [--lines]');
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
  gatehouses: brief.flags.walls ? city.buildings.filter((building) => building.type === grown.wall.gatehouse).length : 0,
  enclosesAll: brief.population < grown.wall.enclosesAllBelow,
  room: 1,
  centralLotArea: city.buildings.filter((building) => centre.has(building.districtId)).reduce((sum, building) => sum + area(building.type), 0),
});
const took = performance.now() - started;
const blocks = town.ground.map((id) => ({ id, polygon: town.blockOf(id), rank: town.rank.get(id)! }));
const points = blocks.flatMap((block) => town.cells[block.id]!.corners.map((corner) => town.corners[corner]!));
const xs = points.map((point) => point[0]);
const ys = points.map((point) => point[1]);
const margin = 120;
const [minX, maxX, minY, maxY] = [Math.min(...xs) - margin, Math.max(...xs) + margin, Math.min(...ys) - margin, Math.max(...ys) + margin];
const f = (value: number) => value.toFixed(1);
const path = (line: readonly Point[], closed: boolean) => line.map(([x, y], at) => `${at === 0 ? 'M' : 'L'}${f(x)} ${f(y)}`).join('') + (closed ? 'Z' : '');
const svg: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(minX)} ${f(minY)} ${f(maxX - minX)} ${f(maxY - minY)}" width="1500" font-family="sans-serif">`, `<rect x="${f(minX)}" y="${f(minY)}" width="${f(maxX - minX)}" height="${f(maxY - minY)}" fill="#f6f4ee"/>`];
if (town.coast) svg.push(`<path d="${path(town.coast.polygon, true)}" fill="#a9cbe8"/>`);
if (town.river) svg.push(`<path d="${path(riverOutline({ id: 'water-1-001', kind: 'river', centreLine: town.river.line, width: town.river.width, widths: town.river.widths }), true)}" fill="#a9cbe8"/>`);
for (const block of blocks) {
  if (block.polygon.length < 3) continue;
  const shade = Math.round(150 + 80 * block.rank);
  svg.push(`<path d="${path(block.polygon, true)}" fill="rgb(${shade},${shade - 10},${shade - 30})" stroke="#23272e" stroke-width="0.3"/>`);
}
const colours: Record<string, string> = { highway: '#c8a060', arterial: '#d8b880', street: '#cfcac0', lane: '#e0ddd5' };
for (const kind of ['lane', 'street', 'arterial', 'highway']) {
  for (const edge of town.edges) {
    if (!edge.street || edge.bridge || edge.kind !== kind) continue;
    svg.push(`<path d="${path([town.corners[edge.a]!, town.corners[edge.b]!], false)}" stroke="${colours[kind]}" stroke-width="${f(town.widthOf(edge))}" stroke-linecap="round" fill="none"/>`);
  }
}
for (const edge of town.edges) if (edge.street && edge.bridge) svg.push(`<path d="${path([town.corners[edge.a]!, town.corners[edge.b]!], false)}" stroke="#9a8f7d" stroke-width="${f(town.widthOf(edge))}" fill="none"/>`);
if (town.wallLine) svg.push(`<path d="${path(town.wallLine, true)}" stroke="#3b3530" stroke-width="2" stroke-dasharray="6 4" fill="none"/>`);
if (process.argv.includes('--lines')) for (const road of town.plan.roads) svg.push(`<path d="${path(road.points, false)}" stroke="red" stroke-width="1.2" fill="none"/>`);
svg.push(`<text x="${f(minX + 20)}" y="${f(minY + 40)}" font-size="28" font-weight="bold">${name}: ${blocks.length} blocks, ${town.plan.roads.length} roads, ${took.toFixed(0)} ms</text>`, '</svg>');
writeFileSync(out, svg.join('\n'));
console.log(`${name}: ${blocks.length} blocks, ${town.plan.roads.filter((road) => road.kind === 'arterial').length} arterials, ${town.chains.size} chains, ${took.toFixed(0)} ms`);
