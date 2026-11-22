/**
 * A town with no straight street in it, for testing everything that reads a layout on bends.
 *
 * It is a generated town put through a smooth warp of the plane: every segment, lot, footprint, district area
 * and body of water is first cut into short pieces and then moved point by point, so that a segment that was
 * one straight line becomes a polyline of many pieces, and a lot's sides bend with its street. A warp of the
 * whole plane keeps what touched touching and what was apart apart, so the result is a sound layout by every
 * rule of the format. A lot's entrance is put back on its segment's line, from which cutting a curve into
 * straight pieces moves it a little.
 */
import { type Layout, type Point, geometry } from '../src/index.ts';

/** Pieces are no longer than this, in metres. */
const PIECE = 6;
/** How far the warp moves a point at most, and over what distance it swings. */
const AMPLITUDE = 14;
const WAVELENGTH = 260;

export const warp = ([x, y]: Point): Point => [x + AMPLITUDE * Math.sin((2 * Math.PI * y) / WAVELENGTH), y + AMPLITUDE * Math.sin((2 * Math.PI * x) / (WAVELENGTH * 1.3) + 1)];

/** A line cut into short pieces, each end and each cut then warped. */
function bendLine(points: readonly Point[], closed: boolean): Point[] {
  const bent: Point[] = [];
  const count = closed ? points.length : points.length - 1;
  for (let at = 0; at < count; at++) {
    const a = points[at] as Point;
    const b = points[(at + 1) % points.length] as Point;
    const pieces = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / PIECE));
    for (let piece = 0; piece < pieces; piece++) bent.push(warp([a[0] + ((b[0] - a[0]) * piece) / pieces, a[1] + ((b[1] - a[1]) * piece) / pieces]));
  }
  if (!closed) bent.push(warp(points[points.length - 1] as Point));
  return bent;
}

/** The same town with every street bent. IDs, and which lot opens onto which segment, are as they were. */
export function bend(layout: Layout): Layout {
  const everyPoint: Point[] = [];
  const keep = (points: Point[]) => {
    everyPoint.push(...points);
    return points;
  };
  const segments = layout.segments.map((segment) => ({ ...segment, points: keep(bendLine(segment.points, false)) }));
  const lines = new Map(segments.map((segment) => [segment.id, segment.points]));
  const bent: Layout = {
    ...layout,
    junctions: layout.junctions.map((junction) => ({ ...junction, position: warp(junction.position) })),
    segments,
    waters: layout.waters.map((water) => (water.kind === 'river' ? { ...water, centreLine: bendLine(water.centreLine, false) } : { ...water, polygon: bendLine(water.polygon, true) })),
    lots: layout.lots.map((lot) => ({
      ...lot,
      polygon: keep(bendLine(lot.polygon, true)),
      entrance: { ...lot.entrance, point: geometry.projectOnPolyline(lines.get(lot.entrance.segmentId) as Point[], warp(lot.entrance.point)).point },
      footprints: lot.footprints.map((footprint) => bendLine(footprint, true)),
    })),
    districtAreas: layout.districtAreas.map((area) => ({ ...area, polygons: area.polygons.map((polygon) => bendLine(polygon, true)), labelPoint: warp(area.labelPoint) })),
  };
  const xs = everyPoint.map((point) => point[0]);
  const ys = everyPoint.map((point) => point[1]);
  const min = (values: number[]) => values.reduce((least, value) => Math.min(least, value), Infinity);
  const max = (values: number[]) => values.reduce((most, value) => Math.max(most, value), -Infinity);
  const builtArea = bent.lots.reduce((sum, lot) => sum + geometry.polygonArea(lot.polygon), 0);
  bent.summary = { ...layout.summary, generator: 'bent', bounds: { minX: min(xs), minY: min(ys), maxX: max(xs), maxY: max(ys) }, builtArea, residentsPerHectare: (layout.summary.residentsPerHectare * layout.summary.builtArea) / builtArea };
  return bent;
}
