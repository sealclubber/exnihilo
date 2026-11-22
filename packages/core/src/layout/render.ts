/**
 * A town's layout as a picture: SVG text, with no people in it. For judging a
 * layout by eye without starting the server.
 *
 * It reads the layout format alone, so it draws whatever any generator made:
 * water, lots tinted by district, streets by kind, the wall with its gates,
 * the plaza, and each exit labelled with where its route leads. One unit of
 * the drawing is one metre.
 */
import type { Point, SettlementBrief } from '../schema.ts';
import { riverOutline } from './measure.ts';
import type { Layout, SegmentKind } from './records.ts';

// Flat fills and thin lines, as in the viewer.
const LAND = '#f6f4ee';
const WATER = '#a9cbe8';
const INK = '#23272e';
const WALL = '#3b3530';
const PLAZA = '#efe6cf';
const GREEN = '#dfe8cf';
const STREETS: Record<SegmentKind, string> = { arterial: '#d8c6a4', street: '#dcd8ce', lane: '#e6e3da', bridge: '#9a8f7d' };
const DISTRICTS = ['#e6b8af', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#b4a7d6', '#d5a6bd', '#d9d2c5', '#c9daf8', '#d0e0c0', '#ead1dc'];
/** Streets are drawn in this order, so that the main roads lie on top. */
const ORDER: SegmentKind[] = ['lane', 'street', 'arterial', 'bridge'];
/** Land shown beyond the town on every side, and the size of the lettering, in metres. */
const MARGIN = 60;
const LETTER = 14;

const round = (value: number) => String(Math.round(value * 10) / 10);
const path = (points: readonly Point[], closed: boolean) => `${points.map(([x, y], at) => `${at === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`).join('')}${closed ? 'Z' : ''}`;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface RenderOptions {
  /** The brief, for the title and for saying where each exit leads. */
  brief?: SettlementBrief;
  /** The names of the districts by ID, for labelling them. Left out, districts are not labelled. */
  districtNames?: Record<string, string>;
}

export function renderLayoutSvg(layout: Layout, options: RenderOptions = {}): string {
  const { brief, districtNames } = options;
  const { bounds } = layout.summary;
  const minX = bounds.minX - MARGIN;
  const minY = bounds.minY - MARGIN;
  const width = bounds.maxX - bounds.minX + 2 * MARGIN;
  const height = bounds.maxY - bounds.minY + 2 * MARGIN;
  const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction]));
  const districts = [...new Set(layout.districtAreas.map((area) => area.districtId))].sort();
  const tint = new Map(districts.map((id, index) => [id, DISTRICTS[index % DISTRICTS.length] as string]));
  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(minX)} ${round(minY)} ${round(width)} ${round(height)}" width="${Math.round(Math.min(2400, Math.max(600, width * 2)))}" font-family="system-ui, sans-serif">`);
  lines.push(`<rect x="${round(minX)}" y="${round(minY)}" width="${round(width)}" height="${round(height)}" fill="${LAND}"/>`);

  // Water: the sea as its polygon, a river as a line of its width.
  for (const water of layout.waters) {
    if (water.kind === 'sea') lines.push(`<path d="${path(water.polygon, true)}" fill="${WATER}"/>`);
    else lines.push(`<path d="${path(riverOutline(water), true)}" fill="${WATER}"/>`);
  }
  // The ground each district covers, faintly, so that the town's outline shows.
  for (const area of layout.districtAreas) {
    lines.push(`<path d="${area.polygons.map((polygon) => path(polygon, true)).join('')}" fill="${tint.get(area.districtId)}" fill-opacity="0.22"/>`);
  }
  // Places, then streets by kind, round at every join and end so that bends and junctions have no gaps.
  const placeOf = new Set(layout.places.flatMap((place) => (place.kind === 'plaza' ? [place.buildingId] : [])));
  for (const place of layout.places) lines.push(`<path d="${path(place.polygon, true)}" fill="${place.kind === 'plaza' ? PLAZA : GREEN}" stroke="${INK}" stroke-opacity="0.35" stroke-width="0.6"/>`);
  // A street wider than the town's usual street is an arterial, drawn in the main roads' colour beneath them.
  const counts = new Map<number, number>();
  for (const segment of layout.segments) if (segment.kind === 'street') counts.set(segment.width, (counts.get(segment.width) ?? 0) + 1);
  const usual = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? Infinity;
  const wide = layout.segments.filter((segment) => segment.kind === 'street' && segment.width > usual);
  for (const kind of ORDER) {
    if (kind === 'arterial' && wide.length > 0) lines.push(`<path d="${wide.map((segment) => path(segment.points, false)).join('')}" fill="none" stroke="${STREETS.arterial}" stroke-width="${round(Math.max(...wide.map((segment) => segment.width)))}" stroke-linecap="round" stroke-linejoin="round"/>`);
    const drawn = layout.segments.filter((segment) => segment.kind === kind && !(kind === 'street' && segment.width > usual));
    if (drawn.length === 0) continue;
    const widths = [...new Set(drawn.map((segment) => segment.width))];
    for (const each of widths) {
      lines.push(`<path d="${drawn.filter((segment) => segment.width === each).map((segment) => path(segment.points, false)).join('')}" fill="none" stroke="${STREETS[kind]}" stroke-width="${round(each)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  }
  // Lots, tinted by district, with their buildings solid on them.
  for (const districtId of districts) {
    const lots = layout.lots.filter((lot) => lot.districtId === districtId && !placeOf.has(lot.buildingId));
    if (lots.length === 0) continue;
    lines.push(`<path d="${lots.map((lot) => path(lot.polygon, true)).join('')}" fill="${tint.get(districtId)}" fill-opacity="0.55" stroke="${INK}" stroke-opacity="0.45" stroke-width="0.35"/>`);
    const built = lots.flatMap((lot) => lot.footprints);
    if (built.length > 0) lines.push(`<path d="${built.map((footprint) => path(footprint, true)).join('')}" fill="${tint.get(districtId)}" stroke="${INK}" stroke-opacity="0.5" stroke-width="0.3"/>`);
  }
  // The wall, a thick dark line, with a gap and a marker at each gate.
  for (const wall of layout.walls) {
    lines.push(`<path d="${path(wall.line, wall.closed)}" fill="none" stroke="${WALL}" stroke-width="${round(wall.width)}" stroke-linejoin="round"/>`);
    for (const gate of wall.gates) {
      const at = junctions.get(gate.junctionId)?.position;
      if (!at) continue;
      const size = gate.arterial ? 7 : 5;
      lines.push(`<circle cx="${round(at[0])}" cy="${round(at[1])}" r="${size}" fill="${LAND}" stroke="${WALL}" stroke-width="1.6"/>`);
    }
  }
  // District names, and each exit with where its route leads.
  if (districtNames) {
    for (const area of layout.districtAreas) {
      const [x, y] = area.labelPoint;
      lines.push(`<text x="${round(x)}" y="${round(y)}" font-size="${LETTER}" font-weight="600" text-anchor="middle" fill="${INK}" fill-opacity="0.75" stroke="${LAND}" stroke-width="3" paint-order="stroke">${escape(districtNames[area.districtId] ?? area.districtId)}</text>`);
    }
  }
  layout.exits.forEach((exit, position) => {
    const at = junctions.get(exit.junctionId)?.position;
    if (!at) return;
    const lead = brief?.routes[position]?.leadsTo;
    const label = `${exit.name ?? exit.kind.replace('-', ' ')}${lead ? ` to ${lead.name}` : ''}`;
    lines.push(`<circle cx="${round(at[0])}" cy="${round(at[1])}" r="4" fill="${INK}"/>`);
    // The label is set toward the middle of the picture, so that it stays in it.
    const anchor = at[0] > minX + width / 2 ? 'end' : 'start';
    lines.push(`<text x="${round(at[0] + (anchor === 'end' ? -8 : 8))}" y="${round(at[1] + (at[1] > minY + height / 2 ? -8 : LETTER + 4))}" font-size="${LETTER}" text-anchor="${anchor}" fill="${INK}" stroke="${LAND}" stroke-width="3" paint-order="stroke">${escape(label)}</text>`);
  });
  // The title, and a bar a hundred metres long.
  const title = `${brief ? `${brief.name}, ${brief.population.toLocaleString('en-US')} residents · ` : ''}${layout.summary.generator} · ${layout.lots.length.toLocaleString('en-US')} lots`;
  lines.push(`<text x="${round(minX + 12)}" y="${round(minY + LETTER + 10)}" font-size="${LETTER + 2}" font-weight="600" fill="${INK}">${escape(title)}</text>`);
  lines.push(`<path d="M${round(minX + 12)} ${round(minY + height - 14)}h100" stroke="${INK}" stroke-width="2"/><text x="${round(minX + 118)}" y="${round(minY + height - 9)}" font-size="${LETTER - 2}" fill="${INK}">100 m</text>`);
  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}
