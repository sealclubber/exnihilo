/**
 * Strip lots. A block is laid out along its long axis: split along it into
 * two rows back to back, or one where it is shallow, and each row cut across
 * into strips, one lot to a strip. Each strip runs from the row's outer side,
 * where its street is, back to the line between the rows. The line between
 * two strips is askew by a little, and is shared by both.
 *
 * Works on convex polygons: what a block is once drawn in from its streets.
 */
import type { Point } from '../schema.ts';
import { clip } from './blocks.ts';
import { polygonArea } from './geometry.ts';

/** One row of a block: the band across it from `low` to `high`, and the side its street is on. */
export interface Row {
  low: number;
  high: number;
  /** Which side of the band the row's lots open onto. */
  outer: 'low' | 'high';
  /** How far along the block lots have been cut from each end. */
  lo: number;
  hi: number;
  /** The skew of the last cut made from each end. */
  skewLo: number;
  skewHi: number;
}

export interface StripBlock {
  polygon: Point[];
  /** The long axis, the direction across it, and a point both are measured from. */
  origin: Point;
  axis: Point;
  across: Point;
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  rows: Row[];
}

const at = (block: StripBlock, u: number, v: number): Point => [block.origin[0] + block.axis[0] * u + block.across[0] * v, block.origin[1] + block.axis[1] * u + block.across[1] * v];
export const uvOf = (block: StripBlock, point: Point): [number, number] => {
  const dx = point[0] - block.origin[0];
  const dy = point[1] - block.origin[1];
  return [dx * block.axis[0] + dy * block.axis[1], dx * block.across[0] + dy * block.across[1]];
};

/** The direction of the longer side of the smallest rectangle around a convex polygon. */
export function longAxis(polygon: readonly Point[]): Point {
  let best: { area: number; axis: Point } | undefined;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index] as Point;
    const b = polygon[(index + 1) % polygon.length] as Point;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-9) continue;
    const u: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const v: Point = [-u[1], u[0]];
    let [minU, maxU, minV, maxV] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const point of polygon) {
      const pu = point[0] * u[0] + point[1] * u[1];
      const pv = point[0] * v[0] + point[1] * v[1];
      minU = Math.min(minU, pu);
      maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv);
      maxV = Math.max(maxV, pv);
    }
    const area = (maxU - minU) * (maxV - minV);
    const axis: Point = maxU - minU >= maxV - minV ? u : v;
    if (!best || area < best.area - 1e-9) best = { area, axis };
  }
  return best ? best.axis : [1, 0];
}

/**
 * Lays a block out in rows: two back to back, the line between them `split` of the way across, or one where the
 * block is shallower than `twoRowsFrom` or where `only` names the one side its lots may open onto.
 */
export function stripBlock(polygon: Point[], twoRowsFrom: number, split: number, only?: 'low' | 'high'): StripBlock {
  const axis = longAxis(polygon);
  const across: Point = [-axis[1], axis[0]];
  const origin = polygon[0] as Point;
  const block: StripBlock = { polygon, origin, axis, across, minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity, rows: [] };
  for (const point of polygon) {
    const [u, v] = uvOf(block, point);
    block.minU = Math.min(block.minU, u);
    block.maxU = Math.max(block.maxU, u);
    block.minV = Math.min(block.minV, v);
    block.maxV = Math.max(block.maxV, v);
  }
  const depth = block.maxV - block.minV;
  const row = (low: number, high: number, outer: 'low' | 'high'): Row => ({ low, high, outer, lo: block.minU, hi: block.maxU, skewLo: 0, skewHi: 0 });
  if (only) block.rows = [row(block.minV, block.maxV, only)];
  else if (depth < twoRowsFrom) block.rows = [row(block.minV, block.maxV, 'low')];
  else {
    const middle = block.minV + depth * split;
    block.rows = [row(block.minV, middle, 'low'), row(middle, block.maxV, 'high')];
  }
  return block;
}

/**
 * The ground of a strip: the part of the block within the band from `low` to `high` across it, between two cuts.
 * Each cut is the line through `u` on the band's outer side, askew by `skew` metres along the block at its inner side.
 */
export function strip(block: StripBlock, low: number, high: number, outer: 'low' | 'high', from: number, skewFrom: number, to: number, skewTo: number): Point[] {
  const band = high - low;
  // A cut through (u, outerV) and (u + skew, innerV), keeping what lies on one side of it.
  const cut = (u: number, skew: number, keepAfter: boolean) => {
    const [outerV, innerV] = outer === 'low' ? [low, high] : [high, low];
    const a = at(block, u, outerV);
    const b = at(block, u + skew, innerV);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // The normal of the line a→b, turned to point along the block's axis.
    let normal: Point = [(b[1] - a[1]) / length, -(b[0] - a[0]) / length];
    if (normal[0] * block.axis[0] + normal[1] * block.axis[1] < 0) normal = [-normal[0], -normal[1]];
    if (!keepAfter) normal = [-normal[0], -normal[1]];
    return { at: a, normal };
  };
  let polygon = clip(block.polygon, { at: at(block, 0, low), normal: block.across });
  if (polygon.length >= 3) polygon = clip(polygon, { at: at(block, 0, high), normal: [-block.across[0], -block.across[1]] });
  if (band <= 0) return [];
  if (polygon.length >= 3 && from > -Infinity) polygon = clip(polygon, cut(from, skewFrom, true));
  if (polygon.length >= 3 && to < Infinity) polygon = clip(polygon, cut(to, skewTo, false));
  return polygon.length >= 3 ? polygon : [];
}

/**
 * Finds where to make the next cut along a band, from `start` in the direction `sign`, so that the strip between
 * holds `area` square metres, no narrower than `least` metres, and no further than `widest` metres from the start
 * nor past `limit`. Returns the strip, where its far cut is, and its area.
 */
export function fitStrip(block: StripBlock, low: number, high: number, outer: 'low' | 'high', start: number, skewStart: number, sign: 1 | -1, area: number, widest: number, limit: number, skewEnd: number, least = 0): { polygon: Point[]; end: number; area: number } {
  const piece = (end: number) => (sign > 0 ? strip(block, low, high, outer, start, skewStart, end, skewEnd) : strip(block, low, high, outer, end, skewEnd, start, skewStart));
  const furthest = sign > 0 ? Math.min(limit, start + widest) : Math.max(limit, start - widest);
  const whole = piece(furthest);
  const wholeArea = whole.length >= 3 ? polygonArea(whole) : 0;
  if (wholeArea <= area) return { polygon: whole, end: furthest, area: wholeArea };
  let [near, far] = [start, furthest];
  for (let step = 0; step < 24; step++) {
    const middle = (near + far) / 2;
    const polygon = piece(middle);
    const got = polygon.length >= 3 ? polygonArea(polygon) : 0;
    if (got < area) near = middle;
    else far = middle;
  }
  const end = sign > 0 ? Math.min(furthest, Math.max(far, start + least)) : Math.max(furthest, Math.min(far, start - least));
  const polygon = piece(end);
  return { polygon, end, area: polygon.length >= 3 ? polygonArea(polygon) : 0 };
}
