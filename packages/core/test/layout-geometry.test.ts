import { describe, expect, it } from 'vitest';
import { type Point, bearing, geometry } from '../src/index.ts';

const {
  SpatialIndex,
  bearingDifference,
  bearingVector,
  boxOf,
  crossingsOfPolyline,
  distanceBetweenPieces,
  distanceBetweenPolygons,
  distanceBetweenPolylines,
  distancePolygonToPolyline,
  distanceToPolyline,
  exactBearing,
  piecesCross,
  pointAlongPolyline,
  pointWithinPolygon,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polygonWithin,
  polygonsOverlap,
  polylineLength,
  projectOnPolyline,
  sharedBoundaryLength,
  slicePolyline,
  strictlyInside,
} = geometry;

const square = (x: number, y: number, size: number): Point[] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];
const pentagon: Point[] = [
  [0, 0],
  [10, 0],
  [14, 8],
  [5, 14],
  [-4, 8],
];
/** An L shape, which is not convex. */
const ell: Point[] = [
  [0, 0],
  [30, 0],
  [30, 10],
  [10, 10],
  [10, 30],
  [0, 30],
];

describe('bearings', () => {
  it('turns a bearing into a direction with y pointing south, and back', () => {
    expect(bearingVector(0)[1]).toBeCloseTo(-1);
    expect(bearingVector(90)[0]).toBeCloseTo(1);
    expect(bearingVector(180)[1]).toBeCloseTo(1);
    for (const degrees of [0, 61, 152, 227, 359]) {
      const [x, y] = bearingVector(degrees);
      expect(exactBearing([0, 0], [x * 100, y * 100])).toBeCloseTo(degrees, 9);
      expect(bearing([0, 0], [x * 100, y * 100])).toBe(degrees);
    }
  });

  it('measures the smaller angle between two bearings', () => {
    expect(bearingDifference(10, 350)).toBe(20);
    expect(bearingDifference(350, 10)).toBe(20);
    expect(bearingDifference(0, 180)).toBe(180);
    expect(bearingDifference(61, 61)).toBe(0);
    expect(bearingDifference(400, 30)).toBe(10);
  });
});

describe('polygon area and centre', () => {
  it('measures area whichever way round the points run', () => {
    expect(polygonArea(square(3, 4, 10))).toBe(100);
    expect(polygonArea([...square(3, 4, 10)].reverse())).toBe(100);
    expect(polygonArea(ell)).toBe(500);
    expect(polygonArea([[0, 0], [4, 0], [0, 3]])).toBe(6);
  });

  it('finds the centroid', () => {
    expect(polygonCentroid(square(0, 0, 10))).toEqual([5, 5]);
    const [x, y] = polygonCentroid(ell);
    expect(x).toBeCloseTo(11);
    expect(y).toBeCloseTo(11);
  });
});

