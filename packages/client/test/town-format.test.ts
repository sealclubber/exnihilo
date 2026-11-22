import { describe, expect, it } from 'vitest';
import type { Lot, Point } from '@worldsim/core';
import { describePath, districtColours, fitBox, formatMetres, insidePolygon, lotAt, polygonArea, riverOutline, scaleBar, wallRuns } from '../src/town-format.ts';
import { toMap, toScreen } from '../src/view.ts';

describe('fitBox', () => {
  it('shows a box whole and centred, whatever its origin', () => {
    const box = { minX: -300, minY: -100, maxX: 500, maxY: 300 };
    const view = fitBox(box, 1000, 600, 50);
    expect(view.scale).toBeCloseTo(1.125);
    expect(toScreen(view, [100, 100])).toEqual([500, 300]);
    const [left, top] = toScreen(view, [-300, -100]);
    const [right, bottom] = toScreen(view, [500, 300]);
    expect(left).toBeCloseTo(50);
    expect(right).toBeCloseTo(950);
    expect(top).toBeGreaterThan(50);
    expect(top).toBeCloseTo(600 - bottom);
  });

  it('copes with a box of no size', () => {
    const view = fitBox({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 400, 300);
    expect(Number.isFinite(view.scale)).toBe(true);
    expect(toMap(view, 200, 150)[0]).toBeCloseTo(5);
  });
});

describe('finding the lot under the pointer', () => {
  const lot = (id: string, polygon: Point[]): Lot => ({ id, buildingId: `building-${id}`, polygon, districtId: 'district-1-001', entrance: { segmentId: 'segment-1-000001', point: [0, 0] }, footprints: [] });
  const lots = [
    lot('square', [[0, 0], [10, 0], [10, 10], [0, 10]]),
    // Five sides, and an L shape: nothing here assumes a rectangle.
    lot('pentagon', [[20, 0], [30, 0], [34, 8], [25, 14], [16, 8]]),
    lot('ell', [[40, 0], [70, 0], [70, 10], [50, 10], [50, 30], [40, 30]]),
  ];

  it('finds lots of any shape', () => {
    expect(lotAt(lots, [5, 5])?.id).toBe('square');
    expect(lotAt(lots, [25, 12])?.id).toBe('pentagon');
    expect(lotAt(lots, [45, 25])?.id).toBe('ell');
    expect(lotAt(lots, [65, 5])?.id).toBe('ell');
  });

  it('finds nothing in the street, or in the notch of an L', () => {
    expect(lotAt(lots, [13, 5])).toBeUndefined();
    expect(lotAt(lots, [60, 20])).toBeUndefined();
    expect(lotAt(lots, [33, 1])).toBeUndefined();
    expect(insidePolygon([33, 12], lots[1]!.polygon)).toBe(false);
  });
});

describe('the scale bar', () => {
  it('picks a round length that fits', () => {
    expect(scaleBar(1)).toEqual({ metres: 100, pixels: 100 });
    expect(scaleBar(0.3)).toEqual({ metres: 200, pixels: 60 });
    expect(scaleBar(5)).toEqual({ metres: 20, pixels: 100 });
    expect(scaleBar(0.05).metres).toBe(2000);
    expect(scaleBar(40).metres).toBe(2);
    for (const scale of [0.02, 0.4, 3, 77]) {
      const bar = scaleBar(scale);
      expect(bar.pixels).toBeLessThanOrEqual(140);
      expect(bar.pixels).toBeGreaterThan(50);
      expect(bar.pixels).toBeCloseTo(bar.metres * scale);
    }
  });

  it('writes lengths in metres or kilometres', () => {
    expect(formatMetres(50)).toBe('50 m');
    expect(formatMetres(412.6)).toBe('413 m');
    expect(formatMetres(2.5)).toBe('2.5 m');
    expect(formatMetres(2000)).toBe('2 km');
    expect(formatMetres(1234)).toBe('1.23 km');
  });
});

describe('district colours and paths', () => {
  it('gives each district a colour, neighbours in the list differing', () => {
    const ids = Array.from({ length: 30 }, (_, index) => `district-5-${String(index + 1).padStart(3, '0')}`);
    const colours = districtColours(ids);
    expect(colours.size).toBe(30);
    for (let at = 1; at < ids.length; at++) expect(colours.get(ids[at]!)).not.toBe(colours.get(ids[at - 1]!));
    expect(colours.get(ids[0]!)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('describes a path in words', () => {
    expect(describePath({ length: 412.6, segmentIds: ['a', 'b', 'c'] })).toBe('413 m along 3 street segments');
    expect(describePath({ length: 12, segmentIds: ['a'] })).toBe('12 m along 1 street segment');
    expect(describePath({ length: 0, segmentIds: ['a'] })).toBe('0 m along 1 street segment');
  });
});

describe('a river\'s outline', () => {
  const river = (widths?: number[]) => ({ id: 'water-1-001', kind: 'river' as const, centreLine: [[0, 0], [10, 0], [20, 0]] as Point[], width: 4, ...(widths && { widths }) });

  it('is the centre line pushed out by half the width on either side', () => {
    expect(riverOutline(river())).toEqual([[0, 2], [10, 2], [20, 2], [20, -2], [10, -2], [0, -2]]);
  });

  it('follows the width at each point where the river has one', () => {
    expect(riverOutline(river([2, 6, 10]))).toEqual([[0, 1], [10, 3], [20, 5], [20, -5], [10, -3], [0, -1]]);
  });
});

describe('polygonArea', () => {
  it('measures a polygon of any shape, whichever way round it is given', () => {
    const ell: Point[] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
    expect(polygonArea(ell)).toBe(64);
    expect(polygonArea([...ell].reverse())).toBe(64);
    expect(polygonArea([[0, 0], [6, 0], [0, 8]])).toBe(24);
  });
});

describe('a wall with its gates left open', () => {
  const square: Point[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const length = (run: Point[]) => run.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - run[index]![0], point[1] - run[index]![1]), 0);

  const near = (point: Point, wanted: Point) => {
    expect(point[0]).toBeCloseTo(wanted[0], 9);
    expect(point[1]).toBeCloseTo(wanted[1], 9);
  };

  it('is one unbroken line when it has no gates', () => {
    expect(wallRuns(square.slice(0, 3), false, [])).toEqual([[[0, 0], [100, 0], [100, 100]]]);
    const closed = wallRuns(square, true, []);
    expect(closed).toHaveLength(1);
    expect(length(closed[0]!)).toBeCloseTo(400);
  });

  it('leaves a gap of the gate\'s length about the point nearest the gate', () => {
    const runs = wallRuns(square.slice(0, 3), false, [{ position: [50, 3], gap: 10 }]);
    expect(runs.map((run) => run.length)).toEqual([2, 3]);
    near(runs[0]![1]!, [45, 0]);
    near(runs[1]![0]!, [55, 0]);
    expect(runs[1]!.slice(1)).toEqual([[100, 0], [100, 100]]);
  });

  it('joins a closed wall through its first point, and breaks it there when a gate stands on it', () => {
    const through = wallRuns(square, true, [{ position: [50, 0], gap: 10 }, { position: [50, 100], gap: 10 }]);
    expect(through).toHaveLength(2);
    near(through[0]![0]!, [45, 100]);
    expect(through[0]).toContainEqual([0, 0]);
    near(through[0]![through[0]!.length - 1]!, [45, 0]);
    expect(through.reduce((sum, run) => sum + length(run), 0)).toBeCloseTo(380);
    const corner = wallRuns(square, true, [{ position: [0, 0], gap: 10 }]);
    expect(corner).toHaveLength(1);
    near(corner[0]![0]!, [5, 0]);
    near(corner[0]![corner[0]!.length - 1]!, [0, 5]);
    expect(length(corner[0]!)).toBeCloseTo(390);
  });
});
