import { describe, expect, it } from 'vitest';
import { bearing, byIdNumber, idNumber, makeId } from '../src/index.ts';

describe('bearing', () => {
  it('measures clockwise from north with y pointing down', () => {
    expect(bearing([0, 0], [0, -10])).toBe(0);
    expect(bearing([0, 0], [10, 0])).toBe(90);
    expect(bearing([0, 0], [0, 10])).toBe(180);
    expect(bearing([0, 0], [-10, 0])).toBe(270);
    expect(bearing([0, 0], [10, -10])).toBe(45);
    expect(bearing([5, 5], [-5, 15])).toBe(225);
  });

  it('stays within 0 to 359 when rounding up to a full turn', () => {
    expect(bearing([0, 0], [-0.001, -10])).toBe(0);
  });
});

describe('IDs', () => {
  it('builds and reads kind-number IDs', () => {
    expect(makeId('settlement', 641)).toBe('settlement-641');
    expect(idNumber('settlement-641')).toBe(641);
    expect(idNumber('state-0')).toBe(0);
  });

  it('rejects numbers and IDs that are not valid', () => {
    expect(() => makeId('cell', -1)).toThrow();
    expect(() => makeId('cell', 1.5)).toThrow();
    expect(() => idNumber('641')).toThrow();
    expect(() => idNumber('cell-01')).toThrow();
  });

  it('orders by number, not by text', () => {
    const list = [{ id: 'cell-10' }, { id: 'cell-9' }, { id: 'cell-100' }];
    expect(list.sort(byIdNumber).map((item) => item.id)).toEqual(['cell-9', 'cell-10', 'cell-100']);
  });
});
