/**
 * Seeded randomness for the city generator. Every pipeline step makes its own
 * stream from the settlement seed and the step's name, so changing one step
 * does not reshuffle the others.
 */
import { deriveSeed } from '../seed.ts';

export interface Rng {
  /** A number from 0 up to, but not including, 1. */
  next(): number;
  /** A whole number from min to max, both included. */
  int(min: number, max: number): number;
  chance(probability: number): boolean;
}

/** The mulberry32 generator: small, fast, and identical on every machine. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability) => next() < probability,
  };
}

/** The stream for one pipeline step of one settlement. */
export function stepRng(seed: number, step: string): Rng {
  return createRng(deriveSeed(String(seed), 'city-step', step));
}

/** Prepares a weighted choice; the result returns an index into `weights`. */
export function weightedPicker(weights: readonly number[]): (rng: Rng) => number {
  const cumulative: number[] = [];
  let total = 0;
  for (const weight of weights) cumulative.push((total += weight));
  if (!(total > 0)) throw new RangeError('cannot choose between weights that add up to zero');
  return (rng) => {
    const target = rng.next() * total;
    for (let index = 0; index < cumulative.length; index++) {
      if (target < (cumulative[index] as number)) return index;
    }
    return cumulative.length - 1;
  };
}

/** Shuffles a list in place. */
export function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index--) {
    const other = rng.int(0, index);
    const held = items[index] as T;
    items[index] = items[other] as T;
    items[other] = held;
  }
  return items;
}

/**
 * Shares `total` whole units out by weight using the largest-remainder
 * method, so the parts always sum to exactly `total`. Ties go to the earlier
 * entry.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return weights.map(() => 0);
  if (!(sum > 0)) throw new RangeError(`cannot share ${total} out between weights that add up to zero`);
  const quotas = weights.map((weight) => (total * weight) / sum);
  const parts = quotas.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = quotas
    .map((quota, index) => ({ index, remainder: quota - Math.floor(quota) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let turn = 0; left > 0; turn++, left--) {
    parts[(order[turn % order.length] as { index: number }).index]!++;
  }
  return parts;
}
