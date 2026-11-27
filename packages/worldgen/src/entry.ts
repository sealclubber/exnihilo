/**
 * AFMG's generator, run headless: its whole generation pipeline as one function.
 *
 * Bundled with AFMG's source (`vendor/afmg/`, untouched) into `dist/afmg.mjs` by `scripts/build.ts`. Ported from
 * `docs/prototypes/afmg-headless-entry.ts`. The generator keeps its state in globals (`grid`, `pack`,
 * `options`) and replaces `Math.random` with a seeded generator, so one world is made at a time and
 * `Math.random` is put back afterwards, whether or not the run succeeds. AFMG's modules are imported only once
 * the browser stubs below are in place, as some of them read `window` or `document` when they load.
 */
// 1. The three things AFMG expects of a browser.
const g = globalThis as Record<string, unknown>;
if (typeof g.window === 'undefined') g.window = globalThis;
if (typeof g.Node === 'undefined')
  g.Node = class {
    addEventListener() {}
    removeEventListener() {}
  };
if (typeof g.document === 'undefined')
  g.document = { readyState: 'complete', addEventListener: () => {}, getElementById: () => null, querySelector: () => null };
Object.assign(globalThis, { grid: undefined, pack: {} });

/** Any part of AFMG's options: objects are merged over the defaults key by key; anything else replaces. */
export type PartialOptions = { [key: string]: unknown };

export interface Generated {
  grid: any;
  pack: any;
  options: any;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (isPlain(value) && isPlain(target[key])) mergeInto(target[key] as Record<string, unknown>, value);
    else target[key] = structuredClone(value);
  }
}

async function run(given: PartialOptions): Promise<Generated> {
  const original = Math.random;
  try {
    // 2. Nothing of the last world is left.
    Object.assign(globalThis, { grid: undefined, pack: {} });
    const { Options } = await import('@/model/options/options-model');
    const { GenerationPipeline } = await import('@/model/generation-pipeline');
    const { log } = await import('@/utils/logger');
    // AFMG times every step on the console; warnings and errors still show.
    log.enabled.time = false;
    log.enabled.info = false;
    // 3. Fresh defaults for every world, or one world's settings leak into the next.
    g.options = Options.getDefaultOptions();
    // 4. The caller's options.
    mergeInto(g.options as Record<string, unknown>, given);
    // 5. The whole pipeline.
    await GenerationPipeline.run({});
    // 6. What it made.
    return { grid: g.grid, pack: g.pack, options: g.options };
  } finally {
    // 7. The seeded generator must not outlive the call.
    Math.random = original;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Makes one world. A call made while another is running waits for it: the generator's state is global. */
export function generateWorld(options: PartialOptions = {}): Promise<Generated> {
  const result = queue.then(() => run(options));
  queue = result.catch(() => undefined);
  return result;
}