describe('points and polylines', () => {
  const bent: Point[] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];

  it('measures a polyline and finds the point at a distance along it', () => {
    expect(polylineLength(bent)).toBe(20);
    expect(pointAlongPolyline(bent, 0)).toEqual([0, 0]);
    expect(pointAlongPolyline(bent, 4)).toEqual([4, 0]);
    expect(pointAlongPolyline(bent, 13)).toEqual([10, 3]);
    expect(pointAlongPolyline(bent, 99)).toEqual([10, 10]);
    expect(pointAlongPolyline(bent, -5)).toEqual([0, 0]);
  });

  it('projects a point onto a polyline', () => {
    expect(projectOnPolyline(bent, [4, 3])).toEqual({ point: [4, 0], along: 4, distance: 3 });
    expect(projectOnPolyline(bent, [12, 6])).toEqual({ point: [10, 6], along: 16, distance: 2 });
    expect(projectOnPolyline(bent, [-3, -4]).distance).toBe(5);
    expect(distanceToPolyline([10, 5], bent)).toBe(0);
  });

  it('cuts a polyline between two distances, in either direction', () => {
    expect(slicePolyline(bent, 4, 13)).toEqual([[4, 0], [10, 0], [10, 3]]);
    expect(slicePolyline(bent, 13, 4)).toEqual([[10, 3], [10, 0], [4, 0]]);
    expect(slicePolyline(bent, 2, 5)).toEqual([[2, 0], [5, 0]]);
    expect(polylineLength(slicePolyline(bent, 3, 17))).toBeCloseTo(14);
  });

  it('measures the distance between straight pieces and between polylines', () => {
    expect(distanceBetweenPieces([0, 0], [10, 0], [5, -5], [5, 5])).toBe(0);
    expect(distanceBetweenPieces([0, 0], [10, 0], [0, 4], [10, 4])).toBe(4);
    expect(distanceBetweenPieces([0, 0], [10, 0], [13, 4], [20, 4])).toBe(5);
    expect(distanceBetweenPolylines(bent, [[0, 6], [6, 6]])).toBe(4);
  });

  it('tells crossing from touching', () => {
    expect(piecesCross([0, 0], [10, 0], [5, -5], [5, 5])).toBe(true);
    expect(piecesCross([0, 0], [10, 0], [5, 0], [5, 5])).toBe(false);
    expect(piecesCross([0, 0], [10, 0], [10, 0], [20, 0])).toBe(false);
    expect(piecesCross([0, 0], [10, 0], [2, 0], [8, 0])).toBe(false);
    expect(crossingsOfPolyline([5, -5], [5, 15], bent)).toBe(1);
    expect(crossingsOfPolyline([-5, 5], [15, 5], bent)).toBe(1);
    expect(crossingsOfPolyline([-5, -5], [-5, 15], bent)).toBe(0);
  });
});

describe('points in polygons', () => {
  it('counts the edge as inside, but not strictly', () => {
    expect(pointInPolygon([5, 5], square(0, 0, 10))).toBe(true);
    expect(pointInPolygon([10, 5], square(0, 0, 10))).toBe(true);
    expect(pointInPolygon([10.001, 5], square(0, 0, 10))).toBe(false);
    expect(strictlyInside([5, 5], square(0, 0, 10))).toBe(true);
    expect(strictlyInside([10, 5], square(0, 0, 10))).toBe(false);
    expect(strictlyInside([0, 0], square(0, 0, 10))).toBe(false);
  });

  it('handles shapes that are not rectangles or convex', () => {
    expect(strictlyInside([5, 7], pentagon)).toBe(true);
    expect(strictlyInside([13, 1], pentagon)).toBe(false);
    expect(strictlyInside([5, 20], ell)).toBe(true);
    expect(strictlyInside([20, 20], ell)).toBe(false);
  });
});

describe('a point within a polygon', () => {
  const draws = (values: number[]) => {
    let next = 0;
    return () => values[next++ % values.length] as number;
  };
  const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  // An L: the bounding box's upper right quarter is outside it.
  const bent: Point[] = [[0, 0], [4, 0], [4, 6], [10, 6], [10, 10], [0, 10]];

  it('is where the draws put it when that is inside', () => {
    expect(pointWithinPolygon(square, draws([0.25, 0.5]), 4)).toEqual([2.5, 5]);
  });

  it('is still inside when every draw misses', () => {
    // Each try lands in the corner the L leaves out.
    const point = pointWithinPolygon(bent, draws([0.9, 0.1]), 3);
    expect(strictlyInside(point, bent)).toBe(true);
    expect(strictlyInside(pointWithinPolygon(bent, draws([0.9, 0.1]), 0), bent)).toBe(true);
  });

  it('is the same for the same draws', () => {
    expect(pointWithinPolygon(bent, draws([0.3, 0.9, 0.1]), 2)).toEqual(pointWithinPolygon(bent, draws([0.3, 0.9, 0.1]), 2));
  });

  it('refuses a polygon with no area', () => {
    expect(() => pointWithinPolygon([[0, 0], [5, 0], [9, 0]], draws([0.5]), 2)).toThrow(/no area/);
  });
});

