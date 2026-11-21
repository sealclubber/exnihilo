/**
 * A yardstick for the cost tests. A limit in seconds fails on a slow or busy
 * machine and passes a regression on a fast one, so cost tests compare the
 * work they time with a fixed piece of work timed at the same moment, on the
 * same machine, under the same load.
 */

/** Seconds this machine takes, just now, for a fixed piece of arithmetic and memory work. */
export function yardstick(): number {
  const started = performance.now();
  const values = new Float64Array(400_000);
  let state = 12345;
  for (let round = 0; round < 12; round++) {
    for (let at = 0; at < values.length; at++) {
      state = (Math.imul(state, 1664525) + 1013904223) | 0;
      values[at] = (state >>> 0) / 4294967296;
    }
    values.sort();
  }
  return (performance.now() - started) / 1000;
}

/**
 * How many yardsticks a piece of work took: the work is timed between two
 * yardsticks and compared with the quicker of them.
 */
export function inYardsticks(work: () => void): { seconds: number; yardsticks: number } {
  const before = yardstick();
  const started = performance.now();
  work();
  const seconds = (performance.now() - started) / 1000;
  const after = yardstick();
  return { seconds, yardsticks: seconds / Math.min(before, after) };
}
