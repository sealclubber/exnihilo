/**
 * A town plan as a picture, stage by stage: SVG text in the manner of the
 * prototype's drawings, for judging each stage by eye before the next is
 * built. One unit of the drawing is one metre.
 */
import type { Point, SettlementBrief } from '../../schema.ts';
import { stripOutline } from '../cutting.ts';
import type { TownPlan } from './plan.ts';
import { cornersOf } from './rects.ts';
import { grown } from './shapes.ts';

const LAND = '#bfbfb5';
const WATER = '#8d9a9c';
const ROAD = '#e1dbd5';
const INK = '#3f322c';
const CASTLE = '#9a9486';
const WARD = '#a9a79b';
const HOUSE = '#6f6485';
const GATE = '#d9a441';

const round = (value: number) => String(Math.round(value * 10) / 10);
const path = (points: readonly Point[], closed: boolean) => `${points.map(([x, y], at) => `${at === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`).join('')}${closed ? 'Z' : ''}`;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function drawPlanSvg(plan: TownPlan, brief: SettlementBrief, highwayWidth: number, mainStreetWidth: number, wardBorder = 6.5): string {
  const extent = Math.max(plan.radius * 2, 330);
  const lines: string[] = [];
  const letter = extent / 55;
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(-extent)} ${round(-extent)} ${round(2 * extent)} ${round(2 * extent)}" width="1400" font-family="system-ui, sans-serif">`);
  lines.push(`<rect x="${round(-extent)}" y="${round(-extent)}" width="${round(2 * extent)}" height="${round(2 * extent)}" fill="${LAND}"/>`);
  if (plan.coast) lines.push(`<path d="${path(plan.coast.polygon, true)}" fill="${WATER}" stroke="${INK}" stroke-width="0.8"/>`);
  if (plan.river) lines.push(`<path d="${path(stripOutline(plan.river.line, plan.river.width), true)}" fill="${WATER}" stroke="${INK}" stroke-width="0.8"/>`);
  // The circle of the ground the town needs, faintly, for scale.
  lines.push(`<circle cx="0" cy="0" r="${round(plan.radius)}" fill="none" stroke="${INK}" stroke-opacity="0.25" stroke-width="1" stroke-dasharray="6 6"/>`);
  const road = (points: readonly Point[], width: number) => {
    lines.push(`<path d="${path(points, false)}" fill="none" stroke="${INK}" stroke-width="${round(width)}" stroke-linejoin="round"/>`);
    lines.push(`<path d="${path(points, false)}" fill="none" stroke="${ROAD}" stroke-width="${round(width - 1.4)}" stroke-linejoin="round"/>`);
  };
  if (plan.houses.length === 0) {
    // Wards as plain cells; the ground between them is the street.
    for (const ward of plan.wards) if (ward.kind === 'ordinary') lines.push(`<path d="${path(ward.polygon, true)}" fill="${WARD}" stroke="${INK}" stroke-width="0.6"/>`);
  } else {
    // The ground between blocks is street; the ground within them, behind the houses, is courtyard.
    const street = plan.wards.filter((ward) => ward.kind === 'ordinary').flatMap((ward) => grown([ward.polygon], wardBorder / 2 + 0.6).rings);
    lines.push(`<path d="${street.map((ring) => path(ring, true)).join('')}" fill="${ROAD}"/>`);
    lines.push(`<path d="${plan.blocks.map((block) => path(block.polygon, true)).join('')}" fill="${LAND}"/>`);
    lines.push(`<path d="${plan.passages.map((passage) => path(cornersOf(passage.rect), true)).join('')}" fill="${ROAD}"/>`);
    lines.push(`<path d="${plan.houses.map((house) => path(house.outline, true)).join('')}" fill="${HOUSE}" stroke="${INK}" stroke-width="0.45" stroke-linejoin="miter"/>`);
  }
  if (plan.plaza) lines.push(`<path d="${path(plan.plaza.polygon, true)}" fill="${ROAD}" stroke="${INK}" stroke-width="1"/>`);
  for (const street of plan.streets) road(street.points, mainStreetWidth - 2);
  for (const highway of plan.highways) road(highway.points, highwayWidth - 2);
  if (plan.harbour) {
    for (const [from, to] of plan.harbour.piers) road([from, to], plan.harbour.pierWidth);
    road(plan.harbour.quay, plan.harbour.width);
  }
  for (const bridge of plan.bridges) road([bridge.a, bridge.b], highwayWidth + 1);
  const tower = (point: Point, half: number) => lines.push(`<rect x="${round(point[0] - half)}" y="${round(point[1] - half)}" width="${round(2 * half)}" height="${round(2 * half)}" fill="${INK}"/>`);
  if (plan.castle) {
    lines.push(`<path d="${path(plan.castle.polygon, true)}" fill="${CASTLE}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>`);
    for (const corner of plan.castle.polygon) tower(corner, 4.5);
  }
  if (plan.wall) {
    for (const part of plan.wall.parts) lines.push(`<path d="${path(part.points, part.closed)}" fill="none" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>`);
    for (const point of plan.wall.towers) tower(point, 6);
    for (const gate of plan.wall.gates) lines.push(`<circle cx="${round(gate.point[0])}" cy="${round(gate.point[1])}" r="9" fill="${GATE}" stroke="${INK}" stroke-width="2.5"/>`);
  }
  if (!plan.plaza) lines.push(`<circle cx="0" cy="0" r="${round(letter / 3)}" fill="${INK}"/>`);
  for (const exit of plan.exits) {
    const route = brief.routes[exit.route];
    if (exit.atQuay) lines.push(`<circle cx="${round(exit.point[0])}" cy="${round(exit.point[1])}" r="${round(letter / 3)}" fill="${INK}"/>`);
    // A land exit lies beyond the picture: its label stands on the way to it. A sea route's stands by the quay.
    const far = exit.atQuay ? 1 : (extent * 0.93) / plan.reach;
    const at: Point = [exit.point[0] * far, exit.point[1] * far + (exit.atQuay ? letter * (1.2 + 1.1 * plan.exits.filter((other) => other.atQuay && other.route < exit.route && other.point === exit.point).length) : 0)];
    const label = `${route?.name ?? route?.kind ?? 'route'}${route?.leadsTo ? ` to ${route.leadsTo.name}` : ''} · ${Math.round(exit.bearing)}°`;
    lines.push(`<text x="${round(at[0])}" y="${round(at[1])}" font-size="${round(letter)}" text-anchor="${at[0] > 0 ? 'end' : 'start'}" fill="${INK}" stroke="${LAND}" stroke-width="${round(letter / 4)}" paint-order="stroke">${escape(label)}</text>`);
  }
  const title = `${brief.name} · ${plan.buildings.toLocaleString('en-US')} buildings`;
  const facts = [
    `${plan.highways.length} highways`,
    `${plan.bridges.length} bridge${plan.bridges.length === 1 ? '' : 's'}`,
    ...(plan.river ? [`river ${Math.round(plan.river.width)} m wide, set ${Math.round(plan.river.distance)} m from the centre`] : []),
    ...(plan.astride !== undefined ? [plan.astride ? 'astride the river' : 'beside the river'] : []),
    `${plan.wards.filter((ward) => ward.kind === 'ordinary').length} wards`,
    ...(plan.houses.length > 0 ? [`${plan.blocks.length.toLocaleString('en-US')} blocks`, `${plan.houses.length.toLocaleString('en-US')} houses made`] : []),
    `${plan.streets.length} main street${plan.streets.length === 1 ? '' : 's'}`,
    ...(plan.river && !plan.farBank ? ['no ground across the river'] : []),
    ...(plan.harbour ? [`${plan.harbour.kind} on the ${plan.harbour.on}`] : []),
    ...(plan.wall ? [`wall ${Math.round(2 * plan.wall.long)} by ${Math.round(2 * plan.wall.short)} m, ${plan.wall.towers.length} towers, ${plan.wall.gates.length} gates${plan.wall.farDropped ? ', closed by the river' : ''}`] : []),
    ...(plan.plaza ? [`plaza ${Math.round(plan.plaza.area).toLocaleString('en-US')} m²`] : []),
    ...(plan.castle ? [`castle ${Math.round(plan.castle.area).toLocaleString('en-US')} m²`] : []),
  ].join(' · ');
  lines.push(`<text x="${round(-extent * 0.97)}" y="${round(-extent * 0.93)}" font-size="${round(letter * 1.5)}" font-weight="700" fill="${INK}">${escape(title)}</text>`);
  lines.push(`<text x="${round(-extent * 0.97)}" y="${round(-extent * 0.93 + letter * 1.6)}" font-size="${round(letter)}" fill="${INK}">${escape(facts)}</text>`);
  plan.notes.forEach((note, at) => lines.push(`<text x="${round(-extent * 0.97)}" y="${round(-extent * 0.93 + letter * (3.2 + 1.4 * at))}" font-size="${round(letter * 0.9)}" fill="#8a2a1a">${escape(note)}</text>`));
  lines.push(`<path d="M${round(-extent * 0.95)} ${round(extent * 0.95)}h100" stroke="${INK}" stroke-width="2"/><text x="${round(-extent * 0.95 + 108)}" y="${round(extent * 0.955)}" font-size="${round(letter)}" fill="${INK}">100 m</text>`);
  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}
