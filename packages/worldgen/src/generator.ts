/**
 * Loads AFMG's generator: the bundle `dist/afmg.mjs`, built from `vendor/afmg/` and `src/entry.ts` when it is
 * missing or older than the wrapper (`scripts/build.ts`). The bundle is built, never committed.
 */
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildBundle, bundlePath, root } from '../scripts/build.ts';

/** What AFMG made: its `grid`, `pack` and `options`, in its own shapes. */
export interface Generated {
  grid: any;
  pack: any;
  options: any;
}

/** AFMG's options, any part of them: objects merge over the defaults key by key; anything else replaces. */
export type AfmgOptions = { [key: string]: unknown };

export type GenerateWorld = (options?: AfmgOptions) => Promise<Generated>;

let loading: Promise<GenerateWorld> | undefined;

const stale = () => {
  if (!existsSync(bundlePath)) return true;
  const built = statSync(bundlePath).mtimeMs;
  return [`${root}src/entry.ts`, `${root}scripts/build.ts`].some((source) => statSync(source).mtimeMs > built);
};

/** AFMG's generator, one world at a time (a call made while another runs waits for it). */
export function loadGenerator(): Promise<GenerateWorld> {
  return (loading ??= (async () => {
    if (stale()) await buildBundle();
    const bundle = (await import(pathToFileURL(bundlePath).href)) as { generateWorld: GenerateWorld };
    return bundle.generateWorld;
  })());
}
