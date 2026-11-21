import { describe, expect, it } from 'vitest';
import type { Lot, Point } from '@worldsim/core';
import { describePath, districtColours, fitBox, formatMetres, insidePolygon, lotAt, scaleBar } from '../src/town-format.ts';
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
