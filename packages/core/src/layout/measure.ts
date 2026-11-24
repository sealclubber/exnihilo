/**
 * Measurements of a layout that say something about how it looks, for the summary and the tests.
 */
import type { Point } from '../schema.ts';
import { boxOf, pointInPolygon, polygonCentroid, polygonWithin, polygonsOverlap, sharedBoundaryLength } from './geometry.ts';
import type { Layout, Segment, Water } from './records.ts';

/** Streets within this many degrees of running round a point, or straight to it, count as a ring or a spoke. */
const RING_TOLERANCE = 20;
/** The middle of the town is left out: every street there runs round the centre or to it. */
const RING_CORE = 30;

/**
 * The share of street and lane length that runs round a point or straight to it, within 20 degrees, leaving out
 * everything within 30 metres of the point. Main roads and bridges are not counted: they are meant to lead to the centre.
 */
export function ringShare(segments: readonly Pick<Segment, 'kind' | 'points'>[], about: Point = [0, 0]): number {
  let counted = 0;
  let total = 0;
  for (const segment of segments) {
    if (segment.kind !== 'street' && segment.kind !== 'lane') continue;
    for (let at = 1; at < segment.points.length; at++) {
      const a = segment.points[at - 1] as Point;
      const b = segment.points[at] as Point;
      const middle: Point = [(a[0] + b[0]) / 2 - about[0], (a[1] + b[1]) / 2 - about[1]];
      const away = Math.hypot(middle[0], middle[1]);
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (away < RING_CORE || length === 0) continue;
      // The angle between the piece and the line out from the point: 0 is a spoke, 90 a ring.
      const cosine = Math.abs(((b[0] - a[0]) * middle[0] + (b[1] - a[1]) * middle[1]) / (length * away));
      const angle = (Math.acos(Math.min(1, cosine)) * 180) / Math.PI;
      total += length;
      if (angle <= RING_TOLERANCE || angle >= 90 - RING_TOLERANCE) counted += length;
    }
  }
  return total === 0 ? 0 : counted / total;
}

/** The width of a river at a point of its centre line. */
export function riverWidthAt(river: Extract<Water, { kind: 'river' }>, index: number): number {
  return river.widths?.[index] ?? river.width;
}

/** A river's two banks as one outline, for drawing it and for telling what is in it. */
export function riverOutline(river: Extract<Water, { kind: 'river' }>): Point[] {
  const { centreLine } = river;
  const left: Point[] = [];
  const right: Point[] = [];
  centreLine.forEach((point, index) => {
    const before = centreLine[Math.max(0, index - 1)] as Point;
    const after = centreLine[Math.min(centreLine.length - 1, index + 1)] as Point;
    const length = Math.hypot(after[0] - before[0], after[1] - before[1]) || 1;
    const nx = -(after[1] - before[1]) / length;
    const ny = (after[0] - before[0]) / length;
    const half = riverWidthAt(river, index) / 2;
    left.push([point[0] + nx * half, point[1] + ny * half]);
    right.push([point[0] - nx * half, point[1] - ny * half]);
  });
  return [...left, ...right.reverse()];
}

/** How a layout's district ground falls: what the census reports, since nothing about it is required but no overlap. */
export interface DistrictGroundMeasure {
  lots: number;
  /** Lots that do not lie inside their own district's ground. */
  lotsOutside: number;
  districts: number;
  /** Districts whose ground is in more than one piece, where pieces join only by a shared edge. */
  inPieces: number;
  /** Of those, the ones still in more than one piece when a bridge link of the district's own joins two pieces. */
  inPiecesAcrossBridges: number;
}

/** A lot on the very edge of ground is inside it: it is tested drawn in by this much, in metres. */
const ON_THE_EDGE = 0.02;

export function measureDistrictGround(layout: Pick<Layout, 'lots' | 'districtAreas' | 'segments' | 'bridgeLinks'>): DistrictGroundMeasure {
  const areas = new Map(layout.districtAreas.map((area) => [area.districtId, area]));
  let lotsOutside = 0;
  for (const lot of layout.lots) {
    const area = areas.get(lot.districtId);
    // Drawn in a little toward its middle, so that a lot whose wall lies on the ground's edge counts as inside.
    const middle = polygonCentroid(lot.polygon);
    const drawnIn = lot.polygon.map((point): Point => {
      const away = Math.hypot(middle[0] - point[0], middle[1] - point[1]) || 1;
      return [point[0] + ((middle[0] - point[0]) * ON_THE_EDGE) / away, point[1] + ((middle[1] - point[1]) * ON_THE_EDGE) / away];
    });
    const box = boxOf(drawnIn);
    const inside = area?.polygons.some((polygon) => {
      const outer = boxOf(polygon, 0.01);
      return box.minX >= outer.minX && box.maxX <= outer.maxX && box.minY >= outer.minY && box.maxY <= outer.maxY && polygonWithin(drawnIn, polygon);
    });
    if (!inside) lotsOutside++;
  }
  const segments = new Map(layout.segments.map((segment) => [segment.id, segment]));
  let inPieces = 0;
  let inPiecesAcrossBridges = 0;
  for (const area of layout.districtAreas) {
    const group = area.polygons.map((_, at) => at);
    const find = (at: number): number => (group[at] === at ? at : (group[at] = find(group[at] as number)));
    const boxes = area.polygons.map((polygon) => boxOf(polygon, 0.01));
    area.polygons.forEach((polygon, at) => {
      for (let other = at + 1; other < area.polygons.length; other++) {
        const [one, two] = [boxes[at] as ReturnType<typeof boxOf>, boxes[other] as ReturnType<typeof boxOf>];
        if (find(other) === find(at) || one.maxX < two.minX || two.maxX < one.minX || one.maxY < two.minY || two.maxY < one.minY) continue;
        const next = area.polygons[other] as Point[];
        if (sharedBoundaryLength(polygon, next) > 1e-6 || polygonsOverlap(polygon, next)) group[find(other)] = find(at);
      }
    });
    const count = () => new Set(group.map((_, at) => find(at))).size;
    if (count() <= 1) continue;
    inPieces++;
    const containing = (point: Point) => area.polygons.findIndex((polygon) => pointInPolygon(point, polygon));
    for (const link of layout.bridgeLinks ?? []) {
      const bridge = segments.get(link.segmentId);
      if (!bridge || link.from !== area.districtId || link.to !== area.districtId) continue;
      // The pieces nearest the bridge's two ends, by their middles.
      const ends = [bridge.points[0] as Point, bridge.points[bridge.points.length - 1] as Point].map((end) => {
        const holding = containing(end);
        if (holding >= 0) return holding;
        let best = 0;
        let least = Infinity;
        area.polygons.forEach((polygon, at) => {
          const centre = polygonCentroid(polygon);
          const away = Math.hypot(centre[0] - end[0], centre[1] - end[1]);
          if (away < least) {
            least = away;
            best = at;
          }
        });
        return best;
      });
      group[find(ends[0] as number)] = find(ends[1] as number);
    }
    if (count() > 1) inPiecesAcrossBridges++;
  }
  return { lots: layout.lots.length, lotsOutside, districts: layout.districtAreas.length, inPieces, inPiecesAcrossBridges };
}
