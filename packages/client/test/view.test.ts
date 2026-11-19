import { describe, expect, it } from 'vitest';
import { pickNearest } from '../src/pick.ts';
import { type View, fitView, panBy, toMap, toScreen, zoomAt } from '../src/view.ts';

const limits = { min: 0.1, max: 100 };

describe('fitView', () => {
  it('shows the whole map, centred, inside the margin', () => {
    const view = fitView(1920, 1002, 1000, 800, 20);
    expect(view.scale).toBeCloseTo(0.5);
    expect(toScreen(view, [0, 0])[0]).toBeCloseTo(20);
    expect(toScreen(view, [1920, 1002])[0]).toBeCloseTo(980);
    const top = toScreen(view, [0, 0])[1];
    const bottom = toScreen(view, [1920, 1002])[1];
    expect(top).toBeCloseTo(800 - bottom);
    expect(top).toBeGreaterThan(20);
  });

  it('is limited by height when the window is wide', () => {
    expect(fitView(100, 100, 1000, 200, 0).scale).toBeCloseTo(2);
  });

  it('never returns a zero or negative scale', () => {
    expect(fitView(1920, 1002, 0, 0).scale).toBeGreaterThan(0);
  });
});

describe('pan and zoom', () => {
  const view: View = { scale: 2, x: 30, y: -10 };

  it('converts between map and screen positions both ways', () => {
    expect(toScreen(view, [10, 20])).toEqual([50, 30]);
    expect(toMap(view, 50, 30)).toEqual([10, 20]);
  });

  it('pans by a screen distance', () => {
    expect(panBy(view, 5, -7)).toEqual({ scale: 2, x: 35, y: -17 });
  });

  it('keeps the map position under the pointer fixed while zooming', () => {
    const before = toMap(view, 400, 300);
    const zoomed = zoomAt(view, 400, 300, 1.7, limits);
    const after = toMap(zoomed, 400, 300);
    expect(zoomed.scale).toBeCloseTo(3.4);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it('stops at the zoom limits without drifting', () => {
    const atMax = zoomAt({ scale: 100, x: 12, y: 34 }, 400, 300, 2, limits);
    expect(atMax).toEqual({ scale: 100, x: 12, y: 34 });
    expect(zoomAt(view, 0, 0, 0.0001, limits).scale).toBe(0.1);
  });
});

describe('pickNearest', () => {
  const view: View = { scale: 2, x: 0, y: 0 };
  const items = [
    { id: 'a', position: [10, 10] as [number, number] },
    { id: 'b', position: [14, 10] as [number, number] },
    { id: 'c', position: [200, 200] as [number, number] },
  ];

  it('picks the item nearest to the pointer', () => {
    expect(pickNearest(items, view, 21, 20)?.id).toBe('a');
    expect(pickNearest(items, view, 27, 21)?.id).toBe('b');
  });

  it('picks nothing when no item is within the radius', () => {
    expect(pickNearest(items, view, 100, 100)).toBeUndefined();
    expect(pickNearest(items, view, 400, 411, 10)).toBeUndefined();
    expect(pickNearest(items, view, 400, 409, 10)?.id).toBe('c');
  });

  it('measures the radius on screen, so zooming in separates neighbours', () => {
    const close: View = { scale: 20, x: 0, y: 0 };
    expect(pickNearest(items, close, 240, 200)).toBeUndefined();
    expect(pickNearest(items, close, 278, 200)?.id).toBe('b');
  });
});
