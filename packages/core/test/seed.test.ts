import { describe, expect, it } from 'vitest';
import { deriveSeed } from '../src/index.ts';

describe('deriveSeed', () => {
  it('returns fixed values, so seeds are the same on every machine and run', () => {
    expect(deriveSeed('154035788', 'settlement', 'settlement-641')).toBe(EXPECTED_BADANOS);
    expect(deriveSeed('', '', '')).toBe(EXPECTED_EMPTY);
    expect(deriveSeed('wörld ✦', 'cell', 'cell-0')).toBe(EXPECTED_UNICODE);
  });

  it('returns an unsigned 32-bit integer', () => {
    for (let n = 0; n < 500; n++) {
      const seed = deriveSeed('154035788', 'settlement', `settlement-${n}`);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('depends on each of the three inputs', () => {
    const base = deriveSeed('1', 'settlement', 'settlement-1');
    expect(deriveSeed('2', 'settlement', 'settlement-1')).not.toBe(base);
    expect(deriveSeed('1', 'cell', 'settlement-1')).not.toBe(base);
    expect(deriveSeed('1', 'settlement', 'settlement-2')).not.toBe(base);
  });

  it('keeps field boundaries, so shifting text between fields changes the seed', () => {
    expect(deriveSeed('ab', 'c', 'd')).not.toBe(deriveSeed('a', 'bc', 'd'));
    expect(deriveSeed('a', 'bc', 'd')).not.toBe(deriveSeed('a', 'b', 'cd'));
  });

  it('gives distinct seeds to the settlements of one world', () => {
    const seeds = new Set<number>();
    for (let n = 1; n <= 5000; n++) seeds.add(deriveSeed('154035788', 'settlement', `settlement-${n}`));
    expect(seeds.size).toBe(5000);
  });
});

const EXPECTED_BADANOS = 3824260698;
const EXPECTED_EMPTY = 1577672556;
const EXPECTED_UNICODE = 1304995437;
