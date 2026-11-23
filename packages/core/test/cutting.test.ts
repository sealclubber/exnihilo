import { describe, expect, it } from 'vitest';
import { area, inset, interiorPoint, merge, offsetLine, sharedLength, simplify, smallestRectangle, splitAlong, stripOutline, subtract, toEdge } from '../src/layout/cutting.ts';
import type { Point } from '../src/schema.ts';

const square = (x: number, y: number, size: number): Point[] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];
/** A U shape: a line straight across it meets it twice. */
const cup: Point[] = [
  [0, 0],
  [30, 0],
  [30, 30],
  [20, 30],
  [20, 10],
  [10, 10],
  [10, 30],
  [0, 30],
];

describe('cutting ground', () => {
  it('splits a square along a line straight across it, the pieces sharing the cut', () => {
    const { pieces, chords } = splitAlong(square(0, 0, 10), [
      [4, -5],
      [4, 15],
    ]);
    expect(pieces).toHaveLength(2);
    expect(chords).toHaveLength(1);
    expect(pieces.map(area).sort((a, b) => a - b)).toEqual([40, 60].map((value) => expect.closeTo(value, 9)));
    expect(sharedLength(pieces[0] as Point[], pieces[1] as Point[])).toBeCloseTo(10, 9);
  });

  it('splits a U along each arm a line crosses, and leaves it whole where the line stops inside', () => {
    expect(splitAlong(cup, [[-5, 20], [35, 20]]).pieces).toHaveLength(3);
    expect(splitAlong(cup, [[-5, 20], [5, 20]]).pieces).toHaveLength(1);
    const total = splitAlong(cup, [[-5, 20], [35, 20]]).pieces.reduce((sum, piece) => sum + area(piece), 0);
    expect(total).toBeCloseTo(area(cup), 9);
  });

  it('cuts cleanly where the line passes exactly through a corner', () => {
    const { pieces } = splitAlong(square(0, 0, 10), [
      [-5, -5],
      [15, 15],
    ]);
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) expect(area(piece)).toBeCloseTo(50, 4);
  });

  it('takes a road strip out of a square, leaving the two sides', () => {
    const road = stripOutline(
      [
        [5, -10],
        [5, 20],
      ],
      2,
    );
    const { pieces, hole } = subtract(square(0, 0, 10), road);
    expect(hole).toBe(false);
    expect(pieces.map(area).sort((a, b) => a - b)).toEqual([40, 40].map((value) => expect.closeTo(value, 6)));
  });

  it('takes a round-ended notch where a road ends inside, and says so where it would leave a hole', () => {
    const stub = stripOutline(
      [
        [5, -10],
        [5, 5],
      ],
      2,
    );
    const notched = subtract(square(0, 0, 10), stub);
    expect(notched.pieces).toHaveLength(1);
    // A 2 m notch 5 m deep, with a round end drawn just round the circle: about half a circle more than its square part.
    expect(area(notched.pieces[0] as Point[])).toBeGreaterThan(100 - 10 - 1.7);
    expect(area(notched.pieces[0] as Point[])).toBeLessThan(100 - 10 - 1.4);
    const inner = subtract(square(0, 0, 10), square(4, 4, 2));
    expect(inner.hole).toBe(true);
  });

  it('bends a strip round a corner without its inner side crossing itself', () => {
    const line: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    const outline = stripOutline(line, 4);
    expect(area(outline)).toBeGreaterThan(70);
    expect(offsetLine(line, 2).length).toBeGreaterThanOrEqual(3);
  });

  it('finds the long side of a slanted rectangle', () => {
    const angle = 0.3;
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    const rect: Point[] = [
      [0, 0],
      [20 * c, 20 * s],
      [20 * c - 5 * s, 20 * s + 5 * c],
      [-5 * s, 5 * c],
    ];
    const found = smallestRectangle(rect);
    expect(Math.hypot(...found.long)).toBeCloseTo(20, 9);
    expect(Math.hypot(...found.short)).toBeCloseTo(5, 9);
  });

  it('draws a square in, and merges two halves back into the whole', () => {
    const drawn = inset(square(0, 0, 10), 1) as Point[];
    expect(area(drawn)).toBeCloseTo(64, 9);
    const { pieces } = splitAlong(square(0, 0, 10), [
      [3, -5],
      [7, 15],
    ]);
    const whole = merge(pieces[0] as Point[], pieces[1] as Point[]) as Point[];
    expect(area(whole)).toBeCloseTo(100, 6);
    expect(merge(square(0, 0, 10), square(20, 0, 10))).toBeUndefined();
  });

  it('merges pieces whose shared side has corners on one only', () => {
    const left: Point[] = [
      [0, 0],
      [10, 0],
      [10, 5],
      [10, 10],
      [0, 10],
    ];
    const whole = merge(left, square(10, 0, 10)) as Point[];
    expect(area(whole)).toBeCloseTo(200, 9);
  });

  it('finds a point inside a U, simplifies a line, and measures from an edge', () => {
    const point = interiorPoint(cup);
    expect(toEdge(point, cup)).toBeGreaterThan(0);
    expect(
      simplify(
        [
          [0, 0],
          [5, 0.01],
          [10, 0],
        ],
        0.1,
      ),
    ).toHaveLength(2);
  });
});
