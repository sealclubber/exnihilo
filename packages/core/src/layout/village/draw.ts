/**
 * A village plan as a picture, step by step: SVG text in the manner of the
 * prototype's drawings, for judging each step by eye before the next is
 * built. One unit of the drawing is one metre.
 */
import type { Point, SettlementBrief } from '../../schema.ts';
import { stripOutline } from '../cutting.ts';
import type { VillagePlan } from './plan.ts';

const LAND = '#c5c4b4';
const WATER = '#8d9a9c';
const ROAD = '#e1dbd5';
const INK = '#3f322c';
const GREEN = '#b4c08f';
const YARD = '#c3c9a6';
const BUILDING = '#3d3d3d';
const SHED = '#8e8a80';

const round = (value: number) => String(Math.round(value * 10) / 10);
const path = (points: readonly Point[], closed: boolean) => `${points.map(([x, y], at) => `${at === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`).join('')}${closed ? 'Z' : ''}`;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SHAPES = { street: 'along a road', green: 'round a green', crossroads: 'at a crossroads', shore: 'on a shore' };

export function drawVillageSvg(plan: VillagePlan, brief: SettlementBrief): string {
  const extent = Math.max(plan.cap * 1.6, 230);
  const lines: string[] = [];
  const letter = extent / 55;
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(-extent)} ${round(-extent)} ${round(2 * extent)} ${round(2 * extent)}" width="1100" font-family="system-ui, sans-serif">`);
  lines.push(`<rect x="${round(-extent)}" y="${round(-extent)}" width="${round(2 * extent)}" height="${round(2 * extent)}" fill="${LAND}"/>`);
  if (plan.coast) lines.push(`<path d="${path(plan.coast.polygon, true)}" fill="${WATER}" stroke="${INK}" stroke-width="0.6"/>`);
  if (plan.river) lines.push(`<path d="${path(stripOutline(plan.river.line, plan.river.width), true)}" fill="${WATER}" stroke="${INK}" stroke-width="0.6"/>`);
  // The cap on the through road's built stretch, faintly.
  lines.push(`<circle cx="0" cy="0" r="${round(plan.cap)}" fill="none" stroke="${INK}" stroke-opacity="0.25" stroke-width="0.8" stroke-dasharray="5 5"/>`);
  const { green, sites } = plan.anchors;
  if (green) lines.push(`<path d="${path(green.outline, true)}" fill="${GREEN}" stroke="#8a9070" stroke-width="0.6"/>`);
  for (const way of plan.ways) {
    lines.push(`<path d="${path(way.points, false)}" fill="none" stroke="#8a8172" stroke-width="${round(way.width + 1)}" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  for (const way of plan.ways) lines.push(`<path d="${path(way.points, false)}" fill="none" stroke="${ROAD}" stroke-width="${round(way.width)}" stroke-linejoin="round" stroke-linecap="round"/>`);
  for (const bridge of plan.bridges) {
    lines.push(`<path d="${path([bridge.a, bridge.b], false)}" fill="none" stroke="${INK}" stroke-width="${round((plan.ways[bridge.way]?.width ?? 6) + 2.2)}"/>`);
    lines.push(`<path d="${path([bridge.a, bridge.b], false)}" fill="none" stroke="#d8d0c4" stroke-width="${round(plan.ways[bridge.way]?.width ?? 6)}"/>`);
  }
  if (green) lines.push(`<path d="${path(green.pond, true)}" fill="${WATER}" stroke="${INK}" stroke-width="0.5"/>`);
  for (const site of sites) {
    if (site.role === 'green') continue;
    if (site.role === 'landing') {
      lines.push(`<path d="${path(site.outline, true)}" fill="#8c7d68" stroke="${INK}" stroke-width="0.6"/>`);
      continue;
    }
    if (site.role === 'church' || site.role === 'manor') lines.push(`<path d="${path(site.outline, true)}" fill="${site.role === 'church' ? YARD : '#cfc9b4'}" stroke="#5a5348" stroke-width="1.2"/>`);
    for (const shed of site.drawing) lines.push(`<path d="${path(shed, true)}" fill="${SHED}" stroke="${INK}" stroke-width="0.4"/>`);
    for (const footprint of site.footprints) lines.push(`<path d="${path(footprint, true)}" fill="${site.role === 'well' ? ROAD : BUILDING}" stroke="${INK}" stroke-width="${site.role === 'well' ? 1 : 0.5}"/>`);
    if (site.role === 'mill') {
      const [x, y] = site.outline.reduce((sum, point) => [sum[0] + point[0] / site.outline.length, sum[1] + point[1] / site.outline.length], [0, 0]);
      lines.push(`<circle cx="${round(x)}" cy="${round(y)}" r="2.6" fill="none" stroke="#e1dbd5" stroke-width="0.8"/>`);
    }
  }
  const flags = Object.entries(brief.flags).filter(([, on]) => on).map(([flag]) => flag);
  lines.push(`<text x="${round(-extent * 0.96)}" y="${round(-extent * 0.92)}" font-size="${round(letter * 1.3)}" font-weight="bold" fill="${INK}">${escape(brief.name)}, ${SHAPES[plan.shape]} · ${plan.buildings} buildings</text>`);
  lines.push(`<text x="${round(-extent * 0.96)}" y="${round(-extent * 0.92 + letter * 1.6)}" font-size="${round(letter * 0.85)}" fill="${INK}">${escape([`${brief.population} residents`, ...flags, ...(plan.river ? ['stream'] : []), ...(plan.coast ? ['coast'] : [])].join(' · '))}</text>`);
  plan.notes.forEach((note, at) => lines.push(`<text x="${round(-extent * 0.96)}" y="${round(extent * 0.9 - at * letter * 1.1)}" font-size="${round(letter * 0.75)}" fill="${INK}">${escape(note)}</text>`));
  lines.push(`<path d="M${round(-extent * 0.93)} ${round(extent * 0.96)}h100" stroke="${INK}" stroke-width="2"/><text x="${round(-extent * 0.93 + 104)}" y="${round(extent * 0.965)}" font-size="${round(letter * 0.8)}" fill="${INK}">100 m</text>`);
  lines.push('</svg>');
  return lines.join('\n');
}