describe('polygons against each other', () => {
  it('finds overlap, and none between shapes that only touch', () => {
    expect(polygonsOverlap(square(0, 0, 10), square(5, 5, 10))).toBe(true);
    expect(polygonsOverlap(square(0, 0, 10), square(10, 0, 10))).toBe(false);
    expect(polygonsOverlap(square(0, 0, 10), square(10, 10, 10))).toBe(false);
    expect(polygonsOverlap(square(0, 0, 10), square(30, 0, 10))).toBe(false);
    expect(polygonsOverlap(square(0, 0, 10), square(0, 0, 10))).toBe(true);
    expect(polygonsOverlap(square(0, 0, 10), square(2, 2, 3))).toBe(true);
    expect(polygonsOverlap(square(2, 2, 3), square(0, 0, 10))).toBe(true);
  });

  it('finds overlap between shapes that are not rectangles', () => {
    expect(polygonsOverlap(pentagon, square(12, 6, 5))).toBe(true);
    expect(polygonsOverlap(pentagon, square(14.5, 0, 5))).toBe(false);
    // The square sits in the notch of the L, touching it on two sides.
    expect(polygonsOverlap(ell, square(10, 10, 15))).toBe(false);
    expect(polygonsOverlap(ell, square(8, 8, 15))).toBe(true);
    // A cross: two bars whose corners all lie outside the other.
    const upright: Point[] = [[4, -5], [6, -5], [6, 15], [4, 15]];
    const flat: Point[] = [[-5, 4], [15, 4], [15, 6], [-5, 6]];
    expect(polygonsOverlap(upright, flat)).toBe(true);
  });

  it('tells whether one polygon lies within another', () => {
    expect(polygonWithin(square(2, 2, 3), square(0, 0, 10))).toBe(true);
    expect(polygonWithin(square(0, 0, 5), square(0, 0, 10))).toBe(true);
    expect(polygonWithin(square(8, 8, 5), square(0, 0, 10))).toBe(false);
    expect(polygonWithin(square(12, 12, 5), ell)).toBe(false);
    expect(polygonWithin(square(1, 12, 5), ell)).toBe(true);
  });

  it('measures the gap between polygons, and to a polyline', () => {
    expect(distanceBetweenPolygons(square(0, 0, 10), square(13, 0, 10))).toBe(3);
    expect(distanceBetweenPolygons(square(0, 0, 10), square(10, 0, 10))).toBe(0);
    expect(distanceBetweenPolygons(square(0, 0, 10), square(13, 14, 10))).toBe(5);
    expect(distanceBetweenPolygons(square(0, 0, 10), square(2, 2, 3))).toBe(0);
    expect(distancePolygonToPolyline(square(0, 0, 10), [[-5, 14], [20, 14]])).toBe(4);
    expect(distancePolygonToPolyline(square(0, 0, 10), [[5, 5], [6, 6]])).toBe(0);
    expect(distancePolygonToPolyline(square(0, 0, 10), [[-5, 5], [20, 5]])).toBe(0);
  });

  it('measures the outline two polygons share', () => {
    expect(sharedBoundaryLength(square(0, 0, 10), square(10, 0, 10))).toBe(10);
    expect(sharedBoundaryLength(square(0, 0, 10), square(10, 4, 10))).toBe(6);
    expect(sharedBoundaryLength(square(0, 0, 10), square(10, 10, 10))).toBe(0);
    expect(sharedBoundaryLength(square(0, 0, 10), square(11, 0, 10))).toBe(0);
    expect(sharedBoundaryLength(ell, square(10, 10, 15))).toBe(30);
  });
});

describe('the spatial index', () => {
  it('finds what is near a box, each thing once', () => {
    const index = new SpatialIndex<string>(10);
    index.add(boxOf(square(0, 0, 25)), 'big');
    index.add(boxOf(square(100, 100, 5)), 'far');
    index.add(boxOf(square(24, 24, 2)), 'corner');
    expect(index.near(boxOf(square(20, 20, 3)))).toEqual(new Set(['big', 'corner']));
    expect(index.near(boxOf(square(101, 101, 1)))).toEqual(new Set(['far']));
    expect(index.near(boxOf(square(-50, -50, 5)))).toEqual(new Set());
    expect(boxOf(square(0, 0, 10), 2)).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 12 });
  });
});
